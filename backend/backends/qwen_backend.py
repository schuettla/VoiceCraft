"""Qwen3-TTS backend — zero-shot voice cloning from a reference sample.

Written against the published model card for `Qwen/Qwen3-TTS-12Hz-*-Base`
(the "Base" checkpoints are the cloning ones; CustomVoice/VoiceDesign are
preset-timbre and description-driven models and cannot clone). The package is
`qwen-tts`, and cloning goes through `generate_voice_clone`.

Hardware notes, learned the hard way on a GTX 1060:
  * bfloat16 and FlashAttention 2 need Ampere (compute 8.0) or newer. On older
    cards float16 sampling goes NaN and trips a device-side assert, so we fall
    back to float32 + SDPA — slower, but correct.
  * The 0.6B checkpoint is the safe default for 6 GB cards; set
    VOICECRAFT_QWEN_MODEL to the 1.7B one if you have the VRAM.
"""

from __future__ import annotations

import logging
from importlib.util import find_spec
from pathlib import Path

import catalog
from backends import device as devices
from backends.base import BackendUnavailable, SynthesisResult, VoicePrint, VoiceSpec
from utils import audio

log = logging.getLogger(__name__)

FALLBACK_SAMPLE_RATE = 24000

# Bump when the payload layout changes so old files are re-extracted instead of
# being loaded into a shape the code no longer understands.
VOICE_PRINT_VERSION = 1

# Qwen wants language names, not ISO codes.
LANGUAGES = {
    "en": "English",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}


class QwenBackend:
    name = "qwen"
    supports_cloning = True
    optional = False

    def __init__(self) -> None:
        self._model = None
        self._device: str | None = None
        self._warning: str | None = None
        # Reference features are expensive to recompute, and a podcast script
        # is many generations from the same profile.
        self._prompt_cache: dict[str, object] = {}

    # -- capability ------------------------------------------------------

    def available(self) -> bool:
        return find_spec("qwen_tts") is not None and find_spec("torch") is not None

    def is_loaded(self) -> bool:
        return self._model is not None

    def device(self) -> str | None:
        return self._device

    def _pick_device(self):
        """CUDA when present, Apple Silicon MPS next, else CPU (PRD §8).

        Pre-Ampere cards (GTX 10xx and friends) have no bf16, and float16
        generation blows up with a device-side assert — logits go NaN and
        sampling indexes out of range — so `allow_fp16` stays off and the
        helper picks float32: slower, but correct.
        """
        plan = devices.pick_device(
            engine="Qwen3-TTS", wants_bf16=True, allow_fp16=False, supports_mps=True
        )
        flash = plan.kind == "cuda" and plan.dtype_name == "bfloat16" and find_spec("flash_attn")
        attn = "flash_attention_2" if flash else "sdpa"
        return plan.device, plan.dtype, attn, plan.warning

    # -- lifecycle -------------------------------------------------------

    def load(self) -> None:
        if self._model is not None:
            return
        if not self.available():
            raise BackendUnavailable(
                "qwen-tts is not installed. Re-run setup, or: pip install qwen-tts"
            )

        from qwen_tts import Qwen3TTSModel  # noqa: PLC0415

        device, dtype, attn, warning = self._pick_device()
        self._device = "cuda" if device.startswith("cuda") else ("mps" if device == "mps" else "cpu")
        self._warning = warning

        # Read the checkpoint at load time, not at import: the Models page can
        # change it while the app is running, and it unloads us when it does.
        model_id = catalog.active_repo_id("qwen")
        log.info("loading %s on %s (%s, attn=%s)", model_id, device, dtype, attn)
        try:
            self._model = Qwen3TTSModel.from_pretrained(
                model_id,
                device_map=device,
                dtype=dtype,
                attn_implementation=attn,
            )
        except Exception as exc:  # noqa: BLE001 - retry without the fast kernels
            log.warning("load failed with attn=%s (%s); retrying with eager", attn, exc)
            self._model = Qwen3TTSModel.from_pretrained(
                model_id,
                device_map=device,
                dtype=dtype,
                attn_implementation="eager",
            )

    def unload(self) -> None:
        self._model = None
        self._prompt_cache.clear()
        self._device = None
        devices.release_gpu_memory()

    # -- synthesis -------------------------------------------------------

    def _extract(self, voice: VoiceSpec):
        """Run the reference clip through the speaker encoder and tokenizer.

        With a transcript the model conditions on both audio and text (ICL);
        without one, `x_vector_only_mode` uses the speaker embedding alone —
        the model card warns that quality drops, which the UI says too.
        """
        waveform, rate = audio.load_reference(voice.sample_path)
        items = self._model.create_voice_clone_prompt(
            ref_audio=(waveform, rate),
            ref_text=voice.sample_text or None,
            x_vector_only_mode=not bool(voice.sample_text),
        )
        return items, len(waveform) / rate

    # -- voice prints ----------------------------------------------------

    def prepare_voice(self, voice: VoiceSpec, out_path: Path) -> VoicePrint:
        """Extract this profile's voice print once and write it to disk.

        This is the cloning step. Everything the model needs to speak as this
        person — the speaker embedding, and in ICL mode the encoded reference
        speech — is computed here, so generation is just synthesis and the
        result survives a restart.
        """
        if not voice.sample_path or not Path(voice.sample_path).exists():
            raise RuntimeError("this profile has no reference sample on disk.")
        if self._model is None:
            self.load()

        import torch  # noqa: PLC0415

        items, seconds = self._extract(voice)
        item = items[0]
        model_id = catalog.active_repo_id("qwen")

        payload = {
            "version": VOICE_PRINT_VERSION,
            "model_id": model_id,
            "sample_path": voice.sample_path,
            "sample_text": item.ref_text,
            "sample_seconds": seconds,
            "x_vector_only_mode": bool(item.x_vector_only_mode),
            "icl_mode": bool(item.icl_mode),
            # CPU tensors: the voice print outlives this process, and the next
            # one may load the model onto a different device.
            "ref_code": None if item.ref_code is None else item.ref_code.detach().cpu(),
            "ref_spk_embedding": item.ref_spk_embedding.detach().cpu(),
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(payload, out_path)

        # Keep it hot for the generation that usually follows immediately.
        self._prompt_cache[self._cache_key(voice)] = items

        return VoicePrint(
            path=out_path,
            mode="x-vector" if item.x_vector_only_mode else "icl",
            model_id=model_id,
            device=self._device,
            size_bytes=out_path.stat().st_size,
            sample_seconds=seconds,
            warning=self._warning,
        )

    def _load_voice_print(self, voice: VoiceSpec):
        """Rebuild a prompt item from disk, or None if it can't be reused."""
        path = Path(voice.voice_path) if voice.voice_path else None
        if path is None or not path.is_file():
            return None

        import torch  # noqa: PLC0415
        from qwen_tts import VoiceClonePromptItem  # noqa: PLC0415

        try:
            payload = torch.load(path, map_location="cpu", weights_only=False)
        except Exception as exc:  # noqa: BLE001 - a bad file must not be fatal
            log.warning("voice print %s is unreadable (%s); re-extracting", path, exc)
            return None

        if payload.get("version") != VOICE_PRINT_VERSION:
            log.info("voice print %s predates this build; re-extracting", path)
            return None
        if payload.get("model_id") != catalog.active_repo_id("qwen"):
            log.info(
                "voice print %s was extracted with %s, now using %s; re-extracting",
                path,
                payload.get("model_id"),
                catalog.active_repo_id("qwen"),
            )
            return None

        log.info("using prepared voice print %s", path)
        device = getattr(self._model, "device", None) or "cpu"
        code = payload.get("ref_code")
        return [
            VoiceClonePromptItem(
                ref_code=None if code is None else code.to(device),
                ref_spk_embedding=payload["ref_spk_embedding"].to(device),
                x_vector_only_mode=payload["x_vector_only_mode"],
                icl_mode=payload["icl_mode"],
                ref_text=payload.get("sample_text"),
            )
        ]

    @staticmethod
    def _cache_key(voice: VoiceSpec) -> str:
        return f"{voice.sample_path}|{voice.sample_text or ''}"

    def _clone_prompt(self, voice: VoiceSpec):
        """Prepared voice print if there is one, else extract it on the fly."""
        key = self._cache_key(voice)
        cached = self._prompt_cache.get(key)
        if cached is not None:
            return cached

        prompt = self._load_voice_print(voice)
        if prompt is None:
            prompt, _seconds = self._extract(voice)
        self._prompt_cache[key] = prompt
        return prompt

    def synthesize(self, text: str, voice: VoiceSpec, out_path: Path) -> SynthesisResult:
        if self._model is None:
            self.load()

        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415

        if not voice.sample_path or not Path(voice.sample_path).exists():
            raise RuntimeError(
                "Qwen3-TTS needs a reference sample; this profile has none on disk."
            )

        language = LANGUAGES.get((voice.language or "en").lower(), "Auto")
        wavs, sample_rate = self._model.generate_voice_clone(
            text=text,
            language=language,
            voice_clone_prompt=self._clone_prompt(voice),
        )

        waveform = np.asarray(wavs[0], dtype="float32").reshape(-1)
        sample_rate = int(sample_rate or FALLBACK_SAMPLE_RATE)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), waveform, sample_rate)

        return SynthesisResult(
            path=out_path,
            duration_seconds=len(waveform) / sample_rate,
            device=self._device,
            warning=self._warning,
        )
