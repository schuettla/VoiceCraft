"""/api/models — download, remove, and choose model weights (FR14)."""

from __future__ import annotations

import subprocess
import sys

from fastapi import APIRouter, HTTPException

import config
from models import ModelsOut, StorageRequest
from services import model_service
from services.model_service import ModelError

router = APIRouter(prefix="/api/models", tags=["models"])


@router.get("", response_model=ModelsOut)
def list_models() -> ModelsOut:
    """Catalog, per-model state, and storage usage — one poll drives the page."""
    return ModelsOut(**model_service.overview())


@router.post("/{model_id}/download", response_model=ModelsOut, status_code=202)
def download(model_id: str) -> ModelsOut:
    try:
        model_service.start_download(model_id)
    except ModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModelsOut(**model_service.overview())


@router.post("/{model_id}/cancel", response_model=ModelsOut)
def cancel(model_id: str) -> ModelsOut:
    if not model_service.cancel_download(model_id):
        raise HTTPException(status_code=404, detail="no download is running")
    return ModelsOut(**model_service.overview())


@router.post("/{model_id}/select", response_model=ModelsOut)
def select(model_id: str) -> ModelsOut:
    try:
        model_service.select(model_id)
    except ModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModelsOut(**model_service.overview())


@router.delete("/{model_id}", response_model=ModelsOut)
def delete(model_id: str) -> ModelsOut:
    try:
        model_service.delete(model_id)
    except ModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModelsOut(**model_service.overview())


@router.post("/storage", response_model=ModelsOut)
def set_storage(request: StorageRequest) -> ModelsOut:
    """Point the app at a different hub cache, or reset to the HF default."""
    try:
        if request.path.strip():
            model_service.set_models_dir(request.path.strip())
        else:
            model_service.reset_models_dir()
    except ModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModelsOut(**model_service.overview())


@router.post("/storage/open", status_code=204, response_model=None)
def open_storage() -> None:
    """Show the model folder in the file manager.

    No path comes from the client here — it is always the configured cache
    directory — so there is nothing to validate against an escape.
    """
    directory = config.models_dir()
    directory.mkdir(parents=True, exist_ok=True)
    opener = {"win32": ["explorer"], "darwin": ["open"]}.get(sys.platform, ["xdg-open"])
    subprocess.Popen([*opener, str(directory)])
