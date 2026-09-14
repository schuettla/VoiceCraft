"""Editing layer: trim, assemble, convert, and asset storage (FR7–FR11).

Every operation writes a NEW file into EDITS_DIR and registers it as an
`output` asset. Sources — generations and user-supplied intro/outro assets —
are never modified or overwritten (FR10).
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

import config
import effects
from database.models import EditAsset, EditProject, Generation
from database.session import session_scope
from models import (
    AssembleRequest,
    BounceRequest,
    ConvertRequest,
    LoudnessRequest,
    LoudnessReport,
    PreviewRequest,
    ProjectData,
    ProjectIn,
    ProjectOut,
    SegmentRef,
    SilenceDetectRequest,
    SilenceRegion,
    TimelineClip,
    TrimRequest,
)
from utils import audio
from utils import timeline as timeline_mod
from utils.paths import slugify, unique_path

log = logging.getLogger(__name__)


class EditError(ValueError):
    """Bad request or ffmpeg failure — surfaced to the client as a 400."""


# --------------------------------------------------------------------------
# Assets
# --------------------------------------------------------------------------


def list_assets(session: Session, kind: str | None = None) -> list[EditAsset]:
    statement = select(EditAsset).order_by(EditAsset.created_at.desc())
    if kind:
        statement = statement.where(EditAsset.kind == kind)
    return list(session.scalars(statement).all())


def get_asset(session: Session, asset_id: str) -> EditAsset | None:
    return session.get(EditAsset, asset_id)


def create_asset(
    session: Session,
    name: str,
    kind: str,
    filename: str,
    payload: bytes,
) -> EditAsset:
    """Store an uploaded intro/outro/clip asset once, reusable across episodes (FR11)."""
    if kind not in ("intro", "outro", "clip", "output"):
        raise EditError("kind must be intro, outro, clip, or output")

    suffix = Path(filename or "asset.wav").suffix.lower() or ".wav"
    path = unique_path(config.ASSETS_DIR, slugify(name, kind), suffix)
    path.write_bytes(payload)

    duration = audio.probe_duration(path)
    if duration is None:
        path.unlink(missing_ok=True)
        raise EditError("That file could not be read as audio.")

    return _register(session, name=name.strip(), kind=kind, path=path, duration=duration)


def delete_asset(session: Session, asset_id: str) -> bool:
    asset = session.get(EditAsset, asset_id)
    if asset is None:
        return False
    Path(asset.path).unlink(missing_ok=True)
    session.delete(asset)
    session.commit()
    return True


def _register(
    session: Session,
    name: str,
    kind: str,
    path: Path,
    duration: float | None,
) -> EditAsset:
    asset = EditAsset(
        name=name,
        kind=kind,
        path=str(path),
        duration_seconds=duration,
        format=path.suffix.lstrip("."),
        size_bytes=path.stat().st_size if path.exists() else None,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


# --------------------------------------------------------------------------
# Source resolution
# --------------------------------------------------------------------------


def _resolve(session: Session, generation_id: str | None, asset_id: str | None) -> tuple[Path, str]:
    """Return (path, display name) for a generation or asset reference."""
    if generation_id:
        generation = session.get(Generation, generation_id)
        if generation is None:
            raise EditError(f"generation {generation_id} not found")
        if generation.status != "completed" or not generation.audio_path:
            raise EditError("that generation has no finished audio yet")
        path = Path(generation.audio_path)
        label = generation.text[:40].strip() or "generation"
    else:
        asset = session.get(EditAsset, asset_id or "")
        if asset is None:
            raise EditError(f"asset {asset_id} not found")
        path = Path(asset.path)
        label = asset.name

    if not path.exists():
        raise EditError(f"source file is missing from disk: {path.name}")
    return path, label


def _resolve_segment(session: Session, segment: SegmentRef) -> tuple[Path, str]:
    return _resolve(session, segment.generation_id, segment.asset_id)


# --------------------------------------------------------------------------
# Operations
# --------------------------------------------------------------------------


def trim(session: Session, request: TrimRequest) -> EditAsset:
    source, label = _resolve(session, request.generation_id, request.asset_id)

    duration = audio.probe_duration(source)
    if duration is not None and request.start >= duration:
        raise EditError(
            f"start ({request.start:.2f}s) is past the end of the clip "
            f"({duration:.2f}s)"
        )
    end = request.end
    if duration is not None and end is not None and end > duration:
        end = duration

    out = unique_path(
        config.EDITS_DIR,
        slugify(request.name or f"{label}-trim", "trim"),
        f".{request.output_format}",
    )
    try:
        audio.trim(source, out, request.start, end)
    except audio.AudioError as exc:
        out.unlink(missing_ok=True)
        raise EditError(str(exc)) from exc

    return _register(
        session,
        name=request.name or f"{label} (trim)",
        kind="output",
        path=out,
        duration=audio.probe_duration(out),
    )


def assemble(session: Session, request: AssembleRequest) -> EditAsset:
    """intro? + segments… + outro? → one file, crossfaded (FR8)."""
    sources: list[Path] = []
    labels: list[str] = []

    if request.intro_asset_id:
        path, label = _resolve(session, None, request.intro_asset_id)
        sources.append(path)
        labels.append(label)

    for segment in request.segments:
        path, label = _resolve_segment(session, segment)
        sources.append(path)
        labels.append(label)

    if request.outro_asset_id:
        path, label = _resolve(session, None, request.outro_asset_id)
        sources.append(path)
        labels.append(label)

    out = unique_path(
        config.EDITS_DIR,
        slugify(request.name or f"{labels[0]}-episode", "episode"),
        f".{request.output_format}",
    )

    workdir = Path(tempfile.mkdtemp(prefix="assemble-", dir=config.TMP_DIR))
    try:
        audio.concat(
            [*sources], out, crossfade_ms=request.crossfade_ms, workdir=workdir
        )
    except audio.AudioError as exc:
        out.unlink(missing_ok=True)
        raise EditError(str(exc)) from exc
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    return _register(
        session,
        name=request.name or "Assembled episode",
        kind="output",
        path=out,
        duration=audio.probe_duration(out),
    )


def convert(session: Session, request: ConvertRequest) -> EditAsset:
    source, label = _resolve(session, request.generation_id, request.asset_id)
    out = unique_path(
        config.EDITS_DIR,
        slugify(request.name or label, "clip"),
        f".{request.output_format}",
    )
    try:
        audio.convert(source, out)
    except audio.AudioError as exc:
        out.unlink(missing_ok=True)
        raise EditError(str(exc)) from exc

    return _register(
        session,
        name=request.name or f"{label} ({request.output_format})",
        kind="output",
        path=out,
        duration=audio.probe_duration(out),
    )


# --------------------------------------------------------------------------
# Timeline projects — the multitrack editor's saved state
# --------------------------------------------------------------------------


def _serialize(data: ProjectData) -> str:
    return data.model_dump_json()


def _deserialize(raw: str) -> ProjectData:
    try:
        return ProjectData.model_validate_json(raw or "{}")
    except Exception:  # noqa: BLE001 - a corrupt row degrades to an empty timeline
        log.warning("project data failed to parse — starting from an empty timeline")
        return ProjectData()


def _project_out(row: EditProject) -> ProjectOut:
    return ProjectOut(
        id=row.id,
        name=row.name,
        data=_deserialize(row.data),
        duration_seconds=row.duration_seconds,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def list_projects(session: Session) -> list[EditProject]:
    statement = select(EditProject).order_by(EditProject.updated_at.desc())
    return list(session.scalars(statement).all())


def get_project(session: Session, project_id: str) -> ProjectOut | None:
    row = session.get(EditProject, project_id)
    return _project_out(row) if row else None


def create_project(session: Session, payload: ProjectIn) -> ProjectOut:
    row = EditProject(name=payload.name.strip() or "Untitled project", data=_serialize(payload.data))
    session.add(row)
    session.commit()
    session.refresh(row)
    return _project_out(row)


def update_project(session: Session, project_id: str, payload: ProjectIn) -> ProjectOut | None:
    row = session.get(EditProject, project_id)
    if row is None:
        return None
    row.name = payload.name.strip() or row.name
    row.data = _serialize(payload.data)
    session.commit()
    session.refresh(row)
    return _project_out(row)


def delete_project(session: Session, project_id: str) -> bool:
    row = session.get(EditProject, project_id)
    if row is None:
        return False
    session.delete(row)
    session.commit()
    return True


# --------------------------------------------------------------------------
# Waveforms and analysis
# --------------------------------------------------------------------------


def get_peaks(
    session: Session, generation_id: str | None, asset_id: str | None, resolution: int
) -> tuple[bytes, float]:
    path, _label = _resolve(session, generation_id, asset_id)
    try:
        return audio.peaks(path, resolution)
    except audio.AudioError as exc:
        raise EditError(str(exc)) from exc


def analyze_silence(session: Session, request: SilenceDetectRequest) -> list[SilenceRegion]:
    path, _label = _resolve(session, request.generation_id, request.asset_id)
    try:
        regions = audio.detect_silence(path, request.noise_db, request.min_duration)
    except audio.AudioError as exc:
        raise EditError(str(exc)) from exc
    return [SilenceRegion(start=start, end=end) for start, end in regions]


def analyze_loudness(session: Session, request: LoudnessRequest) -> LoudnessReport:
    path, _label = _resolve(session, request.generation_id, request.asset_id)
    try:
        report = audio.measure_loudness(path)
    except audio.AudioError as exc:
        raise EditError(str(exc)) from exc
    return LoudnessReport(**report)


def _resolve_clip(data: ProjectData, clip_id: str) -> TimelineClip:
    clip = next((c for c in data.clips if c.id == clip_id), None)
    if clip is None:
        raise EditError(f"clip {clip_id} is not in this project")
    return clip


def _render_clip_to_temp(
    session: Session,
    clip: TimelineClip,
    start: float | None = None,
    end: float | None = None,
    dst: Path | None = None,
) -> Path:
    """Render one clip's own trim + effect chain + gain to a file — shared by
    clip auditioning (`render_preview`) and bouncing (`bounce`). `start`/`end`
    narrow the rendered range within the clip's own [in_point, out_point)
    span (both default to the clip's full span)."""
    source, _label = _resolve(session, clip.source.generation_id, clip.source.asset_id)
    out_point = clip.out_point if clip.out_point is not None else (audio.probe_duration(source) or 0.0)

    range_start = clip.in_point if start is None else max(clip.in_point, start)
    range_end = out_point if end is None else min(out_point, end)
    if range_end <= range_start:
        raise EditError("start must be before end within the clip's own range")

    chain = [f"atrim={range_start:.3f}:{range_end:.3f}", "asetpts=PTS-STARTPTS"]
    effect_chain = effects.build_chain([e.model_dump() for e in clip.effects])
    if effect_chain:
        chain.append(effect_chain)
    chain.append(f"volume={clip.gain_db:.2f}dB")

    out = dst or unique_path(config.TMP_DIR, slugify(f"preview-{clip.id}", "preview"), ".wav")
    try:
        audio.apply_filters(source, out, chain)
    except audio.AudioError as exc:
        out.unlink(missing_ok=True)
        raise EditError(str(exc)) from exc
    return out


def render_preview(session: Session, request: PreviewRequest) -> Path:
    """Render one clip's own effect chain to a temp file, for auditioning
    'render'-only effects the browser's Web Audio graph can't approximate."""
    if not request.clip_id:
        raise EditError("clip_id is required")
    clip = _resolve_clip(request.data, request.clip_id)
    return _render_clip_to_temp(session, clip)


def bounce(session: Session, request: BounceRequest) -> EditAsset:
    """Render a clip's effect chain (optionally narrowed to [start, end)) down
    to a new, reusable `clip` asset. The source clip is untouched (FR10) — a
    bounce just freezes edits that are otherwise re-applied on every render."""
    clip = _resolve_clip(request.data, request.clip_id)
    out = unique_path(
        config.EDITS_DIR,
        slugify(request.name or f"{clip.id}-bounce", "bounce"),
        f".{request.output_format}",
    )
    _render_clip_to_temp(session, clip, start=request.start, end=request.end, dst=out)
    return _register(
        session,
        name=request.name or "Bounced clip",
        kind="clip",
        path=out,
        duration=audio.probe_duration(out),
    )


# --------------------------------------------------------------------------
# Rendering — compiles a project to one output file via a background job
# --------------------------------------------------------------------------


@dataclass
class RenderJob:
    """Live state of one project render, polled by the editor."""

    id: str
    project_id: str
    name: str | None = None
    state: str = "queued"  # queued | measuring | rendering | completed | failed | cancelled
    progress: float = 0.0
    asset: EditAsset | None = None
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


_render_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="render")
_render_jobs: dict[str, RenderJob] = {}
_render_jobs_lock = threading.Lock()


def get_render_job(job_id: str) -> RenderJob | None:
    with _render_jobs_lock:
        return _render_jobs.get(job_id)


def cancel_render(job_id: str) -> bool:
    job = get_render_job(job_id)
    if job is None or job.state not in ("queued", "rendering"):
        return False
    job.cancel.set()
    return True


def start_render(project_id: str, name: str | None, data: ProjectData | None = None) -> RenderJob:
    with session_scope() as session:
        row = session.get(EditProject, project_id)
        if row is None:
            raise EditError("project not found")
        if data is None:
            data = _deserialize(row.data)

    job = RenderJob(id=uuid.uuid4().hex, project_id=project_id, name=name)
    with _render_jobs_lock:
        _render_jobs[job.id] = job
    _render_executor.submit(_run_render, job, data)
    return job


def _resolve_source_key(session: Session, key: str) -> tuple[Path, float]:
    kind, _, ident = key.partition(":")
    path, _label = _resolve(session, ident if kind == "g" else None, ident if kind == "a" else None)
    duration = audio.probe_duration(path)
    if duration is None:
        raise EditError(f"could not read the length of {path.name}")
    return path, duration


def _ffmpeg_render(
    graph: timeline_mod.CompiledGraph,
    paths: dict[str, Path],
    out: Path,
    sample_rate: int,
    channels: int,
    output_format: str,
    on_progress: Callable[[float], None] | None,
    cancel: threading.Event,
) -> None:
    """Write one compiled graph to `out` via ffmpeg, reporting progress —
    shared by both loudnorm passes and a plain (loudness-disabled) render."""
    workdir = Path(tempfile.mkdtemp(prefix="render-", dir=config.TMP_DIR))
    try:
        script_path = workdir / "graph.txt"
        script_path.write_text(graph.filter_script, encoding="utf-8")
        cmd = [config.FFMPEG]
        for key in graph.source_keys:
            cmd += ["-i", str(paths[key])]
        cmd += [
            "-filter_complex_script", str(script_path),
            "-map", "[out]",
            "-ar", str(sample_rate),
            "-ac", str(channels),
            *audio.encoder_args(output_format),
            str(out),
        ]
        audio.run_with_progress(cmd, graph.duration, on_progress=on_progress, cancel=cancel)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _run_render(job: RenderJob, data: ProjectData) -> None:
    job.state = "rendering"
    try:
        with session_scope() as session:
            paths: dict[str, Path] = {}
            durations: dict[str, float] = {}
            for key in timeline_mod.required_sources(data):
                path, duration = _resolve_source_key(session, key)
                paths[key] = path
                durations[key] = duration

        out = unique_path(
            config.EDITS_DIR, slugify(job.name or "episode", "episode"), f".{data.export.output_format}"
        )

        # Two-pass loudnorm: single-pass `loudnorm` only estimates its input
        # stats from the opening seconds, which is off for anything longer
        # than a few minutes. Pass 1 renders the (unlimited, un-normalized)
        # premaster mix to a scratch WAV purely to measure it accurately;
        # pass 2 recompiles the graph with those exact stats.
        loudnorm_measured: dict[str, float | None] | None = None
        if data.master.loudness.enabled:
            job.state = "measuring"
            pass1_graph = timeline_mod.compile_timeline(data, durations, loudnorm_measured=None)
            pass1_dir = Path(tempfile.mkdtemp(prefix="loudnorm-", dir=config.TMP_DIR))
            try:
                pass1_out = pass1_dir / "pass1.wav"
                _ffmpeg_render(
                    pass1_graph, paths, pass1_out,
                    sample_rate=timeline_mod.SAMPLE_RATE, channels=2, output_format="wav",
                    on_progress=lambda fraction: setattr(job, "progress", fraction * 0.35),
                    cancel=job.cancel,
                )
                loudnorm_measured = audio.measure_loudness(pass1_out)
            except audio.AudioError as exc:
                job.state = "cancelled" if job.cancel.is_set() else "failed"
                job.error = None if job.cancel.is_set() else str(exc)
                return
            finally:
                shutil.rmtree(pass1_dir, ignore_errors=True)
            job.state = "rendering"

        graph = timeline_mod.compile_timeline(data, durations, loudnorm_measured=loudnorm_measured)

        base, span = (0.35, 0.65) if data.master.loudness.enabled else (0.0, 1.0)
        try:
            _ffmpeg_render(
                graph, paths, out,
                sample_rate=data.export.sample_rate, channels=data.export.channels,
                output_format=data.export.output_format,
                on_progress=lambda fraction: setattr(job, "progress", base + fraction * span),
                cancel=job.cancel,
            )
        except audio.AudioError as exc:
            out.unlink(missing_ok=True)
            job.state = "cancelled" if job.cancel.is_set() else "failed"
            job.error = None if job.cancel.is_set() else str(exc)
            return

        with session_scope() as session:
            asset = _register(
                session,
                name=job.name or "Rendered episode",
                kind="output",
                path=out,
                duration=audio.probe_duration(out),
            )
            job.asset = asset
        job.state = "completed"
        job.progress = 1.0
    except EditError as exc:
        job.state = "failed"
        job.error = str(exc)
    except Exception as exc:  # noqa: BLE001 - reported to the UI, never raised in a worker thread
        job.state = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        log.exception("render %s failed", job.id)
