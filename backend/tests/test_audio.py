"""Checks for the audio backend (docs/audio-roadmap.md, Phase 4).

No model weights, no GPU: the music / SFX engines are replaced by a fake that
writes a sine WAV, the Hugging Face cache is a folder of tiny files, and the GPU
probe is patched, so nothing here initialises CUDA. Run from the repo root:

    python backend/tests/test_audio.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-audio-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"
os.environ["VOICECRAFT_IDLE_UNLOAD_SECONDS"] = "0"
for _var in ("VOICECRAFT_QWEN_MODEL", "VOICECRAFT_KOKORO_MODEL"):
    os.environ.pop(_var, None)

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

import catalog  # noqa: E402
import config  # noqa: E402
from backends import _REGISTRY, AudioSpec, audio_backends  # noqa: E402
from backends import device as devices  # noqa: E402
from backends.audio_engines import (  # noqa: E402
    ACESTEP_MAX_SECONDS,
    GIB,
    AceStepBackend,
    MossSfxBackend,
)
from backends.base import BackendUnavailable, Support, SynthesisResult  # noqa: E402
from database import session as db_session  # noqa: E402
from services import model_service  # noqa: E402
from utils import audio  # noqa: E402

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


def _raises(exc: type[BaseException], fn, *args) -> bool:
    try:
        fn(*args)
    except exc:
        return True
    return False


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 16)


def fake_snapshot(cache: Path, repo_id: str, files: list[str]) -> None:
    root = cache / f"models--{repo_id.replace('/', '--')}"
    for name in files:
        touch(root / "snapshots" / "abc123" / name)
    (root / "blobs").mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------

TURBO_FILES = [
    "config.json",
    "acestep-v15-turbo/config.json", "acestep-v15-turbo/model.safetensors",
    "acestep-5Hz-lm-1.7B/config.json", "acestep-5Hz-lm-1.7B/model.safetensors",
    "Qwen3-Embedding-0.6B/config.json", "Qwen3-Embedding-0.6B/model.safetensors",
    "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
]
SHARED_FILES = [extra.filename for extra in catalog.ACESTEP_SHARED]


def test_catalog() -> None:
    print("catalog: music and sfx entries")
    check("categories list music and sfx after speech",
          [key for key, _ in catalog.CATEGORIES] == ["speech", "music", "sfx"])
    check("music defaults to ACE-Step, sfx to MOSS",
          catalog.default_engine("music") == "acestep" and catalog.default_engine("sfx") == "moss_sfx")
    check("an empty category has no default", catalog.default_engine("nope") is None)
    check("engines_for groups by category",
          catalog.engines_for("music") == ("acestep", "sa3_music")
          and catalog.engines_for("sfx") == ("moss_sfx", "sa3_sfx"))

    audio_specs = [s for s in catalog.MODELS if s.category in ("music", "sfx")]
    check("six audio entries", {s.id for s in audio_specs} == {
        "acestep-1.5-turbo", "acestep-1.5-sft", "acestep-1.5-xl-turbo", "moss-sfx-v2",
        "sa3-small-music", "sa3-small-sfx"})
    check("all are on-demand engines with a license link",
          all(s.optional_engine and s.license_url for s in audio_specs))
    open_specs = [s for s in audio_specs if not s.engine.startswith("sa3_")]
    check("ACE-Step and MOSS are open and not gated",
          all(s.license_tier == "open" and not s.gated for s in open_specs))
    check("exactly one default per kind",
          sum(s.default for s in audio_specs if s.category == "music") == 1
          and sum(s.default for s in audio_specs if s.category == "sfx") == 1)
    check("the engine names match registered backends",
          {s.engine for s in audio_specs} <= set(audio_backends()))
    check("sizes are plausible (turbo ~10 GB, MOSS ~11 GB)",
          10 * catalog.GB < catalog.get("acestep-1.5-turbo").size_bytes < 11 * catalog.GB
          and 11 * catalog.GB < catalog.get("moss-sfx-v2").size_bytes < 12 * catalog.GB)

    sft, xl = catalog.get("acestep-1.5-sft"), catalog.get("acestep-1.5-xl-turbo")
    check("sft and XL borrow files from the turbo repo",
          all(extra.repo_id == catalog.ACESTEP_REPO for extra in sft.extra_files)
          and sft.extra_files == xl.extra_files and len(sft.extra_files) > 5)
    check("the borrowed files are counted in the estimate",
          sft.download_estimate_bytes > sft.size_bytes)
    check("every shared file is one the turbo repo really has",
          all(name in TURBO_FILES or name.startswith("Qwen3-Embedding-0.6B/") for name in SHARED_FILES))


def test_attributions() -> None:
    print("about: attributions match the catalog")
    path = BACKEND.parent / "app" / "src" / "lib" / "attributions.ts"
    text = path.read_text(encoding="utf-8")
    urls = {spec.license_url for spec in catalog.MODELS if spec.license_url}
    # The Apache link is a shared constant in the file, every other one is inline.
    missing = sorted(
        url for url in urls - {catalog.APACHE_2} if f'"{url}"' not in text
    )
    check("every catalog license link is listed in About", not missing, str(missing))
    check("the Apache link constant is the catalog's",
          f'APACHE_2 = "{catalog.APACHE_2}"' in text and "licenseUrl: APACHE_2" in text)
    check("every engine family has an About entry", all(
        name in text for name in (
            "Qwen3-TTS", "Kokoro", "KittenTTS 2", "ACE-Step", "MOSS-SoundEffect", "Stable Audio 3 Small")))
    check("Powered by KittenML is shown", "Powered by KittenML" in text)
    check("Powered by Stability AI is shown", "Powered by Stability AI" in text)
    import re

    repos = {spec.repo_id for spec in catalog.MODELS}
    sources = re.findall(r'sourceUrl: "https://huggingface\.co/([^"]+)"', text)
    check("every model page link points at a catalog repo",
          len(sources) == 7 and all(repo in repos for repo in sources), str(sources))
    check("both Stable Audio 3 repos have a model page link",
          {catalog.SA3_REPO_MUSIC, catalog.SA3_REPO_SFX} <= set(sources))


def test_downloads() -> None:
    print("catalog: shared ACE-Step files")
    cache = _DATA_DIR / "hf-cache"
    config.save_settings({"models_dir": str(cache)})
    turbo, sft = catalog.get("acestep-1.5-turbo"), catalog.get("acestep-1.5-sft")
    try:
        # Only what sft borrows landed in the turbo repo: that must not make turbo "downloaded".
        fake_snapshot(cache, "ACE-Step/acestep-v15-sft", ["model.safetensors", "config.json"])
        fake_snapshot(cache, catalog.ACESTEP_REPO, SHARED_FILES)
        check("sft is downloaded once its repo and the borrowed files are there",
              model_service.spec_downloaded(sft))
        check("borrowed files alone don't make turbo look downloaded",
              not model_service.spec_downloaded(turbo))

        model_service.delete("acestep-1.5-sft")
        check("deleting sft also removes the borrowed files nobody else needs",
              not (cache / f"models--{catalog.ACESTEP_REPO.replace('/', '--')}").exists())

        fake_snapshot(cache, "ACE-Step/acestep-v15-sft", ["model.safetensors", "config.json"])
        fake_snapshot(cache, catalog.ACESTEP_REPO, TURBO_FILES + SHARED_FILES)
        check("the full repo makes turbo downloaded", model_service.spec_downloaded(turbo))
        check("and sft still is", model_service.spec_downloaded(sft))

        refused = False
        try:
            model_service.delete("acestep-1.5-turbo")
        except model_service.ModelError as exc:
            refused = "ACE-Step 1.5 (quality)" in str(exc)
        check("turbo can't be deleted while sft needs its files", refused)
        check("…and nothing was removed", model_service.spec_downloaded(turbo) and model_service.spec_downloaded(sft))

        model_service.delete("acestep-1.5-sft")
        check("deleting sft keeps turbo's repo", model_service.spec_downloaded(turbo))
        staged = AceStepBackend.stage_root() / "checkpoints" / "vae" / "weights.bin"
        touch(staged)
        model_service.delete("acestep-1.5-turbo")
        check("then turbo can go", not model_service.spec_downloaded(turbo))
        check("the links built for the engine go with the model, so no space is held",
              not AceStepBackend.stage_root().exists())
    finally:
        config.clear_setting("models_dir")


# --------------------------------------------------------------------------
# Engines and hardware rules
# --------------------------------------------------------------------------


def test_hardware_rules() -> None:
    print("engines: what this machine can run")
    ace, moss = AceStepBackend(), MossSfxBackend()
    real = devices.hardware
    try:
        devices.hardware = lambda: devices.Hardware()
        for engine in (ace, moss):
            support = engine.support()
            check(f"{engine.name}: no GPU -> unsupported, says why",
                  not support.ok and "NVIDIA" in (support.reason or ""))

        gtx1060 = devices.Hardware(True, (6, 1), int(6.0 * GIB), "GTX 1060")
        devices.hardware = lambda: gtx1060
        support = ace.support()
        check("ACE-Step on a 6 GB Pascal card: runs, capped at 30 s, with a warning",
              support.ok and support.max_duration_seconds == 30 and "30 seconds" in (support.warning or ""))
        support = moss.support()
        check("MOSS on 6 GB: runs, warns about minutes per clip, 30 s cap",
              support.ok and support.max_duration_seconds == 30 and "minutes" in (support.warning or ""))

        devices.hardware = lambda: devices.Hardware(True, (6, 1), 4 * GIB, "small")
        for engine in (ace, moss):
            support = engine.support()
            check(f"{engine.name}: 4 GB is too little", not support.ok and "4.0 GB" in (support.reason or ""))

        devices.hardware = lambda: devices.Hardware(True, (8, 6), 6 * GIB, "3060 laptop")
        check("ACE-Step: Ampere with only 6 GB is still capped",
              ace.support().max_duration_seconds == 30)
        devices.hardware = lambda: devices.Hardware(True, (7, 5), 16 * GIB, "2080")
        check("ACE-Step: no bf16 (pre-Ampere) is capped even with lots of VRAM",
              ace.support().max_duration_seconds == 30)

        devices.hardware = lambda: devices.Hardware(True, (8, 6), 24 * GIB, "3090")
        support = ace.support()
        check("ACE-Step on a big Ampere card: full length, no warning",
              support.ok and support.max_duration_seconds == ACESTEP_MAX_SECONDS and support.warning is None)
        support = moss.support()
        check("MOSS with 12 GB+: no warning", support.ok and support.warning is None and support.max_duration_seconds == 30)
    finally:
        devices.hardware = real


def test_adapter_basics() -> None:
    print("engines: availability and the refusals that come before any model is touched")
    import importlib  # noqa: PLC0415

    import huggingface_hub  # noqa: PLC0415
    from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

    ace = AceStepBackend()
    check("not installed -> unavailable", ace.available() is False)
    try:
        ace.generate(AudioSpec("x", 12), _DATA_DIR / "x.wav")
        message = ""
    except BackendUnavailable as exc:
        message = str(exc)
    check("generate says to install it from the Models page", "Models page" in message, message)
    check("nothing is left loaded", not ace.is_loaded() and ace.device() is None)

    # Pretend the package is installed: an empty `acestep` package on the path.
    package = _DATA_DIR / "fakepkgs" / "acestep"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    sys.path.insert(0, str(package.parent))
    importlib.invalidate_caches()
    real_hardware = devices.hardware
    real_download = huggingface_hub.snapshot_download

    def not_downloaded(**_kwargs):
        raise LocalEntryNotFoundError("not in the cache")

    try:
        check("an importable package counts as installed", ace.available() is True)

        devices.hardware = lambda: devices.Hardware()
        check("installed, but no CUDA: refuses", _raises(BackendUnavailable, ace.load))

        devices.hardware = lambda: devices.Hardware(True, (6, 1), int(6.0 * GIB), "GTX 1060")
        huggingface_hub.snapshot_download = not_downloaded
        try:
            ace.load()
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("installed, weights missing: says to download them", "Models page" in message, message)
        check("a failed load leaves it unloaded", not ace.is_loaded())
    finally:
        sys.path.remove(str(package.parent))
        sys.modules.pop("acestep", None)
        importlib.invalidate_caches()
        devices.hardware = real_hardware
        huggingface_hub.snapshot_download = real_download

    check("unload on a never-loaded engine is a no-op", ace.unload() is None)
    check("the real engines are registered as audio backends",
          {"acestep": "music", "moss_sfx": "sfx", "sa3_music": "music", "sa3_sfx": "sfx"}
          == {n: b.kind for n, b in audio_backends().items()})
    check("all of them are optional", all(b.optional for b in audio_backends().values()))


# --------------------------------------------------------------------------
# The MOSS adapter, against a fake pipeline with the real call shape
# --------------------------------------------------------------------------


def test_moss_adapter() -> None:
    """Everything the adapter does around `MossSoundEffectPipeline`.

    The fake mirrors the real signatures (`from_pretrained(path, torch_dtype,
    device)`, `pipe(prompt, seconds, num_inference_steps, cfg_scale, seed)` →
    a `(1, 1, samples)` tensor, `.engine.dit`, `.sample_rate`), read from the
    package in the spike's venv. Whether the real model sounds right is not
    something this can say.
    """
    print("moss: the real adapter against a fake pipeline")
    import importlib.machinery  # noqa: PLC0415
    import types  # noqa: PLC0415

    import huggingface_hub  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

    seen: dict = {"loads": [], "calls": []}

    class FakeEngine:
        def __init__(self) -> None:
            self.dit = torch.nn.Linear(4, 4)            # fp32, like the real DiT file
            self.device = torch.device("cpu")
            self.vram_management_enabled = False

    class FakePipeline:
        sample_rate = 48000
        nan = False

        def __init__(self) -> None:
            self.engine = FakeEngine()

        @classmethod
        def from_pretrained(cls, path, torch_dtype=None, device=None, **kwargs):
            seen["loads"].append({"path": path, "dtype": torch_dtype, "device": device})
            pipe = cls()
            seen["pipe"] = pipe
            return pipe

        def __call__(self, prompt, seconds=10.0, num_inference_steps=100, cfg_scale=4.0,
                     seed=0, **kwargs):
            seen["calls"].append({"prompt": prompt, "seconds": seconds,
                                  "steps": num_inference_steps, "cfg": cfg_scale, "seed": seed,
                                  "extra": kwargs})
            samples = int(self.sample_rate * round(seconds, 1))
            wave = torch.full((1, 1, samples), 0.25)
            if self.nan:
                wave[0, 0, 5] = float("nan")
            return wave

    module = types.ModuleType("moss_soundeffect_v2")
    module.__spec__ = importlib.machinery.ModuleSpec("moss_soundeffect_v2", None)
    module.MossSoundEffectPipeline = FakePipeline

    real_hardware = devices.hardware
    real_download = huggingface_hub.snapshot_download
    had_env = os.environ.get("TORCHDYNAMO_DISABLE")
    moss = MossSfxBackend()
    snapshot = _DATA_DIR / "moss-snapshot"
    snapshot.mkdir(exist_ok=True)
    out = _DATA_DIR / "moss-out" / "door.wav"

    def not_downloaded(**_kwargs):
        raise LocalEntryNotFoundError("not in the cache")

    sys.modules["moss_soundeffect_v2"] = module
    try:
        check("a package on the path counts as installed", moss.available())

        devices.hardware = lambda: devices.Hardware()
        check("no CUDA: refuses with the reason", _raises(BackendUnavailable, moss.load))
        check("…and stays unloaded", not moss.is_loaded() and not seen["loads"])

        devices.hardware = lambda: devices.Hardware(True, (6, 1), int(6.0 * GIB), "GTX 1060")
        huggingface_hub.snapshot_download = not_downloaded
        try:
            moss.load()
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("weights missing: says to download them, loads nothing",
              "Models page" in message and not seen["loads"] and not moss.is_loaded(), message)

        asked: dict = {}

        def downloaded(**kwargs):
            asked.update(kwargs)
            return str(snapshot)

        huggingface_hub.snapshot_download = downloaded
        os.environ.pop("TORCHDYNAMO_DISABLE", None)
        moss.load()
        check("the cache is read offline, for the catalog's repo",
              asked.get("local_files_only") is True and asked.get("repo_id") == catalog.MOSS_SFX_REPO, str(asked))
        load = seen["loads"][0]
        check("loaded from the snapshot folder, on the CPU, as bf16",
              load["path"] == str(snapshot) and load["device"] == "cpu" and load["dtype"] == torch.bfloat16, str(load))
        engine = seen["pipe"].engine
        check("only the DiT's parameters are bf16",
              all(p.dtype == torch.bfloat16 for p in engine.dit.parameters()))
        check("the engine is told to use CUDA with its own offload on",
              engine.device == torch.device("cuda") and engine.vram_management_enabled is True)
        check("torch.compile is switched off (Windows has no Triton)",
              os.environ.get("TORCHDYNAMO_DISABLE") == "1")
        check("it reports itself loaded on cuda", moss.is_loaded() and moss.device() == "cuda")

        before = len(seen["loads"])
        moss.load()
        check("loading twice does nothing", len(seen["loads"]) == before)

        result = moss.generate(AudioSpec("heavy wooden door slamming", 3.0), out)
        call = seen["calls"][-1]
        check("defaults: 20 steps, guidance 4, a seed was drawn",
              call["steps"] == 20 and call["cfg"] == 4.0 and 0 <= call["seed"] < 2**31, str(call))
        check("the prompt and length reach the pipeline unchanged",
              call["prompt"] == "heavy wooden door slamming" and call["seconds"] == 3.0)
        data, rate = sf.read(str(out), dtype="float32")
        check("a mono 48 kHz WAV of the asked length",
              rate == 48000 and data.ndim == 1 and abs(len(data) / rate - 3.0) < 0.01, f"{rate} {data.shape}")
        check("the result carries path, length and device",
              result.path == out and abs((result.duration_seconds or 0) - 3.0) < 0.01 and result.device == "cuda")

        moss.generate(AudioSpec("rain", 5.0, seed=7, steps=8, guidance=2.5), out)
        call = seen["calls"][-1]
        check("explicit seed, steps and guidance are forwarded",
              (call["seed"], call["steps"], call["cfg"]) == (7, 8, 2.5), str(call))

        moss.generate(AudioSpec("long", 45.0), out)
        check("a clip over 30 s is clamped, not passed through",
              seen["calls"][-1]["seconds"] == 30.0)

        FakePipeline.nan = True
        try:
            moss.generate(AudioSpec("broken", 2.0), out)
            message = ""
        except RuntimeError as exc:
            message = str(exc)
        check("NaN audio is an error, not a silent file", "invalid audio" in message, message)
        FakePipeline.nan = False

        moss.unload()
        check("unload drops the pipeline",
              moss._pipe is None and not moss.is_loaded() and moss.device() is None)
        try:
            moss._generate(AudioSpec("x", 1.0), out)
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("generating without a pipeline is a clear error", "unloaded" in message, message)

        # A setup failure must not leave a half-loaded engine that looks usable.
        original = MossSfxBackend._offload
        MossSfxBackend._offload = staticmethod(lambda pipe, torch_: (_ for _ in ()).throw(RuntimeError("boom")))
        try:
            check("a failing offload step propagates", _raises(RuntimeError, moss.load))
        finally:
            MossSfxBackend._offload = original
        check("…and leaves it unloaded", not moss.is_loaded() and moss._pipe is None)
    finally:
        sys.modules.pop("moss_soundeffect_v2", None)
        devices.hardware = real_hardware
        huggingface_hub.snapshot_download = real_download
        if had_env is None:
            os.environ.pop("TORCHDYNAMO_DISABLE", None)
        else:
            os.environ["TORCHDYNAMO_DISABLE"] = had_env
        torch._dynamo.config.disable = False


# --------------------------------------------------------------------------
# The staged checkpoint folder
# --------------------------------------------------------------------------


def test_checkpoint_stage() -> None:
    print("stage: a private checkpoint folder made of links into the cache")
    from backends import checkpoint_stage  # noqa: PLC0415

    base = _DATA_DIR / "stage"
    cache = base / "cache" / "main"
    big = b"w" * (checkpoint_stage.COPY_BELOW_BYTES + 1024)
    (cache / "dit").mkdir(parents=True)
    (cache / "dit" / "model.safetensors").write_bytes(big)
    (cache / "dit" / "modeling.py").write_text("original code")
    (cache / "dit" / "config.json").write_text("{}")
    (cache / "dit" / "sub").mkdir()
    (cache / "dit" / "sub" / "extra.txt").write_text("nested")
    (cache / "vae").mkdir()
    (cache / "vae" / "weights.safetensors").write_bytes(big)
    (cache / "dit" / ".cache").mkdir()
    (cache / "dit" / ".cache" / "hidden.txt").write_text("hub bookkeeping")
    root = base / "ckpt"

    checkpoint_stage.stage(cache / "vae", root / "vae")
    check("a read-only part shows the cache's files",
          (root / "vae" / "weights.safetensors").stat().st_size == len(big))
    checkpoint_stage.stage(cache / "vae", root / "vae")
    check("staging twice is a no-op", (root / "vae" / "weights.safetensors").exists())

    checkpoint_stage.stage(cache / "dit", root / "dit", writable=True)
    staged = root / "dit"
    check("a writable part is a real directory with every file",
          staged.is_dir() and not checkpoint_stage._is_link(staged)
          and (staged / "sub" / "extra.txt").read_text() == "nested")
    check("the weights are readable and complete",
          (staged / "model.safetensors").stat().st_size == len(big))
    check("small files are real copies, not links",
          not os.path.islink(staged / "modeling.py")
          and os.stat(staged / "modeling.py").st_nlink == 1)
    check("hidden hub bookkeeping isn't staged", not (staged / ".cache").exists())

    (staged / "modeling.py").write_text("rewritten by the engine")
    checkpoint_stage.stage(cache / "dit", root / "dit", writable=True)
    check("a restage keeps the engine's own edit of a small file",
          (staged / "modeling.py").read_text() == "rewritten by the engine")
    check("...and the cache's copy was never touched",
          (cache / "dit" / "modeling.py").read_text() == "original code")

    elsewhere = base / "cache2" / "main"
    (elsewhere / "dit").mkdir(parents=True)
    (elsewhere / "dit" / "model.safetensors").write_bytes(big[:-512])
    (elsewhere / "dit" / "modeling.py").write_text("moved cache")
    checkpoint_stage.stage(elsewhere / "dit", root / "dit", writable=True)
    check("moving the cache rebuilds the folder instead of serving old files",
          (staged / "modeling.py").read_text() == "moved cache"
          and (staged / "model.safetensors").stat().st_size == len(big) - 512
          and not (staged / "sub").exists())

    try:
        checkpoint_stage.stage(base / "nowhere", root / "x")
        message = ""
    except FileNotFoundError as exc:
        message = str(exc)
    check("a missing source is a clear error", "nowhere" in message, message)

    checkpoint_stage.clear(root)
    check("clearing removes the staged folder", not root.exists())
    check("...and never reaches through a link into the cache",
          (cache / "vae" / "weights.safetensors").stat().st_size == len(big)
          and (cache / "dit" / "modeling.py").read_text() == "original code")
    checkpoint_stage.clear(root)   # again: nothing there, nothing to do
    check("clearing a missing folder is fine", True)


# --------------------------------------------------------------------------
# The ACE-Step adapter, against a fake package with the real call shapes
# --------------------------------------------------------------------------


def test_acestep_adapter() -> None:
    """Everything the adapter does around `acestep`.

    The fake mirrors what the pinned commit (ca1e85fe) exposes: `AceStepHandler`
    with `initialize_service(project_root, config_path, device, ..., offload_to_cpu,
    offload_dit_to_cpu, ...)` returning `(message, ok)` and its `_ensure_models_present`
    start-up download, `GenerationParams` / `GenerationConfig` as dataclasses that
    reject unknown fields, and `generate_music(dit, llm, params, config, save_dir)`
    returning a result whose `audios[0]["path"]` is a WAV. Whether the real model
    sounds right (or sings) is not something this can say.
    """
    print("acestep: the real adapter against a fake package")
    import dataclasses  # noqa: PLC0415
    import importlib.machinery  # noqa: PLC0415
    import types  # noqa: PLC0415
    import uuid  # noqa: PLC0415

    import huggingface_hub  # noqa: PLC0415
    from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

    seen: dict = {"inits": [], "generations": [], "downloads": [], "ckpt_at_init": None}

    @dataclasses.dataclass
    class GenerationParams:
        task_type: str = "text2music"
        caption: str = ""
        lyrics: str = ""
        instrumental: bool = False
        vocal_language: str = "unknown"
        duration: float = -1.0
        inference_steps: int = 8
        seed: int = -1
        guidance_scale: float = 7.0
        thinking: bool = True

    @dataclasses.dataclass
    class GenerationConfig:
        batch_size: int = 2
        use_random_seed: bool = True
        seeds: list | None = None
        audio_format: str = "flac"

    @dataclasses.dataclass
    class GenerationResult:
        audios: list = dataclasses.field(default_factory=list)
        status_message: str = ""
        success: bool = True
        error: str | None = None

    behaviour = {"ok": True, "nan": False, "level": 0.3, "success": True}

    class AceStepHandler:
        def _ensure_models_present(self, *, checkpoint_path, config_path, prefer_source, vae_variant=None):
            # The real one downloads whatever is missing; here a download is a mark.
            for name in ("acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B", "acestep-5Hz-lm-1.7B"):
                if not (Path(checkpoint_path) / name).is_dir():
                    seen["downloads"].append(name)
            return None

        def initialize_service(self, project_root, config_path, device="auto",
                               use_flash_attention=False, compile_model=False,
                               offload_to_cpu=False, offload_dit_to_cpu=False,
                               quantization=None, prefer_source=None, use_mlx_dit=True,
                               vae_checkpoint=None):
            checkpoints = Path(os.environ["ACESTEP_CHECKPOINTS_DIR"])
            self._ensure_models_present(checkpoint_path=checkpoints, config_path=config_path,
                                        prefer_source=prefer_source)
            seen["inits"].append({"project_root": project_root, "config_path": config_path,
                                  "device": device, "offload": offload_to_cpu,
                                  "dit_offload": offload_dit_to_cpu, "quantization": quantization,
                                  "compile": compile_model})
            seen["ckpt_at_init"] = sorted(
                p.relative_to(checkpoints).as_posix() for p in checkpoints.rglob("*")
                if p.is_file() and not p.name.startswith("."))
            return ("loaded" if behaviour["ok"] else "ERROR: no weights"), behaviour["ok"]

    def generate_music(dit_handler, llm_handler, params, config, save_dir=None, progress=None):
        seen["generations"].append({"params": params, "config": config, "llm": llm_handler,
                                    "dit": dit_handler, "save_dir": save_dir})
        if not behaviour["success"]:
            return GenerationResult(success=False, error="generation timed out after 600s")
        rate = 8000
        wave = np.full(int(rate * params.duration), behaviour["level"], dtype="float32")
        if behaviour["nan"]:
            wave[3] = np.nan
        path = Path(save_dir) / f"{uuid.uuid4()}.wav"
        # NaN can only survive in a float file; a 16-bit one turns it into noise or
        # silence (which the almost-silent warning then catches).
        sf.write(str(path), np.stack([wave, wave], axis=1), rate,
                 subtype="FLOAT" if behaviour["nan"] else "PCM_16")
        return GenerationResult(audios=[{"path": str(path), "sample_rate": rate}])

    def fake_module(name: str, **attributes):
        module = types.ModuleType(name)
        module.__spec__ = importlib.machinery.ModuleSpec(name, None, is_package=name == "acestep")
        if name == "acestep":
            module.__path__ = []
        for key, value in attributes.items():
            setattr(module, key, value)
        return module

    fakes = {
        "acestep": fake_module("acestep"),
        "acestep.handler": fake_module("acestep.handler", AceStepHandler=AceStepHandler),
        "acestep.inference": fake_module(
            "acestep.inference", GenerationParams=GenerationParams,
            GenerationConfig=GenerationConfig, generate_music=generate_music),
    }

    cache = _DATA_DIR / "ace-cache"
    main = cache / "main"
    for name in TURBO_FILES:
        touch(main / name)
    sft = cache / "sft"
    for name in ("config.json", "model.safetensors", "modeling_acestep_v15_base.py", "silence_latent.pt"):
        touch(sft / name)
    snapshots = {catalog.ACESTEP_REPO: main, "ACE-Step/acestep-v15-sft": sft}

    real_hardware = devices.hardware
    real_download = huggingface_hub.snapshot_download
    real_active = catalog.active_model
    ace = AceStepBackend()
    out = _DATA_DIR / "ace-out" / "song.wav"
    asked: list[dict] = []

    def downloaded(**kwargs):
        asked.append(kwargs)
        if kwargs["repo_id"] not in snapshots:
            raise LocalEntryNotFoundError("not in the cache")
        return str(snapshots[kwargs["repo_id"]])

    def use_model(model_id: str) -> None:
        catalog.active_model = lambda engine: catalog.get(model_id)

    def load_error(exc_type: type[BaseException]) -> str:
        try:
            ace.load()
        except exc_type as exc:
            return str(exc)
        return ""

    sys.modules.update(fakes)
    try:
        devices.hardware = lambda: devices.Hardware(True, (6, 1), int(6.0 * GIB), "GTX 1060")
        huggingface_hub.snapshot_download = downloaded
        use_model("acestep-1.5-turbo")
        os.environ.pop("ACESTEP_CHECKPOINTS_DIR", None)

        check("a package on the path counts as installed", ace.available())
        check("turbo defaults: 8 steps, guidance 1", ace.defaults() == (8, 1.0), str(ace.defaults()))
        use_model("acestep-1.5-sft")
        check("sft defaults: 50 steps, guidance 7", ace.defaults() == (50, 7.0), str(ace.defaults()))
        use_model("acestep-1.5-turbo")

        ace.load()
        check("the cache is read offline",
              bool(asked) and all(a.get("local_files_only") is True for a in asked), str(asked))
        init = seen["inits"][0]
        check("it started the turbo DiT with the Phase 0 recipe (offload, nothing quantized, no compile)",
              init["config_path"] == "acestep-v15-turbo" and init["offload"] and init["dit_offload"]
              and init["quantization"] is None and not init["compile"], str(init))
        staged = ace.stage_root() / "checkpoints"
        check("the engine reads a private folder, not the cache",
              Path(os.environ["ACESTEP_CHECKPOINTS_DIR"]) == staged
              and Path(init["project_root"]) == staged.parent)
        check("that folder holds the DiT, the VAE and the text encoder",
              {"acestep-v15-turbo/model.safetensors", "vae/diffusion_pytorch_model.safetensors",
               "Qwen3-Embedding-0.6B/model.safetensors"} <= set(seen["ckpt_at_init"]),
              str(seen["ckpt_at_init"]))
        check("the language model isn't staged (it stays off)",
              not any(name.startswith("acestep-5Hz-lm") for name in seen["ckpt_at_init"]))
        check("nothing was downloaded", not seen["downloads"], str(seen["downloads"]))
        check("it reports itself loaded on cuda", ace.is_loaded() and ace.device() == "cuda")
        before = len(seen["inits"])
        ace.load()
        check("loading twice does nothing", len(seen["inits"]) == before)

        result = ace.generate(AudioSpec("lo-fi hip hop, warm Rhodes", 30.0), out)
        call = seen["generations"][-1]
        params, generation = call["params"], call["config"]
        check("instrumental: the marker lyrics and the flag",
              params.instrumental is True and params.lyrics == "[Instrumental]", str(params))
        check("the style is the caption; length and defaults are forwarded",
              params.caption == "lo-fi hip hop, warm Rhodes" and params.duration == 30.0
              and params.inference_steps == 8 and params.guidance_scale == 1.0, str(params))
        check("the language model is off and no handler is passed",
              params.thinking is False and call["llm"] is None)
        check("a seed was drawn and used for the one take",
              0 <= params.seed < 2**31 and generation.seeds == [params.seed]
              and generation.use_random_seed is False and generation.batch_size == 1)
        check("it asks for a WAV", generation.audio_format == "wav")
        data, rate = sf.read(str(out), dtype="float32")
        check("the engine's file lands at the requested path, stereo",
              out.is_file() and data.ndim == 2 and data.shape[1] == 2 and rate == 8000)
        check("the result carries path, length and device",
              result.path == out and abs((result.duration_seconds or 0) - 30.0) < 0.01
              and result.device == "cuda")
        check("a normal-level clip carries no warning", result.warning is None)
        check("the scratch folder is gone", not Path(call["save_dir"]).exists())

        ace.generate(AudioSpec("ballad", 20.0, lyrics="[verse]\nla la la", seed=5, steps=12, guidance=3.0), out)
        params = seen["generations"][-1]["params"]
        check("lyrics turn vocals on and are passed unchanged",
              params.instrumental is False and params.lyrics == "[verse]\nla la la")
        check("explicit seed, steps and guidance are forwarded",
              (params.seed, params.inference_steps, params.guidance_scale) == (5, 12, 3.0), str(params))

        ace.generate(AudioSpec("short", 3.0), out)
        check("a clip under 10 s is raised to the engine's minimum",
              seen["generations"][-1]["params"].duration == 10.0)
        ace.generate(AudioSpec("long", 9000.0), out)
        check("a clip over 10 minutes is clamped", seen["generations"][-1]["params"].duration == 600.0)

        behaviour["level"] = 0.0005
        quiet = ace.generate(AudioSpec("barely there", 12.0), out)
        check("an almost silent result is flagged",
              bool(quiet.warning) and "silent" in quiet.warning, str(quiet.warning))
        behaviour["level"] = 0.3

        behaviour["nan"] = True
        try:
            ace.generate(AudioSpec("broken", 12.0), out)
            message = ""
        except RuntimeError as exc:
            message = str(exc)
        check("NaN audio is an error, not a silent file", "invalid audio" in message, message)
        behaviour["nan"] = False

        behaviour["success"] = False
        try:
            ace.generate(AudioSpec("slow", 12.0), out)
            message = ""
        except RuntimeError as exc:
            message = str(exc)
        check("a failed generation surfaces the engine's reason", "timed out" in message, message)
        behaviour["success"] = True

        ace.unload()
        check("unload drops the handler", ace._dit is None and not ace.is_loaded() and ace.device() is None)
        try:
            ace._generate(AudioSpec("x", 12.0), out)
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("generating without a handler is a clear error", "unloaded" in message, message)

        # A model that is not in the cache must not start a download.
        del snapshots[catalog.ACESTEP_REPO]
        message = load_error(BackendUnavailable)
        check("weights missing: says to download them, starts nothing",
              "Models page" in message and not ace.is_loaded(), message)
        snapshots[catalog.ACESTEP_REPO] = main

        # The engine's own start-up would fetch whatever is missing; that step is off.
        shutil.rmtree(ace.stage_root())
        seen["downloads"].clear()
        shutil.rmtree(main / "vae")
        (main / "vae").mkdir()
        ace.load()
        check("a missing piece never triggers the engine's own download", not seen["downloads"], str(seen["downloads"]))
        ace.unload()
        for name in ("vae/config.json", "vae/diffusion_pytorch_model.safetensors"):
            touch(main / name)

        # The sft variant: its own repo for the DiT, the turbo repo for the rest.
        use_model("acestep-1.5-sft")
        shutil.rmtree(ace.stage_root())
        seen["inits"].clear()
        ace.load()
        check("sft starts its own folder name",
              seen["inits"][0]["config_path"] == "acestep-v15-sft", str(seen["inits"]))
        check("its DiT comes from the sft repo, the VAE from the turbo repo",
              {"acestep-v15-sft/model.safetensors", "acestep-v15-sft/modeling_acestep_v15_base.py",
               "vae/config.json", "Qwen3-Embedding-0.6B/model.safetensors"} <= set(seen["ckpt_at_init"]),
              str(seen["ckpt_at_init"]))
        ace.generate(AudioSpec("x", 12.0), out)
        check("sft gets its own defaults (50 steps, guidance 7)",
              (seen["generations"][-1]["params"].inference_steps,
               seen["generations"][-1]["params"].guidance_scale) == (50, 7.0))
        ace.unload()

        use_model("acestep-1.5-turbo")
        behaviour["ok"] = False
        message = load_error(RuntimeError)
        check("a failed start is an error with the engine's message, and nothing stays loaded",
              "could not start" in message and "no weights" in message and not ace.is_loaded()
              and ace._dit is None, message)
        behaviour["ok"] = True

        ace.clear_staged()
        check("clear_staged removes the private folder", not ace.stage_root().exists())
        ace.clear_staged()
    finally:
        for name in fakes:
            sys.modules.pop(name, None)
        devices.hardware = real_hardware
        huggingface_hub.snapshot_download = real_download
        catalog.active_model = real_active
        os.environ.pop("ACESTEP_CHECKPOINTS_DIR", None)


# --------------------------------------------------------------------------
# API, against a fake engine
# --------------------------------------------------------------------------


class SineEngine:
    """Stands in for ACE-Step / MOSS: writes a sine of the requested length."""

    optional = True

    def __init__(self, name: str, kind: str, label: str) -> None:
        self.name, self.kind, self.label = name, kind, label
        self.installed = True
        self.support_value = Support(True)
        self._loaded = False
        self.specs: list[AudioSpec] = []
        self.fail: str | None = None
        self.unloads = 0

    def available(self) -> bool:
        return self.installed

    def support(self) -> Support:
        return self.support_value

    def is_loaded(self) -> bool:
        return self._loaded

    def device(self) -> str | None:
        return "cuda" if self._loaded else None

    def load(self) -> None:
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False
        self.unloads += 1

    def generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        if self.fail:
            raise RuntimeError(self.fail)
        self._loaded = True
        self.specs.append(spec)
        rate = 8000
        samples = (0.2 * np.sin(np.linspace(0, 400, int(rate * spec.duration_seconds)))).astype("float32")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), samples, rate)
        return SynthesisResult(path=out_path, duration_seconds=spec.duration_seconds, device="cuda")


class QuietSpeech:
    """A speech engine that is 'loaded' until something unloads it."""

    optional = False
    supports_cloning = False

    def __init__(self, name: str, loaded: bool = False) -> None:
        self.name = name
        self._loaded = loaded
        self.unloads = 0

    def available(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return self._loaded

    def device(self) -> str | None:
        return "cpu" if self._loaded else None

    def unload(self) -> None:
        self._loaded = False
        self.unloads += 1

    def synthesize(self, text, voice, out_path):
        self._loaded = True
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), np.zeros(2400, dtype="float32"), 24000)
        return SynthesisResult(path=out_path, duration_seconds=0.1, device="cpu")


def _wait_for(client, generation_id: str) -> dict:
    deadline = time.monotonic() + 15
    row: dict = {}
    while time.monotonic() < deadline:
        row = client.get(f"/api/generations/{generation_id}").json()
        if row["status"] in ("completed", "failed"):
            return row
        time.sleep(0.05)
    return row


def test_api() -> None:
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from app import create_app  # noqa: PLC0415

    saved = dict(_REGISTRY)
    real_hardware = devices.hardware
    real_downloaded = model_service.active_downloaded
    downloaded: set[str] = set()
    model_service.active_downloaded = lambda engine: engine in downloaded
    devices.hardware = lambda: devices.Hardware()      # never initialise CUDA here
    try:
        with TestClient(create_app()) as client:
            # ---- the real adapters, on a machine with nothing installed ----
            print("api: /api/audio-engines with the real adapters")
            rows = client.get("/api/audio-engines").json()
            check("all four engines listed, music first, each kind's default leading",
                  [r["name"] for r in rows] == ["acestep", "sa3_music", "moss_sfx", "sa3_sfx"],
                  str([r["name"] for r in rows]))
            ace, moss_row = rows[0], rows[2]
            check("not installed, not ready", ace["installed"] is False and ace["ready"] is False)
            check("no GPU -> unsupported with a reason",
                  ace["supported"] is False and "NVIDIA" in (ace["unsupported_reason"] or ""))
            check("license and size come from the catalog",
                  ace["license_tier"] == "open" and ace["license_name"] == "MIT"
                  and ace["model_id"] == "acestep-1.5-turbo" and ace["download_estimate_bytes"] > 10 * catalog.GB)
            check("each kind marks exactly one default",
                  [r["default"] for r in rows] == [True, False, True, False])
            check("the forms learn each engine's default steps and guidance",
                  (ace["default_steps"], ace["default_guidance"]) == (8, 1.0)
                  and (moss_row["default_steps"], moss_row["default_guidance"]) == (20, 4.0),
                  str((ace["default_steps"], moss_row["default_steps"])))
            check("ACE-Step and MOSS are not gated", not ace["gated"] and not moss_row["gated"])
            refused = client.post("/api/generations/audio", json={"kind": "sfx", "prompt": "rain", "duration_seconds": 3})
            check("an engine that isn't installed answers 409 with what to do",
                  refused.status_code == 409 and "Models page" in refused.text, refused.text)

            # ---- swap in fakes ----
            moss = SineEngine("moss_sfx", "sfx", "MOSS-SoundEffect v2")
            ace_fake = SineEngine("acestep", "music", "ACE-Step 1.5")
            speech = QuietSpeech("qwen", loaded=True)
            kokoro = QuietSpeech("kokoro")
            _REGISTRY.update({"moss_sfx": moss, "acestep": ace_fake, "qwen": speech, "kokoro": kokoro})
            devices.hardware = real_hardware

            print("api: readiness checks")
            body = {"kind": "sfx", "prompt": "heavy wooden door slamming in a hallway", "duration_seconds": 3}
            check("installed but weights missing -> 409 naming the model",
                  (r := client.post("/api/generations/audio", json=body)).status_code == 409
                  and "MOSS-SoundEffect v2" in r.text and "Models page" in r.text, r.text)
            downloaded.update({"moss_sfx", "acestep"})
            rows = {r["name"]: r for r in client.get("/api/audio-engines").json()}
            check("with weights and support the engine is ready", rows["moss_sfx"]["ready"] is True)

            moss.support_value = Support(False, reason="needs an NVIDIA GPU")
            check("unsupported hardware -> 409 with the reason",
                  (r := client.post("/api/generations/audio", json=body)).status_code == 409
                  and "NVIDIA" in r.text, r.text)
            rows = {r["name"]: r for r in client.get("/api/audio-engines").json()}
            check("…and not ready", rows["moss_sfx"]["ready"] is False and rows["moss_sfx"]["supported"] is False)

            moss.support_value = Support(True, warning="slow here", max_duration_seconds=10)
            rows = {r["name"]: r for r in client.get("/api/audio-engines").json()}
            check("the warning and hardware cap are exposed",
                  rows["moss_sfx"]["warning"] == "slow here" and rows["moss_sfx"]["max_duration_seconds"] == 10)
            check("a clip over the cap -> 400 that names the limit",
                  (r := client.post("/api/generations/audio", json={**body, "duration_seconds": 12})).status_code == 400
                  and "at most 10 seconds" in r.text, r.text)
            moss.installed = False
            check("uninstalled mid-way -> 409",
                  client.post("/api/generations/audio", json=body).status_code == 409)
            moss.installed = True
            moss.support_value = Support(True)

            print("api: request validation")
            for label, patch in {
                "blank prompt": {"prompt": "   "},
                "zero duration": {"duration_seconds": 0},
                "unknown kind": {"kind": "speech"},
                "an sfx longer than 30 s": {"duration_seconds": 31},
                "lyrics on an sfx": {"lyrics": "la la"},
                "more than 4 takes": {"takes": 5},
                "a negative seed": {"seed": -1},
                "bad engine name": {"engine": "../etc"},
                "unsupported format": {"output_format": "aiff"},
            }.items():
                check(f"{label} -> 422",
                      client.post("/api/generations/audio", json={**body, **patch}).status_code == 422)
            check("several takes of music -> 422",
                  client.post("/api/generations/audio", json={
                      "kind": "music", "prompt": "lofi", "duration_seconds": 20, "takes": 2}).status_code == 422)
            song = {"kind": "music", "prompt": "lofi", "duration_seconds": 30}
            for label, patch in {
                "a song under 10 s": {"duration_seconds": 9.5},
                "a style over 512 characters": {"prompt": "x" * 513},
                "lyrics over 4096 characters": {"lyrics": "la " * 1400},
            }.items():
                check(f"{label} -> 422",
                      client.post("/api/generations/audio", json={**song, **patch}).status_code == 422)
            check("an unknown engine -> 400 listing the real ones",
                  (r := client.post("/api/generations/audio", json={**body, "engine": "nope"})).status_code == 400
                  and "moss_sfx" in r.text, r.text)
            check("an engine of the other kind -> 400",
                  (r := client.post("/api/generations/audio", json={**body, "engine": "acestep"})).status_code == 400
                  and "music" in r.text, r.text)

            print("api: a sound effect")
            before = speech.unloads
            r = client.post("/api/generations/audio", json={
                **body, "seed": 7, "steps": 12, "guidance": 4.5})
            check("accepted with 202 and a list of one queued row",
                  r.status_code == 202 and len(r.json()) == 1 and r.json()[0]["status"] == "queued", r.text)
            row = r.json()[0]
            check("the row is an sfx for the default engine, with no profile",
                  row["kind"] == "sfx" and row["engine"] == "moss_sfx" and row["profile_id"] is None)
            check("the prompt is the text and the options are in params",
                  row["text"] == body["prompt"]
                  and row["params"] == {"duration_seconds": 3, "seed": 7, "steps": 12, "guidance": 4.5}, str(row["params"]))
            done = _wait_for(client, row["id"])
            check("the job completed", done["status"] == "completed", str(done))
            path = Path(done["audio_path"])
            check("a wav was written, named from the first words of the prompt",
                  path.is_file() and path.suffix == ".wav" and path.name.startswith("heavy-wooden-door-slamming-"), path.name)
            check("duration and device recorded",
                  abs(done["duration_seconds"] - 3) < 0.05 and done["device"] == "cuda" and done["format"] == "wav")
            check("the engine saw exactly the request",
                  moss.specs[-1] == AudioSpec("heavy wooden door slamming in a hallway", 3, None, 7, 12, 4.5), str(moss.specs[-1]))
            check("a loaded speech engine was unloaded to make room", speech.unloads == before + 1 and not speech.is_loaded())
            check("the file is served by the app",
                  client.get("/api/files", params={"path": done["audio_path"]}).status_code == 200)

            print("api: takes")
            r = client.post("/api/generations/audio", json={**body, "duration_seconds": 1, "takes": 3, "seed": 10})
            rows3 = r.json()
            check("three rows come back", r.status_code == 202 and len(rows3) == 3, r.text)
            check("each take records its place and its own seed",
                  [(x["params"]["take"], x["params"]["takes"], x["params"]["seed"]) for x in rows3]
                  == [(1, 3, 10), (2, 3, 11), (3, 3, 12)], str([x["params"] for x in rows3]))
            finished = [_wait_for(client, x["id"]) for x in rows3]
            paths = {f["audio_path"] for f in finished}
            check("all complete, into distinct files",
                  all(f["status"] == "completed" for f in finished) and len(paths) == 3)
            check("without a seed no seed is recorded or sent",
                  (lambda x: "seed" not in x["params"])(client.post(
                      "/api/generations/audio", json={**body, "duration_seconds": 1}).json()[0]))
            _wait_for(client, client.get("/api/generations", params={"kind": "sfx", "limit": 1}).json()[0]["id"])

            print("api: music, lyrics and formats")
            r = client.post("/api/generations/audio", json={
                "kind": "music", "prompt": "warm lofi piano, vinyl crackle", "duration_seconds": 20,
                "lyrics": "  la la la  ", "output_format": "wav"})
            music = r.json()[0]
            check("music goes to the music engine", music["kind"] == "music" and music["engine"] == "acestep", r.text)
            check("lyrics are stored trimmed", music["params"]["lyrics"] == "la la la", str(music["params"]))
            done = _wait_for(client, music["id"])
            check("the engine got the lyrics", ace_fake.specs[-1].lyrics == "la la la" and done["status"] == "completed")
            check("a music job unloads the SFX engine", not moss.is_loaded())

            instrumental = client.post("/api/generations/audio", json={
                "kind": "music", "prompt": "ambient drone", "duration_seconds": 12, "lyrics": "   "}).json()[0]
            check("blank lyrics mean instrumental", "lyrics" not in instrumental["params"])
            _wait_for(client, instrumental["id"])
            check("and reach the engine as None", ace_fake.specs[-1].lyrics is None)

            edge = client.post("/api/generations/audio", json={
                "kind": "music", "prompt": "x" * 512, "duration_seconds": 10, "lyrics": "l" * 4096})
            check("the limits themselves (10 s, 512 characters, 4096 of lyrics) are accepted",
                  edge.status_code == 202, edge.text)
            _wait_for(client, edge.json()[0]["id"])

            if audio.ffmpeg_available():
                converted = client.post("/api/generations/audio", json={**body, "duration_seconds": 1, "output_format": "mp3"}).json()[0]
                done = _wait_for(client, converted["id"])
                leftovers = list(Path(done["audio_path"]).parent.glob("*.raw.wav"))
                check("another format is transcoded and the intermediate removed",
                      done["status"] == "completed" and done["audio_path"].endswith(".mp3")
                      and done["format"] == "mp3" and not leftovers, str(done))
            else:
                print("  SKIP  mp3 transcode (ffmpeg not found)")

            print("api: failures and scheduling")
            moss.fail = "CUDA out of memory"
            failing = client.post("/api/generations/audio", json={**body, "duration_seconds": 2}).json()[0]
            done = _wait_for(client, failing["id"])
            check("a failing engine marks the row failed with the reason",
                  done["status"] == "failed" and "CUDA out of memory" in done["error"] and done["audio_path"] is None, str(done))
            check("no half-written file is left behind",
                  not [p for p in config.GENERATIONS_DIR.glob("*") if p.name.startswith("heavy-wooden-door-slamming-" + failing["id"][:8])])
            moss.fail = None

            moss._loaded = True
            profile = client.post("/api/profiles", data={"name": "Draft", "engine": "kokoro", "preset_voice": "af_heart"}).json()
            speech_job = client.post("/api/generations", json={"profile_id": profile["id"], "text": "Hello."}).json()
            done = _wait_for(client, speech_job["id"])
            check("a speech job unloads a loaded SFX engine",
                  done["status"] == "completed" and not moss.is_loaded())
            check("speech rows are still kind=speech with an engine", done["kind"] == "speech" and done["engine"] == "kokoro")

            print("api: the ?kind= filter")
            everything = client.get("/api/generations", params={"limit": 500}).json()
            kinds = {k: client.get("/api/generations", params={"kind": k, "limit": 500}).json() for k in ("speech", "music", "sfx")}
            check("each filter returns only its kind",
                  all(all(x["kind"] == k for x in rows_) and rows_ for k, rows_ in kinds.items()))
            check("the filters partition the full list",
                  sum(len(v) for v in kinds.values()) == len(everything))
            check("an unknown kind is rejected", client.get("/api/generations", params={"kind": "video"}).status_code == 422)
            check("music rows carry no profile", all(x["profile_id"] is None for x in kinds["music"] + kinds["sfx"]))

            print("api: housekeeping")
            health = {e["name"]: e for e in client.get("/api/health").json()["engines"]}
            check("health lists the audio engines as optional",
                  health["acestep"]["optional"] and health["moss_sfx"]["optional"] and not health["qwen"]["optional"])
            target = next(x for x in kinds["sfx"] if x["audio_path"])
            check("the file exists before the delete", Path(target["audio_path"]).is_file())
            check("deleting an audio generation removes its file",
                  client.delete(f"/api/generations/{target['id']}").status_code == 204
                  and not Path(target["audio_path"]).exists())
    finally:
        _REGISTRY.clear()
        _REGISTRY.update(saved)
        devices.hardware = real_hardware
        model_service.active_downloaded = real_downloaded


def main() -> int:
    config.ensure_dirs()
    db_session.init_db()
    test_catalog()
    test_attributions()
    test_downloads()
    test_hardware_rules()
    test_adapter_basics()
    test_checkpoint_stage()
    test_acestep_adapter()
    test_moss_adapter()
    test_api()         # last: closing the TestClient shuts the worker executor down
    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
