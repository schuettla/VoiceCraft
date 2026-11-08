"""Checks for the shared plumbing (docs/audio-roadmap.md, Phase 2).

No model weights, no GPU work: the Hugging Face cache is a folder of empty
files, engines are fakes, and the device helper is driven by a patched
compute capability. Run from the repo root:

    python backend/tests/test_plumbing.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
from dataclasses import replace
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-plumbing-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"
os.environ["VOICECRAFT_IDLE_UNLOAD_SECONDS"] = "0"  # the watcher is driven by hand below
for _var in ("VOICECRAFT_QWEN_MODEL", "VOICECRAFT_KOKORO_MODEL"):
    os.environ.pop(_var, None)

import catalog  # noqa: E402
import config  # noqa: E402
from backends import device as devices  # noqa: E402
from backends import _REGISTRY, unload_except  # noqa: E402
from catalog import ExtraFile, ModelSpec  # noqa: E402
from database import session as db_session  # noqa: E402
from database.models import Generation  # noqa: E402
from database.session import session_scope  # noqa: E402
from services import generation_service, model_service  # noqa: E402

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


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * 16)


def fake_snapshot(cache: Path, repo_id: str, files: list[str], incomplete: bool = False) -> None:
    root = cache / f"models--{repo_id.replace('/', '--')}"
    for name in files:
        touch(root / "snapshots" / "abc123" / name)
    (root / "blobs").mkdir(parents=True, exist_ok=True)
    if incomplete:
        touch(root / "blobs" / "deadbeef.incomplete")


# --------------------------------------------------------------------------


def test_device() -> None:
    print("device helper")
    real = devices.cuda_capability
    try:
        devices.cuda_capability = lambda: (8, 6)
        plan = devices.pick_device(engine="X", wants_bf16=True)
        check("Ampere + bf16 wanted -> bfloat16, no warning",
              plan.dtype_name == "bfloat16" and plan.kind == "cuda" and plan.warning is None)
        plan = devices.pick_device(engine="X", wants_bf16=False)
        check("Ampere, bf16 not wanted -> float32", plan.dtype_name == "float32")

        devices.cuda_capability = lambda: (6, 1)
        plan = devices.pick_device(engine="Kitten", wants_bf16=True)
        check("Pascal -> float32 with a warning naming the engine",
              plan.dtype_name == "float32" and "Kitten" in (plan.warning or ""))
        plan = devices.pick_device(engine="SA3", wants_bf16=True, allow_fp16=True)
        check("Pascal, fp16 allowed -> float16 with a warning",
              plan.dtype_name == "float16" and plan.warning is not None)

        devices.cuda_capability = lambda: None
        plan = devices.pick_device(engine="X", wants_bf16=True, supports_mps=False)
        check("no GPU -> CPU, float32, warning",
              plan.device == "cpu" and plan.dtype_name == "float32" and plan.warning is not None)
        import torch  # noqa: PLC0415

        check("CPU path caps the thread pool", torch.get_num_threads() <= devices.MAX_CPU_THREADS)
    finally:
        devices.cuda_capability = real


def test_reference() -> None:
    print("reference loader")
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    from utils import audio  # noqa: PLC0415

    path = _DATA_DIR / "stereo.wav"
    tone = (np.sin(np.linspace(0, 200, 16000)) * 1.0).astype("float32")
    sf.write(str(path), np.stack([tone, tone * 0.5], axis=1), 16000)
    samples, rate = audio.load_reference(path)
    check("stereo is downmixed to mono", samples.ndim == 1 and len(samples) == 16000)
    check("sample rate kept", rate == 16000)
    check("peak normalized to 0.95", abs(float(np.max(np.abs(samples))) - 0.95) < 1e-3)
    check("float32 and contiguous", samples.dtype == np.float32 and samples.flags.c_contiguous)


def test_catalog() -> None:
    print("catalog: active model by id")
    config.save_settings({})
    check("default is the engine's default entry", catalog.active_model("qwen").id == "qwen3-tts-0.6b")
    check("repo id follows the entry", catalog.active_repo_id("kokoro") == config.DEFAULT_KOKORO_MODEL_ID)
    check("unknown engine raises", _raises(KeyError, catalog.active_model, "nope"))

    config.save_settings({"qwen_model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base"})
    check("legacy repo-id setting still resolves",
          catalog.active_model("qwen").id == "qwen3-tts-1.7b")

    model_service.select("qwen3-tts-0.6b")
    settings = config.load_settings()
    check("select stores the model id", settings["active_models"]["qwen"] == "qwen3-tts-0.6b")
    check("select drops the legacy key", "qwen_model" not in settings)
    check("select wins over the old value", catalog.active_model("qwen").id == "qwen3-tts-0.6b")

    config.save_settings({"active_models": {"qwen": "does-not-exist"}})
    check("a stale id falls back to the default", catalog.active_model("qwen").id == "qwen3-tts-0.6b")

    os.environ["VOICECRAFT_QWEN_MODEL"] = "someone/finetune"
    try:
        check("env override wins and may be outside the catalog",
              catalog.active_repo_id("qwen") == "someone/finetune")
        check("no catalog entry is active under an override",
              not any(catalog.is_active(s) for s in catalog.for_engine("qwen")))
    finally:
        os.environ.pop("VOICECRAFT_QWEN_MODEL")
    config.save_settings({"active_models": {}})

    print("catalog: entries sharing a repo")
    shared_a = ModelSpec(
        id="t-packed", repo_id="org/shared", title="A", category="speech", engine="tengine",
        summary="", size_bytes=10, default=True, variant="packed",
        allow_patterns=("config.json", "lm/packed*"),
    )
    shared_b = replace(shared_a, id="t-emb4", variant="emb4", default=False,
                       allow_patterns=("config.json", "lm/emb4*"))
    _install_specs(shared_a, shared_b)
    try:
        check("each sees the other as sharing its repo",
              [s.id for s in catalog.sharing_repo(shared_a)] == ["t-emb4"])
        check("the default entry is active at first", catalog.active_model("tengine").id == "t-packed")
        config.save_settings({"active_models": {"tengine": "t-emb4"}})
        check("the second variant can be chosen although the repo id is identical",
              catalog.active_model("tengine").id == "t-emb4" and catalog.is_active(shared_b)
              and not catalog.is_active(shared_a))
    finally:
        _remove_specs(shared_a, shared_b)
        config.save_settings({"active_models": {}})


def test_downloads() -> None:
    print("model_service: per-entry download state")
    cache = _DATA_DIR / "hf-cache"
    config.save_settings({"models_dir": str(cache)})

    packed = ModelSpec(
        id="d-packed", repo_id="org/kit", title="P", category="speech", engine="dengine",
        summary="", size_bytes=10, allow_patterns=("config.json", "lm/packed*", "speaker/*"),
        extra_files=(ExtraFile("other/codec", "s3gen.safetensors", 5),),
    )
    emb4 = replace(packed, id="d-emb4", allow_patterns=("config.json", "lm/emb4*", "speaker/*"),
                   extra_files=())
    _install_specs(packed, emb4)
    try:
        check("nothing downloaded yet", not model_service.spec_downloaded(packed))

        fake_snapshot(cache, "org/kit", ["config.json", "lm/packed.bin", "speaker/s.bin"])
        check("main repo complete but the extra file is missing -> not downloaded",
              not model_service.spec_downloaded(packed))
        check("the sibling variant is not marked downloaded by it",
              not model_service.spec_downloaded(emb4))

        fake_snapshot(cache, "other/codec", ["s3gen.safetensors"])
        check("main + extra present -> downloaded", model_service.spec_downloaded(packed))
        check("an entry without extras only needs its own files",
              not model_service.spec_downloaded(emb4))

        fake_snapshot(cache, "org/kit", ["lm/emb4.bin"])
        check("sibling becomes downloaded once its own files land",
              model_service.spec_downloaded(emb4))

        info = model_service.describe(packed)
        check("describe reports the shared repo", info["shared_with"] == ["d-emb4"])
        check("describe size counts only this entry's files (+ extras)",
              info["size_bytes"] == 16 * 3 + 16, str(info["size_bytes"]))
        check("estimate includes the extra file", info["download_estimate_bytes"] == 15)

        fake_snapshot(cache, "org/kit", ["lm/more.bin"], incomplete=True)
        check("an in-flight .incomplete blob means not downloaded",
              not model_service.spec_downloaded(packed))
        for blob in (cache / "models--org--kit" / "blobs").glob("*.incomplete"):
            blob.unlink()

        # A third entry from a different repo that also needs the codec files.
        borrower = replace(
            packed, id="d-borrower", repo_id="org/borrower", allow_patterns=(),
        )
        _install_specs(borrower)
        try:
            fake_snapshot(cache, "org/borrower", ["weights.bin"])
            model_service.delete("d-emb4")
            check("deleting one variant removes the shared repo, both variants",
                  not (cache / "models--org--kit").exists()
                  and not model_service.spec_downloaded(packed)
                  and not model_service.spec_downloaded(emb4))
            check("extra files another entry still needs are kept",
                  (cache / "models--other--codec").exists())

            model_service.delete("d-borrower")
            check("once nothing needs the extra repo it is removed too",
                  not (cache / "models--other--codec").exists())
        finally:
            _remove_specs(borrower)
    finally:
        _remove_specs(packed, emb4)
        config.clear_setting("models_dir")

    print("model_service: license fields")
    qwen = model_service.describe(catalog.get("qwen3-tts-0.6b"))
    check("open tier with a license name", qwen["license_tier"] == "open" and qwen["license_name"] == "Apache 2.0")
    check("license url present", bool(qwen["license_url"]))
    check("not gated", qwen["gated"] is False)


def test_generation_columns() -> None:
    print("generations: kind / engine / params")
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from app import create_app  # noqa: PLC0415

    with TestClient(create_app()) as client:
        with session_scope() as session:
            session.add(Generation(id="g-old", text="legacy row", status="completed"))
            session.add(Generation(
                id="g-new", text="a door slam", status="completed", kind="sfx",
                engine="moss_sfx", params=json.dumps({"seed": 7, "steps": 12}),
            ))
            session.add(Generation(id="g-bad", text="bad params", status="completed",
                                   params="{not json"))
        rows = {row["id"]: row for row in client.get("/api/generations").json()}
        check("a row without the new values reads as speech", rows["g-old"]["kind"] == "speech")
        check("engine and params default to null",
              rows["g-old"]["engine"] is None and rows["g-old"]["params"] is None)
        check("kind and engine round-trip", rows["g-new"]["kind"] == "sfx" and rows["g-new"]["engine"] == "moss_sfx")
        check("params come back as an object", rows["g-new"]["params"] == {"seed": 7, "steps": 12})
        check("unparseable params don't break the listing", rows["g-bad"]["params"] is None)

        health = client.get("/api/health").json()
        check("health carries the optional flag", all("optional" in e for e in health["engines"]))
        check("speech engines are not optional",
              not any(e["optional"] for e in health["engines"] if e["name"] in ("qwen", "kokoro", "kitten")))
        check("health reports the catalog entry in use",
              {e["name"]: e["model_id"] for e in health["engines"]} == {
                  "qwen": "qwen3-tts-0.6b", "kokoro": "kokoro-82m", "kitten": "kitten-tts-2",
                  "acestep": "acestep-1.5-turbo", "moss_sfx": "moss-sfx-v2",
                  "sa3_music": "sa3-small-music", "sa3_sfx": "sa3-small-sfx"})

        test_kitten_options(client)

        models = client.get("/api/models").json()["models"]
        check("models expose license tier", all(m["license_tier"] in ("open", "conditional", "noncommercial") for m in models))

    print("generations: migrating an old database")
    with db_session._engine.begin() as connection:
        for column in ("kind", "engine", "params"):
            connection.exec_driver_sql(f"ALTER TABLE generations DROP COLUMN {column}")
    db_session._add_missing_columns()
    with db_session._engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(generations)").fetchall()}
        kinds = {row[0] for row in connection.exec_driver_sql("SELECT kind FROM generations").fetchall()}
    check("the three columns are added back", {"kind", "engine", "params"} <= columns)
    check("existing rows get kind='speech'", kinds == {"speech"}, str(kinds))


class RecordingEngine:
    """Writes a short silent WAV and remembers the voice it was asked for."""

    optional = False

    def __init__(self, name: str, supports_cloning: bool) -> None:
        self.name = name
        self.supports_cloning = supports_cloning
        self.voices: list = []

    def available(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False

    def device(self) -> str | None:
        return "cpu"

    def unload(self) -> None:
        pass

    def synthesize(self, text, voice, out_path):
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
        from backends.base import SynthesisResult  # noqa: PLC0415

        self.voices.append(voice)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), np.zeros(2400, dtype="float32"), 24000)
        return SynthesisResult(path=out_path, duration_seconds=0.1, device="cpu")


def _wait_for(client, generation_id: str) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        row = client.get(f"/api/generations/{generation_id}").json()
        if row["status"] in ("completed", "failed"):
            return row
        time.sleep(0.05)
    return row


def test_kitten_options(client) -> None:
    print("generations: KittenTTS options")
    kitten = RecordingEngine("kitten", supports_cloning=True)
    kokoro = RecordingEngine("kokoro", supports_cloning=False)
    saved = dict(_REGISTRY)
    _REGISTRY.update({"kitten": kitten, "kokoro": kokoro})
    try:
        made = client.post("/api/profiles", data={"name": "Bruno", "engine": "kitten", "preset_voice": "Bruno"})
        check("a kitten preset profile is accepted", made.status_code == 201, made.text)
        profile_id = made.json()["id"]

        plain = client.post("/api/generations", json={"profile_id": profile_id, "text": "Hello."}).json()
        done = _wait_for(client, plain["id"])
        check("without options, params holds only the model that made it", done["status"] == "completed" and done["params"] == {"model": "kitten-tts-2"}, str(done))
        check("kind and engine are recorded", done["kind"] == "speech" and done["engine"] == "kitten")

        styled = client.post("/api/generations", json={
            "profile_id": profile_id, "text": "Hello.", "preset": "expressive", "seed": 5}).json()
        check("preset and seed are stored in params", styled["params"] == {"preset": "expressive", "seed": 5, "model": "kitten-tts-2"}, str(styled))
        done = _wait_for(client, styled["id"])
        check("the job completed", done["status"] == "completed", str(done))
        check("the engine received them", kitten.voices[-1].options == {"preset": "expressive", "seed": 5}
              and kitten.voices[-1].preset_voice == "Bruno")

        seed_zero = client.post("/api/generations", json={
            "profile_id": profile_id, "text": "Hello.", "seed": 0}).json()
        check("a seed of 0 is kept", seed_zero["params"] == {"seed": 0, "model": "kitten-tts-2"}, str(seed_zero))
        _wait_for(client, seed_zero["id"])

        check("an unknown style is rejected by the API",
              client.post("/api/generations", json={
                  "profile_id": profile_id, "text": "x", "preset": "angry"}).status_code == 422)
        check("a negative seed is rejected",
              client.post("/api/generations", json={
                  "profile_id": profile_id, "text": "x", "seed": -1}).status_code == 422)

        draft = client.post("/api/profiles", data={"name": "Draft", "engine": "kokoro", "preset_voice": "af_heart"}).json()
        other = client.post("/api/generations", json={
            "profile_id": draft["id"], "text": "Hello.", "preset": "expressive", "seed": 9}).json()
        check("engines without these knobs don't record them", other["params"] == {"model": "kokoro-82m"}, str(other))
        _wait_for(client, other["id"])
        check("and don't receive them", kokoro.voices[-1].options == {})
    finally:
        _REGISTRY.clear()
        _REGISTRY.update(saved)


class FakeEngine:
    optional = False
    supports_cloning = False

    def __init__(self, name: str, loaded: bool) -> None:
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


def test_scheduling() -> None:
    print("GPU scheduling")
    keep = FakeEngine("keep", True)
    drop = FakeEngine("drop", True)
    cold = FakeEngine("cold", False)
    saved = dict(_REGISTRY)
    _REGISTRY.clear()
    _REGISTRY.update({"keep": keep, "drop": drop, "cold": cold})
    try:
        dropped = unload_except("keep")
        check("only loaded engines other than the one needed are unloaded", dropped == ["drop"])
        check("the needed engine stays loaded", keep.is_loaded() and keep.unloads == 0)
        check("an engine that wasn't loaded is left alone", cold.unloads == 0)

        _REGISTRY["drop"] = FakeEngine("drop", True)
        generation_service.release_other_engines("keep")
        check("release_other_engines drops the others", not _REGISTRY["drop"].is_loaded())

        # idle unload
        generation_service.IDLE_UNLOAD_SECONDS = 0.15
        generation_service._last_activity = time.monotonic()
        check("not idle yet -> nothing unloaded", generation_service._idle_check() is False and keep.is_loaded())
        time.sleep(0.25)
        generation_service._pending = 1
        check("idle but a job is pending -> nothing unloaded",
              generation_service._idle_check() is False and keep.is_loaded())
        generation_service._pending = 0
        check("idle with nothing pending -> unloaded", generation_service._idle_check() is True)
        check("the loaded engine was released", not keep.is_loaded())
        check("nothing loaded -> nothing to do", generation_service._idle_check() is False)

        # The Settings preference decides when the environment variable isn't set.
        generation_service.IDLE_UNLOAD_SECONDS = None
        config.save_settings({"preferences": {}})
        check("no preference: the default is ten minutes", generation_service.idle_seconds() == 600)
        config.save_settings({"preferences": {"idle_unload_minutes": 3}})
        check("the preference is read each time", generation_service.idle_seconds() == 180)
        config.save_settings({"preferences": {"idle_unload_minutes": 0}})
        check("0 minutes keeps models loaded", generation_service.idle_seconds() == 0
              and generation_service._idle_check() is False)
        config.save_settings({"preferences": {"idle_unload_minutes": "soon"}})
        check("a damaged value falls back to the default", generation_service.idle_seconds() == 600)
        generation_service.IDLE_UNLOAD_SECONDS = 5
        config.save_settings({"preferences": {"idle_unload_minutes": 3}})
        check("the environment variable wins over the preference", generation_service.idle_seconds() == 5)
        config.save_settings({"preferences": {}})

        # the real queue keeps the pending count honest
        generation_service.IDLE_UNLOAD_SECONDS = 0
        done: list[int] = []
        generation_service.submit(lambda: done.append(1))
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and generation_service._pending:
            time.sleep(0.02)
        check("submit runs the job and counts it down", done == [1] and generation_service._pending == 0)

        def boom() -> None:
            raise RuntimeError("job failed")

        generation_service.submit(boom)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and generation_service._pending:
            time.sleep(0.02)
        check("a failing job still decrements the count", generation_service._pending == 0)

        # With idle unload off, the watcher looks rarely instead of twice a second.
        generation_service.IDLE_UNLOAD_SECONDS = 0
        check("idle unload off -> the watcher waits 30 s", generation_service._watch_interval() == 30.0)
        generation_service.IDLE_UNLOAD_SECONDS = 1
        check("idle unload on -> the watcher checks often", generation_service._watch_interval() == 0.5)
        generation_service.IDLE_UNLOAD_SECONDS = 0

        # Picking or deleting a model from a request must not unload the engine
        # under a running job: the unload waits for the worker.
        busy = FakeEngine("busy", True)
        _REGISTRY["busy"] = busy
        gate = threading.Event()
        seen: dict[str, bool] = {}

        def running_job() -> None:
            gate.wait(3)
            seen["loaded_during_job"] = busy.is_loaded()

        generation_service.submit(running_job)
        model_service._unload_engine("busy")
        check("a request's unload doesn't hit the running job", busy.is_loaded() and busy.unloads == 0)
        gate.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and generation_service._pending:
            time.sleep(0.02)
        check("…the job finished with its engine loaded", seen.get("loaded_during_job") is True)
        check("…and the unload ran after it", not busy.is_loaded() and busy.unloads == 1)

        busy._loaded = True
        generation_service.submit(model_service._unload_engine, "busy")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and generation_service._pending:
            time.sleep(0.02)
        check("on the worker itself the unload is immediate", not busy.is_loaded() and busy.unloads == 2)
        check("…and doesn't queue a second job", generation_service._pending == 0)
    finally:
        _REGISTRY.clear()
        _REGISTRY.update(saved)
        generation_service.IDLE_UNLOAD_SECONDS = 0


# --------------------------------------------------------------------------


def _raises(exc: type[BaseException], fn, *args) -> bool:
    try:
        fn(*args)
    except exc:
        return True
    return False


def _install_specs(*specs: ModelSpec) -> None:
    catalog.MODELS = (*catalog.MODELS, *specs)
    catalog._BY_ID.update({spec.id: spec for spec in specs})


def _remove_specs(*specs: ModelSpec) -> None:
    ids = {spec.id for spec in specs}
    catalog.MODELS = tuple(spec for spec in catalog.MODELS if spec.id not in ids)
    for spec_id in ids:
        catalog._BY_ID.pop(spec_id, None)


def main() -> int:
    config.ensure_dirs()
    db_session.init_db()
    test_device()
    test_reference()
    test_catalog()
    test_downloads()
    # Before the API test: closing the TestClient shuts the worker executor down.
    test_scheduling()
    test_generation_columns()
    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
