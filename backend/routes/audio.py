"""/api/audio-engines — which music and SFX engines exist and what they can do here."""

from __future__ import annotations

from fastapi import APIRouter

from models import AudioEngineOut
from services import audio_service

router = APIRouter(prefix="/api/audio-engines", tags=["audio"])


@router.get("", response_model=list[AudioEngineOut])
def list_audio_engines() -> list[AudioEngineOut]:
    """Per engine: installed, supported (and why not), license tier, gated, default.

    The Generate view uses it to pick between the form and the install card;
    the Models page uses it for the "Install engine" step.
    """
    return audio_service.overview()
