"""Live KittenTTS 2 check (docs/audio-roadmap.md, Appendix A). Loads the model.

    python backend/tests/test_generate_kitten.py

Needs `kittenml` and an already-downloaded Kitten variant (Models page); it never
downloads anything itself and skips when either is missing. It uses the variant
that is on disk, so it works for the small one too. Heavy: it loads a 1.7B model
(GPU if there is one, otherwise a CPU run about 15x slower than real time).

What it proves, in order:
  1. a preset voice speaks,
  2. a cloned profile builds its voice print (and no Whisper download happens),
  3. the clone speaks,
  4. after `unload()` the voice print is reused and the clone speaks again.
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

os.environ.setdefault("VOICECRAFT_DATA_DIR", tempfile.mkdtemp(prefix="voicecraft-kitten-live-"))
os.environ["PYTHONUTF8"] = "1"

import catalog  # noqa: E402
import config  # noqa: E402
from services import model_service  # noqa: E402

TEXT = "Welcome back to the show. This sentence was generated entirely on this machine."
WHISPER_REPO = "models--openai--whisper-large-v3"

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


def pick_downloaded_variant() -> str | None:
    for spec in catalog.for_engine("kitten"):
        if model_service.spec_downloaded(spec):
            return spec.id
    return None


def wait(client, kind: str, ident: str, timeout: float = 900.0) -> dict:
    deadline = time.monotonic() + timeout
    url = f"/api/generations/{ident}" if kind == "generation" else f"/api/profiles/{ident}"
    row: dict = {}
    while time.monotonic() < deadline:
        row = client.get(url).json()
        if kind == "generation" and row["status"] in ("completed", "failed"):
            return row
        if kind == "profile" and row["voice_status"] in ("ready", "failed"):
            return row
        time.sleep(1.0)
    return row


def generate(client, profile_id: str, **extra) -> tuple[dict, float]:
    started = time.monotonic()
    queued = client.post("/api/generations", json={"profile_id": profile_id, "text": TEXT, **extra}).json()
    done = wait(client, "generation", queued["id"])
    return done, time.monotonic() - started


def main() -> int:
    from importlib.util import find_spec

    if find_spec("kittenml") is None:
        print("SKIP  kittenml is not installed (pip install kittenml==0.9.4)")
        return 0
    variant = pick_downloaded_variant()
    if variant is None:
        print("SKIP  no KittenTTS 2 variant is downloaded; get one from the Models page")
        return 0
    config.save_settings({catalog.ACTIVE_SETTING: {"kitten": variant}})
    print(f"using {variant}")

    import numpy as np  # noqa: PLC0415
    from fastapi.testclient import TestClient  # noqa: PLC0415

    from app import create_app  # noqa: PLC0415
    from backends import get_backend  # noqa: PLC0415
    from utils import audio  # noqa: PLC0415

    hub = config.models_dir()
    whisper_before = (hub / WHISPER_REPO).exists()

    with TestClient(create_app()) as client:
        print("preset voice")
        preset = client.post("/api/profiles", data={
            "name": "Bruno", "engine": "kitten", "preset_voice": "Bruno"}).json()
        done, seconds = generate(client, preset["id"], seed=1, preset="stable")
        check("preset generation completed", done["status"] == "completed", str(done.get("error")))
        if done["status"] != "completed":
            return 1
        length = audio.probe_duration(Path(done["audio_path"])) or 0.0
        check("it produced speech", length > 1.0, f"{length:.2f}s")
        print(f"        {length:.1f}s of audio in {seconds:.1f}s on {done['device']} "
              f"(includes the model load); params={done['params']}")

        print("clone")
        snapshot = next((hub / "models--KittenML--kitten-tts-2" / "snapshots").iterdir())
        entries = json.loads((snapshot / "voices" / "voices.json").read_text(encoding="utf-8"))
        entry = entries["Bruno"]
        sample = snapshot / "voices" / entry["reference"]
        clone = client.post(
            "/api/profiles",
            data={"name": "Clone", "engine": "kitten", "sample_text": entry["transcript"]},
            files={"sample": (sample.name, sample.read_bytes(), "audio/wav")},
        ).json()
        check("a clone starts pending", clone["voice_status"] == "pending")
        clone = wait(client, "profile", clone["id"])
        check("the voice print is ready", clone["voice_status"] == "ready", str(clone.get("voice_error")))
        if clone["voice_status"] != "ready":
            return 1
        with np.load(clone["voice_path"], allow_pickle=False) as payload:
            check("it loads without pickle", payload["embedding"].shape == (512,))
        check("no Whisper download happened",
              (hub / WHISPER_REPO).exists() == whisper_before)

        done, seconds = generate(client, clone["id"], seed=1)
        check("clone generation completed", done["status"] == "completed", str(done.get("error")))
        length = audio.probe_duration(Path(done["audio_path"])) or 0.0
        check("the clone produced speech", length > 1.0, f"{length:.2f}s")
        print(f"        {length:.1f}s of audio in {seconds:.1f}s on {done['device']}")

        print("reload")
        get_backend("kitten").unload()
        check("unloaded", not get_backend("kitten").is_loaded())
        done, seconds = generate(client, clone["id"], seed=1)
        check("clone speaks again after a reload", done["status"] == "completed", str(done.get("error")))
        check("still no Whisper download", (hub / WHISPER_REPO).exists() == whisper_before)

    print(f"\n{PASSED} passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
