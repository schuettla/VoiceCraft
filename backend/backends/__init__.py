"""Backend registry — name → singleton instance."""

from __future__ import annotations

import logging

from backends import device as devices
from backends.audio_engines import AceStepBackend, MossSfxBackend
from backends.base import (
    AudioBackend,
    AudioSpec,
    BackendUnavailable,
    Support,
    SynthesisResult,
    TTSBackend,
    VoiceSpec,
)
from backends.kitten_backend import KITTEN_PRESET_VOICES, KittenBackend
from backends.kokoro_backend import PRESET_VOICES, KokoroBackend
from backends.qwen_backend import QwenBackend
from backends.sa3_engines import Sa3MusicBackend, Sa3SfxBackend

log = logging.getLogger(__name__)

AUDIO_KINDS = ("music", "sfx")

# One registry for every engine, speech and audio alike: the one-job-at-a-time
# rule, unload-before-job and the idle unload all walk it, and they have to see
# the music and SFX models as well (they are the heaviest things in VRAM).
_REGISTRY: dict[str, TTSBackend | AudioBackend] = {
    "qwen": QwenBackend(),
    "kokoro": KokoroBackend(),
    "kitten": KittenBackend(),
    "acestep": AceStepBackend(),
    "moss_sfx": MossSfxBackend(),
    # Stable Audio 3 Small: one package, one checkpoint per kind.
    "sa3_music": Sa3MusicBackend(),
    "sa3_sfx": Sa3SfxBackend(),
}


def get_backend(name: str) -> TTSBackend | AudioBackend:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise BackendUnavailable(f"unknown engine: {name}") from None


def all_backends() -> dict[str, TTSBackend | AudioBackend]:
    return dict(_REGISTRY)


def audio_backends(kind: str | None = None) -> dict[str, AudioBackend]:
    """The music / SFX engines, optionally only those of one `kind`."""
    return {
        name: backend
        for name, backend in _REGISTRY.items()
        if getattr(backend, "kind", None) in AUDIO_KINDS
        and (kind is None or backend.kind == kind)
    }


def unload_all() -> None:
    for backend in _REGISTRY.values():
        try:
            backend.unload()
        except Exception:  # pragma: no cover - shutdown best effort
            pass
    devices.release_gpu_memory()


def unload_except(keep: str | None) -> list[str]:
    """Free every loaded engine other than `keep`, then return VRAM to the driver.

    Called before each job: Qwen3-TTS, KittenTTS and the music/SFX engines
    would otherwise all sit in the same 6 GB. Returns the names it unloaded.
    """
    dropped: list[str] = []
    for name, backend in _REGISTRY.items():
        if name == keep or not backend.is_loaded():
            continue
        try:
            backend.unload()
            dropped.append(name)
        except Exception:  # noqa: BLE001 - a failed unload must not fail the job
            log.warning("could not unload %s", name, exc_info=True)
    if dropped:
        devices.release_gpu_memory()
    return dropped


__all__ = [
    "AUDIO_KINDS",
    "KITTEN_PRESET_VOICES",
    "PRESET_VOICES",
    "AudioBackend",
    "AudioSpec",
    "BackendUnavailable",
    "Support",
    "SynthesisResult",
    "TTSBackend",
    "VoiceSpec",
    "all_backends",
    "audio_backends",
    "get_backend",
    "unload_all",
    "unload_except",
]
