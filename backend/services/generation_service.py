"""TTS generation: queueing, execution, and status persistence (FR4–FR6).

Jobs run on a single background worker thread so two GPU generations never
contend for VRAM. Status transitions are written to SQLite as they happen, so
history — including failures — survives an app restart (FR5).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

import catalog
import config
from backends import (
    AudioSpec,
    VoiceSpec,
    all_backends,
    get_backend,
    unload_all,
    unload_except,
)
from database.models import Generation, Profile
from database.session import session_scope
from models import GenerateRequest, GenerationStatus
from services import model_service
from utils import audio
from utils.paths import slugify, unique_path

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")

# --------------------------------------------------------------------------
# GPU scheduling
# --------------------------------------------------------------------------
#
# One job runs at a time, and a job only ever needs one engine, so:
#   * before a job, every *other* loaded engine is unloaded — Qwen3-TTS and
#     Kitten (and later the music / SFX models) must not share 6 GB of VRAM;
#   * once nothing has run for IDLE_UNLOAD_SECONDS, the loaded engine is
#     unloaded too, so an open-but-idle app doesn't hold the GPU. 0 disables it.

# `VOICECRAFT_IDLE_UNLOAD_SECONDS` wins when set (0 disables); otherwise the
# "idle_unload_minutes" preference from Settings decides, and is read each time so
# a change applies without a restart.
_IDLE_ENV = os.environ.get("VOICECRAFT_IDLE_UNLOAD_SECONDS")
IDLE_UNLOAD_SECONDS: float | None = float(_IDLE_ENV) if _IDLE_ENV not in (None, "") else None
DEFAULT_IDLE_MINUTES = 10


def idle_seconds() -> float:
    """How long the worker may sit idle before models are unloaded (0 = never)."""
    if IDLE_UNLOAD_SECONDS is not None:
        return IDLE_UNLOAD_SECONDS
    try:
        minutes = float(
            (config.load_settings().get("preferences") or {}).get(
                "idle_unload_minutes", DEFAULT_IDLE_MINUTES
            )
        )
    except (TypeError, ValueError):
        minutes = DEFAULT_IDLE_MINUTES
    return max(minutes, 0.0) * 60

_state_lock = threading.Lock()
_pending = 0                       # jobs submitted and not yet finished
_last_activity = time.monotonic()
_watcher_stop = threading.Event()
_watcher: threading.Thread | None = None


def release_other_engines(engine: str) -> None:
    """Unload every loaded engine except `engine` (call at the start of a job)."""
    dropped = unload_except(engine)
    if dropped:
        log.info("unloaded %s to make room for %s", ", ".join(dropped), engine)


_worker_flag = threading.local()


def on_worker() -> bool:
    """True when called from the job worker (between or inside jobs)."""
    return getattr(_worker_flag, "active", False)


def run_on_worker(fn, *args) -> None:
    """Run `fn` on the worker: now if this *is* the worker, else after the queued jobs.

    For things that must not happen under a running job, such as unloading the
    engine it is using when the Models page picks or deletes a model.
    """
    if on_worker():
        fn(*args)
    else:
        submit(fn, *args)


def _tracked(fn, args) -> None:
    global _pending, _last_activity
    _worker_flag.active = True
    try:
        fn(*args)
    finally:
        with _state_lock:
            _pending -= 1
            _last_activity = time.monotonic()


def _idle_check() -> bool:
    """Unload everything if the worker has been idle long enough. True if it did."""
    # The lock is held across the unload: `submit` takes it to count a new job,
    # so a job can't be queued while the models it needs are being torn down.
    limit = idle_seconds()
    if limit <= 0:
        return False
    with _state_lock:
        if _pending or time.monotonic() - _last_activity < limit:
            return False
        if not any(backend.is_loaded() for backend in all_backends().values()):
            return False
        log.info("idle for %.0fs — unloading models", limit)
        unload_all()
        return True


def _watch_interval() -> float:
    """How long the watcher sleeps between checks.

    With idle unload switched off (0) there is nothing to time, so it only looks
    every 30 s in case Settings turns it back on, instead of reading the settings
    file twice a second.
    """
    limit = idle_seconds()
    if limit <= 0:
        return 30.0
    return min(30.0, max(0.5, limit / 4))


def _watch_idle() -> None:
    while not _watcher_stop.wait(_watch_interval()):
        try:
            _idle_check()
        except Exception:  # noqa: BLE001 - the watcher must outlive a bad unload
            log.warning("idle unload failed", exc_info=True)


def _ensure_watcher() -> None:
    global _watcher
    if idle_seconds() <= 0 or (_watcher and _watcher.is_alive()):
        return
    _watcher_stop.clear()
    _watcher = threading.Thread(target=_watch_idle, name="idle-unload", daemon=True)
    _watcher.start()


def submit(fn, *args) -> None:
    """Queue GPU work on the one worker thread.

    Voice preparation shares this queue with generation: both load the same
    model, and running them concurrently would fight over VRAM. FIFO also
    means a generation submitted right after a profile is created waits for
    that profile's voice print, which is exactly the order the user wants.
    """
    global _pending
    with _state_lock:
        _pending += 1
    _ensure_watcher()
    _executor.submit(_tracked, fn, args)


class GenerationError(ValueError):
    """The request is wrong (HTTP 400)."""


class EngineNotReady(GenerationError):
    """The request is fine, but the engine can't take it yet (HTTP 409):
    not installed, weights missing, or not runnable on this hardware."""


def list_generations(
    session: Session, limit: int = 100, kind: str | None = None
) -> list[Generation]:
    query = select(Generation).order_by(Generation.created_at.desc())
    if kind:
        query = query.where(Generation.kind == kind)
    return list(session.scalars(query.limit(limit)).all())


def get_generation(session: Session, generation_id: str) -> Generation | None:
    return session.get(Generation, generation_id)


def set_favorite(
    session: Session, generation_id: str, favorite: bool
) -> Generation | None:
    generation = session.get(Generation, generation_id)
    if generation is None:
        return None
    generation.favorite = favorite
    session.commit()
    return generation


def reset_stale_jobs() -> int:
    """Fail any job left mid-flight by a crash or a hard app close.

    Without this, a killed process leaves rows stuck in `processing` forever
    (PRD §8, reliability).
    """
    with session_scope() as session:
        result = session.execute(
            update(Generation)
            .where(Generation.status.in_(["queued", "processing"]))
            .values(
                status=GenerationStatus.failed.value,
                error="Interrupted — the app closed while this generation was running.",
                completed_at=dt.datetime.now(dt.timezone.utc),
            )
        )
        count = result.rowcount or 0
    if count:
        log.warning("marked %d interrupted generation(s) as failed", count)
    return count


def enqueue(session: Session, request: GenerateRequest) -> Generation:
    profile = session.get(Profile, request.profile_id)
    if profile is None:
        raise GenerationError("profile not found")

    # Options only some engines understand live in `params`, so the column set
    # never changes when an engine gains a knob. Today that is KittenTTS 2.
    options: dict = {}
    if profile.engine == "kitten":
        if request.preset:
            options["preset"] = request.preset
        if request.seed is not None:
            options["seed"] = request.seed

    # Which checkpoint makes it: the one asked for, else the engine's active one.
    model = None
    if request.model_id:
        model = catalog.get(request.model_id)
        if model is None:
            raise GenerationError(f"unknown model {request.model_id!r}")
        if model.engine != profile.engine:
            raise GenerationError(
                f"{model.title} belongs to {model.engine!r}, but this voice uses "
                f"{profile.engine!r}"
            )
        if not model_service.spec_downloaded(model):
            raise EngineNotReady(
                f"{model.title} is not downloaded yet. Get it from the Models page."
            )
        reason = model_service.unavailable_reason(model)
        if reason:
            raise EngineNotReady(f"{model.title} can't run on this machine. {reason}")
    else:
        try:
            model = catalog.active_model(profile.engine)
        except KeyError:
            model = None
    # Recorded for the lists; it stays out of `VoiceSpec.options`, which is what the engine reads.
    recorded = {**options, **({"model": model.id} if model else {})}

    generation = Generation(
        profile_id=profile.id,
        kind="speech",
        engine=profile.engine,
        params=json.dumps(recorded) if recorded else None,
        text=request.text,
        status=GenerationStatus.queued.value,
    )
    session.add(generation)
    session.commit()
    session.refresh(generation)

    voice = VoiceSpec(
        language=profile.language,
        sample_path=profile.sample_path,
        sample_text=profile.sample_text,
        preset_voice=profile.preset_voice,
        speed=request.speed,
        voice_path=profile.voice_path,
        options=options,
    )
    out_path = unique_path(
        config.GENERATIONS_DIR,
        f"{slugify(profile.name, 'voice')}-{generation.id[:8]}",
        f".{request.output_format}",
    )
    submit(
        _run_job, generation.id, profile.engine, voice, out_path, request.text,
        request.model_id,
    )
    return generation


def _set_status(generation_id: str, **fields) -> None:
    with session_scope() as session:
        session.execute(
            update(Generation).where(Generation.id == generation_id).values(**fields)
        )


def _run_job(
    generation_id: str,
    engine: str,
    voice: VoiceSpec,
    out_path: Path,
    text: str,
    model_id: str | None = None,
) -> None:
    _execute(
        generation_id, engine, out_path,
        lambda backend, raw_path: backend.synthesize(text, voice, raw_path),
        model_id,
    )


def run_audio_job(
    generation_id: str, engine: str, spec: AudioSpec, out_path: Path,
    model_id: str | None = None,
) -> None:
    """A music / SFX job: same queue, same status writes, a different engine call."""
    _execute(
        generation_id, engine, out_path,
        lambda backend, raw_path: backend.generate(spec, raw_path),
        model_id,
    )


def _use_model(model_id: str | None) -> None:
    """Make `model_id` the checkpoint its engine loads, if it isn't already.

    Runs on the worker between jobs, so no other job is using the engine: the
    unload that `select` does can't pull weights out from under a running one.
    Making the choice the saved one (instead of a per-job override) keeps the
    Models page and the Generate page agreeing on what is active.
    """
    spec = catalog.get(model_id) if model_id else None
    if spec is not None and not catalog.is_active(spec):
        model_service.select(spec.id)


def _execute(
    generation_id: str, engine: str, out_path: Path, produce, model_id: str | None = None
) -> None:
    """Run one job on the worker: `produce(backend, wav_path)` makes the audio.

    Everything around the engine call — the unload-before-job rule, the status
    transitions, the ffmpeg transcode and the failure record — is the same for
    speech and for music / SFX, so it lives here once.
    """
    _set_status(generation_id, status=GenerationStatus.processing.value)
    release_other_engines(engine)
    # The engines only write WAV, so a request for anything else synthesizes to
    # a WAV beside the target and hands it to ffmpeg. The intermediate is
    # deleted, so the user is left with exactly the file they asked for.
    wanted = out_path.suffix.lower().lstrip(".")
    raw_path = out_path if wanted == "wav" else out_path.with_suffix(".raw.wav")
    try:
        _use_model(model_id)
        backend = get_backend(engine)
        result = produce(backend, raw_path)
        final = Path(result.path)
        if wanted != "wav":
            audio.convert(final, out_path)
            final.unlink(missing_ok=True)
            final = out_path
        duration = result.duration_seconds or audio.probe_duration(final)
        _set_status(
            generation_id,
            status=GenerationStatus.completed.value,
            audio_path=str(final),
            duration_seconds=duration,
            device=result.device,
            warning=result.warning,
            error=None,
            completed_at=dt.datetime.now(dt.timezone.utc),
        )
        log.info("generation %s completed (%s)", generation_id, engine)
    except Exception as exc:  # noqa: BLE001 - the failure must be recorded, not raised
        log.exception("generation %s failed", generation_id)
        Path(out_path).unlink(missing_ok=True)
        Path(raw_path).unlink(missing_ok=True)
        _set_status(
            generation_id,
            status=GenerationStatus.failed.value,
            error=f"{type(exc).__name__}: {exc}",
            completed_at=dt.datetime.now(dt.timezone.utc),
        )


def delete_generation(session: Session, generation_id: str) -> bool:
    generation = session.get(Generation, generation_id)
    if generation is None:
        return False
    if generation.audio_path:
        Path(generation.audio_path).unlink(missing_ok=True)
    session.delete(generation)
    session.commit()
    return True


def shutdown() -> None:
    _watcher_stop.set()
    _executor.shutdown(wait=False, cancel_futures=True)
