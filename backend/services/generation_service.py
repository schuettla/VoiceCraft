"""TTS generation: queueing, execution, and status persistence (FR4–FR6).

Jobs run on a single background worker thread so two GPU generations never
contend for VRAM. Status transitions are written to SQLite as they happen, so
history — including failures — survives an app restart (FR5).
"""

from __future__ import annotations

import datetime as dt
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

import config
from backends import VoiceSpec, get_backend
from database.models import Generation, Profile
from database.session import session_scope
from models import GenerateRequest, GenerationStatus
from utils import audio
from utils.paths import slugify, unique_path

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")


def submit(fn, *args) -> None:
    """Queue GPU work on the one worker thread.

    Voice preparation shares this queue with generation: both load the same
    model, and running them concurrently would fight over VRAM. FIFO also
    means a generation submitted right after a profile is created waits for
    that profile's voice print, which is exactly the order the user wants.
    """
    _executor.submit(fn, *args)


class GenerationError(ValueError):
    pass


def list_generations(session: Session, limit: int = 100) -> list[Generation]:
    return list(
        session.scalars(
            select(Generation).order_by(Generation.created_at.desc()).limit(limit)
        ).all()
    )


def get_generation(session: Session, generation_id: str) -> Generation | None:
    return session.get(Generation, generation_id)


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

    generation = Generation(
        profile_id=profile.id,
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
    )
    out_path = unique_path(
        config.GENERATIONS_DIR,
        f"{slugify(profile.name, 'voice')}-{generation.id[:8]}",
        f".{request.output_format}",
    )
    submit(_run_job, generation.id, profile.engine, voice, out_path, request.text)
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
) -> None:
    _set_status(generation_id, status=GenerationStatus.processing.value)
    # The engines only write WAV, so a request for anything else synthesizes to
    # a WAV beside the target and hands it to ffmpeg. The intermediate is
    # deleted, so the user is left with exactly the file they asked for.
    wanted = out_path.suffix.lower().lstrip(".")
    raw_path = out_path if wanted == "wav" else out_path.with_suffix(".raw.wav")
    try:
        backend = get_backend(engine)
        result = backend.synthesize(text, voice, raw_path)
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
    _executor.shutdown(wait=False, cancel_futures=True)
