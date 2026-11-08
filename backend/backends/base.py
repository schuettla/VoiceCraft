"""TTS backend protocol.

Ported from Voicebox's backend/registry pattern (PRD §6, G5): each engine is a
small class with the same surface, registered by name, so porting a new engine
from Voicebox later means dropping in one file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable


@dataclass(slots=True)
class VoiceSpec:
    """What a backend needs to know about the voice it is producing.

    `sample_path` drives zero-shot cloning (Qwen3-TTS, KittenTTS 2). `preset_voice`
    selects a built-in voice (Kokoro, which cannot clone — PRD §5; KittenTTS 2
    profiles are one or the other).
    """

    language: str = "en"
    sample_path: str | None = None
    sample_text: str | None = None
    preset_voice: str | None = None
    speed: float = 1.0
    # Voice print produced by `prepare_voice`, if the profile has one. Reusing
    # it skips re-analysing the reference clip on every generation.
    voice_path: str | None = None
    # Per-generation options from the job's `params` (Kitten: `preset`, `seed`).
    # Engines read what they know and ignore the rest.
    options: dict[str, Any] = field(default_factory=dict)


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


@dataclass(slots=True)
class AudioSpec:
    """One music or sound-effect request (docs/audio-roadmap.md §5.2).

    There is no voice here: the prompt describes the sound. Everything but
    `prompt` and `duration_seconds` is optional and left to the engine's own
    defaults when None.
    """

    prompt: str
    duration_seconds: float
    lyrics: str | None = None        # music only; None = instrumental
    seed: int | None = None
    steps: int | None = None
    guidance: float | None = None


@dataclass(frozen=True, slots=True)
class Support:
    """Whether an engine is worth running on this machine, and what to tell the user.

    `max_duration_seconds` is the longest clip the engine should be asked for on
    *this* hardware — the API refuses longer requests instead of letting a job
    run into the engine's own timeout.
    """

    ok: bool
    reason: str | None = None            # why not, when `ok` is False
    warning: str | None = None           # runs, but the user should know something
    max_duration_seconds: float | None = None


@runtime_checkable
class TTSBackend(Protocol):
    name: str
    supports_cloning: bool
    # True for engines the user installs on demand (music, sound effects). The
    # health check reports it so the header doesn't warn about an engine that
    # was never meant to be there.
    optional: bool

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


@runtime_checkable
class AudioBackend(Protocol):
    """Sibling of `TTSBackend` for music and sound effects.

    `TTSBackend` is built around a voice (`VoiceSpec`, `prepare_voice`), which
    music and SFX don't have. The lifecycle methods are the same on purpose, so
    the registry, the unload-before-job rule and the idle unload treat both alike.
    """

    name: str
    kind: str                         # "music" | "sfx"
    optional: bool                    # always True: installed on demand

    def available(self) -> bool:
        """True if the engine's packages import — cheap, must not download anything."""

    def support(self) -> Support:
        """Can this machine run the engine, and for how long a clip."""

    def is_loaded(self) -> bool:
        ...

    def device(self) -> str | None:
        ...

    def load(self) -> None:
        ...

    def generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        """Write a WAV to `out_path` (the job transcodes it if another format was asked for)."""

    def unload(self) -> None:
        ...
