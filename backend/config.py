"""Central configuration and on-disk layout for VoiceCraft.

Everything lives under a single data directory so the app stays fully local
and is trivial to back up or wipe. Override with VOICECRAFT_DATA_DIR.

Model weights are the exception: they live in the Hugging Face hub cache,
which is shared with every other HF-based tool on the machine and is often
moved to a bigger disk. The Models page owns that location, so this module is
imported before anything that touches `huggingface_hub` — see `main.py` — and
exports the resulting directory into the environment on import.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Any

APP_NAME = "VoiceCraft"

# Different port than Voicebox (17500) so both can run side by side (PRD §6).
# The PRD names 17600, but Dropbox squats on that port on this machine and the
# backend cannot bind — 17610 is the next free one. Override with VOICECRAFT_PORT.
HOST = os.environ.get("VOICECRAFT_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICECRAFT_PORT", "17610"))


def _default_data_dir() -> Path:
    """Match the Rust shell's setup::data_dir() so both sides agree.

    Windows: %LOCALAPPDATA%\\VoiceCraft. macOS: ~/Library/Application
    Support/VoiceCraft. Linux: $XDG_DATA_HOME or ~/.local/share/VoiceCraft.
    """
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME


DATA_DIR = Path(os.environ.get("VOICECRAFT_DATA_DIR", _default_data_dir())).resolve()

SETTINGS_PATH = DATA_DIR / "settings.json"  # user choices the Models page writes

# Creating a cloning profile extracts its voice print straight away. Tests set
# this to 0 so the suite stays free of model weights and GPU time.
AUTO_PREPARE_VOICES = os.environ.get("VOICECRAFT_AUTO_PREPARE", "1") != "0"

SAMPLES_DIR = DATA_DIR / "samples"       # reference clips uploaded for cloning
VOICES_DIR = DATA_DIR / "voices"         # prepared voice prints (speaker embedding + codes)
GENERATIONS_DIR = DATA_DIR / "generations"  # raw TTS output (WAV)
ASSETS_DIR = DATA_DIR / "assets"         # reusable intro/outro/clip assets
EDITS_DIR = DATA_DIR / "edits"           # trim/assemble/convert/render results
TMP_DIR = DATA_DIR / "tmp"               # ffmpeg intermediates
PEAKS_DIR = DATA_DIR / "peaks"           # cached waveform peak data (regenerable)
DB_PATH = DATA_DIR / "voicecraft.db"
# Credentials the user typed in (the Hugging Face token for gated downloads).
# Deliberately not in ALL_DIRS: nothing lists, serves or cleans this folder.
SECRETS_DIR = DATA_DIR / "secrets"

ALL_DIRS = (
    SAMPLES_DIR, VOICES_DIR, GENERATIONS_DIR, ASSETS_DIR, EDITS_DIR, TMP_DIR,
    PEAKS_DIR,
)

# Any path we hand back to the client must live under one of these roots.
# `voices/` is deliberately excluded: those are tensors, not playable audio.
SAFE_ROOTS = (SAMPLES_DIR, GENERATIONS_DIR, ASSETS_DIR, EDITS_DIR, TMP_DIR)

FFMPEG = os.environ.get("VOICECRAFT_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("VOICECRAFT_FFPROBE") or shutil.which("ffprobe") or "ffprobe"


# --------------------------------------------------------------------------
# Settings (settings.json)
# --------------------------------------------------------------------------
#
# A tiny JSON file rather than a table: these are a handful of scalars the app
# needs before the database — or the ORM — is available, and being able to fix
# a broken model choice in a text editor is worth more than schema validation.

_settings_lock = threading.Lock()
_settings_cache: dict[str, Any] | None = None


def load_settings() -> dict[str, Any]:
    """Read settings.json, falling back to defaults if it's missing or corrupt."""
    global _settings_cache
    with _settings_lock:
        if _settings_cache is None:
            try:
                loaded = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
                _settings_cache = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                _settings_cache = {}
        return dict(_settings_cache)


def save_settings(values: dict[str, Any]) -> dict[str, Any]:
    """Merge `values` into settings.json and return the full settings."""
    global _settings_cache
    with _settings_lock:
        current = dict(_settings_cache or {})
        current.update(values)
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(
            json.dumps(current, indent=2, sort_keys=True), encoding="utf-8"
        )
        _settings_cache = current
        return dict(current)


def clear_setting(key: str) -> dict[str, Any]:
    """Forget a setting so its default applies again."""
    global _settings_cache
    with _settings_lock:
        current = dict(_settings_cache or {})
        current.pop(key, None)
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(
            json.dumps(current, indent=2, sort_keys=True), encoding="utf-8"
        )
        _settings_cache = current
        return dict(current)


# --------------------------------------------------------------------------
# Model weights
# --------------------------------------------------------------------------

# Hugging Face model ids. The "Base" Qwen checkpoints are the cloning ones
# (3-second rapid voice clone from a reference clip); CustomVoice/VoiceDesign
# cannot clone — they select preset timbres or synthesize from a description.
DEFAULT_QWEN_MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
DEFAULT_KOKORO_MODEL_ID = "hexgrad/Kokoro-82M"


def _default_models_dir() -> Path:
    """Where huggingface_hub would cache weights if we said nothing."""
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if os.environ.get(var):
            return Path(os.environ[var])
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def models_dir() -> Path:
    """The hub cache the app reads and writes weights through.

    The user's choice wins over the HF environment variables so that moving
    the cache from the Models page actually moves it, even on a machine that
    already had HF_HOME set for something else.
    """
    chosen = load_settings().get("models_dir")
    if chosen:
        return Path(chosen).expanduser()
    return _default_models_dir()


def apply_models_dir_env(directory: Path | None = None) -> None:
    """Point huggingface_hub at `directory` via the environment.

    Must run before `huggingface_hub` is imported anywhere: the library reads
    these into module constants at import time, so setting them later has no
    effect on an already-loaded process. `main.py` imports this module first
    for exactly that reason.
    """
    resolved = Path(directory or models_dir()).expanduser()
    os.environ["HF_HUB_CACHE"] = str(resolved)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(resolved)
    os.environ.setdefault("HF_HOME", str(resolved.parent))


# Which checkpoint an engine loads is resolved in `catalog.active_repo_id`: the
# choice is stored by model id (two catalog entries can share one repo), and the
# VOICECRAFT_QWEN_MODEL / VOICECRAFT_KOKORO_MODEL overrides are read there too.

apply_models_dir_env()

# Intermediate format every clip is normalized to before concatenation.
# Mismatched sample rates/channel counts are the usual source of clicks at
# segment boundaries (PRD §10).
INTERMEDIATE_SAMPLE_RATE = 44100
INTERMEDIATE_CHANNELS = 2

SUPPORTED_FORMATS = ("wav", "mp3", "ogg", "flac")

MAX_CROSSFADE_MS = 500


def ensure_dirs() -> None:
    for directory in (DATA_DIR, *ALL_DIRS):
        directory.mkdir(parents=True, exist_ok=True)
