"""Checks for the KittenTTS 2 engine (docs/audio-roadmap.md, Phase 3).

No kittenml, no weights, no GPU: the model is a fake that records what the
backend asked of it. What is verified here is *our* logic: which arguments
reach kittenml, that a clone can never trigger the Whisper download, that voice
prints round-trip without pickle, and that the catalog describes the download
the way the Models page needs. The real model is exercised by
`test_generate_kitten.py`, which skips itself when it can't run.

    python backend/tests/test_kitten.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
from importlib.util import find_spec
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-kitten-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"
os.environ["VOICECRAFT_IDLE_UNLOAD_SECONDS"] = "0"
for _var in ("VOICECRAFT_QWEN_MODEL", "VOICECRAFT_KOKORO_MODEL", "VOICECRAFT_KITTEN_MODEL"):
    os.environ.pop(_var, None)

import numpy as np  # noqa: E402

import catalog  # noqa: E402
import config  # noqa: E402
from backends import kitten_backend  # noqa: E402
from backends.base import VoiceSpec  # noqa: E402
from backends.kitten_backend import KITTEN_PRESET_VOICES, KittenBackend  # noqa: E402
from services import model_service  # noqa: E402

PASSED = 0
FAILED = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        print(f"  FAIL  {label} {detail}")


def raises(fn, exc=Exception) -> str | None:
    try:
        fn()
    except exc as error:
        return str(error)
    return None


# --------------------------------------------------------------------------


class FakeCodec:
    def encode_reference(self, path):
        return np.arange(40, dtype=np.int64)


class FakeModel:
    """Stands in for kittenml.kittentts2.KittenTTS2."""

    sample_rate = 24000
    available_voices = list(KITTEN_PRESET_VOICES)

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.built: list[dict] = []
        self._reference_cache: dict = {}
        self.codec = FakeCodec()
        self.transcribed = 0

    def speaker_encoder(self, path):
        return np.linspace(0, 1, 512, dtype=np.float32)

    def _build_reference(self, embedding, reference_tokens, transcript, reference_wav):
        self.built.append(
            {"tokens": list(reference_tokens), "transcript": transcript, "wav": reference_wav}
        )
        return {"transcript": transcript}

    def generate(self, text, voice=None, reference=None, reference_text=None,
                 preset=None, advanced=None, **_):
        self.calls.append(dict(text=text, voice=voice, reference=reference,
                               reference_text=reference_text, preset=preset, advanced=advanced))
        return np.zeros(24000, dtype=np.float32)  # one second of silence


def install_fake_kittenml() -> None:
    """`_seed_cache` imports one helper from kittenml; give it a stand-in."""
    vocoder = types.ModuleType("kittenml.kittentts2.vocoder")
    vocoder.resolve_reference_path = lambda path: str(Path(path))
    for name in ("kittenml", "kittenml.kittentts2"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["kittenml.kittentts2.vocoder"] = vocoder


def make_backend() -> tuple[KittenBackend, FakeModel]:
    backend = KittenBackend()
    model = FakeModel()
    backend._model = model
    backend._device = "cuda"
    return backend, model


def write_wav(path: Path) -> str:
    import soundfile as sf

    sf.write(str(path), np.zeros(24000, dtype="float32"), 24000)
    return str(path)


# --------------------------------------------------------------------------


def test_voice_list() -> None:
    print("preset voices")
    check("115 bundled voices", len(KITTEN_PRESET_VOICES) == 115, str(len(KITTEN_PRESET_VOICES)))
    check("no duplicates", len(set(KITTEN_PRESET_VOICES)) == len(KITTEN_PRESET_VOICES))
    check("the model's default voice is in it", kitten_backend.DEFAULT_VOICE in KITTEN_PRESET_VOICES)

    config.save_settings({"models_dir": str(_DATA_DIR / "hub")})
    check("no download: the bundled list is used",
          kitten_backend.preset_voices() == list(KITTEN_PRESET_VOICES))

    voices = _DATA_DIR / "hub" / "models--KittenML--kitten-tts-2" / "snapshots" / "rev1" / "voices"
    voices.mkdir(parents=True)
    (voices / "voices.json").write_text(
        json.dumps({"Bruno": {}, "Zoë": {}}, ensure_ascii=False), encoding="utf-8"
    )
    check("the downloaded model's list wins, read as UTF-8",
          kitten_backend.preset_voices() == ["Bruno", "Zoë"])
    (voices / "voices.json").write_text("{broken", encoding="utf-8")
    check("a corrupt file falls back to the bundled list",
          kitten_backend.preset_voices() == list(KITTEN_PRESET_VOICES))
    (voices / "voices.json").unlink()
    config.clear_setting("models_dir")


def test_catalog() -> None:
    print("catalog")
    packed = catalog.get("kitten-tts-2")
    small = catalog.get("kitten-tts-2-emb4")
    check("both entries exist", packed is not None and small is not None)
    check("they share one repo", packed.repo_id == small.repo_id == "KittenML/kitten-tts-2")
    check("variants differ", {packed.variant, small.variant} == {"packed", "emb4"})
    check("the standard variant is the engine default", packed.default and not small.default)
    check("both clone", packed.clones_voices and small.clones_voices)
    check("conditional tier, not gated",
          packed.license_tier == small.license_tier == catalog.TIER_CONDITIONAL
          and not packed.gated and not small.gated)
    check("license named and linked", "Stellon" in packed.license_name and packed.license_url.startswith("https://"))
    check("each entry fetches only its own weights",
          any("ternary" in p for p in packed.allow_patterns)
          and not any("emb4" in p for p in packed.allow_patterns)
          and any("emb4" in p for p in small.allow_patterns)
          and not any("ternary" in p for p in small.allow_patterns))
    check("the llama.cpp bundle is never fetched",
          not any(p.startswith("cpp") or p == "*" for p in packed.allow_patterns + small.allow_patterns))
    check("the vocoder from the second repo is part of the download",
          [e.repo_id for e in packed.extra_files] == ["ResembleAI/chatterbox-turbo"]
          and packed.extra_files == small.extra_files)
    check("estimate counts it", packed.download_estimate_bytes > packed.size_bytes + 900 * catalog.MB)
    check("the small one is smaller", small.download_estimate_bytes < packed.download_estimate_bytes)
    check("twenty languages", len(packed.languages) == 20 and {"en", "de", "ja"} <= set(packed.languages))

    check("engine is known to the catalog", "kitten" in catalog.engines())
    check("default variant is active", catalog.active_model("kitten").id == "kitten-tts-2")

    # `is_downloaded` must not call a half-fetched repo ready.
    hub = _DATA_DIR / "hub2"
    config.save_settings({"models_dir": str(hub)})
    snap = hub / "models--KittenML--kitten-tts-2" / "snapshots" / "rev1"
    for name in ("config.json", "lm/config.json", "lm/merges.txt", "lm/model-tl2-emb4.safetensors",
                 "speaker/model.safetensors", "voices/voices.json"):
        (snap / name).parent.mkdir(parents=True, exist_ok=True)
        (snap / name).write_bytes(b"x")
    check("emb4 weights present but vocoder missing: not downloaded",
          not model_service.spec_downloaded(small))
    vocoder = hub / "models--ResembleAI--chatterbox-turbo" / "snapshots" / "rev1" / "s3gen_meanflow.safetensors"
    vocoder.parent.mkdir(parents=True, exist_ok=True)
    vocoder.write_bytes(b"x")
    check("with the vocoder the small variant is downloaded", model_service.spec_downloaded(small))
    check("the other variant is still missing its weights", not model_service.spec_downloaded(packed))
    config.clear_setting("models_dir")


def test_options() -> None:
    print("options")
    options = KittenBackend._options
    check("no options", options(VoiceSpec()) == (None, None))
    check("preset and seed", options(VoiceSpec(options={"preset": "expressive", "seed": 7}))
          == ("expressive", {"seed": 7}))
    check("a seed of 0 is a seed", options(VoiceSpec(options={"seed": 0})) == (None, {"seed": 0}))
    check("unknown style rejected", raises(lambda: options(VoiceSpec(options={"preset": "angry"})), ValueError) is not None)


def test_clone() -> None:
    print("clone")
    install_fake_kittenml()
    backend, model = make_backend()
    sample = write_wav(_DATA_DIR / "clone.wav")
    out = _DATA_DIR / "voices" / "p1.vprint"

    voice = VoiceSpec(sample_path=sample, sample_text="The quick brown fox.")
    message = raises(lambda: backend.prepare_voice(VoiceSpec(sample_path=sample), out))
    check("no transcript: refused", message is not None and "transcript" in message, str(message))
    message = raises(lambda: backend.prepare_voice(VoiceSpec(sample_path=sample, sample_text="  "), out))
    check("blank transcript: refused", message is not None)
    check("refusal happens before any model work", model.calls == [] and model.built == [])
    check("nothing was written", not out.exists())
    message = raises(lambda: backend.prepare_voice(VoiceSpec(sample_path=str(_DATA_DIR / "nope.wav"), sample_text="x"), out))
    check("missing sample refused", message is not None)

    print_ = backend.prepare_voice(voice, out)
    check("voice print written under the requested name", out.is_file() and print_.path == out)
    check("mode is icl (audio + transcript)", print_.mode == "icl")
    check("model id is the repo", print_.model_id == "KittenML/kitten-tts-2")
    check("size reported", print_.size_bytes == out.stat().st_size and print_.size_bytes > 0)
    with np.load(out, allow_pickle=False) as payload:
        check("loads without pickle", payload["embedding"].shape == (512,) and payload["embedding"].dtype == np.float32)
        check("tokens, transcript and sample are kept",
              payload["reference_tokens"].shape == (40,)
              and str(payload["transcript"]) == "The quick brown fox."
              and str(payload["sample_path"]) == sample)
        check("version stored", int(payload["version"]) == kitten_backend.VOICE_PRINT_VERSION)
    key = ("clone", sample, "The quick brown fox.")
    check("kittenml's reference cache is seeded", key in model._reference_cache)

    # Generation reuses the print: a fresh model gets the reference rebuilt from
    # the file, with no call to the speaker encoder or the codec.
    backend2, model2 = make_backend()
    model2.speaker_encoder = lambda path: (_ for _ in ()).throw(AssertionError("analysed again"))
    result = backend2.synthesize("Hello there.", VoiceSpec(
        sample_path=sample, sample_text="The quick brown fox.", voice_path=str(out),
        options={"preset": "expressive", "seed": 11}), _DATA_DIR / "out" / "a.wav")
    call = model2.calls[0]
    check("cloned through reference + transcript",
          call["reference"] == sample and call["reference_text"] == "The quick brown fox." and call["voice"] is None)
    check("preset and seed forwarded", call["preset"] == "expressive" and call["advanced"] == {"seed": 11})
    check("the print's reference was rebuilt, not recomputed",
          model2.built and model2.built[0]["tokens"] == list(range(40)))
    check("wav written at the model's rate", Path(result.path).is_file() and abs(result.duration_seconds - 1.0) < 1e-6)
    check("device reported", result.device == "cuda" and result.warning is None)

    stale = _DATA_DIR / "voices" / "stale.vprint"
    with open(stale, "wb") as handle:
        np.savez(handle, version=np.array(0), embedding=np.zeros(512, np.float32),
                 reference_tokens=np.zeros(3, np.int64), transcript=np.array("other"))
    backend3, model3 = make_backend()
    backend3.synthesize("x", VoiceSpec(sample_path=sample, sample_text="The quick brown fox.",
                                       voice_path=str(stale)), _DATA_DIR / "out" / "b.wav")
    check("an outdated print is ignored (kittenml analyses the clip itself)",
          not model3.built and model3.calls[0]["reference"] == sample)
    garbage = _DATA_DIR / "voices" / "garbage.vprint"
    garbage.write_bytes(b"not an npz")
    backend4, model4 = make_backend()
    backend4.synthesize("x", VoiceSpec(sample_path=sample, sample_text="The quick brown fox.",
                                       voice_path=str(garbage)), _DATA_DIR / "out" / "c.wav")
    check("an unreadable print is not fatal", len(model4.calls) == 1)

    backend5, model5 = make_backend()
    message = raises(lambda: backend5.synthesize("x", VoiceSpec(sample_path=sample), _DATA_DIR / "out" / "d.wav"))
    check("generation without a transcript is refused (no Whisper download)",
          message is not None and "transcript" in message and model5.calls == [])


def test_preset() -> None:
    print("preset voice")
    backend, model = make_backend()
    backend.synthesize("Hi.", VoiceSpec(preset_voice="Luna"), _DATA_DIR / "out" / "p.wav")
    call = model.calls[0]
    check("speaks with the named voice", call["voice"] == "Luna" and call["reference"] is None)
    check("no options means the model's defaults", call["preset"] is None and call["advanced"] is None)
    backend.synthesize("Hi.", VoiceSpec(), _DATA_DIR / "out" / "p2.wav")
    check("falls back to the default voice", model.calls[1]["voice"] == kitten_backend.DEFAULT_VOICE)

    result = backend.synthesize("Hi.", VoiceSpec(preset_voice="Luna", speed=1.5), _DATA_DIR / "out" / "p3.wav")
    check("speed is not silently dropped", result.warning is not None and "speed" in result.warning)
    backend._warning = kitten_backend.CPU_WARNING
    result = backend.synthesize("Hi.", VoiceSpec(preset_voice="Luna"), _DATA_DIR / "out" / "p4.wav")
    check("the CPU warning reaches the result", result.warning == kitten_backend.CPU_WARNING)


def test_lifecycle() -> None:
    print("lifecycle")
    backend = KittenBackend()
    check("not loaded at first", not backend.is_loaded() and backend.device() is None)
    wanted = find_spec("kittenml") is not None and find_spec("torch") is not None
    check("available() mirrors whether kittenml and torch import", backend.available() == wanted)
    # load() itself is deliberately not called here: with kittenml installed it
    # would read the real weights from the user's Hugging Face cache.
    check("not optional", backend.optional is False and backend.supports_cloning is True)
    backend, _model = make_backend()
    check("loaded", backend.is_loaded() and backend.device() == "cuda")
    backend.unload()
    check("unload drops the model", not backend.is_loaded() and backend.device() is None)


def main() -> int:
    test_voice_list()
    test_catalog()
    test_options()
    test_lifecycle()  # before test_clone, which puts a stand-in kittenml in sys.modules
    test_clone()
    test_preset()
    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
