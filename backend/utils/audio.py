"""ffmpeg/ffprobe wrappers.

Everything the editing layer does is a subprocess call (PRD §6). Nothing here
touches the database or knows about HTTP.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import sys
import threading
from array import array
from functools import lru_cache
from pathlib import Path
from typing import Callable

import config

log = logging.getLogger(__name__)

# Windows: keep console windows from flashing when we spawn ffmpeg.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_ENCODERS: dict[str, list[str]] = {
    "wav": ["-c:a", "pcm_s16le"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    "ogg": ["-c:a", "libvorbis", "-q:a", "5"],
    "flac": ["-c:a", "flac"],
}


class AudioError(RuntimeError):
    """An ffmpeg/ffprobe invocation failed, with stderr attached."""


def encoder_args(fmt: str) -> list[str]:
    try:
        return list(_ENCODERS[fmt])
    except KeyError:
        raise AudioError(f"unsupported output format: {fmt}") from None


@lru_cache(maxsize=1)
def ffmpeg_available() -> bool:
    """Cached: the health endpoint is polled every few seconds by the UI."""
    try:
        _run([config.FFMPEG, "-version"])
        return True
    except (AudioError, FileNotFoundError, OSError):
        return False


def _run(cmd: list[str]) -> str:
    log.debug("exec: %s", " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise AudioError(
            f"{cmd[0]} not found. Install ffmpeg and put it on PATH, or set "
            "VOICECRAFT_FFMPEG."
        ) from exc
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-12:]
        raise AudioError("\n".join(tail) or f"{cmd[0]} exited {proc.returncode}")
    return proc.stdout


def probe_duration(path: str | Path) -> float | None:
    """Duration in seconds, or None if ffprobe can't determine it."""
    try:
        out = _run(
            [
                config.FFPROBE,
                "-v", "error",
                "-print_format", "json",
                "-show_format",
                str(path),
            ]
        )
        value = json.loads(out).get("format", {}).get("duration")
        return float(value) if value is not None else None
    except (AudioError, ValueError, json.JSONDecodeError):
        return None


def normalize(src: str | Path, dst: str | Path) -> Path:
    """Re-encode to the common intermediate WAV.

    Concatenating clips whose sample rate or channel layout differs is the
    documented source of boundary artifacts (PRD §10), so every input goes
    through here before it is stitched.
    """
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            config.FFMPEG, "-y",
            "-i", str(src),
            "-ar", str(config.INTERMEDIATE_SAMPLE_RATE),
            "-ac", str(config.INTERMEDIATE_CHANNELS),
            "-c:a", "pcm_s16le",
            str(dst),
        ]
    )
    return dst


def trim(src: str | Path, dst: str | Path, start: float, end: float | None) -> Path:
    """Cut [start, end] out of `src` into a new file (FR7, FR10)."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # -ss before -i seeks fast; -t (a duration, not an absolute timestamp) is
    # unambiguous once the input has been shifted to zero by the seek.
    cmd = [config.FFMPEG, "-y", "-ss", f"{start:.3f}", "-i", str(src)]
    if end is not None:
        cmd += ["-t", f"{max(0.0, end - start):.3f}"]
    cmd += [*encoder_args(dst.suffix.lstrip(".")), str(dst)]
    _run(cmd)
    return dst


def apply_filters(src: str | Path, dst: str | Path, filters: list[str]) -> Path:
    """Run an arbitrary `-af` audio filter chain over `src`.

    Used for one-off renders — a clip preview, a bounce — where a full
    `filter_complex` graph would be overkill.
    """
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [config.FFMPEG, "-y", "-i", str(src)]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += [*encoder_args(dst.suffix.lstrip(".")), str(dst)]
    _run(cmd)
    return dst


def convert(src: str | Path, dst: str | Path) -> Path:
    """Transcode to the format implied by `dst`'s extension (FR9)."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            config.FFMPEG, "-y",
            "-i", str(src),
            *encoder_args(dst.suffix.lstrip(".")),
            str(dst),
        ]
    )
    return dst


def concat(
    sources: list[str | Path],
    dst: str | Path,
    crossfade_ms: int = 0,
    workdir: Path | None = None,
) -> Path:
    """Join clips in order, optionally crossfading each boundary (FR8).

    Inputs are normalized first. With crossfade_ms == 0 this is a plain
    concat; otherwise `acrossfade` is chained pairwise, which overlaps each
    boundary by the given duration.
    """
    if not sources:
        raise AudioError("nothing to concatenate")

    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    workdir = Path(workdir or config.TMP_DIR)
    workdir.mkdir(parents=True, exist_ok=True)

    normalized: list[Path] = []
    for index, src in enumerate(sources):
        normalized.append(normalize(src, workdir / f"seg_{index:03d}.wav"))

    if len(normalized) == 1:
        return convert(normalized[0], dst)

    fade = max(0, crossfade_ms) / 1000.0
    if fade > 0:
        # A crossfade eats `fade` seconds off each side of the boundary, so a
        # segment shorter than the fade would be swallowed whole.
        for path in normalized:
            duration = probe_duration(path) or 0.0
            if duration <= fade:
                raise AudioError(
                    f"segment '{path.name}' is {duration:.2f}s, shorter than the "
                    f"{fade:.2f}s crossfade"
                )

    cmd = [config.FFMPEG, "-y"]
    for path in normalized:
        cmd += ["-i", str(path)]

    if fade <= 0:
        streams = "".join(f"[{i}:a]" for i in range(len(normalized)))
        filtergraph = f"{streams}concat=n={len(normalized)}:v=0:a=1[out]"
    else:
        steps: list[str] = []
        current = "[0:a]"
        for index in range(1, len(normalized)):
            label = "[out]" if index == len(normalized) - 1 else f"[x{index}]"
            steps.append(
                f"{current}[{index}:a]"
                f"acrossfade=d={fade:.3f}:c1=tri:c2=tri{label}"
            )
            current = label
        filtergraph = ";".join(steps)

    cmd += [
        "-filter_complex", filtergraph,
        "-map", "[out]",
        *encoder_args(dst.suffix.lstrip(".")),
        str(dst),
    ]
    _run(cmd)

    for path in normalized:
        path.unlink(missing_ok=True)
    return dst


# --------------------------------------------------------------------------
# Timeline editor support: peaks, analysis, progress-tracked rendering
# --------------------------------------------------------------------------


def _run_bytes(cmd: list[str]) -> bytes:
    """Like `_run`, but for a filter chain whose stdout is raw sample data."""
    try:
        proc = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    except FileNotFoundError as exc:
        raise AudioError(f"{cmd[0]} not found. Install ffmpeg and put it on PATH.") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-12:]
        raise AudioError("\n".join(tail) or f"{cmd[0]} exited {proc.returncode}")
    return proc.stdout


def peaks(path: str | Path, resolution: int = 100) -> tuple[bytes, float]:
    """Downsampled min/max waveform peaks for drawing, cached on disk.

    `resolution` is buckets per second. The result is `resolution * duration`
    pairs of signed bytes (min, max), decoded from a mono PCM downmix — plenty
    for a canvas waveform at any zoom level the editor offers, and orders of
    magnitude smaller than shipping the browser the original audio to decode.
    """
    path = Path(path)
    duration = probe_duration(path) or 0.0
    try:
        mtime = path.stat().st_mtime_ns
    except OSError as exc:
        raise AudioError(f"source file is missing: {path}") from exc

    key = hashlib.sha1(f"{path.resolve()}:{mtime}:{resolution}".encode()).hexdigest()
    cache = config.PEAKS_DIR / f"{key}.bin"
    if cache.exists():
        return cache.read_bytes(), duration

    sample_rate = max(200, resolution * 4)
    raw = _run_bytes(
        [
            config.FFMPEG, "-v", "error", "-i", str(path),
            "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
        ]
    )
    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if sys.byteorder == "big":
        samples.byteswap()

    total_buckets = max(1, round(duration * resolution)) if duration > 0 else 1
    per_bucket = max(1, len(samples) // total_buckets) if samples else 1
    out = bytearray(total_buckets * 2)
    for i in range(total_buckets):
        chunk = samples[i * per_bucket : (i + 1) * per_bucket]
        if not chunk:
            continue
        lo = max(-32768, min(chunk))
        hi = max(chunk, default=0)
        out[i * 2] = (max(-128, min(127, lo // 256))) & 0xFF
        out[i * 2 + 1] = (max(-128, min(127, hi // 256))) & 0xFF

    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(bytes(out))
    return bytes(out), duration


_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def detect_silence(
    path: str | Path, noise_db: float = -30.0, min_duration: float = 0.5
) -> list[tuple[float, float]]:
    """Regions at or below `noise_db` lasting at least `min_duration` seconds.

    A silence still running at end-of-file has no matching `silence_end` line
    and is dropped rather than guessed at — better to under- than over-cut.
    """
    try:
        proc = subprocess.run(
            [
                config.FFMPEG, "-i", str(path),
                "-af", f"silencedetect=noise={noise_db}dB:d={min_duration}",
                "-f", "null", "-",
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise AudioError(f"{config.FFMPEG} not found") from exc

    stderr = proc.stderr or ""
    starts = [float(m) for m in _SILENCE_START.findall(stderr)]
    ends = [float(m) for m in _SILENCE_END.findall(stderr)]
    return list(zip(starts, ends))


_LOUDNESS_EMPTY: dict[str, float | None] = {
    "integrated_lufs": None,
    "true_peak_db": None,
    "loudness_range": None,
    "threshold_db": None,
}


def measure_loudness(path: str | Path, filter_prefix: str = "") -> dict[str, float | None]:
    """Integrated LUFS, true peak, loudness range, and gating threshold via a
    `loudnorm` dry-run — the four `measured_*` inputs a second, corrective
    `loudnorm` pass needs (see `utils.timeline`'s two-pass mode).

    `filter_prefix` lets a caller measure the signal *after* some other filter
    chain (e.g. the project's own master effects) rather than the raw file.
    """
    af = f"{filter_prefix},loudnorm=print_format=json" if filter_prefix else "loudnorm=print_format=json"
    try:
        proc = subprocess.run(
            [config.FFMPEG, "-i", str(path), "-af", af, "-f", "null", "-"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise AudioError(f"{config.FFMPEG} not found") from exc

    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", proc.stderr or "", re.S)
    if not match:
        return dict(_LOUDNESS_EMPTY)

    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return dict(_LOUDNESS_EMPTY)

    def _finite(key: str) -> float | None:
        try:
            value = float(payload.get(key))
        except (TypeError, ValueError):
            return None
        return value if value == value and abs(value) != float("inf") else None

    return {
        "integrated_lufs": _finite("input_i"),
        "true_peak_db": _finite("input_tp"),
        "loudness_range": _finite("input_lra"),
        "threshold_db": _finite("input_thresh"),
    }


def run_with_progress(
    cmd: list[str],
    total_seconds: float,
    on_progress: Callable[[float], None] | None = None,
    cancel: threading.Event | None = None,
) -> None:
    """Run an ffmpeg command, reporting fractional progress as it renders.

    Used for renders long enough to want a progress bar (project exports).
    `cmd` should not include `-progress`; it is inserted here.
    """
    full = [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]
    log.debug("exec: %s", " ".join(full))
    try:
        proc = subprocess.Popen(
            full,
            stdin=subprocess.DEVNULL,  # ffmpeg otherwise reads stdin for interactive keys
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=_NO_WINDOW,
        )
    except FileNotFoundError as exc:
        raise AudioError(
            f"{cmd[0]} not found. Install ffmpeg and put it on PATH, or set "
            "VOICECRAFT_FFMPEG."
        ) from exc

    stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    assert proc.stdout is not None
    for line in proc.stdout:
        if cancel is not None and cancel.is_set():
            proc.kill()
            break
        line = line.strip()
        if line.startswith("out_time_ms=") and total_seconds > 0 and on_progress:
            try:
                # Misleadingly named: the value is microseconds, not milliseconds.
                microseconds = int(line.split("=", 1)[1])
            except ValueError:
                continue
            on_progress(min(1.0, max(0.0, (microseconds / 1_000_000) / total_seconds)))

    proc.wait()
    stderr_thread.join(timeout=2)

    if cancel is not None and cancel.is_set():
        raise AudioError("cancelled")
    if proc.returncode != 0:
        tail = "".join(stderr_lines).strip().splitlines()[-12:]
        raise AudioError("\n".join(tail) or f"{cmd[0]} exited {proc.returncode}")
    if on_progress:
        on_progress(1.0)
