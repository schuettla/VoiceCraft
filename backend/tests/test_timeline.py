"""Tests for the timeline filtergraph compiler and its API surface.

Two layers: pure golden-graph checks against `utils.timeline.compile_timeline`
(no ffmpeg needed), and a live end-to-end pass through the API with real
ffmpeg — projects, peaks, effects, silence/loudness analysis, and a render
job that produces a file of the expected length. Run from the repo root:

    VOICECRAFT_DATA_DIR=... python backend/tests/test_timeline.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import tempfile  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

_DATA_DIR = Path(tempfile.mkdtemp(prefix="voicecraft-timeline-test-"))
os.environ["VOICECRAFT_DATA_DIR"] = str(_DATA_DIR)
os.environ["VOICECRAFT_AUTO_PREPARE"] = "0"

import config  # noqa: E402
from app import create_app  # noqa: E402
from database.session import session_scope  # noqa: E402
from database.models import Generation  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from models import (  # noqa: E402
    DuckSettings,
    IntroOutroSlot,
    LoudnessSettings,
    MasterBus,
    ProjectData,
    SourceRef,
    Track,
    TrackKind,
    TimelineClip,
)
from utils.audio import measure_loudness  # noqa: E402
from utils.timeline import compile_timeline, required_sources  # noqa: E402

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
            "-ar", "44100", "-ac", "2", str(path),
        ],
        check=True, capture_output=True,
    )
    return path


def _wait_render(client: TestClient, job_id: str, timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    job: dict = {"state": "timeout"}
    while time.time() < deadline:
        job = client.get(f"/api/edit/render/{job_id}").json()
        if job["state"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.2)
    return job


def _rms_db(path: str, start: float, end: float, pre_filter: str) -> float:
    """Overall RMS level (dBFS) of [start, end) after `pre_filter`."""
    proc = subprocess.run(
        [config.FFMPEG, "-hide_banner", "-i", path,
         "-af", f"atrim={start}:{end},{pre_filter},astats", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    levels = [line.rsplit(":", 1)[1] for line in proc.stderr.splitlines() if "RMS level dB" in line]
    return float(levels[-1])


def test_pure_compiler() -> None:
    print("compiler (pure)")

    data = ProjectData(
        tracks=[Track(id="v", name="Voice", kind=TrackKind.voice)],
        clips=[
            TimelineClip(
                id="c1", track_id="v", source=SourceRef(generation_id="gen1"),
                start=0, in_point=0, out_point=5,
            )
        ],
        intro=IntroOutroSlot(asset_id="intro1", crossfade_ms=500),
        outro=IntroOutroSlot(asset_id="outro1", crossfade_ms=300),
    )
    check(
        "required sources in stable order",
        required_sources(data) == ["a:intro1", "a:outro1", "g:gen1"],
        str(required_sources(data)),
    )
    graph = compile_timeline(data, {"a:intro1": 2.0, "a:outro1": 2.0, "g:gen1": 5.0})
    # body_offset = 2 - 0.5 = 1.5; body_end = 1.5 + 5 = 6.5;
    # outro_start = max(1.5, 6.5 - 0.3) = 6.2; total = 6.2 + 2 = 8.2
    check("intro+body+outro duration", abs(graph.duration - 8.2) < 1e-6, str(graph.duration))
    check("ends in [out]", graph.filter_script.strip().endswith("[out]"))
    check("intro fades out", "afade=t=out" in graph.filter_script)
    check("outro fades in", "afade=t=in" in graph.filter_script)

    # No intro/outro: body starts at t=0, single clip, single track.
    plain = ProjectData(
        tracks=[Track(id="v", kind=TrackKind.voice)],
        clips=[TimelineClip(id="c1", track_id="v", source=SourceRef(generation_id="g"), start=0, out_point=3)],
    )
    graph2 = compile_timeline(plain, {"g:g": 3.0})
    check("no intro/outro duration == clip length", abs(graph2.duration - 3.0) < 1e-6)
    check("no adelay needed at t=0", "adelay" not in graph2.filter_script, graph2.filter_script)

    # Muted track contributes nothing.
    muted = ProjectData(
        tracks=[Track(id="v", kind=TrackKind.voice, mute=True)],
        clips=[TimelineClip(id="c1", track_id="v", source=SourceRef(generation_id="g"), start=0, out_point=3)],
    )
    try:
        compile_timeline(muted, {"g:g": 3.0})
        check("muted-only project rejected", False)
    except Exception as exc:  # noqa: BLE001
        check("muted-only project rejected", "nothing to render" in str(exc))

    # Ducking: voice ducks music, and music is also (correctly) still mixed.
    ducked = ProjectData(
        tracks=[
            Track(id="v", kind=TrackKind.voice),
            Track(id="m", kind=TrackKind.music, duck=DuckSettings(enabled=True, against_track_ids=["v"])),
        ],
        clips=[
            TimelineClip(id="c1", track_id="v", source=SourceRef(generation_id="voice"), start=0, out_point=5),
            TimelineClip(id="c2", track_id="m", source=SourceRef(asset_id="music"), start=0, out_point=10),
        ],
    )
    graph3 = compile_timeline(ducked, {"g:voice": 5.0, "a:music": 10.0})
    check("duck key is split before reuse", "asplit=2" in graph3.filter_script, graph3.filter_script)
    check("sidechaincompress present", "sidechaincompress" in graph3.filter_script)
    check("duration is the longer track", abs(graph3.duration - 10.0) < 1e-6)

    # Effect params are interpolated into the graph: clamp and whitelist them.
    from effects import build_chain  # noqa: PLC0415
    check("out-of-range param clamped", build_chain([{"type": "gain", "params": {"db": 999}}]) == "volume=24.00dB")
    check(
        "unknown choice falls back to default",
        "[out]" not in build_chain([{"type": "hum_removal", "params": {"hz": "60[out];amovie=x"}}]),
    )
    try:
        Track(id="bad;id")
        check("track id with graph syntax rejected", False)
    except Exception:  # noqa: BLE001
        check("track id with graph syntax rejected", True)

    # Two-pass loudnorm: pass 1 (no measurement yet) must not shape the signal
    # at all — no loudnorm, no safety limiter — since it exists purely to be
    # measured. Pass 2 (measurement in hand) applies loudnorm with the exact
    # measured_* stats and linear=true, plus the usual safety limiter.
    loud = ProjectData(
        tracks=[Track(id="v", kind=TrackKind.voice)],
        clips=[TimelineClip(id="c1", track_id="v", source=SourceRef(generation_id="g"), start=0, out_point=3)],
        master=MasterBus(loudness=LoudnessSettings(enabled=True, target_lufs=-16.0)),
    )
    pass1 = compile_timeline(loud, {"g:g": 3.0})
    check("loudnorm pass 1 has no loudnorm filter", "loudnorm" not in pass1.filter_script, pass1.filter_script)
    check("loudnorm pass 1 has no safety limiter", "alimiter" not in pass1.filter_script, pass1.filter_script)

    measured = {"integrated_lufs": -20.0, "true_peak_db": -3.0, "loudness_range": 5.0, "threshold_db": -30.0}
    pass2 = compile_timeline(loud, {"g:g": 3.0}, loudnorm_measured=measured)
    check(
        "loudnorm pass 2 uses the measured stats",
        "measured_I=-20.00" in pass2.filter_script and "linear=true" in pass2.filter_script,
        pass2.filter_script,
    )
    check("loudnorm pass 2 keeps the safety limiter", "alimiter" in pass2.filter_script, pass2.filter_script)

    incomplete = {**measured, "integrated_lufs": None}
    fallback = compile_timeline(loud, {"g:g": 3.0}, loudnorm_measured=incomplete)
    check(
        "a failed measurement falls back to single-pass loudnorm instead of crashing",
        "loudnorm=I=" in fallback.filter_script and "measured_I" not in fallback.filter_script,
        fallback.filter_script,
    )

    # loudness disabled: unaffected by the loudnorm_measured plumbing either way.
    plain_loud = compile_timeline(plain, {"g:g": 3.0})
    check("loudness disabled keeps the safety limiter, no loudnorm", (
        "alimiter" in plain_loud.filter_script and "loudnorm" not in plain_loud.filter_script
    ))


def test_api_end_to_end() -> None:
    print("api (real ffmpeg)")
    tones = _DATA_DIR / "fixtures"
    tones.mkdir(parents=True, exist_ok=True)

    with TestClient(create_app()) as client:
        voice = make_tone(tones / "voice.wav", 4, 300)
        music = make_tone(tones / "music.wav", 8, 220)

        music_id = client.post(
            "/api/edit/assets",
            data={"name": "Bed music", "kind": "clip"},
            files={"file": ("music.wav", music.read_bytes(), "audio/wav")},
        ).json()["id"]

        generation_id = "gen" + os.urandom(4).hex()
        with session_scope() as session:
            session.add(
                Generation(
                    id=generation_id, profile_id=None, text="Hello.", status="completed",
                    audio_path=str(voice), duration_seconds=4.0,
                )
            )

        print("peaks")
        response = client.get("/api/edit/peaks", params={"generation_id": generation_id, "resolution": 50})
        check("peaks ok", response.status_code == 200, response.text)
        duration_hdr = float(response.headers.get("X-Duration", "0"))
        check("peaks length matches duration*resolution*2 bytes",
              abs(len(response.content) - round(duration_hdr * 50) * 2) <= 2,
              f"{len(response.content)} vs {duration_hdr}")

        print("effects")
        registry = client.get("/api/edit/effects").json()
        check("effects registry non-empty", len(registry) > 5, str(len(registry)))
        check("gain effect present", any(e["type"] == "gain" for e in registry))

        print("analysis")
        silence_src = make_tone(tones / "silence_test.wav", 1, 400)
        response = client.post(
            "/api/edit/analyze/silence",
            json={"asset_id": music_id, "noise_db": -30.0, "min_duration": 0.3},
        )
        check("silence analysis ok", response.status_code == 200, response.text)

        response = client.post("/api/edit/analyze/loudness", json={"asset_id": music_id})
        check("loudness analysis ok", response.status_code == 200, response.text)
        check("loudness has a number", isinstance(response.json()["integrated_lufs"], float), response.text)

        print("project")
        project_data = {
            "tracks": [
                {"id": "v", "name": "Voice", "kind": "voice"},
                {"id": "m", "name": "Music", "kind": "music", "gain_db": -8,
                 "duck": {"enabled": True, "against_track_ids": ["v"]}},
            ],
            "clips": [
                {"id": "c1", "track_id": "v", "source": {"generation_id": generation_id},
                 "start": 0, "in_point": 0, "out_point": 4, "fade_in": 0.1},
                {"id": "c2", "track_id": "m", "source": {"asset_id": music_id},
                 "start": 0, "in_point": 0, "out_point": 8},
            ],
            "export": {"output_format": "wav"},
        }
        response = client.post("/api/edit/projects", json={"name": "Test episode", "data": project_data})
        check("project created", response.status_code == 201, response.text)
        project = response.json()
        project_id = project["id"]

        response = client.get(f"/api/edit/projects/{project_id}")
        check("project fetched", response.status_code == 200 and response.json()["name"] == "Test episode")

        response = client.get("/api/edit/projects")
        check("project listed", any(p["id"] == project_id for p in response.json()))

        renamed = {**project_data}
        response = client.put(
            f"/api/edit/projects/{project_id}", json={"name": "Renamed episode", "data": renamed}
        )
        check("project renamed", response.status_code == 200 and response.json()["name"] == "Renamed episode")

        print("render")
        response = client.post(f"/api/edit/projects/{project_id}/render", json={"name": "rendered-mix"})
        check("render accepted", response.status_code == 202, response.text)
        job_id = response.json()["id"]

        job = _wait_render(client, job_id)
        check("render completed", job["state"] == "completed", str(job))
        if job and job["state"] == "completed":
            asset = job["asset"]
            check("render duration ~8s (longer of the two tracks)",
                  abs((asset["duration_seconds"] or 0) - 8.0) < 0.3, str(asset["duration_seconds"]))
            check("render lives in EDITS_DIR", Path(asset["path"]).parent == config.EDITS_DIR)

        print("ducking depth (live data sent with the render request)")
        # A 2 kHz bed under the 300 Hz voice, so a steep high-pass isolates the
        # bed when measuring. The saved project has ducking OFF; the request
        # body turns it on — proving the render uses the live document.
        bed = make_tone(tones / "bed.wav", 8, 2000)
        bed_id = client.post(
            "/api/edit/assets",
            data={"name": "Bed 2k", "kind": "clip"},
            files={"file": ("bed.wav", bed.read_bytes(), "audio/wav")},
        ).json()["id"]
        live = {
            **project_data,
            "tracks": [
                {"id": "v", "name": "Voice", "kind": "voice"},
                {"id": "m", "name": "Music", "kind": "music",
                 "duck": {"enabled": True, "against_track_ids": ["v"], "amount_db": -12}},
            ],
            "clips": [
                project_data["clips"][0],
                {"id": "c2", "track_id": "m", "source": {"asset_id": bed_id}, "start": 0, "out_point": 8},
            ],
        }
        saved = {**live, "tracks": [live["tracks"][0], {**live["tracks"][1], "duck": {"enabled": False}}]}
        client.put(f"/api/edit/projects/{project_id}", json={"name": "Renamed episode", "data": saved})
        job = _wait_render(client, client.post(
            f"/api/edit/projects/{project_id}/render", json={"name": "ducked", "data": live}
        ).json()["id"])
        check("ducked render completed", job["state"] == "completed", str(job))
        if job["state"] == "completed":
            out = job["asset"]["path"]
            under = _rms_db(out, 1.0, 3.0, "highpass=f=1200,highpass=f=1200,highpass=f=1200")
            after = _rms_db(out, 5.0, 7.0, "highpass=f=1200,highpass=f=1200,highpass=f=1200")
            depth = after - under
            check("bed dips ~12 dB under the voice", 9.0 <= depth <= 13.5, f"depth={depth:.2f} dB")

        print("preview")
        preview_clip = {
            "id": "c1", "track_id": "v", "source": {"generation_id": generation_id},
            "start": 0, "in_point": 0, "out_point": 4,
            "effects": [{"id": "e1", "type": "gain", "params": {"db": -6}}],
        }
        response = client.post(
            "/api/edit/preview",
            json={"clip_id": "c1", "data": {**project_data, "clips": [preview_clip, project_data["clips"][1]]}},
        )
        check("clip preview rendered", response.status_code == 200, response.text)
        check("preview file exists", Path(response.json()["path"]).exists())

        print("bounce")
        # Bounce a 1s-4s sub-range of the voice clip (with a gain effect baked
        # in) to a new, reusable clip asset — the source clip/generation must
        # be untouched (FR10).
        bounce_clip = {
            "id": "c1", "track_id": "v", "source": {"generation_id": generation_id},
            "start": 0, "in_point": 0, "out_point": 4,
            "effects": [{"id": "e1", "type": "gain", "params": {"db": -6}}],
        }
        response = client.post(
            "/api/edit/bounce",
            json={
                "clip_id": "c1", "start": 1.0, "end": 4.0, "name": "bounced-voice",
                "output_format": "wav",
                "data": {**project_data, "clips": [bounce_clip, project_data["clips"][1]]},
            },
        )
        check("bounce accepted", response.status_code == 201, response.text)
        bounced = response.json()
        check("bounced asset is kind=clip", bounced.get("kind") == "clip", str(bounced))
        check("bounced asset duration ~3s (4-1)", abs((bounced["duration_seconds"] or 0) - 3.0) < 0.3,
              str(bounced["duration_seconds"]))
        check("bounce did not touch the source generation", Path(voice).exists() and voice.stat().st_size > 0)

        print("loudness normalization (two-pass)")
        target = -20.0
        loud_data = {
            **project_data,
            "master": {"loudness": {"enabled": True, "target_lufs": target}},
        }
        response = client.post("/api/edit/projects", json={"name": "Loudness test", "data": loud_data})
        loud_project_id = response.json()["id"]
        job = _wait_render(client, client.post(
            f"/api/edit/projects/{loud_project_id}/render", json={"name": "loudnorm-out"}
        ).json()["id"])
        check("loudnorm render completed", job["state"] == "completed", str(job))
        if job["state"] == "completed":
            report = measure_loudness(job["asset"]["path"])
            check(
                f"rendered mix is within 1.5 LU of the {target} LUFS target",
                report["integrated_lufs"] is not None and abs(report["integrated_lufs"] - target) <= 1.5,
                str(report),
            )
        client.delete(f"/api/edit/projects/{loud_project_id}")

        print("cleanup")
        check("delete project", client.delete(f"/api/edit/projects/{project_id}").status_code == 204)
        check("deleted project 404s", client.get(f"/api/edit/projects/{project_id}").status_code == 404)


def main() -> int:
    test_pure_compiler()
    test_api_end_to_end()
    print(f"\n{PASSED} passed, {FAILED} failed  (data dir: {_DATA_DIR})")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
