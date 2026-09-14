"""Model weight management: inspect, download, delete, and choose (FR14).

Weights live in the Hugging Face hub cache, not in the app's data directory,
so this module never touches `config.SAFE_ROOTS`. It works directly against
the cache layout — `models--org--name/{blobs,snapshots,refs}` — because that
is what the engines themselves read, and anything else would download the
same gigabytes twice.

Downloads run on their own single-slot executor: two concurrent multi-gigabyte
pulls only make each other slower, and serialising them keeps the progress
readout honest.
"""

from __future__ import annotations

import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import catalog
import config
from catalog import ModelSpec

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-dl")


class ModelError(ValueError):
    """A request the user can fix: unknown model, missing dependency, no space."""


# --------------------------------------------------------------------------
# Download jobs
# --------------------------------------------------------------------------


@dataclass
class DownloadJob:
    """Live state of one download, polled by the UI."""

    model_id: str
    state: str = "queued"  # queued | downloading | completed | failed | cancelled
    downloaded_bytes: int = 0
    total_bytes: int = 0
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


_jobs: dict[str, DownloadJob] = {}
_jobs_lock = threading.Lock()


def _job(model_id: str) -> DownloadJob | None:
    with _jobs_lock:
        return _jobs.get(model_id)


# --------------------------------------------------------------------------
# Cache inspection
# --------------------------------------------------------------------------


def _repo_dir(repo_id: str, directory: Path | None = None) -> Path:
    """`Qwen/Qwen3-TTS-…` → `<cache>/models--Qwen--Qwen3-TTS-…`."""
    base = directory or config.models_dir()
    return base / f"models--{repo_id.replace('/', '--')}"


def _dir_size(path: Path) -> int:
    """Bytes on disk under `path`, symlinks resolved once.

    The hub cache stores one copy in `blobs/` and symlinks it from
    `snapshots/`, so walking naively would either double-count or, on Windows
    without developer mode (where the "symlinks" are real copies), count the
    truth. Summing `blobs/` only is wrong in the second case, so we walk
    everything and de-duplicate by the resolved file.
    """
    total = 0
    seen: set[tuple[int, int]] = set()
    if not path.exists():
        return 0
    for entry in path.rglob("*"):
        try:
            if not entry.is_file():
                continue
            stat = entry.stat()
            # st_ino is 0 on some Windows filesystems; fall back to the path.
            key = (stat.st_dev, stat.st_ino)
            if stat.st_ino and key in seen:
                continue
            if stat.st_ino:
                seen.add(key)
            total += stat.st_size
        except OSError:
            continue
    return total


def is_downloaded(repo_id: str) -> bool:
    """True when a complete snapshot exists — not merely a partial download."""
    snapshots = _repo_dir(repo_id) / "snapshots"
    if not snapshots.is_dir():
        return False
    for revision in snapshots.iterdir():
        if revision.is_dir() and any(revision.iterdir()):
            # A download still in flight leaves .incomplete blobs behind.
            incomplete = _repo_dir(repo_id) / "blobs"
            if incomplete.is_dir() and any(incomplete.glob("*.incomplete")):
                return False
            return True
    return False


def _engine_available(engine: str) -> bool:
    from backends import get_backend  # noqa: PLC0415 - avoids an import cycle

    try:
        return get_backend(engine).available()
    except Exception:  # noqa: BLE001 - an unknown engine is simply unavailable
        return False


def describe(spec: ModelSpec) -> dict:
    """Everything the Models page shows for one catalog entry."""
    downloaded = is_downloaded(spec.repo_id)
    job = _job(spec.id)
    return {
        "id": spec.id,
        "repo_id": spec.repo_id,
        "title": spec.title,
        "category": spec.category,
        "engine": spec.engine,
        "summary": spec.summary,
        "notes": list(spec.notes),
        "languages": list(spec.languages),
        "clones_voices": spec.clones_voices,
        "needs_gpu": spec.needs_gpu,
        "downloaded": downloaded,
        "size_bytes": _dir_size(_repo_dir(spec.repo_id)) if downloaded else None,
        "download_estimate_bytes": spec.size_bytes,
        "active": catalog.active_repo_id(spec.engine) == spec.repo_id,
        "engine_available": _engine_available(spec.engine),
        "path": str(_repo_dir(spec.repo_id)) if downloaded else None,
        "job": _job_payload(job) if job else None,
    }


def _job_payload(job: DownloadJob) -> dict:
    return {
        "state": job.state,
        "downloaded_bytes": job.downloaded_bytes,
        "total_bytes": job.total_bytes,
        "error": job.error,
    }


def overview() -> dict:
    """Catalog + storage state, in one round trip (the page polls this)."""
    directory = config.models_dir()
    return {
        "models_dir": str(directory),
        "models_dir_exists": directory.is_dir(),
        "free_bytes": _free_bytes(directory),
        "used_bytes": _dir_size(directory),
        "categories": [
            {"id": key, "label": label} for key, label in catalog.CATEGORIES
        ],
        "models": [describe(spec) for spec in catalog.MODELS],
    }


def _free_bytes(directory: Path) -> int | None:
    """Free space on the volume holding `directory`, or its nearest parent."""
    probe = directory
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------


def start_download(model_id: str) -> DownloadJob:
    spec = catalog.get(model_id)
    if spec is None:
        raise ModelError(f"unknown model: {model_id}")

    with _jobs_lock:
        existing = _jobs.get(model_id)
        if existing and existing.state in ("queued", "downloading"):
            return existing
        job = DownloadJob(model_id=model_id, total_bytes=spec.size_bytes)
        _jobs[model_id] = job

    free = _free_bytes(config.models_dir())
    if free is not None and free < spec.size_bytes:
        job.state = "failed"
        job.error = (
            f"Not enough space in {config.models_dir()} — this model needs about "
            f"{spec.size_bytes // (1024**3)} GB."
        )
        raise ModelError(job.error)

    _executor.submit(_run_download, spec, job)
    return job


def cancel_download(model_id: str) -> bool:
    """Ask a running download to stop at the next file boundary."""
    job = _job(model_id)
    if job is None or job.state not in ("queued", "downloading"):
        return False
    job.cancel.set()
    return True


def _run_download(spec: ModelSpec, job: DownloadJob) -> None:
    try:
        from huggingface_hub import snapshot_download  # noqa: PLC0415
    except ImportError as exc:
        job.state = "failed"
        job.error = (
            "huggingface_hub is not installed. Re-run setup from the header, "
            "or: pip install huggingface_hub"
        )
        log.error("model download unavailable: %s", exc)
        return

    if job.cancel.is_set():
        job.state = "cancelled"
        return

    job.state = "downloading"
    directory = config.models_dir()
    directory.mkdir(parents=True, exist_ok=True)

    # hf's own progress goes to a tqdm bar we can't read from here, so measure
    # the cache directory instead. It counts .incomplete blobs, which is
    # exactly the number we want to show.
    stop = threading.Event()
    watcher = threading.Thread(
        target=_watch_progress, args=(spec, job, stop), daemon=True
    )
    watcher.start()

    try:
        snapshot_download(
            repo_id=spec.repo_id,
            cache_dir=str(directory),
            allow_patterns=list(spec.allow_patterns) or None,
            max_workers=4,
        )
        if job.cancel.is_set():
            job.state = "cancelled"
        else:
            job.state = "completed"
            job.downloaded_bytes = _dir_size(_repo_dir(spec.repo_id, directory))
            job.total_bytes = job.downloaded_bytes
            log.info("downloaded %s", spec.repo_id)
            # Profiles held back because these weights were missing can now be
            # cloned; queue them rather than making the user click Retry.
            from services import voice_service  # noqa: PLC0415 - import cycle

            voice_service.resume_pending()
    except Exception as exc:  # noqa: BLE001 - reported to the UI, never raised
        job.state = "cancelled" if job.cancel.is_set() else "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        log.exception("download of %s failed", spec.repo_id)
    finally:
        stop.set()


def _watch_progress(spec: ModelSpec, job: DownloadJob, stop: threading.Event) -> None:
    """Poll the cache directory so the UI has a real byte count to show."""
    directory = _repo_dir(spec.repo_id)
    while not stop.wait(1.0):
        size = _dir_size(directory)
        job.downloaded_bytes = size
        # The published estimate is approximate; never let the bar exceed 100%.
        if size > job.total_bytes:
            job.total_bytes = size


# --------------------------------------------------------------------------
# Delete and select
# --------------------------------------------------------------------------


def delete(model_id: str) -> None:
    spec = catalog.get(model_id)
    if spec is None:
        raise ModelError(f"unknown model: {model_id}")

    job = _job(model_id)
    if job and job.state in ("queued", "downloading"):
        raise ModelError("this model is still downloading — cancel it first")

    directory = _repo_dir(spec.repo_id)
    if not directory.exists():
        raise ModelError("this model is not downloaded")

    # Drop it from memory first: on Windows an open weights file cannot be
    # deleted, and the engine holds one for as long as it stays loaded.
    if catalog.active_repo_id(spec.engine) == spec.repo_id:
        _unload_engine(spec.engine)

    shutil.rmtree(directory, ignore_errors=True)
    if directory.exists():
        raise ModelError(
            "the files are in use — close anything reading them and try again"
        )
    with _jobs_lock:
        _jobs.pop(model_id, None)
    log.info("deleted %s", spec.repo_id)


def select(model_id: str) -> None:
    """Make this checkpoint the one its engine loads from now on."""
    spec = catalog.get(model_id)
    if spec is None:
        raise ModelError(f"unknown model: {model_id}")
    key = catalog.SETTING_KEY.get(spec.engine)
    if key is None:
        raise ModelError(f"engine {spec.engine} has no selectable checkpoint")
    if catalog.active_repo_id(spec.engine) == spec.repo_id:
        return

    config.save_settings({key: spec.repo_id})
    # The engine is holding the previous weights; drop them so the next
    # generation loads the new choice instead of silently using the old one.
    _unload_engine(spec.engine)
    log.info("%s now uses %s", spec.engine, spec.repo_id)


def _unload_engine(engine: str) -> None:
    from backends import get_backend  # noqa: PLC0415 - avoids an import cycle

    try:
        get_backend(engine).unload()
    except Exception:  # noqa: BLE001 - best effort; a failed unload isn't fatal
        log.warning("could not unload %s", engine, exc_info=True)


# --------------------------------------------------------------------------
# Storage location
# --------------------------------------------------------------------------


def set_models_dir(raw: str) -> Path:
    """Move the app's view of the cache to `raw`.

    Nothing is copied: the hub cache is shared with every other HF tool on the
    machine, so silently relocating gigabytes on the user's behalf would be a
    surprise. Models already present in the new location are picked up
    immediately; anything else shows as not downloaded.
    """
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise ModelError("give a full path, for example D:\\models\\huggingface")

    try:
        candidate.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ModelError(f"cannot use that folder: {exc}") from exc

    probe = candidate / ".voicecraft-write-test"
    try:
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise ModelError(f"that folder is not writable: {exc}") from exc

    resolved = candidate.resolve()
    config.save_settings({"models_dir": str(resolved)})
    config.apply_models_dir_env(resolved)

    # Engines cached a path to the old location when they loaded.
    for engine in catalog.SETTING_KEY:
        _unload_engine(engine)
    return resolved


def reset_models_dir() -> Path:
    """Go back to the Hugging Face default location."""
    config.clear_setting("models_dir")
    directory = config.models_dir()
    config.apply_models_dir_env(directory)
    for engine in catalog.SETTING_KEY:
        _unload_engine(engine)
    return directory


def shutdown() -> None:
    for job in list(_jobs.values()):
        job.cancel.set()
    _executor.shutdown(wait=False, cancel_futures=True)
