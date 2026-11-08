"""End-to-end smoke test of the API against real ffmpeg.

Covers the parts that don't need model weights: profile CRUD, asset upload,
trim, assemble (with crossfade), and convert. Run from the repo root:

    VOICECRAFT_DATA_DIR=... python backend/tests/test_smoke.py

It creates its own throwaway data dir and prints a pass/fail line per step.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-test-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
# Creating a cloning profile would otherwise load the model and extract a real
# voice print — minutes of GPU time this suite is designed not to need.
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"

import config  # noqa: E402
from app import create_app  # noqa: E402
from database.models import Generation  # noqa: E402
from database.session import session_scope  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

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


def make_tone(path: Path, seconds: float, freq: int) -> Path:
    subprocess.run(
        [
            config.FFMPEG, "-y", "-f", "lavfi",
            "-i", f"sine=frequency={freq}:duration={seconds}",
            "-ar", "44100", "-ac", "1", str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def main() -> int:
    tones = _DATA_DIR / "fixtures"
    tones.mkdir(parents=True, exist_ok=True)

    with TestClient(create_app()) as client:
        print("health")
        health = client.get("/api/health").json()
        check("responds", health["version"] == "0.1.0")
        check("ffmpeg detected", health["ffmpeg"] is True, str(health))
        check("speech and audio engines listed",
              {e["name"] for e in health["engines"]}
              == {"qwen", "kokoro", "kitten", "acestep", "moss_sfx", "sa3_music", "sa3_sfx"})
        check("only the music / SFX engines are optional",
              {e["name"] for e in health["engines"] if e["optional"]}
              == {"acestep", "moss_sfx", "sa3_music", "sa3_sfx"})

        print("profiles")
        voices = client.get("/api/profiles/voices").json()
        check("kokoro presets exposed", "af_heart" in voices)
        check("presets default to kokoro's list", voices == client.get(
            "/api/profiles/voices", params={"engine": "kokoro"}).json())
        kitten_voices = client.get("/api/profiles/voices", params={"engine": "kitten"}).json()
        check("kitten presets exposed", "Bruno" in kitten_voices and len(kitten_voices) >= 100)
        check("qwen has no presets",
              client.get("/api/profiles/voices", params={"engine": "qwen"}).json() == [])

        # KittenTTS 2: a profile is a clone (sample + transcript) or a preset.
        # Nothing here touches the model: creation only validates and records.
        clip = make_tone(tones / "kitten-sample.wav", 3, 330)
        clip_files = {"sample": ("kitten-sample.wav", clip.read_bytes(), "audio/wav")}
        response = client.post(
            "/api/profiles",
            data={"name": "Kitten clone", "engine": "kitten"},
            files=clip_files,
        )
        check("kitten clone without a transcript rejected", response.status_code == 400, response.text)
        check("the refusal explains why", "transcript" in response.text)
        response = client.post(
            "/api/profiles",
            data={"name": "Kitten clone", "engine": "kitten", "sample_text": "   "},
            files=clip_files,
        )
        check("a blank transcript counts as missing", response.status_code == 400)
        response = client.post(
            "/api/profiles",
            data={"name": "Both", "engine": "kitten", "sample_text": "hello", "preset_voice": "Bruno"},
            files=clip_files,
        )
        check("clone and preset together rejected", response.status_code == 400, response.text)
        response = client.post(
            "/api/profiles", data={"name": "No voice", "engine": "kitten"})
        check("kitten profile with neither rejected", response.status_code == 400)
        response = client.post(
            "/api/profiles",
            data={"name": "Bad voice", "engine": "kitten", "preset_voice": "Nobody"},
        )
        check("unknown kitten preset rejected", response.status_code == 400)
        response = client.post(
            "/api/profiles",
            data={"name": "Kitten Bruno", "engine": "kitten", "preset_voice": "Bruno"},
        )
        check("kitten preset profile created", response.status_code == 201, response.text)
        kitten_preset = response.json()
        check("a preset profile needs no voice print", kitten_preset["voice_status"] == "not_needed")
        check("preset profile keeps its voice", kitten_preset["preset_voice"] == "Bruno")
        response = client.post(
            "/api/profiles",
            data={"name": "Kitten clone", "engine": "kitten", "sample_text": "  The quick brown fox.  "},
            files=clip_files,
        )
        check("kitten clone created", response.status_code == 201, response.text)
        kitten_clone = response.json()
        check("a clone waits for its voice print", kitten_clone["voice_status"] == "pending")
        check("the transcript is stored trimmed", kitten_clone["sample_text"] == "The quick brown fox.")
        check("a clone has no preset", kitten_clone["preset_voice"] is None)
        check("retrying a preset profile stays not_needed",
              client.post(f"/api/profiles/{kitten_preset['id']}/prepare").json()["voice_status"] == "not_needed")
        for created in (kitten_preset, kitten_clone):
            client.delete(f"/api/profiles/{created['id']}")

        response = client.post(
            "/api/profiles",
            data={"name": "Draft voice", "engine": "kokoro", "language": "en",
                  "preset_voice": "af_heart"},
        )
        check("create kokoro profile", response.status_code == 201, response.text)
        profile_id = response.json()["id"]

        response = client.post(
            "/api/profiles",
            data={"name": "Bad", "engine": "kokoro", "preset_voice": "nope"},
        )
        check("unknown preset rejected", response.status_code == 400)

        response = client.post("/api/profiles", data={"name": "Clone", "engine": "qwen"})
        check("qwen without sample rejected", response.status_code == 400)

        sample = make_tone(tones / "sample.wav", 3, 220)
        response = client.post(
            "/api/profiles",
            data={"name": "Clone", "engine": "qwen", "language": "en"},
            files={"sample": ("sample.wav", sample.read_bytes(), "audio/wav")},
        )
        check("create qwen profile with sample", response.status_code == 201, response.text)
        check("listed", len(client.get("/api/profiles").json()) == 2)

        # Cloning itself needs the model, so it is switched off here (see
        # VOICECRAFT_AUTO_PREPARE below); the profile should still report
        # honestly where it stands rather than claiming to be ready.
        clone = response.json()
        check("clone profile starts unprepared", clone["voice_status"] == "pending")
        check("clone profile has no voice print yet", clone["voice_path"] is None)
        preset = client.get("/api/profiles").json()
        check(
            "preset profile needs no voice print",
            all(
                p["voice_status"] == "not_needed"
                for p in preset
                if p["engine"] == "kokoro"
            ),
        )

        print("models")
        # Nothing here downloads: the catalog, the selection, and the error
        # paths are all exercisable against whatever is (or isn't) cached.
        catalog = client.get("/api/models").json()
        ids = {m["id"] for m in catalog["models"]}
        check("catalog listed", {"qwen3-tts-0.6b", "kokoro-82m"} <= ids, str(ids))
        check("both kitten variants listed", {"kitten-tts-2", "kitten-tts-2-emb4"} <= ids, str(ids))
        check("music and sfx entries listed",
              {"acestep-1.5-turbo", "acestep-1.5-sft", "acestep-1.5-xl-turbo", "moss-sfx-v2"} <= ids, str(ids))
        check("the page has a section per kind",
              [c["id"] for c in catalog["categories"]] == ["speech", "music", "sfx"])
        check("audio entries are marked as on-demand engines",
              all(m["optional_engine"] for m in catalog["models"] if m["category"] in ("music", "sfx")))
        check("storage location reported", bool(catalog["models_dir"]))
        check(
            "one active checkpoint per engine",
            sorted(m["engine"] for m in catalog["models"] if m["active"])
            == ["acestep", "kitten", "kokoro", "moss_sfx", "qwen", "sa3_music", "sa3_sfx"],
        )

        response = client.post("/api/models/qwen3-tts-1.7b/select")
        check("select alternate checkpoint", response.status_code == 200, response.text)
        check(
            "selection took effect",
            next(m for m in response.json()["models"] if m["id"] == "qwen3-tts-1.7b")["active"],
        )
        check(
            "health reports the choice",
            next(e for e in client.get("/api/health").json()["engines"]
                 if e["name"] == "qwen")["model"] == "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        )
        client.post("/api/models/qwen3-tts-0.6b/select")

        check("unknown model rejected", client.post("/api/models/nope/select").status_code == 400)
        check("cancel with no download 404s",
              client.post("/api/models/kokoro-82m/cancel").status_code == 404)
        check("relative storage path rejected",
              client.post("/api/models/storage", json={"path": "relative"}).status_code == 400)

        moved = _DATA_DIR / "models-elsewhere"
        response = client.post("/api/models/storage", json={"path": str(moved)})
        check("storage location moved", response.status_code == 200, response.text)
        check("moved location reported", response.json()["models_dir"] == str(moved.resolve()))
        check(
            "nothing appears downloaded in the empty location",
            all(not m["downloaded"] for m in response.json()["models"]),
        )
        check("delete of an absent model rejected",
              client.delete("/api/models/kokoro-82m").status_code == 400)
        check("storage reset", client.post("/api/models/storage", json={"path": ""}).status_code == 200)

        print("assets")
        intro = make_tone(tones / "intro.wav", 2, 440)
        outro = make_tone(tones / "outro.wav", 2, 330)
        intro_id = client.post(
            "/api/edit/assets",
            data={"name": "Intro sting", "kind": "intro"},
            files={"file": ("intro.wav", intro.read_bytes(), "audio/wav")},
        ).json()["id"]
        outro_id = client.post(
            "/api/edit/assets",
            data={"name": "Outro sting", "kind": "outro"},
            files={"file": ("outro.wav", outro.read_bytes(), "audio/wav")},
        ).json()["id"]
        check("intro + outro stored", len(client.get("/api/edit/assets").json()) == 2)

        response = client.post(
            "/api/edit/assets",
            data={"name": "Not audio", "kind": "intro"},
            files={"file": ("x.txt", b"hello", "text/plain")},
        )
        check("non-audio upload rejected", response.status_code == 400)

        print("generation record")
        # Stand in for a real TTS run so the edit routes can be exercised
        # without model weights.
        body = make_tone(config.GENERATIONS_DIR / "body.wav", 6, 300)
        generation_id = uuid.uuid4().hex
        with session_scope() as session:
            session.add(
                Generation(
                    id=generation_id,
                    profile_id=profile_id,
                    text="This is the episode body.",
                    status="completed",
                    audio_path=str(body),
                    duration_seconds=6.0,
                )
            )
        listed = client.get(f"/api/generations/{generation_id}").json()
        check("generation reports its format", listed["format"] == "wav", str(listed))

        served = client.get("/api/files", params={"path": str(body)})
        check("file served for playback", served.status_code == 200)
        check(
            "path traversal blocked",
            client.get("/api/files", params={"path": "C:/Windows/win.ini"}).status_code == 403,
        )

        print("trim")
        response = client.post(
            "/api/edit/trim",
            json={"generation_id": generation_id, "start": 1.0, "end": 3.0,
                  "output_format": "wav", "name": "body-trim"},
        )
        check("trim ok", response.status_code == 201, response.text)
        trimmed = response.json()
        check("trim length ~2s", abs((trimmed["duration_seconds"] or 0) - 2.0) < 0.2,
              str(trimmed["duration_seconds"]))
        from utils import audio as audio_utils

        check(
            "source not overwritten (FR10)",
            Path(body).exists() and abs((audio_utils.probe_duration(body) or 0) - 6.0) < 0.1,
        )

        response = client.post(
            "/api/edit/trim", json={"generation_id": generation_id, "start": 99.0}
        )
        check("start past end rejected", response.status_code == 400)

        response = client.post("/api/edit/trim", json={"start": 0, "end": 1})
        check("missing source rejected", response.status_code == 422)

        print("assemble")
        response = client.post(
            "/api/edit/assemble",
            json={
                "intro_asset_id": intro_id,
                "outro_asset_id": outro_id,
                "segments": [{"generation_id": generation_id}],
                "crossfade_ms": 0,
                "output_format": "mp3",
                "name": "episode-hard-cut",
            },
        )
        check("assemble without crossfade", response.status_code == 201, response.text)
        hard = response.json()
        check("hard-cut length ~10s", abs((hard["duration_seconds"] or 0) - 10.0) < 0.4,
              str(hard["duration_seconds"]))

        response = client.post(
            "/api/edit/assemble",
            json={
                "intro_asset_id": intro_id,
                "outro_asset_id": outro_id,
                "segments": [{"generation_id": generation_id}],
                "crossfade_ms": 500,
                "output_format": "mp3",
                "name": "episode-crossfade",
            },
        )
        check("assemble with 500ms crossfade", response.status_code == 201, response.text)
        faded = response.json()
        # Two boundaries × 0.5s of overlap ⇒ ~1s shorter than the hard cut.
        check("crossfade shortens output", (faded["duration_seconds"] or 0) <
              (hard["duration_seconds"] or 0) - 0.8,
              f"{faded['duration_seconds']} vs {hard['duration_seconds']}")
        check("output is mp3", Path(faded["path"]).suffix == ".mp3")
        check("lives in EDITS_DIR", Path(faded["path"]).parent == config.EDITS_DIR)

        response = client.post(
            "/api/edit/assemble",
            json={"segments": [{"generation_id": generation_id}], "crossfade_ms": 900},
        )
        check("crossfade above 500ms rejected", response.status_code == 422)

        print("convert")
        for fmt in ("wav", "mp3", "ogg", "flac"):
            response = client.post(
                "/api/edit/convert",
                json={"generation_id": generation_id, "output_format": fmt,
                      "name": f"body-{fmt}"},
            )
            ok = response.status_code == 201 and Path(response.json()["path"]).exists()
            check(f"convert to {fmt}", ok, response.text)

        print("settings")
        settings = client.get("/api/settings").json()
        check("data dir reported", settings["data_dir"] == str(config.DATA_DIR))
        check(
            "every managed directory listed",
            {d["key"] for d in settings["directories"]}
            == {"samples", "voices", "generations", "assets", "edits", "tmp", "peaks"},
        )
        check("ffmpeg reported present", settings["ffmpeg"]["available"] is True)
        preferences = {**settings["preferences"], "default_output_format": "flac"}
        response = client.put("/api/settings/preferences", json=preferences)
        check(
            "preference saved",
            response.status_code == 200
            and response.json()["preferences"]["default_output_format"] == "flac",
            response.text,
        )
        check(
            "preference survives a reread",
            client.get("/api/settings").json()["preferences"]["default_output_format"]
            == "flac",
        )
        generate_defaults = {
            "default_music_seconds": 90, "default_music_vocals": "vocals",
            "default_sfx_seconds": 1.5, "default_sfx_takes": 3,
            "default_kitten_style": "expressive", "idle_unload_minutes": 0,
        }
        saved_prefs = client.put(
            "/api/settings/preferences", json={**settings["preferences"], **generate_defaults}
        ).json()["preferences"]
        check("the Generate defaults are saved and read back",
              all(saved_prefs[key] == value for key, value in generate_defaults.items()), str(saved_prefs))
        check("an old settings file without them gets the defaults",
              settings["preferences"]["default_music_seconds"] == 30
              and settings["preferences"]["default_sfx_takes"] == 1
              and settings["preferences"]["idle_unload_minutes"] == 10, str(settings["preferences"]))
        for bad in ({"default_music_seconds": 5}, {"default_sfx_takes": 9},
                    {"default_music_vocals": "choir"}, {"idle_unload_minutes": -1}):
            check(f"{next(iter(bad))} out of range is rejected",
                  client.put("/api/settings/preferences", json={**settings["preferences"], **bad}).status_code == 422)
        # The generation and its edits are all still referenced, so a cleanup
        # run must leave them alone (it is a space reclaim, not a delete).
        before = sum(1 for _ in config.EDITS_DIR.iterdir())
        removed = client.post("/api/settings/cleanup").json()
        check("cleanup ran", "files_removed" in removed, str(removed))
        check(
            "cleanup keeps referenced files",
            sum(1 for _ in config.EDITS_DIR.iterdir()) == before,
        )

        print("cleanup")
        check("delete asset", client.delete(f"/api/edit/assets/{outro_id}").status_code == 204)
        check("delete profile", client.delete(f"/api/profiles/{profile_id}").status_code == 204)
        check(
            "generation survives profile delete",
            client.get(f"/api/generations/{generation_id}").status_code == 200,
        )

    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
