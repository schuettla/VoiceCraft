"""Voice preparation — the cloning step that Profiles used to be missing.

Creating a profile used to write a row and copy a file, and nothing else
happened until the first generation. That made "clone a voice" invisible and
pushed every failure (unreadable clip, missing model, no VRAM) into the middle
of the user's first script.

Preparing a voice runs the reference clip through the model's speaker encoder
and speech tokenizer once, and writes the result — the voice print — to
`voices/<profile id>.vprint`. From then on generation reuses it, the profile
has a real "ready" state, and problems surface next to the sample that caused
them.

Preset-voice engines (Kokoro) have nothing to extract; their profiles are
marked `not_needed`.
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

import catalog
import config
from backends import VoiceSpec, get_backend
from database.models import Profile
from database.session import session_scope
from models import VoiceStatus
from services import model_service
from services.generation_service import submit

log = logging.getLogger(__name__)

NO_WEIGHTS = (
    "Waiting for this engine's model to be downloaded — start it on the "
    "Models tab, and cloning runs by itself when it finishes."
)

# Short, phonetically varied, and language-neutral enough to judge a clone by.
PREVIEW_TEXT = (
    "This is how my cloned voice sounds. "
    "If it sounds like me, the profile is ready to use."
)


def voice_print_path(profile: Profile) -> Path:
    return config.VOICES_DIR / f"{profile.id}.vprint"


def _set(profile_id: str, **fields) -> None:
    with session_scope() as session:
        session.execute(
            update(Profile).where(Profile.id == profile_id).values(**fields)
        )


def _can_run(engine: str) -> tuple[bool, str | None]:
    """Whether cloning can start now, and why not if it can't.

    Weights matter as much as the package: extracting a voice print loads the
    checkpoint, and doing that for a model that isn't downloaded would turn
    "create a profile" into a silent multi-gigabyte download. Downloads belong
    to the Models page, so we wait for it instead.
    """
    backend = get_backend(engine)
    if not backend.available():
        return False, "This engine is not installed — run Setup from the header."
    if not config.AUTO_PREPARE_VOICES:
        return False, None
    try:
        repo_id = catalog.active_repo_id(engine)
    except KeyError:
        return True, None
    if not model_service.is_downloaded(repo_id):
        return False, NO_WEIGHTS
    return True, None


def needs_preparation(profile: Profile) -> bool:
    """True when this profile is a clone whose voice print isn't usable."""
    if not get_backend(profile.engine).supports_cloning:
        return False
    if profile.voice_status != VoiceStatus.ready.value:
        return True
    return not (profile.voice_path and Path(profile.voice_path).is_file())


def enqueue(session: Session, profile: Profile) -> Profile:
    """Queue extraction for `profile` and return it marked as pending."""
    backend = get_backend(profile.engine)
    if not backend.supports_cloning:
        profile.voice_status = VoiceStatus.not_needed.value
        profile.voice_error = None
        session.commit()
        session.refresh(profile)
        return profile

    can_run, reason = _can_run(profile.engine)
    profile.voice_status = VoiceStatus.pending.value
    profile.voice_error = reason
    session.commit()
    session.refresh(profile)

    if can_run:
        submit(_prepare_job, profile.id)
    else:
        log.info("holding voice prep for %s: %s", profile.id, reason or "disabled")
    return profile


def reset_stale() -> int:
    """Clear `preparing` rows left behind by a crash, so they can be retried."""
    with session_scope() as session:
        result = session.execute(
            update(Profile)
            .where(Profile.voice_status == VoiceStatus.preparing.value)
            .values(
                voice_status=VoiceStatus.pending.value,
                voice_error="Interrupted — the app closed while preparing this voice.",
            )
        )
        return result.rowcount or 0


def resume_pending() -> int:
    """Re-queue every profile whose voice print is missing or unfinished.

    Runs at startup: a voice print can go missing because preparation failed
    while the engine was still installing, because the app was closed
    mid-extraction, or because the user switched models. None of those should
    need a manual click to recover from.
    """
    queued = 0
    with session_scope() as session:
        for profile in session.scalars(select(Profile)).all():
            backend = get_backend(profile.engine)
            if not backend.supports_cloning:
                if profile.voice_status != VoiceStatus.not_needed.value:
                    profile.voice_status = VoiceStatus.not_needed.value
                continue
            # Don't hammer a voice that failed for a real reason (a corrupt
            # clip); the user retries those from the Profiles page.
            if profile.voice_status == VoiceStatus.failed.value:
                continue
            if not needs_preparation(profile):
                continue
            can_run, reason = _can_run(profile.engine)
            profile.voice_status = VoiceStatus.pending.value
            profile.voice_error = reason
            if can_run:
                submit(_prepare_job, profile.id)
                queued += 1
    if queued:
        log.info("queued %d voice print(s) for preparation", queued)
    return queued


def _prepare_job(profile_id: str) -> None:
    with session_scope() as session:
        profile = session.get(Profile, profile_id)
        if profile is None:
            return
        engine = profile.engine
        out_path = voice_print_path(profile)
        voice = VoiceSpec(
            language=profile.language,
            sample_path=profile.sample_path,
            sample_text=profile.sample_text,
            preset_voice=profile.preset_voice,
        )

    _set(profile_id, voice_status=VoiceStatus.preparing.value)
    try:
        result = get_backend(engine).prepare_voice(voice, out_path)
        _set(
            profile_id,
            voice_status=VoiceStatus.ready.value,
            voice_path=str(result.path),
            voice_mode=result.mode,
            voice_model_id=result.model_id,
            voice_error=None,
            voice_prepared_at=dt.datetime.now(dt.timezone.utc),
        )
        log.info(
            "voice print ready for %s (%s, %.1fs sample)",
            profile_id,
            result.mode,
            result.sample_seconds or 0.0,
        )
    except Exception as exc:  # noqa: BLE001 - the failure belongs in the UI
        log.exception("voice preparation failed for %s", profile_id)
        Path(out_path).unlink(missing_ok=True)
        _set(
            profile_id,
            voice_status=VoiceStatus.failed.value,
            voice_path=None,
            voice_error=f"{type(exc).__name__}: {exc}",
        )


def discard(profile: Profile) -> None:
    """Delete a profile's voice print from disk (called when it is deleted)."""
    if profile.voice_path:
        Path(profile.voice_path).unlink(missing_ok=True)
    voice_print_path(profile).unlink(missing_ok=True)
