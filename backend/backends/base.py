"""TTS backend protocol.

Ported from Voicebox's backend/registry pattern (PRD §6, G5): each engine is a
small class with the same surface, registered by name, so porting a new engine
from Voicebox later means dropping in one file.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable


@dataclass(slots=True)
class VoiceSpec:
    """What a backend needs to know about the voice it is producing.

    `sample_path` drives zero-shot cloning (Qwen3-TTS). `preset_voice` selects
    a built-in voice (Kokoro, which cannot clone — PRD §5).
    """

    language: str = "en"
    sample_path: str | None = None
    sample_text: str | None = None
    preset_voice: str | None = None
    speed: float = 1.0
    # Voice print produced by `prepare_voice`, if the profile has one. Reusing
    # it skips re-analysing the reference clip on every generation.
    voice_path: str | None = None


@dataclass(slots=True)
class SynthesisResult:
    path: Path
    duration_seconds: float | None = None
    device: str | None = None
    warning: str | None = None


@dataclass(slots=True)
class VoicePrint:
    """What `prepare_voice` extracted from a reference clip and wrote to disk.

    This is the artefact that makes a profile a *cloned voice* rather than a
    row in a table: the speaker embedding (and, in ICL mode, the encoded
    reference speech) the model conditions on.
    """

    path: Path
    mode: str                      # "icl" (audio + transcript) | "x-vector"
    model_id: str
    device: str | None = None
    size_bytes: int | None = None
    sample_seconds: float | None = None
    warning: str | None = None


class BackendUnavailable(RuntimeError):
    """The engine's Python dependencies or model weights aren't installed."""


@runtime_checkable
class TTSBackend(Protocol):
    name: str
    supports_cloning: bool

    def available(self) -> bool:
        """True if imports resolve — cheap, must not download anything."""

    def is_loaded(self) -> bool:
        ...

    def device(self) -> str | None:
        ...

    def load(self) -> None:
        """Load weights. May download from Hugging Face on first run."""

    def prepare_voice(self, voice: VoiceSpec, out_path: Path) -> VoicePrint:
        """Analyse a reference clip and persist the voice print to `out_path`.

        Only cloning backends implement this; call it behind a
        `supports_cloning` check.
        """

    def synthesize(self, text: str, voice: VoiceSpec, out_path: Path) -> SynthesisResult:
        """Write a WAV to `out_path`."""

    def unload(self) -> None:
        ...
