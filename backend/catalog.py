"""The catalog of model weights the Models page offers.

One entry per downloadable checkpoint, as opposed to `backends/` which holds
one entry per *engine*. The distinction matters because an engine can run
several checkpoints — Qwen3-TTS has a 0.6B and a 1.7B Base — and the user
picks between them on hardware grounds, not on capability grounds.

`size_bytes` is the published repository size, used only to draw a progress
bar and to warn about disk space before a download starts. Real on-disk size
is always measured, never taken from here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import config

GB = 1024**3
MB = 1024**2


@dataclass(frozen=True, slots=True)
class ModelSpec:
    id: str                      # stable key used by the API and settings
    repo_id: str                 # Hugging Face repository
    title: str
    category: str                # "speech" — grouping header in the UI
    engine: str                  # which backends/ engine loads it
    summary: str
    size_bytes: int              # approximate download size
    default: bool = False        # preselected when nothing is chosen
    clones_voices: bool = False
    needs_gpu: bool = False
    languages: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()
    # Restricting the download to weights avoids pulling the repo's demo audio
    # and duplicate checkpoint formats.
    allow_patterns: tuple[str, ...] = field(default=())


CATEGORIES: tuple[tuple[str, str], ...] = (
    ("speech", "Speech generation"),
)

MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="qwen3-tts-0.6b",
        repo_id=config.DEFAULT_QWEN_MODEL_ID,
        title="Qwen3-TTS 0.6B (Base)",
        category="speech",
        engine="qwen",
        summary="Zero-shot voice cloning from a reference clip. Fits in 6 GB of VRAM.",
        size_bytes=2 * GB,
        default=True,
        clones_voices=True,
        needs_gpu=True,
        languages=("en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"),
        notes=(
            "The safe default for 6 GB cards such as a GTX 1060.",
            "Runs on CPU, but a sentence takes minutes rather than seconds.",
        ),
    ),
    ModelSpec(
        id="qwen3-tts-1.7b",
        repo_id="Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        title="Qwen3-TTS 1.7B (Base)",
        category="speech",
        engine="qwen",
        summary="The larger cloning checkpoint — closer to the reference voice, "
                "but it wants roughly 8 GB of VRAM.",
        size_bytes=5 * GB,
        clones_voices=True,
        needs_gpu=True,
        languages=("en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"),
        notes=(
            "Choose this only if your GPU has 8 GB or more.",
            "Pre-Ampere cards run it in float32, which roughly doubles the VRAM it needs.",
        ),
    ),
    ModelSpec(
        id="kokoro-82m",
        repo_id=config.DEFAULT_KOKORO_MODEL_ID,
        title="Kokoro 82M",
        category="speech",
        engine="kokoro",
        summary="28 preset voices, fast enough on CPU for drafts. Cannot clone a voice.",
        size_bytes=350 * MB,
        default=True,
        clones_voices=False,
        needs_gpu=False,
        languages=("en", "es", "fr", "hi", "it", "pt", "ja", "zh"),
        notes=(
            "No GPU required — this is the fallback when Qwen3-TTS is unavailable.",
            "Voice selection happens per profile, not here.",
        ),
    ),
)

_BY_ID = {spec.id: spec for spec in MODELS}

# The settings key that stores the active checkpoint for each engine.
SETTING_KEY = {"qwen": "qwen_model", "kokoro": "kokoro_model"}


def get(model_id: str) -> ModelSpec | None:
    return _BY_ID.get(model_id)


def for_engine(engine: str) -> tuple[ModelSpec, ...]:
    return tuple(spec for spec in MODELS if spec.engine == engine)


def active_repo_id(engine: str) -> str:
    """Repo id the given engine will load right now."""
    if engine == "qwen":
        return config.qwen_model_id()
    if engine == "kokoro":
        return config.kokoro_model_id()
    raise KeyError(f"unknown engine: {engine}")
