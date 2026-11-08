"""Kokoro-82M backend — fast CPU preset voices.

Kokoro does NOT clone. It picks from ~50 built-in voices, so a Kokoro profile
stores a preset voice id (`af_heart`, `am_michael`, …) rather than a reference
sample. This is a documented constraint, not a bug (PRD §5).
"""

from __future__ import annotations

import logging
from importlib.util import find_spec
from pathlib import Path

import catalog
from backends.base import BackendUnavailable, SynthesisResult, VoiceSpec

log = logging.getLogger(__name__)

SAMPLE_RATE = 24000

# Voice ids ship with the model; the first letter encodes language + gender.
PRESET_VOICES: tuple[str, ...] = (
    "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah",
    "af_nova", "af_sky", "af_alloy", "af_jessica", "af_river",
    "am_michael", "am_fenrir", "am_puck", "am_echo", "am_eric", "am_liam",
    "am_onyx", "am_santa", "am_adam",
    "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
    "bm_george", "bm_fable", "bm_lewis", "bm_daniel",
)

DEFAULT_VOICE = "af_heart"

# Kokoro's pipeline takes a one-letter language code, not an ISO tag.
_LANG_CODES = {
    "en": "a", "en-us": "a", "en-gb": "b",
    "es": "e", "fr": "f", "hi": "h", "it": "i", "pt": "p",
    "ja": "j", "zh": "z",
}


def _lang_code(language: str, voice: str) -> str:
    code = _LANG_CODES.get((language or "en").lower())
    if code:
        return code
    # Fall back to the voice id's own prefix (af_/bm_/…).
    return voice[0] if voice else "a"


class KokoroBackend:
    name = "kokoro"
    supports_cloning = False
    optional = False

    def __init__(self) -> None:
        self._pipelines: dict[str, object] = {}

    def available(self) -> bool:
        return find_spec("kokoro") is not None

    def is_loaded(self) -> bool:
        return bool(self._pipelines)

    def device(self) -> str | None:
        return "cpu" if self._pipelines else None

    def load(self) -> None:
        self._pipeline_for("a")

    def _pipeline_for(self, lang_code: str):
        if lang_code in self._pipelines:
            return self._pipelines[lang_code]
        if not self.available():
            raise BackendUnavailable(
                "kokoro is not installed. pip install kokoro soundfile"
            )
        from kokoro import KPipeline  # noqa: PLC0415 - deliberately lazy

        repo_id = catalog.active_repo_id("kokoro")
        log.info("loading Kokoro pipeline (lang_code=%s, repo=%s)", lang_code, repo_id)
        pipeline = KPipeline(lang_code=lang_code, repo_id=repo_id)
        self._pipelines[lang_code] = pipeline
        return pipeline

    def synthesize(self, text: str, voice: VoiceSpec, out_path: Path) -> SynthesisResult:
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415

        preset = voice.preset_voice or DEFAULT_VOICE
        pipeline = self._pipeline_for(_lang_code(voice.language, preset))

        chunks = []
        for _graphemes, _phonemes, audio in pipeline(
            text, voice=preset, speed=voice.speed
        ):
            chunks.append(np.asarray(audio, dtype="float32").reshape(-1))
        if not chunks:
            raise RuntimeError("Kokoro produced no audio for the given text")

        samples = np.concatenate(chunks)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), samples, SAMPLE_RATE)

        return SynthesisResult(
            path=out_path,
            duration_seconds=len(samples) / SAMPLE_RATE,
            device="cpu",
        )

    def unload(self) -> None:
        self._pipelines.clear()
