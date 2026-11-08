"""/api/profiles — voice profile CRUD (FR1–FR3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from backends import kitten_backend
from backends.kokoro_backend import PRESET_VOICES
from database.session import get_session
from models import Engine, GenerateRequest, GenerationOut, ProfileCreate, ProfileOut
from services import generation_service, profile_service, voice_service
from services.profile_service import ProfileError

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


@router.get("/voices", response_model=list[str])
def preset_voices(engine: Engine = Engine.kokoro) -> list[str]:
    """Preset voice ids an engine offers for preset profiles.

    Kokoro cannot clone, so every Kokoro profile is a preset (the default, so
    older clients keep working). KittenTTS 2 lists the voices of the downloaded
    model, or its bundled list before the weights are there. Qwen3-TTS has
    none: it only clones.
    """
    if engine == Engine.kitten:
        return kitten_backend.preset_voices()
    if engine == Engine.kokoro:
        return list(PRESET_VOICES)
    return []


@router.get("", response_model=list[ProfileOut])
def list_profiles(session: Session = Depends(get_session)) -> list[ProfileOut]:
    return profile_service.list_profiles(session)


@router.get("/{profile_id}", response_model=ProfileOut)
def get_profile(profile_id: str, session: Session = Depends(get_session)) -> ProfileOut:
    profile = profile_service.get_profile(session, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return profile


@router.post("", response_model=ProfileOut, status_code=201)
async def create_profile(
    name: str = Form(...),
    engine: Engine = Form(...),
    language: str = Form("en"),
    preset_voice: str | None = Form(None),
    sample_text: str | None = Form(None),
    sample: UploadFile | None = File(None),
    session: Session = Depends(get_session),
) -> ProfileOut:
    """Multipart because a cloned profile carries its reference clip inline."""
    payload = await sample.read() if sample is not None else None
    try:
        return profile_service.create_profile(
            session,
            ProfileCreate(
                name=name,
                engine=engine,
                language=language,
                preset_voice=preset_voice or None,
                sample_text=sample_text or None,
            ),
            sample_filename=sample.filename if sample else None,
            sample_bytes=payload or None,
        )
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{profile_id}/prepare", response_model=ProfileOut)
def prepare_voice(
    profile_id: str, session: Session = Depends(get_session)
) -> ProfileOut:
    """Re-run the cloning step — extract the voice print from the sample again."""
    profile = profile_service.prepare_voice(session, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return profile


@router.post("/{profile_id}/preview", response_model=GenerationOut, status_code=201)
def preview_voice(
    profile_id: str, session: Session = Depends(get_session)
) -> GenerationOut:
    """Speak a fixed sentence in this voice, so the clone can be judged here.

    It is an ordinary generation, so it lands in the history and can be
    trimmed or assembled like anything else.
    """
    profile = profile_service.get_profile(session, profile_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="profile not found")
    return generation_service.enqueue(
        session,
        GenerateRequest(profile_id=profile_id, text=voice_service.PREVIEW_TEXT),
    )


@router.delete("/{profile_id}", status_code=204, response_model=None)
def delete_profile(profile_id: str, session: Session = Depends(get_session)) -> None:
    if not profile_service.delete_profile(session, profile_id):
        raise HTTPException(status_code=404, detail="profile not found")
