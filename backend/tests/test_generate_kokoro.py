"""Live generation check (M2). Needs `torch` + `kokoro` installed.

    python backend/tests/test_generate_kokoro.py

Creates a Kokoro profile, generates a sentence, waits for the job, and reports
the resulting WAV. First run downloads the ~330 MB model from Hugging Face.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

os.environ.setdefault(
    "VOICECRAFT_DATA_DIR", tempfile.mkdtemp(prefix="voicecraft-generate-")
)

from app import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from utils import audio  # noqa: E402

TEXT = "Welcome back to the show. This sentence was generated entirely on this machine."


def main() -> int:
    with TestClient(create_app()) as client:
        engines = {e["name"]: e for e in client.get("/api/health").json()["engines"]}
        if not engines["kokoro"]["available"]:
            print("SKIP  kokoro is not installed (pip install kokoro misaki[en])")
            return 0

        profile = client.post(
            "/api/profiles",
            data={"name": "Draft", "engine": "kokoro", "language": "en",
                  "preset_voice": "af_heart"},
        ).json()

        started = time.monotonic()
        generation = client.post(
            "/api/generations", json={"profile_id": profile["id"], "text": TEXT}
        ).json()
        print(f"queued {generation['id']}")

        deadline = started + 300  # first run includes the model download
        while time.monotonic() < deadline:
            generation = client.get(f"/api/generations/{generation['id']}").json()
            if generation["status"] in ("completed", "failed"):
                break
            time.sleep(1.0)

        elapsed = time.monotonic() - started
        if generation["status"] != "completed":
            print(f"FAIL  status={generation['status']} error={generation['error']}")
            return 1

        path = Path(generation["audio_path"])
        duration = audio.probe_duration(path)
        print(f"PASS  {path}")
        print(f"      {duration:.2f}s of audio in {elapsed:.1f}s on {generation['device']}")
        return 0 if duration and duration > 1.0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
