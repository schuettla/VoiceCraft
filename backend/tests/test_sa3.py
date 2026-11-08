"""Checks for Stable Audio 3 Small and the gated-download flow (Phase 9).

No weights, no GPU, no network: the Hugging Face hub functions are replaced by
fakes that write tiny files into a temporary cache, the `stable_audio_3` package
is a fake with the real call shapes (read from the repository at commit
`790793b`), and the GPU probe is patched. Run from the repo root:

    python backend/tests/test_sa3.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-sa3-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"
os.environ["VOICECRAFT_IDLE_UNLOAD_SECONDS"] = "0"
for _var in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
    os.environ.pop(_var, None)

import soundfile as sf  # noqa: E402

import catalog  # noqa: E402
import config  # noqa: E402
from backends import AudioSpec, audio_backends, sa3_files  # noqa: E402
from backends import device as devices  # noqa: E402
from backends.audio_engines import GIB  # noqa: E402
from backends.base import BackendUnavailable  # noqa: E402
from backends.sa3_engines import Sa3MusicBackend, Sa3SfxBackend  # noqa: E402
from services import hf_token, model_service  # noqa: E402

PASSED = 0
FAILED = 0

TOKEN = "hf_" + "a" * 34
OTHER_TOKEN = "hf_" + "b" * 34
MUSIC_REPO = catalog.SA3_REPO_MUSIC
SFX_REPO = catalog.SA3_REPO_SFX
ENCODER_REPO = sa3_files.DEFAULT_ENCODER_REPO


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


def model_config(**encoder) -> dict:
    """A `model_config.json` shaped like the library's `factory.py` reads it."""
    return {
        "sample_rate": 44100,
        "sample_size": 5292032,
        "model": {
            "conditioning": {
                "cond_dim": 768,
                "configs": [
                    {"id": "number", "type": "number", "config": {"min_val": 0, "max_val": 512}},
                    {"id": "prompt", "type": "t5gemma", "config": {"max_length": 128, **encoder}},
                ],
            }
        },
    }


def put(cache: Path, repo_id: str, name: str, content: bytes = b"x" * 16) -> None:
    path = cache / f"models--{repo_id.replace('/', '--')}" / "snapshots" / "abc123" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    (cache / f"models--{repo_id.replace('/', '--')}" / "blobs").mkdir(exist_ok=True)


def put_model(cache: Path, repo_id: str, config_json: dict) -> None:
    put(cache, repo_id, "model_config.json", json.dumps(config_json).encode())
    put(cache, repo_id, "model.safetensors")


def put_encoder(cache: Path, repo_id: str = ENCODER_REPO, subfolder: str = "") -> None:
    prefix = f"{subfolder}/" if subfolder else ""
    for name in ("config.json", "model.safetensors", "tokenizer.json"):
        put(cache, repo_id, prefix + name)


# --------------------------------------------------------------------------
# What the model's config says about its text encoder
# --------------------------------------------------------------------------


def test_encoder_config() -> None:
    print("sa3_files: which repository holds the text encoder")
    ref = sa3_files.encoder_ref(model_config())
    check("no name at all: the library's default repository", ref.repo_id == ENCODER_REPO and ref.subfolder is None)
    ref = sa3_files.encoder_ref(model_config(model_name="google/other"))
    check("model_name is used when there is no repo_id", ref.repo_id == "google/other")
    ref = sa3_files.encoder_ref(model_config(repo_id="stabilityai/x", subfolder="text_encoder", model_name="google/other"))
    check("repo_id wins over model_name, and the subfolder is kept",
          ref.repo_id == "stabilityai/x" and ref.subfolder == "text_encoder")
    check("the link points at the Hub page", ref.url == "https://huggingface.co/stabilityai/x")
    check("a path in the config doesn't become the repository",
          sa3_files.encoder_ref(model_config(model_path="C:/their/machine")).repo_id == ENCODER_REPO)

    for label, broken in (
        ("no conditioning section", {"model": {}}),
        ("no t5gemma entry", {"model": {"conditioning": {"configs": [{"id": "n", "type": "number"}]}}}),
        ("a repository that isn't a Hub id", model_config(repo_id="nonsense")),
    ):
        check(f"refused: {label}", _raises(sa3_files.EncoderConfigError, sa3_files.encoder_ref, broken))

    config_json = model_config(repo_id="stabilityai/x", subfolder="text_encoder")
    sa3_files.pin_encoder(config_json, "C:/cache/snap")
    inner = [c for c in config_json["model"]["conditioning"]["configs"] if c["type"] == "t5gemma"][0]["config"]
    check("pinning sets model_path (which the library tries first) and keeps the subfolder",
          inner["model_path"] == "C:/cache/snap" and inner["subfolder"] == "text_encoder")
    check("the other conditioners are untouched",
          "model_path" not in config_json["model"]["conditioning"]["configs"][0]["config"])

    path = _DATA_DIR / "model_config.json"
    path.write_text(json.dumps(model_config()), encoding="utf-8")
    check("a config is read back as a dict", isinstance(sa3_files.read_config(path), dict))
    path.write_text("{not json", encoding="utf-8")
    check("a broken file is an EncoderConfigError", _raises(sa3_files.EncoderConfigError, sa3_files.read_config, path))
    check("a missing file too", _raises(sa3_files.EncoderConfigError, sa3_files.read_config, _DATA_DIR / "nope.json"))


# --------------------------------------------------------------------------
# The token
# --------------------------------------------------------------------------


def test_token_store() -> None:
    print("hf_token: stored by the app, never read back out")
    real_env = hf_token._read_environment
    hf_token._read_environment = lambda: None       # the machine's own login must not leak in
    try:
        check("nothing saved: not configured", hf_token.status() == {"configured": False, "source": None})
        check("and no token to download with", hf_token.get() is None)

        for bad in ("", "   ", "hello", "hf_short", "hf_" + "a" * 40 + " b", "xx_" + "a" * 34):
            check(f"rejected: {bad[:12]!r}", _raises(hf_token.TokenError, hf_token.save, bad))
        check("a rejected token leaves nothing on disk", not (config.SECRETS_DIR / "hf_token").exists())

        status = hf_token.save(f"  {TOKEN}\n")
        check("saving reports it as the app's own", status == {"configured": True, "source": "app"})
        stored = (config.SECRETS_DIR / "hf_token").read_text(encoding="utf-8")
        check("the file holds the trimmed token", stored == TOKEN)
        check("the status never contains the token", TOKEN not in json.dumps(status))
        check("get() returns it for downloads", hf_token.get() == TOKEN)
        check("no temporary file is left behind", not list(config.SECRETS_DIR.glob("*.tmp")))
        if os.name != "nt":
            mode = (config.SECRETS_DIR / "hf_token").stat().st_mode & 0o777
            check("owner-only permissions where the system has them", mode == 0o600, oct(mode))
        check("not in settings.json and not in the database folder listing",
              TOKEN not in config.SETTINGS_PATH.read_text(encoding="utf-8") if config.SETTINGS_PATH.exists() else True)
        check("the secrets folder is not one the app serves or cleans",
              config.SECRETS_DIR not in config.ALL_DIRS and config.SECRETS_DIR not in config.SAFE_ROOTS)

        hf_token.save(OTHER_TOKEN)
        check("saving again replaces it", hf_token.get() == OTHER_TOKEN)

        check("clearing forgets it", hf_token.clear() == {"configured": False, "source": None}
              and not (config.SECRETS_DIR / "hf_token").exists())
        check("clearing twice is fine", hf_token.clear()["configured"] is False)

        hf_token._read_environment = lambda: "hf_from_the_cli"
        check("a Hugging Face login counts when the app has none",
              hf_token.status() == {"configured": True, "source": "huggingface"}
              and hf_token.get() == "hf_from_the_cli")
        hf_token.save(TOKEN)
        check("the app's own token wins over the login", hf_token.get() == TOKEN
              and hf_token.status()["source"] == "app")
        hf_token.clear()
        check("clearing leaves the login in effect", hf_token.status()["source"] == "huggingface")
    finally:
        hf_token._read_environment = real_env
        hf_token.clear()


# --------------------------------------------------------------------------
# Catalog entries
# --------------------------------------------------------------------------


def test_catalog_entries() -> None:
    print("catalog: Stable Audio 3 Small")
    music, sfx = catalog.get("sa3-small-music"), catalog.get("sa3-small-sfx")
    check("both entries exist, in the right categories",
          music is not None and sfx is not None and music.category == "music" and sfx.category == "sfx")
    check("they use the library's own repository ids",
          (music.repo_id, sfx.repo_id) == ("stabilityai/stable-audio-3-small-music", "stabilityai/stable-audio-3-small-sfx"))
    check("both are gated, conditional-tier and name the license",
          all(s.gated and s.license_tier == "conditional" and s.license_url == catalog.SA3_LICENSE
              and s.license_name == "Stability AI Community License" for s in (music, sfx)))
    check("neither is a default (ACE-Step and MOSS stay the defaults)", not music.default and not sfx.default)
    check("the text encoder is counted in the estimate",
          music.download_estimate_bytes == music.size_bytes + music.companion_bytes
          and music.companion_bytes > 1 * catalog.GB)
    check("the credit and the revenue cap are in the notes",
          any("Powered by Stability AI" in n for n in music.notes)
          and any("$1M" in n for n in music.notes))
    check("they run without a GPU", not music.needs_gpu and not sfx.needs_gpu)
    check("the registered engines match", {music.engine, sfx.engine} <= set(audio_backends()))
    check("the model names the library knows are the ones the adapter will be given",
          catalog.COMPANION_SA3_TEXT_ENCODER == sa3_files.COMPANION)


# --------------------------------------------------------------------------
# The download flow (fake hub)
# --------------------------------------------------------------------------


class FakeHub:
    """Stands in for `snapshot_download` / `hf_hub_download`; records every call."""

    def __init__(self, cache: Path) -> None:
        self.cache = cache
        self.calls: list[dict] = []
        self.model_configs: dict[str, dict] = {MUSIC_REPO: model_config(), SFX_REPO: model_config()}
        self.refused: set[str] = set()      # repositories that answer "gated"

    def snapshot_download(self, repo_id, cache_dir=None, token=None, **kwargs):
        from huggingface_hub.errors import GatedRepoError  # noqa: PLC0415

        self.calls.append({"repo": repo_id, "token": token, **kwargs})
        if repo_id in self.refused:
            raise GatedRepoError("401 Client Error: gated repo")
        if repo_id in self.model_configs:
            put_model(self.cache, repo_id, self.model_configs[repo_id])
        elif repo_id == "stabilityai/x":
            put_encoder(self.cache, repo_id, "text_encoder")
        else:
            put_encoder(self.cache, repo_id)
        return str(self.cache)

    def hf_hub_download(self, repo_id, filename, cache_dir=None, token=None, **kwargs):
        self.calls.append({"repo": repo_id, "file": filename, "token": token})
        put(self.cache, repo_id, filename)
        return str(self.cache)


def _wait(model_id: str) -> model_service.DownloadJob:
    deadline = time.monotonic() + 15
    job = model_service._job(model_id)
    while job is not None and job.state in ("queued", "downloading") and time.monotonic() < deadline:
        time.sleep(0.05)
        job = model_service._job(model_id)
    assert job is not None
    return job


def test_downloads() -> None:
    print("downloads: gated models and their text encoder")
    import huggingface_hub  # noqa: PLC0415

    from services import voice_service  # noqa: PLC0415

    cache = _DATA_DIR / "hf-cache"
    config.save_settings({"models_dir": str(cache)})
    hub = FakeHub(cache)
    real = (huggingface_hub.snapshot_download, huggingface_hub.hf_hub_download)
    real_env, real_resume = hf_token._read_environment, voice_service.resume_pending
    huggingface_hub.snapshot_download = hub.snapshot_download
    huggingface_hub.hf_hub_download = hub.hf_hub_download
    hf_token._read_environment = lambda: None
    voice_service.resume_pending = lambda: None
    music, sfx = catalog.get("sa3-small-music"), catalog.get("sa3-small-sfx")
    try:
        hf_token.clear()
        try:
            model_service.start_download("sa3-small-music")
            message = ""
        except model_service.ModelError as exc:
            message = str(exc)
        check("no token: refused before any download starts, with the steps",
              "gated" in message and f"https://huggingface.co/{MUSIC_REPO}" in message
              and "huggingface.co/settings/tokens" in message and "Hugging Face access" in message, message)
        check("…no request went out and no job was created",
              not hub.calls and model_service._job("sa3-small-music") is None)
        check("a model that isn't gated needs no token for the check",
              catalog.get("kokoro-82m").gated is False)

        hf_token.save(TOKEN)
        hub.refused = {ENCODER_REPO}
        model_service.start_download("sa3-small-music")
        job = _wait("sa3-small-music")
        check("the text encoder's own gate is reported, naming that repository",
              job.state == "failed" and ENCODER_REPO in (job.error or "") and "accept its terms" in (job.error or ""),
              str(job.error))
        check("the token is never part of an error", TOKEN not in (job.error or ""))
        check("the main files landed but the model isn't offered as downloaded",
              model_service.is_downloaded(MUSIC_REPO) and not model_service.spec_downloaded(music))
        check("every request carried the token",
              all(call["token"] == TOKEN for call in hub.calls), str(hub.calls))
        main_call, encoder_call = hub.calls[0], hub.calls[-1]
        check("the model's own download has no pattern filter", main_call["repo"] == MUSIC_REPO)
        check("the encoder download skips formats the loader never reads",
              encoder_call["repo"] == ENCODER_REPO and "*.onnx" in encoder_call["ignore_patterns"]
              and encoder_call["allow_patterns"] is None, str(encoder_call))

        hub.refused = {MUSIC_REPO}
        hub.calls.clear()
        model_service.start_download("sa3-small-music")
        job = _wait("sa3-small-music")
        check("a refusal on the model's own repository says so, with the link",
              job.state == "failed" and f"https://huggingface.co/{MUSIC_REPO}" in (job.error or ""), str(job.error))

        hub.refused = set()
        hub.calls.clear()
        model_service.start_download("sa3-small-music")
        job = _wait("sa3-small-music")
        check("with access, the download completes", job.state == "completed", str(job.error))
        check("and the model counts as downloaded (weights + config + encoder)",
              model_service.spec_downloaded(music))
        check("the encoder repository is its own cache folder",
              (cache / f"models--{ENCODER_REPO.replace('/', '--')}").is_dir())
        ref = model_service.companion_ref(music)
        check("the companion is found from the downloaded config", ref is not None and ref.repo_id == ENCODER_REPO)
        info = model_service.describe(music)
        check("the page reports it downloaded, gated, with the license",
              info["downloaded"] and info["gated"] and info["license_name"] == "Stability AI Community License")
        check("its size counts the encoder",
              info["size_bytes"] == model_service._dir_size(cache / f"models--{MUSIC_REPO.replace('/', '--')}")
              + model_service._dir_size(cache / f"models--{ENCODER_REPO.replace('/', '--')}"))

        # The second Stable Audio entry shares the encoder repository.
        model_service.start_download("sa3-small-sfx")
        job = _wait("sa3-small-sfx")
        check("the sound-effect model downloads too", job.state == "completed", str(job.error))
        encoder_dir = cache / f"models--{ENCODER_REPO.replace('/', '--')}"
        model_service.delete("sa3-small-music")
        check("deleting one keeps the encoder the other still needs",
              encoder_dir.is_dir() and model_service.spec_downloaded(sfx))
        check("…and removes its own repository", not (cache / f"models--{MUSIC_REPO.replace('/', '--')}").exists())
        model_service.delete("sa3-small-sfx")
        check("deleting the last one removes the encoder too", not encoder_dir.exists())

        # An encoder kept in a subfolder of the model's own repository.
        hub.model_configs[MUSIC_REPO] = model_config(repo_id=MUSIC_REPO, subfolder="text_encoder")
        hub.calls.clear()
        model_service.start_download("sa3-small-music")
        job = _wait("sa3-small-music")
        check("a subfolder encoder needs no second download",
              job.state == "completed" and {c["repo"] for c in hub.calls} == {MUSIC_REPO}, str(hub.calls))
        check("but it isn't 'downloaded' until the subfolder's files are there",
              not model_service.spec_downloaded(music))
        put_encoder(cache, MUSIC_REPO, "text_encoder")
        check("…then it is", model_service.spec_downloaded(music))
        model_service.delete("sa3-small-music")

        # A config that names no encoder can't be made ready.
        hub.model_configs[MUSIC_REPO] = {"model": {}}
        model_service.start_download("sa3-small-music")
        job = _wait("sa3-small-music")
        check("a config without an encoder entry fails with a plain reason",
              job.state == "failed" and "text encoder" in (job.error or ""), str(job.error))
        check("and never counts as downloaded", not model_service.spec_downloaded(music))
        model_service.delete("sa3-small-music")

        # A public model must not receive the app's token.
        hub.calls.clear()
        model_service.start_download("kokoro-82m")
        _wait("kokoro-82m")
        check("an ungated download is made without the app's token",
              hub.calls and all(call["token"] is None for call in hub.calls), str(hub.calls))
    finally:
        huggingface_hub.snapshot_download, huggingface_hub.hf_hub_download = real
        hf_token._read_environment, voice_service.resume_pending = real_env, real_resume
        hf_token.clear()
        config.clear_setting("models_dir")


# --------------------------------------------------------------------------
# The adapter, against a fake package with the real call shapes
# --------------------------------------------------------------------------


def test_adapter() -> None:
    print("adapter: the real code against a fake stable_audio_3")
    import importlib.machinery  # noqa: PLC0415
    import types  # noqa: PLC0415

    import huggingface_hub  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

    seen: dict = {"loads": [], "calls": [], "wrapped": []}

    class FakeNetwork:
        sample_rate = 44100

    class FakeStableAudioModel:
        nan = False
        quiet = False

        def __init__(self, model, model_config, device, model_half):
            self.model, self.model_config = model, model_config
            self.device, self.model_half = device, model_half
            seen["wrapped"].append((device, model_half))

        def generate(self, prompt=None, negative_prompt=None, duration=120, steps=8,
                     cfg_scale=1.0, batch_size=1, sample_size=5292032, seed=-1, **kwargs):
            seen["calls"].append({"prompt": prompt, "duration": duration, "steps": steps,
                                  "cfg": cfg_scale, "seed": seed, "batch": batch_size,
                                  "sample_size": sample_size, "extra": kwargs})
            samples = int(44100 * duration)
            wave = torch.full((batch_size, 2, samples), 0.0 if self.quiet else 0.25)
            if self.nan:
                wave[0, 0, 5] = float("nan")
            return wave

    def load_diffusion_cond(model_config, ckpt_path, device="cuda", model_half=False):
        seen["loads"].append({"config": model_config, "ckpt": ckpt_path, "device": device, "half": model_half})
        return FakeNetwork()

    def make(name: str, **attrs):
        module = types.ModuleType(name)
        module.__spec__ = importlib.machinery.ModuleSpec(name, None, is_package=name == "stable_audio_3")
        if name == "stable_audio_3":
            module.__path__ = []
        for key, value in attrs.items():
            setattr(module, key, value)
        return module

    fakes = {
        "stable_audio_3": make("stable_audio_3"),
        "stable_audio_3.loading_utils": make("stable_audio_3.loading_utils", load_diffusion_cond=load_diffusion_cond),
        "stable_audio_3.model": make("stable_audio_3.model", StableAudioModel=FakeStableAudioModel),
    }

    cache = _DATA_DIR / "adapter-cache"
    music_dir = cache / "music"
    encoder_dir = cache / "encoder"
    music_dir.mkdir(parents=True)
    encoder_dir.mkdir(parents=True)
    config_path = music_dir / "model_config.json"
    config_path.write_text(json.dumps(model_config()), encoding="utf-8")
    checkpoint = music_dir / "model.safetensors"
    checkpoint.write_bytes(b"x")

    asked: list[dict] = []
    missing: set[str] = set()

    def fake_file(repo_id, filename, local_files_only=False, **_kwargs):
        asked.append({"repo": repo_id, "file": filename, "offline": local_files_only})
        if filename in missing:
            raise LocalEntryNotFoundError("not in the cache")
        return str(config_path if filename == sa3_files.CONFIG_NAME else checkpoint)

    def fake_snapshot(repo_id, local_files_only=False, **_kwargs):
        asked.append({"repo": repo_id, "snapshot": True, "offline": local_files_only})
        if "encoder" in missing:
            raise LocalEntryNotFoundError("not in the cache")
        return str(encoder_dir)

    real_hardware, real_threads = devices.hardware, devices.set_cpu_threads
    real_hub = (huggingface_hub.hf_hub_download, huggingface_hub.snapshot_download)
    music = Sa3MusicBackend()
    out = _DATA_DIR / "sa3-out" / "beat.wav"

    for name, module in fakes.items():
        sys.modules[name] = module
    huggingface_hub.hf_hub_download = fake_file
    huggingface_hub.snapshot_download = fake_snapshot
    devices.set_cpu_threads = lambda: None
    try:
        check("a package on the path counts as installed", music.available())
        check("the engines advertise what they can't do",
              music.supports_lyrics is False and Sa3SfxBackend().supports_lyrics is False)
        check("music and sound effects are two engines of two kinds",
              (music.name, music.kind) == ("sa3_music", "music")
              and (Sa3SfxBackend.name, Sa3SfxBackend.kind) == ("sa3_sfx", "sfx"))
        check("defaults: 8 steps, guidance 1", music.defaults() == (8, 1.0))

        # --- what this machine can do ---
        devices.hardware = lambda: devices.Hardware()
        support = music.support()
        check("no GPU: still supported, with a plain CPU warning that promises no speed",
              support.ok and "CPU" in (support.warning or "") and "not been measured" in (support.warning or ""))
        check("music is capped at the checkpoint's 2 minutes, effects at the app's 30 s",
              support.max_duration_seconds == 120 and Sa3SfxBackend().support().max_duration_seconds == 30)
        devices.hardware = lambda: devices.Hardware(True, (6, 1), int(6.0 * GIB), "GTX 1060")
        support = music.support()
        check("on a 6 GB card: supported, no warning", support.ok and support.warning is None)

        # --- loading ---
        devices.hardware = lambda: devices.Hardware()
        missing.add(sa3_files.WEIGHTS_NAME)
        try:
            music.load()
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("weights missing: says so and sends the user to the Models page",
              "weights" in message and "Models page" in message and not seen["loads"] and not music.is_loaded(), message)
        missing.clear()

        missing.add("encoder")
        try:
            music.load()
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("text encoder missing: names the repository, loads nothing",
              ENCODER_REPO in message and "Models page" in message and not seen["loads"], message)
        missing.clear()

        config_path.write_text(json.dumps({"model": {}}), encoding="utf-8")
        try:
            music.load()
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("a config that can't be understood is a clear error, and nothing loads",
              "can't be loaded" in message and "conditioning" in message and not seen["loads"], message)
        config_path.write_text(json.dumps(model_config()), encoding="utf-8")

        asked.clear()
        music.load()
        check("everything is read from the cache, offline",
              asked and all(item["offline"] is True for item in asked), str(asked))
        check("…for the catalog's repository and the config's encoder",
              {item["repo"] for item in asked} == {MUSIC_REPO, ENCODER_REPO}, str(asked))
        load = seen["loads"][0]
        check("the weights path and CPU settings reach the library",
              load["ckpt"] == str(checkpoint) and (load["device"], load["half"]) == ("cpu", False), str(load))
        encoder = [c for c in load["config"]["model"]["conditioning"]["configs"] if c["type"] == "t5gemma"][0]["config"]
        check("the encoder is pinned to its local folder, so loading it can't reach the network",
              encoder["model_path"] == str(encoder_dir))
        check("the file on disk was not rewritten",
              "model_path" not in config_path.read_text(encoding="utf-8"))
        check("it reports itself loaded on the CPU", music.is_loaded() and music.device() == "cpu")
        check("the library wrapper got what from_pretrained would give it",
              seen["wrapped"][-1] == ("cpu", False) and music._model.model.use_lora is False
              and music._model.model.lora_names == [])
        before = len(seen["loads"])
        music.load()
        check("loading twice does nothing", len(seen["loads"]) == before)
        music.unload()
        check("unload drops the model", music._model is None and not music.is_loaded() and music.device() is None)

        for capability, expected, label in (
            ((6, 1), False, "Pascal (GTX 1060): float32"),
            ((7, 5), True, "Turing: float16"),
            ((8, 6), True, "Ampere: float16"),
        ):
            devices.hardware = lambda c=capability: devices.Hardware(True, c, 8 * GIB, "gpu")
            music.load()
            check(f"{label}, on CUDA", (seen["loads"][-1]["device"], seen["loads"][-1]["half"]) == ("cuda", expected),
                  str(seen["loads"][-1]))
            music.unload()

        # --- generating ---
        devices.hardware = lambda: devices.Hardware()
        result = music.generate(AudioSpec("lo-fi hip hop, warm Rhodes", 12.0), out)
        call = seen["calls"][-1]
        check("defaults: 8 steps, guidance 1, a seed was drawn, one clip",
              call["steps"] == 8 and call["cfg"] == 1.0 and 0 <= call["seed"] < 2**31 and call["batch"] == 1, str(call))
        check("the prompt and length reach the library unchanged",
              call["prompt"] == "lo-fi hip hop, warm Rhodes" and call["duration"] == 12.0)
        check("the trained length comes from the model's own config, as the library's CLI does",
              call["sample_size"] == 5292032)
        data, rate = sf.read(str(out), dtype="float32")
        check("a stereo 44.1 kHz WAV of the asked length",
              rate == 44100 and data.ndim == 2 and data.shape[1] == 2 and abs(len(data) / rate - 12.0) < 0.01,
              f"{rate} {data.shape}")
        check("the result carries path, length and device",
              result.path == out and abs((result.duration_seconds or 0) - 12.0) < 0.01 and result.device == "cpu"
              and result.warning is None)

        music.generate(AudioSpec("rain", 5.0, seed=7, steps=4, guidance=3.0), out)
        call = seen["calls"][-1]
        check("explicit seed, steps and guidance are forwarded",
              (call["seed"], call["steps"], call["cfg"]) == (7, 4, 3.0), str(call))

        music.generate(AudioSpec("long", 600.0), out)
        check("a clip past the trained length is clamped to 2 minutes", seen["calls"][-1]["duration"] == 120.0)
        music.generate(AudioSpec("tiny", 0.2), out)
        check("a vanishing clip is raised to one second", seen["calls"][-1]["duration"] == 1.0)

        try:
            music.generate(AudioSpec("a song", 20.0, lyrics="la la la"), out)
            message = ""
        except ValueError as exc:
            message = str(exc)
        check("lyrics are refused, not sung as plain text", "lyrics" in message and "ACE-Step" in message, message)

        FakeStableAudioModel.quiet = True
        result = music.generate(AudioSpec("silence", 3.0), out)
        check("a nearly silent result carries a warning", "almost silent" in (result.warning or ""), str(result.warning))
        FakeStableAudioModel.quiet = False

        FakeStableAudioModel.nan = True
        try:
            music.generate(AudioSpec("broken", 3.0), out)
            message = ""
        except RuntimeError as exc:
            message = str(exc)
        check("NaN audio is an error, not a silent file", "invalid audio" in message, message)
        FakeStableAudioModel.nan = False

        music.unload()
        try:
            music._generate(AudioSpec("x", 3.0), out)
            message = ""
        except BackendUnavailable as exc:
            message = str(exc)
        check("generating without a model is a clear error", "unloaded" in message, message)
    finally:
        for name in fakes:
            sys.modules.pop(name, None)
        devices.hardware, devices.set_cpu_threads = real_hardware, real_threads
        huggingface_hub.hf_hub_download, huggingface_hub.snapshot_download = real_hub
    check("without the package, the engines say they are not installed",
          not music.available() and not Sa3SfxBackend().available())
    try:
        Sa3SfxBackend().generate(AudioSpec("door", 2.0), out)
        message = ""
    except BackendUnavailable as exc:
        message = str(exc)
    check("…and point at the Models page", "Models page" in message, message)


# --------------------------------------------------------------------------
# The API
# --------------------------------------------------------------------------


def test_api() -> None:
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from app import create_app  # noqa: PLC0415

    print("api: token routes, engine list and the lyrics refusal")
    real_hardware = devices.hardware
    real_env = hf_token._read_environment
    devices.hardware = lambda: devices.Hardware()
    hf_token._read_environment = lambda: None
    hf_token.clear()
    try:
        with TestClient(create_app()) as client:
            r = client.get("/api/models/hf-token")
            check("the token status starts empty", r.status_code == 200 and r.json() == {"configured": False, "source": None}, r.text)

            r = client.put("/api/models/hf-token", json={"token": "hello"})
            check("a token of the wrong shape is a 400 with advice",
                  r.status_code == 400 and "hf_" in r.text, r.text)

            r = client.put("/api/models/hf-token", json={"token": TOKEN})
            check("saving answers with the status only",
                  r.status_code == 200 and r.json() == {"configured": True, "source": "app"} and TOKEN not in r.text, r.text)
            r = client.get("/api/models/hf-token")
            check("reading it back never returns the token", TOKEN not in r.text and r.json()["configured"] is True)
            check("the token isn't part of the models listing",
                  TOKEN not in client.get("/api/models").text)
            check("…or of the settings", TOKEN not in client.get("/api/settings").text)

            r = client.delete("/api/models/hf-token")
            check("DELETE on the token route clears it (not read as a model id)",
                  r.status_code == 200 and r.json()["configured"] is False, r.text)
            check("the file is gone", not (config.SECRETS_DIR / "hf_token").exists())

            r = client.post("/api/models/sa3-small-music/download")
            check("downloading a gated model without a token is a 400 that says what to do",
                  r.status_code == 400 and "gated" in r.text and "Hugging Face access" in r.text, r.text)

            rows = {row["name"]: row for row in client.get("/api/audio-engines").json()}
            check("both Stable Audio 3 engines are listed", {"sa3_music", "sa3_sfx"} <= set(rows))
            check("music: instrumental only, sfx: no lyrics",
                  rows["sa3_music"]["lyrics"] is False and rows["sa3_sfx"]["lyrics"] is False
                  and rows["acestep"]["lyrics"] is True)
            check("they report gated, the license and the combined download size",
                  rows["sa3_music"]["gated"] and rows["sa3_music"]["license_name"] == "Stability AI Community License"
                  and rows["sa3_music"]["download_estimate_bytes"] > 3 * catalog.GB)
            check("they are runnable on a machine without a GPU (unlike ACE-Step and MOSS)",
                  rows["sa3_music"]["supported"] and rows["sa3_sfx"]["supported"]
                  and not rows["acestep"]["supported"] and not rows["moss_sfx"]["supported"])
            check("neither is the default of its kind", not rows["sa3_music"]["default"] and not rows["sa3_sfx"]["default"])

            r = client.post("/api/generations/audio", json={
                "kind": "music", "engine": "sa3_music", "prompt": "a ballad", "duration_seconds": 20,
                "lyrics": "la la la"})
            check("lyrics for an engine that can't sing are refused with advice, before anything else",
                  r.status_code == 400 and "can't sing lyrics" in r.text and "Pick another engine" in r.text, r.text)
            r = client.post("/api/generations/audio", json={
                "kind": "music", "engine": "sa3_music", "prompt": "a ballad", "duration_seconds": 20})
            check("an instrumental request is checked for readiness: not installed -> 409 with what to do",
                  r.status_code == 409 and "Models page" in r.text, r.text)
            r = client.post("/api/generations/audio", json={
                "kind": "sfx", "engine": "sa3_music", "prompt": "door", "duration_seconds": 2})
            check("an engine of the wrong kind is refused", r.status_code == 400, r.text)
    finally:
        devices.hardware = real_hardware
        hf_token._read_environment = real_env
        hf_token.clear()


def main() -> int:
    test_encoder_config()
    test_token_store()
    test_catalog_entries()
    test_downloads()
    test_adapter()
    test_api()          # last: closing the TestClient shuts the worker executor down
    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
