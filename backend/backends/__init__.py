"""Backend registry — name → singleton instance."""

from __future__ import annotations

from backends.base import (
    BackendUnavailable,
    SynthesisResult,
    TTSBackend,
    VoiceSpec,
)
from backends.kokoro_backend import PRESET_VOICES, KokoroBackend
from backends.qwen_backend import QwenBackend

_REGISTRY: dict[str, TTSBackend] = {
    "qwen": QwenBackend(),
    "kokoro": KokoroBackend(),
}


def get_backend(name: str) -> TTSBackend:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise BackendUnavailable(f"unknown engine: {name}") from None


def all_backends() -> dict[str, TTSBackend]:
    return dict(_REGISTRY)


def unload_all() -> None:
    for backend in _REGISTRY.values():
        try:
            backend.unload()
        except Exception:  # pragma: no cover - shutdown best effort
            pass


__all__ = [
    "PRESET_VOICES",
    "BackendUnavailable",
    "SynthesisResult",
    "TTSBackend",
    "VoiceSpec",
    "all_backends",
    "get_backend",
    "unload_all",
]
