"""Music and sound-effect jobs (docs/audio-roadmap.md §5.2–5.3, Phase 4).

Speech jobs start from a profile; these start from a prompt. They share the one
worker queue in `generation_service`, so a music job never runs next to a speech
job and the unload-before-job rule keeps VRAM to one model.

The checks in `enqueue` run in the order the user can fix them: is that an
engine at all → is it installed → are its weights downloaded → can this
hardware run it → is the clip short enough for this hardware. Every refusal says
what to do, because the alternative is a job that fails minutes later.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

import catalog
import config
from backends import AudioSpec, Support, audio_backends
from database.models import EditAsset, Generation
from models import AudioEdit, AudioGenerateRequest, GenerationStatus
from services import generation_service, model_service
from services.generation_service import EngineNotReady, GenerationError
from utils import audio
from utils.paths import slugify, unique_path

log = logging.getLogger(__name__)

# Kinds in the order the UI lists them.
KIND_ORDER = ("music", "sfx")
# How many words of the prompt name the file: "door-slam-1a2b3c4d.wav".
SLUG_WORDS = 4


def _support(backend) -> Support:
    try:
        return backend.support()
    except Exception as exc:  # noqa: BLE001 - a broken GPU probe must not break the page
        log.warning("could not inspect hardware for %s", getattr(backend, "name", "?"), exc_info=True)
        return Support(False, reason=f"Could not check this machine ({type(exc).__name__}).")


def _active_spec(engine: str) -> catalog.ModelSpec | None:
    try:
        return catalog.active_model(engine)
    except KeyError:
        return None


def _downloaded(engine: str) -> bool:
    try:
        return model_service.active_downloaded(engine)
    except KeyError:
        return False


def _defaults(backend) -> tuple[Any, Any]:
    try:
        return backend.defaults()
    except Exception:  # noqa: BLE001 - a test double or an older engine may not have them
        return None, None


def _spec_downloaded(engine: str, spec: catalog.ModelSpec) -> bool:
    """Whether `spec`'s weights are on disk; the active one goes through `_downloaded`."""
    active = _active_spec(engine)
    if active is not None and active.id == spec.id:
        return _downloaded(engine)
    return model_service.spec_downloaded(spec)


def _model_info(name: str, backend, spec: catalog.ModelSpec, installed: bool) -> dict[str, Any]:
    """One checkpoint of an engine, with the limits and defaults a job on *it* gets.

    Asked inside `assume_model`, because the engines answer `support()` and
    `defaults()` for whichever checkpoint is active, and this one may not be.
    """
    with catalog.assume_model(spec.id):
        support = _support(backend)
        default_steps, default_guidance = _defaults(backend)
    downloaded = _spec_downloaded(name, spec)
    reason = model_service.unavailable_reason(spec)
    return {
        "id": spec.id,
        "title": spec.title,
        "variant": spec.variant or None,
        "summary": spec.summary,
        "default": spec.default,
        "active": catalog.is_active(spec),
        "downloaded": downloaded,
        "unavailable_reason": reason,
        "max_duration_seconds": support.max_duration_seconds if support.ok else None,
        "default_steps": default_steps,
        "default_guidance": default_guidance,
        "download_estimate_bytes": spec.download_estimate_bytes,
        "license_tier": spec.license_tier,
        "license_name": spec.license_name or None,
        "license_url": spec.license_url or None,
        "gated": spec.gated,
        "ready": installed and downloaded and support.ok and reason is None,
    }


def engine_info(name: str, backend) -> dict[str, Any]:
    """Everything the Generate view and the Models page need to know about one engine."""
    support = _support(backend)
    spec = _active_spec(name)
    installed = backend.available()
    downloaded = _downloaded(name)
    default_steps, default_guidance = _defaults(backend)
    models = [_model_info(name, backend, entry, installed) for entry in catalog.for_engine(name)]
    # The engine's default entry first, the rest in catalog order.
    models.sort(key=lambda item: not item["default"])
    return {
        "name": name,
        "kind": backend.kind,
        "label": getattr(backend, "label", name),
        "default": catalog.default_engine(backend.kind) == name,
        "installed": installed,
        "supported": support.ok,
        "unsupported_reason": None if support.ok else support.reason,
        "warning": support.warning if support.ok else None,
        "max_duration_seconds": support.max_duration_seconds if support.ok else None,
        "default_steps": default_steps,
        "default_guidance": default_guidance,
        "loaded": backend.is_loaded(),
        "device": backend.device(),
        "model_id": spec.id if spec else None,
        "model_title": spec.title if spec else None,
        "model_downloaded": downloaded,
        "download_estimate_bytes": spec.download_estimate_bytes if spec else None,
        "license_tier": spec.license_tier if spec else "open",
        "license_name": (spec.license_name or None) if spec else None,
        "license_url": (spec.license_url or None) if spec else None,
        "gated": spec.gated if spec else False,
        "lyrics": bool(getattr(backend, "supports_lyrics", backend.kind == "music")),
        "editing": bool(getattr(backend, "supports_editing", False)),
        "ready": installed and downloaded and support.ok,
        "models": models,
    }


def overview() -> list[dict[str, Any]]:
    """Every music / SFX engine, music first, each kind's default leading."""
    engines = audio_backends()

    def order(item: tuple[str, Any]) -> tuple[int, int, int]:
        name, backend = item
        kind = KIND_ORDER.index(backend.kind) if backend.kind in KIND_ORDER else len(KIND_ORDER)
        return (kind, 0 if catalog.default_engine(backend.kind) == name else 1, 0)

    return [engine_info(name, backend) for name, backend in sorted(engines.items(), key=order)]


def _editing_engine(kind: str) -> str | None:
    """The first engine of this kind that can start from a clip, ready ones first."""
    candidates = [
        (name, backend) for name, backend in sorted(audio_backends(kind).items())
        if getattr(backend, "supports_editing", False)
    ]
    for name, backend in candidates:
        if backend.available() and _downloaded(name):
            return name
    return candidates[0][0] if candidates else None


def _resolve_engine(request: AudioGenerateRequest):
    """(engine name, engine, catalog entry the job loads) for a request, or a refusal."""
    chosen = catalog.get(request.model_id) if request.model_id else None
    if request.model_id and chosen is None:
        raise GenerationError(f"unknown model {request.model_id!r}")
    # A model names its engine; an engine named as well has to be that one.
    if chosen is not None and request.engine and request.engine != chosen.engine:
        raise GenerationError(
            f"{chosen.title} belongs to {chosen.engine!r}, not {request.engine!r}"
        )
    name = (chosen.engine if chosen else None) or request.engine or (
        _editing_engine(request.kind) if request.edit else None
    ) or catalog.default_engine(request.kind)
    if not name:
        raise GenerationError(f"there is no {request.kind} engine")
    everything = audio_backends()
    backend = everything.get(name)
    if backend is None:
        known = ", ".join(sorted(audio_backends(request.kind))) or "none"
        raise GenerationError(f"unknown engine {name!r}; {request.kind} engines: {known}")
    if backend.kind != request.kind:
        raise GenerationError(
            f"{getattr(backend, 'label', name)} makes {backend.kind}, not {request.kind}"
        )
    # An engine that can't sing must say so now, not return an instrumental the
    # user asked a lyric for.
    if request.lyrics and not getattr(backend, "supports_lyrics", True):
        raise GenerationError(
            f"{getattr(backend, 'label', name)} can't sing lyrics. Pick another engine "
            "for vocals, or ask for an instrumental."
        )
    if request.edit and not getattr(backend, "supports_editing", False):
        better = _editing_engine(request.kind)
        label = getattr(audio_backends().get(better), "label", better) if better else None
        raise GenerationError(
            f"{getattr(backend, 'label', name)} can't start from an existing clip."
            + (f" Pick {label} for variations, extensions and replacing a part." if label else "")
        )
    return name, backend, chosen or _active_spec(name)


def _check_ready(
    name: str, backend, duration_seconds: float, spec: catalog.ModelSpec | None = None
) -> None:
    """Refuse a job the engine couldn't run, judged for `spec` (the active model if None)."""
    label = getattr(backend, "label", name)
    if not backend.available():
        raise EngineNotReady(f"{label} is not installed. Install it from the Models page.")
    if spec is None:
        downloaded, reason = _downloaded(name), None
    else:
        downloaded = _spec_downloaded(name, spec)
        reason = model_service.unavailable_reason(spec)
    if not downloaded:
        what = (spec or _active_spec(name))
        raise EngineNotReady(
            f"{what.title if what else 'its model'} is not downloaded yet. "
            "Get it from the Models page."
        )
    if reason:
        raise EngineNotReady(f"{spec.title} can't run on this machine. {reason}")
    # `support()` answers for the active checkpoint, so ask it for this one.
    with catalog.assume_model(spec.id if spec else None):
        support = _support(backend)
    if not support.ok:
        raise EngineNotReady(support.reason or f"{label} can't run on this machine.")
    limit = support.max_duration_seconds
    if limit is not None and duration_seconds > limit:
        raise GenerationError(
            f"{label} can make clips of at most {limit:.0f} seconds on this machine "
            f"(you asked for {duration_seconds:g}). Ask for a shorter one."
        )


# An extension must add at least this much, or there is nothing to generate.
MIN_EXTENSION_SECONDS = 1.0


def _source(session: Session, edit: AudioEdit) -> tuple[str, float]:
    """The file an edit starts from and its length, or a refusal saying what is wrong."""
    if edit.generation_id:
        row = session.get(Generation, edit.generation_id)
        if row is None:
            raise GenerationError("the clip to start from no longer exists")
        if row.status != GenerationStatus.completed.value or not row.audio_path:
            raise GenerationError("the clip to start from has no finished audio yet")
        path = Path(row.audio_path)
    else:
        asset = session.get(EditAsset, edit.asset_id or "")
        if asset is None:
            raise GenerationError("the clip to start from no longer exists")
        path = Path(asset.path)
    if not path.exists():
        raise GenerationError(f"the clip to start from is missing from disk ({path.name})")
    seconds = audio.probe_duration(path)
    if not seconds or seconds <= 0:
        raise GenerationError(f"could not read the length of {path.name}")
    return str(path), float(seconds)


def _edit_plan(session: Session, request: AudioGenerateRequest) -> tuple[float, dict[str, Any]]:
    """(result length, `AudioSpec` fields) for an edit; (asked length, {}) otherwise."""
    edit = request.edit
    if edit is None:
        return request.duration_seconds, {}
    path, source_seconds = _source(session, edit)
    fields: dict[str, Any] = {"edit": edit.mode, "source_path": path}
    if edit.mode == "variation":
        fields["strength"] = edit.strength
        return source_seconds, fields
    if edit.mode == "replace":
        start, end = edit.start_seconds or 0.0, min(edit.end_seconds or 0.0, source_seconds)
        if start >= source_seconds or end <= start:
            raise GenerationError(
                f"the part to replace ({edit.start_seconds:g}-{edit.end_seconds:g} s) is "
                f"outside the clip, which is {source_seconds:.1f} s long"
            )
        fields["region"] = (start, end)
        return source_seconds, fields
    # extend: the request's length is the result's length
    if request.duration_seconds < source_seconds + MIN_EXTENSION_SECONDS:
        raise GenerationError(
            f"the clip is already {source_seconds:.1f} s long; ask for a result at least "
            f"{MIN_EXTENSION_SECONDS:g} s longer than that"
        )
    return request.duration_seconds, fields


def _slug(prompt: str, kind: str) -> str:
    return slugify(" ".join(prompt.split()[:SLUG_WORDS]).lower(), kind)


def enqueue(session: Session, request: AudioGenerateRequest) -> list[Generation]:
    """Queue `request.takes` jobs (one for music) and return their `queued` rows."""
    name, backend, model = _resolve_engine(request)
    duration, edit_fields = _edit_plan(session, request)
    _check_ready(name, backend, duration, model)

    rows: list[tuple[Generation, AudioSpec]] = []
    for take in range(request.takes):
        # A fixed seed with several takes would give the same clip N times, so
        # each take offsets it; the seed actually used is what the row records.
        seed = None if request.seed is None else (request.seed + take) % (2**31)
        params: dict[str, Any] = {"duration_seconds": duration}
        if model is not None:
            params["model"] = model.id     # which checkpoint made it, for the lists
        if request.edit:
            params["edit"] = request.edit.mode
            params["source"] = request.edit.generation_id or request.edit.asset_id
            if request.edit.mode == "variation":
                params["strength"] = request.edit.strength
            elif request.edit.mode == "replace":
                params["region"] = list(edit_fields["region"])
        for key, value in (
            ("lyrics", request.lyrics),
            ("seed", seed),
            ("steps", request.steps),
            ("guidance", request.guidance),
        ):
            if value is not None:
                params[key] = value
        if request.takes > 1:
            params["take"], params["takes"] = take + 1, request.takes

        generation = Generation(
            profile_id=None,
            kind=request.kind,
            engine=name,
            params=json.dumps(params),
            text=request.prompt,
            status=GenerationStatus.queued.value,
        )
        session.add(generation)
        session.commit()
        session.refresh(generation)
        spec = AudioSpec(
            prompt=request.prompt,
            duration_seconds=duration,
            lyrics=request.lyrics,
            seed=seed,
            steps=request.steps,
            guidance=request.guidance,
            **edit_fields,
        )
        rows.append((generation, spec))

    stem = _slug(request.prompt, request.kind)
    for generation, spec in rows:
        out_path = unique_path(
            config.GENERATIONS_DIR, f"{stem}-{generation.id[:8]}", f".{request.output_format}"
        )
        generation_service.submit(
            generation_service.run_audio_job, generation.id, name, spec, out_path,
            model.id if model else None,
        )
    return [generation for generation, _ in rows]
