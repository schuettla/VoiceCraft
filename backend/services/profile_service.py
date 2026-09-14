"""Voice profile CRUD (FR1–FR3)."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

import config
from backends.kokoro_backend import PRESET_VOICES
from database.models import Profile
from models import Engine, ProfileCreate, VoiceStatus
from services import voice_service
from utils import audio
from utils.paths import slugify, unique_path


class ProfileError(ValueError):
    """Invalid profile input — surfaced to the client as a 400."""


def list_profiles(session: Session) -> list[Profile]:
    return list(
        session.scalars(select(Profile).order_by(Profile.created_at.desc())).all()
    )


def get_profile(session: Session, profile_id: str) -> Profile | None:
    return session.get(Profile, profile_id)


def create_profile(
    session: Session,
    data: ProfileCreate,
    sample_filename: str | None = None,
    sample_bytes: bytes | None = None,
) -> Profile:
    """Create a profile, storing the reference sample if one was uploaded.

    Qwen clones from a sample; Kokoro selects a preset voice and rejects one
    (PRD §5). Enforcing that here keeps generation from failing later with a
    confusing error.
    """
    sample_path: Path | None = None

    if data.engine == Engine.qwen:
        if not sample_bytes:
            raise ProfileError(
                "Qwen3-TTS profiles need a reference audio sample (10–30s works well)."
            )
        stem = slugify(data.name, "voice")
        suffix = Path(sample_filename or "sample.wav").suffix.lower() or ".wav"
        sample_path = unique_path(config.SAMPLES_DIR, stem, suffix)
        sample_path.write_bytes(sample_bytes)

        duration = audio.probe_duration(sample_path)
        if duration is None:
            sample_path.unlink(missing_ok=True)
            raise ProfileError(
                "That file could not be read as audio. Use WAV, MP3, FLAC, or OGG."
            )
    else:
        if sample_bytes:
            raise ProfileError(
                "Kokoro cannot clone a voice. Choose one of its preset voices instead."
            )
        if not data.preset_voice:
            raise ProfileError("Kokoro profiles need a preset voice id.")
        if data.preset_voice not in PRESET_VOICES:
            raise ProfileError(f"unknown Kokoro voice: {data.preset_voice}")

    profile = Profile(
        name=data.name.strip(),
        engine=data.engine.value,
        language=data.language or "en",
        sample_path=str(sample_path) if sample_path else None,
        sample_text=(data.sample_text or None) if data.engine == Engine.qwen else None,
        preset_voice=data.preset_voice if data.engine == Engine.kokoro else None,
        voice_status=(
            VoiceStatus.pending.value
            if data.engine == Engine.qwen
            else VoiceStatus.not_needed.value
        ),
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)

    # Clone now rather than at first generation: the voice print is what makes
    # this a voice and not just a row, and errors belong next to the sample.
    return voice_service.enqueue(session, profile)


def delete_profile(session: Session, profile_id: str) -> bool:
    """Delete a profile and its reference sample.

    Past generations are kept — their `profile_id` is nulled by the FK rule —
    so deleting a voice never destroys audio the user may still be editing.
    """
    profile = session.get(Profile, profile_id)
    if profile is None:
        return False
    if profile.sample_path:
        Path(profile.sample_path).unlink(missing_ok=True)
    voice_service.discard(profile)
    session.delete(profile)
    session.commit()
    return True


def prepare_voice(session: Session, profile_id: str) -> Profile | None:
    """Re-run the cloning step for a profile (the Retry button)."""
    profile = session.get(Profile, profile_id)
    if profile is None:
        return None
    voice_service.discard(profile)
    profile.voice_path = None
    return voice_service.enqueue(session, profile)
