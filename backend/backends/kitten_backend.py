"""KittenTTS 2 backend — zero-shot cloning *and* 115 built-in voices.

KittenTTS 2 is a 1.7B speech language model with ternary weights. One engine
covers both profile kinds: a **clone** (reference clip + its transcript) and a
**preset** (one of the voices that ship with the weights), never both.

Things measured on a GTX 1060 (docs/audio-roadmap.md, Phase 0):
  * bf16 *runs* on Pascal and the audio is clean, so there is no fp32 path.
    Patching the config to fp32 fails (`mat1 and mat2 must have the same
    dtype`: some weights stay bf16). The model is loaded exactly as published.
  * CPU works but is ~15x slower than real time. The result says so.
  * There is no MPS path; Apple Silicon runs on CPU.
  * Windows needs PYTHONUTF8=1 (the package reads voices.json without an
    encoding). The Tauri shell sets it when it launches the backend.

Without a transcript, kittenml quietly downloads Whisper large-v3 (~3 GB) to
transcribe the clip. A clone therefore *requires* `sample_text`, and this module
refuses to proceed without one, so no hidden download can happen.
"""

from __future__ import annotations

import json
import logging
from importlib.util import find_spec
from pathlib import Path
from typing import Any

import numpy as np

import catalog
import config
from backends import device as devices
from backends.base import BackendUnavailable, SynthesisResult, VoicePrint, VoiceSpec

log = logging.getLogger(__name__)

# Bump when the payload layout changes so old files are re-extracted.
VOICE_PRINT_VERSION = 1

PRESETS = ("stable", "expressive")  # decode presets in the repo's config.json
DEFAULT_PRESET = "stable"
DEFAULT_VOICE = "Bruno"

CPU_WARNING = (
    "KittenTTS 2 is running on the CPU, about 15× slower than real time. "
    "A CUDA GPU makes it practical."
)

# The voices that ship with the weights (`voices/voices.json`, 115 entries as of
# kittenml 0.9.4). Kept here so the profile form works before the weights are
# downloaded; `preset_voices()` prefers the list the downloaded model carries,
# and `load()` warns if the two ever disagree.
KITTEN_PRESET_VOICES: tuple[str, ...] = (
    "AirportAnnouncer", "Alfred", "Arabic", "ArabicFalconer", "ArabicMother",
    "ArabicNews", "AudiobookNarratorFemale", "Bella", "BoredTeenager", "Bruno",
    "CalmHostageNegotiator", "Chinese", "ChineseLivestreamSeller",
    "ChineseNewsCctv", "ChineseXianxiaMaster", "Claire", "Dante", "Diana",
    "Dolores", "DutchBaker", "DutchGrandpaStory", "DutchWeatherPresenter",
    "Edith", "Eleanor", "Elliot", "FairytaleNarratorWhimsical", "Frank",
    "French", "FrenchDocumentary", "FrenchGrandmereRecette", "FrenchTeacher",
    "FrenchWaiter", "German", "GermanKneipe", "GermanProfessor",
    "GermanTrainAnnouncement", "Grace", "GrandmaBedtimeStory", "GriefEulogy",
    "Herbert", "Hindi", "HindiBollywoodDrama", "HindiCollegeFriends",
    "HindiDadiKahani", "HindiYogaTeacher", "Hugo", "IndonesianNewsAnchor",
    "IndonesianTourGuide", "Iris", "Italian", "ItalianFashionDesigner",
    "ItalianFootballFan", "ItalianGondolier", "ItalianNonnaKitchen",
    "ItalianOperaTenor", "JapaneseAnimeHeroine", "JapaneseGrandma",
    "JapaneseSalarymanApology", "JapaneseTrainConductor", "Jasper", "Julian",
    "Kiki", "KoreanGrandpaAdvice", "KoreanKdramaConfession", "KoreanNewsAnchor",
    "Laurence", "Leo", "Luna", "Maeve", "Marcus", "Martha", "Matthew", "Miles",
    "NervousFirstDate", "NewsAnchorFemale", "Otis", "PilotCabinAnnouncement",
    "PolishBabciaPierogi", "PolishMountainGuide", "PolishNewsAnchor",
    "PolishPoetryStudent", "Portuguese", "PortugueseBeach", "PortugueseBusiness",
    "PortugueseFado", "PortugueseGrandpaFarm", "PortugueseNewsAnchor", "Raven",
    "Reginald", "Rosie", "Russian", "RussianBabushka", "RussianFairyTale",
    "RussianHockeyCheer", "RussianLiteratureTeacher", "RussianSpaceControl",
    "RussianTaxiDriver", "Sable", "Saoirse", "SarcasticCoworker", "Serena",
    "Spanish", "SpanishAbuela", "SpanishBreakupSad", "SpanishNews",
    "SpanishTango", "TurkishFisherman", "TurkishGrandmaCooking",
    "TurkishNewsAnchor", "Victor", "Victoria", "Vincent", "Walter",
    "WeatherPresenterCheerful", "Willow",
)


def _voices_json() -> Path | None:
    """The `voices.json` of the downloaded weights, if they are on disk."""
    repo = config.models_dir() / ("models--" + catalog.KITTEN_REPO.replace("/", "--"))
    for candidate in sorted((repo / "snapshots").glob("*/voices/voices.json")):
        return candidate
    return None


def preset_voices() -> list[str]:
    """Names accepted for a preset profile.

    Read from the downloaded model when there is one — the model is the source of
    truth — and from the bundled list otherwise.
    """
    path = _voices_json()
    if path is not None:
        try:
            names = list(json.loads(path.read_text(encoding="utf-8")))
            if names:
                return names
        except (OSError, ValueError):
            log.warning("could not read %s; using the bundled voice list", path)
    return list(KITTEN_PRESET_VOICES)


class KittenBackend:
    name = "kitten"
    supports_cloning = True
    optional = False

    def __init__(self) -> None:
        self._model = None
        self._device: str | None = None
        self._warning: str | None = None

    # -- capability ------------------------------------------------------

    def available(self) -> bool:
        return find_spec("kittenml") is not None and find_spec("torch") is not None

    def is_loaded(self) -> bool:
        return self._model is not None

    def device(self) -> str | None:
        return self._device

    # -- lifecycle -------------------------------------------------------

    def load(self) -> None:
        if self._model is not None:
            return
        if not self.available():
            raise BackendUnavailable(
                "kittenml is not installed. Re-run setup, or: pip install kittenml==0.9.4"
            )

        from huggingface_hub import snapshot_download  # noqa: PLC0415
        from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415
        from kittenml import KittenTTS  # noqa: PLC0415

        # Read at load time, not import: the Models page can switch variant while
        # the app is running (and unloads us when it does).
        spec = catalog.active_model("kitten")
        try:
            # Offline on purpose: weights are fetched by the Models page, never as
            # a side effect of generating something.
            local = snapshot_download(
                repo_id=spec.repo_id,
                allow_patterns=list(spec.allow_patterns) or None,
                local_files_only=True,
            )
        except LocalEntryNotFoundError as exc:
            raise BackendUnavailable(
                f"{spec.title} is not downloaded. Get it from the Models page."
            ) from exc

        # bf16 is what the weights are published in and what runs on every CUDA
        # card tested; only the device is ours to choose. MPS is not supported.
        plan = devices.pick_device(
            engine="KittenTTS 2", wants_bf16=True, allow_fp16=True, supports_mps=False
        )
        device = "cuda" if plan.kind == "cuda" else "cpu"
        self._device = device
        self._warning = CPU_WARNING if device == "cpu" else None

        log.info("loading %s (%s) on %s", spec.repo_id, spec.variant, device)
        self._model = KittenTTS(local, device=device, weights=spec.variant or None)

        known = set(getattr(self._model, "available_voices", []) or [])
        if known and known != set(KITTEN_PRESET_VOICES):
            log.warning(
                "kittenml reports %d voices but the bundled list has %d; "
                "the downloaded model's list is used",
                len(known), len(KITTEN_PRESET_VOICES),
            )

    def unload(self) -> None:
        self._model = None
        self._device = None
        self._warning = None
        devices.release_gpu_memory()

    # -- voice prints ----------------------------------------------------

    @staticmethod
    def _require_clone_inputs(voice: VoiceSpec) -> tuple[str, str]:
        if not voice.sample_path or not Path(voice.sample_path).is_file():
            raise RuntimeError("this profile has no reference sample on disk.")
        transcript = (voice.sample_text or "").strip()
        if not transcript:
            # Without it kittenml would download Whisper large-v3 (~3 GB).
            raise RuntimeError(
                "KittenTTS 2 needs the transcript of the reference sample "
                "(what the clip says). Add it to the profile."
            )
        return voice.sample_path, transcript

    def prepare_voice(self, voice: VoiceSpec, out_path: Path) -> VoicePrint:
        """Compute this profile's speaker embedding and reference tokens once.

        Uses kittenml's own hooks (`speaker_encoder`, `codec.encode_reference`),
        which are private API in 0.9.4 — hence the pin. The clip stays on disk:
        the vocoder conditioning is rebuilt from it at generation time, so the
        voice print supplements the sample rather than replacing it.
        """
        sample, transcript = self._require_clone_inputs(voice)
        if self._model is None:
            self.load()
        model = self._model

        embedding = np.asarray(model.speaker_encoder(sample), dtype=np.float32).reshape(-1)
        tokens = np.asarray(model.codec.encode_reference(sample), dtype=np.int64).reshape(-1)
        repo = catalog.active_repo_id("kitten")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Plain arrays through np.savez: loading never needs pickle, so a voice
        # print can't carry code. An open file keeps np.savez from appending
        # ".npz" to the name the caller expects.
        with open(out_path, "wb") as handle:
            np.savez(
                handle,
                version=np.array(VOICE_PRINT_VERSION),
                model_id=np.array(repo),
                embedding=embedding,
                reference_tokens=tokens,
                transcript=np.array(transcript),
                sample_path=np.array(sample),
            )

        self._seed_cache(sample, transcript, embedding, tokens)
        return VoicePrint(
            path=out_path,
            mode="icl",
            model_id=repo,
            device=self._device,
            size_bytes=out_path.stat().st_size,
            warning=self._warning,
        )

    def _seed_cache(self, sample: str, transcript: str, embedding, tokens) -> None:
        """Hand a reference to kittenml so `generate` skips re-analysing the clip.

        Best effort: these are private attributes, and if a different kittenml is
        installed the clip is simply analysed again, which is slower, not wrong.
        """
        try:
            from kittenml.kittentts2.vocoder import resolve_reference_path  # noqa: PLC0415

            key = ("clone", resolve_reference_path(sample), transcript)
            if key not in self._model._reference_cache:
                self._model._reference_cache[key] = self._model._build_reference(
                    embedding=embedding,
                    reference_tokens=[int(t) for t in tokens],
                    transcript=transcript,
                    reference_wav=sample,
                )
        except Exception:  # noqa: BLE001 - an optimisation must not fail the job
            log.info("could not reuse the voice print; kittenml will re-analyse the clip",
                     exc_info=True)

    def _reuse_voice_print(self, voice: VoiceSpec, sample: str, transcript: str) -> None:
        path = Path(voice.voice_path) if voice.voice_path else None
        if path is None or not path.is_file():
            return
        try:
            with np.load(path, allow_pickle=False) as payload:
                if int(payload["version"]) != VOICE_PRINT_VERSION:
                    log.info("voice print %s predates this build; ignoring", path)
                    return
                if str(payload["transcript"]) != transcript:
                    log.info("voice print %s was made for another transcript; ignoring", path)
                    return
                embedding = payload["embedding"]
                tokens = payload["reference_tokens"]
        except Exception as exc:  # noqa: BLE001 - a bad file must not be fatal
            log.warning("voice print %s is unreadable (%s); re-analysing", path, exc)
            return
        log.info("using prepared voice print %s", path)
        self._seed_cache(sample, transcript, embedding, tokens)

    # -- synthesis -------------------------------------------------------

    @staticmethod
    def _options(voice: VoiceSpec) -> tuple[str | None, dict[str, Any] | None]:
        preset = voice.options.get("preset") or None
        if preset is not None and preset not in PRESETS:
            raise ValueError(f"unknown style {preset!r}; choose one of {list(PRESETS)}")
        seed = voice.options.get("seed")
        return preset, ({"seed": int(seed)} if seed is not None else None)

    def synthesize(self, text: str, voice: VoiceSpec, out_path: Path) -> SynthesisResult:
        import soundfile as sf  # noqa: PLC0415

        preset, advanced = self._options(voice)
        if voice.sample_path:  # a clone: validate before loading 1.7B parameters
            sample, transcript = self._require_clone_inputs(voice)
        if self._model is None:
            self.load()
        model = self._model

        if voice.sample_path:
            self._reuse_voice_print(voice, sample, transcript)
            samples = model.generate(
                text, reference=sample, reference_text=transcript,
                preset=preset, advanced=advanced,
            )
        else:
            name = voice.preset_voice or DEFAULT_VOICE
            samples = model.generate(text, voice=name, preset=preset, advanced=advanced)

        waveform = np.asarray(samples, dtype="float32").reshape(-1)
        rate = int(model.sample_rate)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), waveform, rate)

        warnings = [w for w in (self._warning, self._speed_note(voice)) if w]
        return SynthesisResult(
            path=out_path,
            duration_seconds=len(waveform) / rate,
            device=self._device,
            warning=" ".join(warnings) or None,
        )

    @staticmethod
    def _speed_note(voice: VoiceSpec) -> str | None:
        if abs(voice.speed - 1.0) < 1e-6:
            return None
        return "KittenTTS 2 has no speed control; the speed setting was ignored."
