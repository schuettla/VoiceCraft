"""The catalog of model weights the Models page offers.

One entry per downloadable checkpoint, as opposed to `backends/` which holds
one entry per *engine*. The distinction matters because an engine can run
several checkpoints — Qwen3-TTS has a 0.6B and a 1.7B Base — and the user
picks between them on hardware grounds, not on capability grounds.

Two entries may even share one Hugging Face repo and differ only in which files
they fetch (`variant` + `allow_patterns`), so the *active* checkpoint of an
engine is stored by **model id**, never by repo id.

`size_bytes` is the published repository size, used only to draw a progress
bar and to warn about disk space before a download starts. Real on-disk size
is always measured, never taken from here.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

import config

GB = 1024**3
MB = 1024**2

# License tiers (docs/audio-roadmap.md §1.1). VoiceCraft ships no weights, so
# the badge tells the *user* what they are agreeing to when they download one.
TIER_OPEN = "open"                    # MIT / Apache 2.0 — no prompts
TIER_CONDITIONAL = "conditional"      # community licenses: caps, attribution, gating
TIER_NONCOMMERCIAL = "noncommercial"  # output can't be used commercially
LICENSE_TIERS = (TIER_OPEN, TIER_CONDITIONAL, TIER_NONCOMMERCIAL)

APACHE_2 = "https://www.apache.org/licenses/LICENSE-2.0"

# `ModelSpec.companion` values: what kind of second repository an entry needs.
# The resolution lives in backends/sa3_files.py (this module must not import
# `backends`, which imports it).
COMPANION_SA3_TEXT_ENCODER = "sa3-text-encoder"


@dataclass(frozen=True, slots=True)
class ExtraFile:
    """A file from *another* repo that an engine fetches on its own at load time.

    Kitten's codec downloads `s3gen_meanflow.safetensors` from a second repo the
    first time it runs. Listing it here makes the Models page download it up
    front, so "downloaded" really means "will run offline".
    """

    repo_id: str
    filename: str
    size_bytes: int = 0


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

    # --- fields added for music / SFX / Kitten (all default to "unchanged") ---
    variant: str = ""            # tells entries that share one repo apart ("packed" / "emb4")
    extra_files: tuple[ExtraFile, ...] = ()
    optional_engine: bool = False  # the engine's Python packages are installed on demand
    license_tier: str = TIER_OPEN
    license_name: str = ""       # short label for the badge, e.g. "Apache 2.0"
    license_url: str = ""
    gated: bool = False          # download needs a Hugging Face token + accepted terms
    source: str = "hf"           # "hf" | "github_release"
    # A second repository the weights' own config names (Stable Audio 3's text
    # encoder). Empty for everything else. Which repository it is can only be
    # read once the main files are on disk, so `companion_bytes` is the published
    # size, used for the estimate and the free-space check only.
    companion: str = ""
    companion_bytes: int = 0
    # Hardware an entry needs, so a bigger model is offered to the machines that
    # can run it and explained, not hidden, on the ones that can't.
    # `min_capability` is the CUDA compute capability's major number (8 = Ampere,
    # the RTX 30 series); 0 means "no requirement". `requirement` is the sentence
    # shown when this machine falls short.
    min_capability: int = 0
    requirement: str = ""
    # The longest clip this checkpoint makes, when it differs from its engine's
    # usual limit (0 = the engine's own).
    max_seconds: float = 0.0

    @property
    def download_estimate_bytes(self) -> int:
        """Main repo plus every extra file — what the progress bar counts to."""
        return (
            self.size_bytes
            + sum(extra.size_bytes for extra in self.extra_files)
            + self.companion_bytes
        )


# KittenTTS 2 (docs/audio-roadmap.md §1.2, Appendix A). Both variants live in one
# repo; its codec also fetches one file from a second repo on first use, so that
# file is part of the download and not a surprise at load time.
KITTEN_REPO = "KittenML/kitten-tts-2"
KITTEN_LICENSE = "https://huggingface.co/KittenML/kitten-tts-2/blob/main/LICENSE.md"
KITTEN_VOCODER = ExtraFile(
    repo_id="ResembleAI/chatterbox-turbo",
    filename="s3gen_meanflow.safetensors",
    size_bytes=1065 * MB,
)
KITTEN_LANGUAGES = (
    "en", "ar", "zh", "fr", "de", "hi", "it", "pt", "ru", "es",
    "ja", "ko", "tr", "nl", "sv", "da", "fi", "sw", "el", "he",
)
KITTEN_NOTES = (
    "Powered by KittenML. Weights are under the Stellon Labs Community License: "
    "free for personal use; commercial use needs a free registration below $1M revenue.",
    "A cloned profile needs the transcript of its sample (no Whisper download).",
    "Works on CPU, but about 15× slower than real time; a GPU is strongly advised.",
    "Don't use its output to train another model — the license forbids it.",
    "Also downloads a ~1 GB vocoder file from ResembleAI/chatterbox-turbo.",
)


# ACE-Step 1.5 (music) and MOSS-SoundEffect v2 (SFX) — sizes and file lists read
# from the Hugging Face API on 2026-11-07 (metadata only). Phase 0 numbers come
# from the GTX 1060 6 GB run in docs/audio-roadmap.md.
ACESTEP_REPO = "ACE-Step/Ace-Step1.5"
ACESTEP_LICENSE = "https://huggingface.co/ACE-Step/Ace-Step1.5"   # card shows MIT
MOSS_SFX_REPO = "OpenMOSS-Team/MOSS-SoundEffect-v2.0"

# The turbo repo bundles everything. The sft and XL repos hold only a DiT, so
# they borrow the VAE and the text encoder from it instead of duplicating them.
ACESTEP_SHARED = tuple(
    ExtraFile(ACESTEP_REPO, name, size * MB)
    for name, size in (
        ("config.json", 0),
        ("vae/config.json", 0),
        ("vae/diffusion_pytorch_model.safetensors", 338),
        ("Qwen3-Embedding-0.6B/added_tokens.json", 0),
        ("Qwen3-Embedding-0.6B/chat_template.jinja", 0),
        ("Qwen3-Embedding-0.6B/config.json", 0),
        ("Qwen3-Embedding-0.6B/merges.txt", 2),
        ("Qwen3-Embedding-0.6B/model.safetensors", 1192),
        ("Qwen3-Embedding-0.6B/special_tokens_map.json", 0),
        ("Qwen3-Embedding-0.6B/tokenizer.json", 12),
        ("Qwen3-Embedding-0.6B/tokenizer_config.json", 0),
        ("Qwen3-Embedding-0.6B/vocab.json", 3),
    )
)
ACESTEP_NOTES = (
    "MIT licensed. Vocals or instrumental, 48 kHz stereo.",
    "Needs an NVIDIA GPU.",
)


# Stable Audio 3 Small (docs/audio-roadmap.md Phase 9). Both repositories are
# gated; the weights are under Stability AI's Community License, the code (which
# the app installs separately) is MIT. Sizes are the roadmap's: the model 2.3 GB
# plus the T5Gemma text encoder 1.2 GB. Not downloaded on this machine, so the
# real figure is whatever the Models page measures after a download.
SA3_REPO_MUSIC = "stabilityai/stable-audio-3-small-music"
SA3_REPO_SFX = "stabilityai/stable-audio-3-small-sfx"
SA3_REPO_MEDIUM = "stabilityai/stable-audio-3-medium"
SA3_LICENSE = "https://stability.ai/license"
SA3_LICENSE_NAME = "Stability AI Community License"
SA3_COMMON_NOTES = (
    "Gated: you need a free Hugging Face account, you accept Stability's terms on "
    "the model page, and you give the app a read token (\"Hugging Face access\" on this page).",
    "Weights are under the Stability AI Community License: free for personal use and "
    "for organisations below $1M annual revenue; larger ones need a licence from "
    "Stability. Read it before using the output commercially.",
    "Powered by Stability AI.",
    "Also downloads a ~1.2 GB text encoder (T5Gemma). Its repository may have its own "
    "terms (Google's Gemma licence); if so the download says so.",
    "Runs on a CPU or a small GPU. Not timed on any machine here.",
)


CATEGORIES: tuple[tuple[str, str], ...] = (
    ("speech", "Speech generation"),
    ("music", "Music generation"),
    ("sfx", "Sound effects"),
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
        license_name="Apache 2.0",
        license_url=APACHE_2,
        notes=(
            "The safe default for GPUs with limited memory.",
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
        license_name="Apache 2.0",
        license_url=APACHE_2,
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
        license_name="Apache 2.0",
        license_url=APACHE_2,
        notes=(
            "No GPU required — this is the fallback when Qwen3-TTS is unavailable.",
            "Voice selection happens per profile, not here.",
        ),
    ),
    ModelSpec(
        id="kitten-tts-2",
        repo_id=KITTEN_REPO,
        title="KittenTTS 2",
        category="speech",
        engine="kitten",
        variant="packed",
        summary="Clones a voice from 5–30 s of audio or speaks with one of 115 "
                "built-in voices, in 20 languages. Understands [joyful], <laugh> "
                "and (((emphasis))) tags.",
        size_bytes=1050 * MB,
        default=True,
        clones_voices=True,
        needs_gpu=True,
        languages=KITTEN_LANGUAGES,
        # Fetch only what this variant reads: the repo also carries a llama.cpp
        # bundle and the other weight packings, several GB nobody asked for.
        allow_patterns=("config.json", "lm/*.json", "lm/*.txt",
                        "lm/model-ternary.safetensors", "speaker/*", "voices/*"),
        extra_files=(KITTEN_VOCODER,),
        license_tier=TIER_CONDITIONAL,
        license_name="Stellon Labs Community License",
        license_url=KITTEN_LICENSE,
        notes=KITTEN_NOTES + (
            "Lossless packing — the better-sounding of the two downloads.",
        ),
    ),
    ModelSpec(
        id="kitten-tts-2-emb4",
        repo_id=KITTEN_REPO,
        title="KittenTTS 2 (small)",
        category="speech",
        engine="kitten",
        variant="emb4",
        summary="The same model with a 4-bit embedding table: about half the "
                "download of the standard variant, slightly lossy.",
        size_bytes=560 * MB,
        clones_voices=True,
        needs_gpu=True,
        languages=KITTEN_LANGUAGES,
        allow_patterns=("config.json", "lm/*.json", "lm/*.txt",
                        "lm/model-tl2-emb4.safetensors", "speaker/*", "voices/*"),
        extra_files=(KITTEN_VOCODER,),
        license_tier=TIER_CONDITIONAL,
        license_name="Stellon Labs Community License",
        license_url=KITTEN_LICENSE,
        notes=KITTEN_NOTES + (
            "Choose this if disk space is tight.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-turbo",
        repo_id=ACESTEP_REPO,
        title="ACE-Step 1.5 (turbo)",
        category="music",
        engine="acestep",
        summary="Text to music, with or without vocals. The fast 8-step model — "
                "the one tested on a 6 GB card.",
        size_bytes=int(10.09 * GB),
        default=True,
        needs_gpu=True,
        optional_engine=True,
        # Explicit patterns, so the shared files the sft / XL entries add to this
        # repo can never make the turbo weights look downloaded.
        allow_patterns=("config.json", "acestep-v15-turbo/*", "acestep-5Hz-lm-1.7B/*",
                        "Qwen3-Embedding-0.6B/*", "vae/*"),
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "The 10 GB includes the 1.7B language model, the text encoder and the VAE.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-sft",
        repo_id="ACE-Step/acestep-v15-sft",
        title="ACE-Step 1.5 (quality)",
        category="music",
        engine="acestep",
        summary="The supervised fine-tune: slower than turbo, aimed at quality.",
        size_bytes=int(4.79 * GB),
        needs_gpu=True,
        optional_engine=True,
        extra_files=ACESTEP_SHARED,
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "Reuses the text encoder and VAE of the turbo download "
            "(about 1.5 GB), so delete this one first if you remove turbo.",
            "Not tested on a small card yet.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-base",
        repo_id="ACE-Step/acestep-v15-base",
        title="ACE-Step 1.5 (base)",
        category="music",
        engine="acestep",
        summary="The untuned foundation model the other variants are derived from. "
                "50 steps, so slower than turbo; mostly for comparing or experimenting.",
        size_bytes=int(4.79 * GB),
        needs_gpu=True,
        optional_engine=True,
        extra_files=ACESTEP_SHARED,
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "Reuses the text encoder and VAE of the turbo download "
            "(about 1.5 GB), so delete this one first if you remove turbo.",
            "Not tested on a real card yet. The app uses it for plain text to music, "
            "like the other variants.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-xl-turbo",
        repo_id="ACE-Step/acestep-v15-xl-turbo",
        title="ACE-Step 1.5 XL (turbo)",
        category="music",
        engine="acestep",
        summary="The larger DiT. Better music, but a 20 GB download that wants a "
                "big GPU.",
        size_bytes=int(19.95 * GB),
        needs_gpu=True,
        optional_engine=True,
        extra_files=ACESTEP_SHARED,
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "Choose this only with a large GPU; it has not been run here.",
            "Reuses the text encoder and VAE of the turbo download "
            "(about 1.5 GB), so delete this one first if you remove turbo.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-xl-sft",
        repo_id="ACE-Step/acestep-v15-xl-sft",
        title="ACE-Step 1.5 XL (quality)",
        category="music",
        engine="acestep",
        summary="The larger DiT with the quality fine-tune: slower than XL turbo, "
                "a 20 GB download that wants a big GPU.",
        size_bytes=int(19.95 * GB),
        needs_gpu=True,
        optional_engine=True,
        extra_files=ACESTEP_SHARED,
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "Choose this only with a large GPU. Not tested on a real card yet.",
            "Reuses the text encoder and VAE of the turbo download "
            "(about 1.5 GB), so delete this one first if you remove turbo.",
        ),
    ),
    ModelSpec(
        id="acestep-1.5-xl-base",
        repo_id="ACE-Step/acestep-v15-xl-base",
        title="ACE-Step 1.5 XL (base)",
        category="music",
        engine="acestep",
        summary="The untuned larger foundation model. 50 steps and a 20 GB download; "
                "mostly for comparing or experimenting, with a big GPU.",
        size_bytes=int(19.95 * GB),
        needs_gpu=True,
        optional_engine=True,
        extra_files=ACESTEP_SHARED,
        license_name="MIT",
        license_url=ACESTEP_LICENSE,
        notes=ACESTEP_NOTES + (
            "Choose this only with a large GPU. Not tested on a real card yet.",
            "Reuses the text encoder and VAE of the turbo download "
            "(about 1.5 GB), so delete this one first if you remove turbo.",
        ),
    ),
    ModelSpec(
        id="moss-sfx-v2",
        repo_id=MOSS_SFX_REPO,
        title="MOSS-SoundEffect v2",
        category="sfx",
        engine="moss_sfx",
        summary="Text to sound effect or ambience, up to 30 s, 48 kHz.",
        size_bytes=int(11.23 * GB),
        default=True,
        needs_gpu=True,
        optional_engine=True,
        license_name="Apache 2.0",
        license_url=APACHE_2,
        notes=(
            "An 11 GB download.",
            "A 3 s effect costs as much as a 30 s one: the model always renders 30 s and crops.",
            "Needs an NVIDIA GPU.",
        ),
    ),
    ModelSpec(
        id="sa3-small-music",
        repo_id=SA3_REPO_MUSIC,
        title="Stable Audio 3 Small (music)",
        category="music",
        engine="sa3_music",
        summary="The lite music model: 8 steps, up to 2 minutes of 44.1 kHz stereo, "
                "small enough for a CPU or a 6 GB card. No vocals.",
        size_bytes=int(2.3 * GB),
        companion=COMPANION_SA3_TEXT_ENCODER,
        companion_bytes=int(1.2 * GB),
        needs_gpu=False,
        optional_engine=True,
        license_tier=TIER_CONDITIONAL,
        license_name=SA3_LICENSE_NAME,
        license_url=SA3_LICENSE,
        gated=True,
        notes=SA3_COMMON_NOTES + (
            "Instrumental only: its documentation doesn't mention lyrics.",
        ),
    ),
    ModelSpec(
        id="sa3-medium-music",
        repo_id=SA3_REPO_MEDIUM,
        title="Stable Audio 3 Medium (music)",
        category="music",
        engine="sa3_music",
        summary="The larger Stable Audio model: music up to 6 minutes 20 seconds at "
                "44.1 kHz stereo. For RTX 30 series cards and newer. No vocals.",
        size_bytes=int(8 * GB),
        companion=COMPANION_SA3_TEXT_ENCODER,
        companion_bytes=int(1.2 * GB),
        needs_gpu=True,
        optional_engine=True,
        license_tier=TIER_CONDITIONAL,
        license_name=SA3_LICENSE_NAME,
        license_url=SA3_LICENSE,
        gated=True,
        min_capability=8,
        requirement="Needs an NVIDIA RTX 30 series card or newer (Stability's page lists "
                    "Flash Attention 2 as a requirement for this model).",
        max_seconds=380.0,
        notes=SA3_COMMON_NOTES + (
            "Instrumental only, like the Small model.",
            "The download size is an estimate; the Models page shows the real figure "
            "once it is on disk.",
            "Not yet verified on a real card: if it fails to load on yours, the error "
            "says why, and the Small model keeps working.",
        ),
    ),
    ModelSpec(
        id="sa3-small-sfx",
        repo_id=SA3_REPO_SFX,
        title="Stable Audio 3 Small (sound effects)",
        category="sfx",
        engine="sa3_sfx",
        summary="The lite sound-effect model: 8 steps, small enough for a CPU or a "
                "6 GB card. Much faster than MOSS on small hardware.",
        size_bytes=int(2.3 * GB),
        companion=COMPANION_SA3_TEXT_ENCODER,
        companion_bytes=int(1.2 * GB),
        needs_gpu=False,
        optional_engine=True,
        license_tier=TIER_CONDITIONAL,
        license_name=SA3_LICENSE_NAME,
        license_url=SA3_LICENSE,
        gated=True,
        notes=SA3_COMMON_NOTES + (
            "Trained on licensed (AudioSparx) and Creative Commons (Freesound) recordings.",
        ),
    ),
)

_BY_ID = {spec.id: spec for spec in MODELS}

# Settings written before the active model was stored by id: engine → settings
# key holding a *repo* id. Still read so an existing choice survives the upgrade;
# `model_service.select` replaces it with the new form.
LEGACY_SETTING_KEY = {"qwen": "qwen_model", "kokoro": "kokoro_model"}

# An environment variable can point an engine at a checkpoint that isn't in the
# catalog at all (a fine-tune, say), so it wins and is returned as a bare repo id.
ENV_OVERRIDE = {
    "qwen": "VOICECRAFT_QWEN_MODEL",
    "kokoro": "VOICECRAFT_KOKORO_MODEL",
}

ACTIVE_SETTING = "active_models"  # settings.json: {engine: model id}


def get(model_id: str) -> ModelSpec | None:
    return _BY_ID.get(model_id)


def for_engine(engine: str) -> tuple[ModelSpec, ...]:
    return tuple(spec for spec in MODELS if spec.engine == engine)


def engines() -> tuple[str, ...]:
    """Every engine that has at least one catalog entry, in catalog order."""
    seen: dict[str, None] = {}
    for spec in MODELS:
        seen.setdefault(spec.engine)
    return tuple(seen)


def default_engine(category: str) -> str | None:
    """The engine of a category's default entry (None for an empty category)."""
    specs = [spec for spec in MODELS if spec.category == category]
    if not specs:
        return None
    return next((spec for spec in specs if spec.default), specs[0]).engine


def engines_for(category: str) -> tuple[str, ...]:
    """Engines with at least one entry in `category`, in catalog order."""
    seen: dict[str, None] = {}
    for spec in MODELS:
        if spec.category == category:
            seen.setdefault(spec.engine)
    return tuple(seen)


def sharing_repo(spec: ModelSpec) -> tuple[ModelSpec, ...]:
    """Other entries that live in the same Hugging Face repo as `spec`."""
    return tuple(
        other
        for other in MODELS
        if other.id != spec.id and other.repo_id == spec.repo_id and other.source == spec.source
    )


def _env_override(engine: str) -> str | None:
    var = ENV_OVERRIDE.get(engine)
    return (os.environ.get(var) or None) if var else None


_assumed: ContextVar[str | None] = ContextVar("assumed_model", default=None)


@contextmanager
def assume_model(model_id: str | None) -> Iterator[None]:
    """Answer `active_model` as if `model_id` were its engine's saved choice.

    A request can name a model other than the active one. Whatever depends on the
    checkpoint (a clip-length limit, default steps, a label) is asked inside this
    block, so it is answered for the model the job will use, without touching the
    saved choice. Local to the calling thread / task; nothing is persisted.
    """
    token = _assumed.set(model_id)
    try:
        yield
    finally:
        _assumed.reset(token)


def active_model(engine: str) -> ModelSpec:
    """The catalog entry `engine` will load, ignoring environment overrides.

    Order: a model assumed by `assume_model` → the saved choice (a model id) → a
    legacy saved repo id → the engine's default entry.
    """
    specs = for_engine(engine)
    if not specs:
        raise KeyError(f"unknown engine: {engine}")

    assumed = _BY_ID.get(_assumed.get() or "")
    if assumed is not None and assumed.engine == engine:
        return assumed

    settings = config.load_settings()

    saved = (settings.get(ACTIVE_SETTING) or {}).get(engine)
    chosen = _BY_ID.get(saved) if saved else None
    if chosen is not None and chosen.engine == engine:
        return chosen

    legacy_key = LEGACY_SETTING_KEY.get(engine)
    legacy_repo = settings.get(legacy_key) if legacy_key else None
    if legacy_repo:
        for spec in specs:
            if spec.repo_id == legacy_repo:
                return spec

    return next((spec for spec in specs if spec.default), specs[0])


def active_repo_id(engine: str) -> str:
    """Repo id the given engine will load right now."""
    override = _env_override(engine)
    if override:
        return override
    return active_model(engine).repo_id


def is_active(spec: ModelSpec) -> bool:
    """Whether `spec` is the checkpoint its engine loads."""
    override = _env_override(spec.engine)
    if override:
        return spec.repo_id == override
    return active_model(spec.engine).id == spec.id
