"""/api/settings — what the app is using, and the few knobs worth exposing.

Model downloads and their storage live on the Models page; this is everything
else: where files are kept, what hardware the engines found, the defaults new
work starts from, and the two maintenance actions (free VRAM, reclaim disk).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

import config
from backends import all_backends, unload_all
from database.models import EditAsset, Generation, Profile
from database.session import session_scope
from models import (
    CleanupResult,
    DirectoryInfo,
    Preferences,
    SettingsOut,
    ToolInfo,
)
from utils import audio

router = APIRouter(prefix="/api/settings", tags=["settings"])

log = logging.getLogger(__name__)

_DIRECTORIES = (
    ("samples", "Reference samples", config.SAMPLES_DIR),
    ("voices", "Voice prints", config.VOICES_DIR),
    ("generations", "Generated speech", config.GENERATIONS_DIR),
    ("assets", "Intro / outro / imported clips", config.ASSETS_DIR),
    ("edits", "Finished episodes", config.EDITS_DIR),
    ("tmp", "Temporary files", config.TMP_DIR),
    ("peaks", "Waveform cache", config.PEAKS_DIR),
)


def _measure(directory: Path) -> tuple[int, int]:
    """(file count, total bytes) — the directories are flat and small."""
    files = 0
    total = 0
    try:
        for entry in directory.iterdir():
            if entry.is_file():
                files += 1
                total += entry.stat().st_size
    except OSError:
        return 0, 0
    return files, total


def _gpu() -> dict:
    """Report the GPU the way the engines see it, without importing torch eagerly."""
    info: dict = {"torch": None, "cuda": False, "device_name": None, "detail": None}
    try:
        import torch  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001 - torch missing is a normal state here
        info["detail"] = f"PyTorch is not installed ({type(exc).__name__})."
        return info

    info["torch"] = torch.__version__
    if not torch.cuda.is_available():
        info["detail"] = (
            "No CUDA device. Generation falls back to the CPU, which is very slow "
            "for cloning — re-run Setup to install a CUDA build of PyTorch."
        )
        return info

    major, minor = torch.cuda.get_device_capability()
    free, total = torch.cuda.mem_get_info()
    info.update(
        cuda=True,
        device_name=torch.cuda.get_device_name(0),
        capability=f"{major}.{minor}",
        vram_free_bytes=free,
        vram_total_bytes=total,
        precision="bfloat16" if major >= 8 else "float32",
    )
    if major < 8:
        info["detail"] = (
            "This GPU predates bfloat16, so Qwen3-TTS runs in float32 — correct, "
            "but slower and heavier on VRAM."
        )
    return info


@router.get("", response_model=SettingsOut)
def get_settings() -> SettingsOut:
    directories = []
    for key, label, path in _DIRECTORIES:
        files, size = _measure(path)
        directories.append(
            DirectoryInfo(key=key, label=label, path=str(path), files=files, bytes=size)
        )

    usage = shutil.disk_usage(config.DATA_DIR) if config.DATA_DIR.exists() else None

    return SettingsOut(
        data_dir=str(config.DATA_DIR),
        db_path=str(config.DB_PATH),
        db_bytes=config.DB_PATH.stat().st_size if config.DB_PATH.exists() else 0,
        settings_path=str(config.SETTINGS_PATH),
        host=config.HOST,
        port=config.PORT,
        directories=directories,
        free_bytes=usage.free if usage else None,
        ffmpeg=ToolInfo(
            available=audio.ffmpeg_available(),
            ffmpeg_path=config.FFMPEG,
            ffprobe_path=config.FFPROBE,
        ),
        gpu=_gpu(),
        engines_loaded=[
            name for name, backend in all_backends().items() if backend.is_loaded()
        ],
        preferences=Preferences(**config.load_settings().get("preferences", {})),
    )


@router.put("/preferences", response_model=SettingsOut)
def set_preferences(preferences: Preferences) -> SettingsOut:
    """Defaults the Profiles / Generate / Edit pages start from."""
    config.save_settings({"preferences": preferences.model_dump()})
    return get_settings()


@router.post("/unload", response_model=SettingsOut)
def unload_models() -> SettingsOut:
    """Drop the loaded models to free VRAM. The next generation reloads them."""
    unload_all()
    return get_settings()


@router.post("/cleanup", response_model=CleanupResult)
def cleanup() -> CleanupResult:
    """Delete scratch files and audio no database row points at any more.

    Files still referenced by a generation, an asset, or a voice profile are
    never touched — this reclaims space, it does not delete work.
    """
    with session_scope() as session:
        referenced = {
            Path(value).resolve()
            for value in (
                *session.scalars(select(Generation.audio_path)).all(),
                *session.scalars(select(EditAsset.path)).all(),
                *session.scalars(select(Profile.sample_path)).all(),
                *session.scalars(select(Profile.voice_path)).all(),
            )
            if value
        }

    removed = 0
    freed = 0
    # tmp/ and peaks/ are pure scratch/cache — ffmpeg intermediates and
    # regenerable waveform data — so nothing in them is ever "referenced".
    always_clear = (config.TMP_DIR, config.PEAKS_DIR)
    sweep = (
        *always_clear,
        config.GENERATIONS_DIR,
        config.VOICES_DIR,
        config.SAMPLES_DIR,
        config.EDITS_DIR,
        config.ASSETS_DIR,
    )
    for directory in sweep:
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_file():
                continue
            if directory not in always_clear and entry.resolve() in referenced:
                continue
            try:
                size = entry.stat().st_size
                entry.unlink()
            except OSError as exc:
                log.warning("could not delete %s: %s", entry, exc)
                continue
            removed += 1
            freed += size

    log.info("cleanup removed %d orphaned file(s), %d bytes", removed, freed)
    return CleanupResult(files_removed=removed, bytes_freed=freed)


@router.post("/open", status_code=204, response_model=None)
def open_directory(payload: dict) -> None:
    """Open one of the app's own folders in the file manager."""
    key = payload.get("key")
    match = next((path for k, _label, path in _DIRECTORIES if k == key), None)
    if key == "data":
        match = config.DATA_DIR
    if match is None:
        raise HTTPException(status_code=400, detail=f"unknown directory: {key}")
    match.mkdir(parents=True, exist_ok=True)
    opener = {"win32": ["explorer"], "darwin": ["open"]}.get(sys.platform, ["xdg-open"])
    subprocess.Popen([*opener, str(match)])  # noqa: S603 - fixed, app-owned path
