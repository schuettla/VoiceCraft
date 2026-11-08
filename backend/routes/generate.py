"""/api/generations — submit text, poll status, list history (FR4–FR6)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database.session import get_session
from models import (
    AudioGenerateRequest,
    GenerateRequest,
    GenerationKind,
    GenerationOut,
    GenerationUpdate,
)
from services import audio_service, generation_service
from services.generation_service import EngineNotReady, GenerationError

router = APIRouter(prefix="/api/generations", tags=["generations"])

LIST_MAX = 100_000


@router.get("", response_model=list[GenerationOut])
def list_generations(
    # High enough for the Library to load a whole history; rows are small.
    limit: int = Query(default=100, ge=1, le=LIST_MAX),
    kind: GenerationKind | None = Query(default=None),
    session: Session = Depends(get_session),
) -> list[GenerationOut]:
    """Newest first. `?kind=speech|music|sfx` narrows it to one type."""
    return generation_service.list_generations(session, limit=limit, kind=kind)


@router.post("/audio", response_model=list[GenerationOut], status_code=202)
def create_audio_generation(
    request: AudioGenerateRequest, session: Session = Depends(get_session)
) -> list[GenerationOut]:
    """Queue a music or sound-effect job.

    Returns the `queued` rows — one, or `takes` of them for sound effects — for
    the client to poll. 400 means the request is wrong, 409 that the engine
    isn't ready (not installed, no weights, unsupported hardware).
    """
    try:
        return audio_service.enqueue(session, request)
    except EngineNotReady as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except GenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("", response_model=GenerationOut, status_code=202)
def create_generation(
    request: GenerateRequest, session: Session = Depends(get_session)
) -> GenerationOut:
    """Returns immediately with a `queued` row; the client polls for status."""
    try:
        return generation_service.enqueue(session, request)
    except EngineNotReady as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except GenerationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{generation_id}", response_model=GenerationOut)
def get_generation(
    generation_id: str, session: Session = Depends(get_session)
) -> GenerationOut:
    generation = generation_service.get_generation(session, generation_id)
    if generation is None:
        raise HTTPException(status_code=404, detail="generation not found")
    return generation


@router.patch("/{generation_id}", response_model=GenerationOut)
def update_generation(
    generation_id: str,
    update: GenerationUpdate,
    session: Session = Depends(get_session),
) -> GenerationOut:
    generation = generation_service.set_favorite(session, generation_id, update.favorite)
    if generation is None:
        raise HTTPException(status_code=404, detail="generation not found")
    return generation


@router.delete("/{generation_id}", status_code=204, response_model=None)
def delete_generation(
    generation_id: str, session: Session = Depends(get_session)
) -> None:
    if not generation_service.delete_generation(session, generation_id):
        raise HTTPException(status_code=404, detail="generation not found")
