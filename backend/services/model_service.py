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

import fnmatch
import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import catalog
import config
from catalog import ExtraFile, ModelSpec
from services import hf_token

log = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model-dl")


class ModelError(ValueError):
    """A request the user can fix: unknown model, missing dependency, no space."""


def gate_message(title: str, repo_id: str, *, has_token: bool) -> str:
    """What to do about a gated repository, in the order a person does it."""
    if not has_token:
        return (
            f"{title} is a gated model: Hugging Face only serves it to an account "
            f"that accepted its terms. Open https://huggingface.co/{repo_id} and accept "
            "them, create a read token at https://huggingface.co/settings/tokens, "
            "then paste it under \"Hugging Face access\" on the Models page."
        )
    return (
        f"Hugging Face refused access to {repo_id}. Open https://huggingface.co/{repo_id}, "
        "accept its terms with the same account the token belongs to (a read token is "
        "enough), then download again."
    )


def _is_access_error(exc: BaseException) -> bool:
    """A gated / unauthorised answer from the Hub (401, 403, or its gated error)."""
    try:
        from huggingface_hub.errors import GatedRepoError  # noqa: PLC0415
    except ImportError:
        return False
    if isinstance(exc, GatedRepoError):
        return True
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status in (401, 403)


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


def _snapshot_files(repo_id: str) -> list[tuple[str, Path]]:
    """(path relative to the snapshot, file) for every file in every snapshot."""
    snapshots = _repo_dir(repo_id) / "snapshots"
    found: list[tuple[str, Path]] = []
    if not snapshots.is_dir():
        return found
    for revision in snapshots.iterdir():
        if not revision.is_dir():
            continue
        for entry in revision.rglob("*"):
            try:
                if entry.is_file():
                    found.append((entry.relative_to(revision).as_posix(), entry))
            except OSError:
                continue
    return found


def _matches(relative: str, patterns: tuple[str, ...]) -> bool:
    # huggingface_hub filters with fnmatch too, so this agrees with what a
    # download with the same `allow_patterns` would have fetched.
    return any(fnmatch.fnmatch(relative, pattern) for pattern in patterns)


def _extra_present(extra: ExtraFile) -> bool:
    return any(
        relative == extra.filename for relative, _ in _snapshot_files(extra.repo_id)
    )


def companion_ref(spec: ModelSpec):
    """The second repository `spec` needs, read from its own downloaded config.

    None for an entry without one, and None until the main files (and so the
    config that names it) are on disk or when the config can't be read.
    """
    if spec.companion != catalog.COMPANION_SA3_TEXT_ENCODER:
        return None
    from backends import sa3_files  # noqa: PLC0415 - avoids an import cycle

    for relative, path in _snapshot_files(spec.repo_id):
        if relative == sa3_files.CONFIG_NAME:
            try:
                return sa3_files.encoder_ref(sa3_files.read_config(path))
            except sa3_files.EncoderConfigError:
                return None
    return None


def _companion_present(spec: ModelSpec, ref) -> bool:
    """The encoder's config and at least one weights file are in the cache."""
    if ref.repo_id != spec.repo_id and not is_downloaded(ref.repo_id):
        return False
    prefix = f"{ref.subfolder.strip('/')}/" if ref.subfolder else ""
    files = [relative for relative, _ in _snapshot_files(ref.repo_id)]
    return (f"{prefix}config.json" in files) and any(
        relative.startswith(prefix) and relative.endswith((".safetensors", ".bin"))
        for relative in files
    )


def spec_downloaded(spec: ModelSpec) -> bool:
    """True when *this catalog entry* can run offline.

    Repo-level `is_downloaded` is not enough once two entries share a repo
    (downloading the 947 MiB Kitten variant must not mark the 506 MiB one as
    present) or once an engine pulls a file from a second repo.
    """
    if not is_downloaded(spec.repo_id):
        return False
    if spec.allow_patterns:
        # Every pattern must have caught at least one file: `lm/x*` landing but
        # `speaker/*` missing is a broken download, not a finished one.
        files = [relative for relative, _ in _snapshot_files(spec.repo_id)]
        for pattern in spec.allow_patterns:
            if not any(fnmatch.fnmatch(relative, pattern) for relative in files):
                return False
    if not all(_extra_present(extra) for extra in spec.extra_files):
        return False
    if spec.companion:
        ref = companion_ref(spec)
        # Without it the model would try to fetch its text encoder on the first
        # generation, which an app that downloads only on request must never do.
        return ref is not None and _companion_present(spec, ref)
    return True


def active_downloaded(engine: str) -> bool:
    """Whether the checkpoint `engine` would load right now is on disk."""
    repo_id = catalog.active_repo_id(engine)
    for spec in catalog.for_engine(engine):
        if catalog.is_active(spec):
            return spec_downloaded(spec)
    return is_downloaded(repo_id)  # an env override pointing outside the catalog


def _spec_size(spec: ModelSpec) -> int:
    """Bytes this entry occupies; only its own files when the repo is shared."""
    if spec.allow_patterns and catalog.sharing_repo(spec):
        total = sum(
            path.stat().st_size
            for relative, path in _snapshot_files(spec.repo_id)
            if _matches(relative, spec.allow_patterns)
        )
    else:
        total = _dir_size(_repo_dir(spec.repo_id))
    for extra in spec.extra_files:
        total += sum(
            path.stat().st_size
            for relative, path in _snapshot_files(extra.repo_id)
            if relative == extra.filename
        )
    ref = companion_ref(spec)
    if ref is not None and ref.repo_id != spec.repo_id:
        total += _dir_size(_repo_dir(ref.repo_id))
    return total


def _spec_dirs(spec: ModelSpec, directory: Path | None = None) -> list[Path]:
    """Every cache folder a download of `spec` writes to (main repo + extras)."""
    dirs = [_repo_dir(spec.repo_id, directory)]
    for extra in spec.extra_files:
        extra_dir = _repo_dir(extra.repo_id, directory)
        if extra_dir not in dirs:
            dirs.append(extra_dir)
    ref = companion_ref(spec)
    if ref is not None:
        companion_dir = _repo_dir(ref.repo_id, directory)
        if companion_dir not in dirs:
            dirs.append(companion_dir)
    return dirs


def _spec_total(spec: ModelSpec, directory: Path | None = None) -> int:
    return sum(_dir_size(folder) for folder in _spec_dirs(spec, directory))


def _engine_available(engine: str) -> bool:
    from backends import get_backend  # noqa: PLC0415 - avoids an import cycle

    try:
        return get_backend(engine).available()
    except Exception:  # noqa: BLE001 - an unknown engine is simply unavailable
        return False


def unavailable_reason(spec: ModelSpec) -> str | None:
    """Why this machine can't run `spec`, or None when it can (or nothing is required)."""
    if not spec.min_capability:
        return None
    from backends import device as devices  # noqa: PLC0415 - avoids an import cycle

    try:
        hardware = devices.hardware()
    except Exception:  # noqa: BLE001 - a broken GPU probe must not break the page
        return None
    if hardware.cuda and hardware.capability and hardware.capability[0] >= spec.min_capability:
        return None
    return spec.requirement or "This model needs a newer GPU than this machine has."


def describe(spec: ModelSpec) -> dict:
    """Everything the Models page shows for one catalog entry."""
    downloaded = spec_downloaded(spec)
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
        "size_bytes": _spec_size(spec) if downloaded else None,
        "download_estimate_bytes": spec.download_estimate_bytes,
        "active": catalog.is_active(spec),
        "engine_available": _engine_available(spec.engine),
        "path": str(_repo_dir(spec.repo_id)) if downloaded else None,
        "job": _job_payload(job) if job else None,
        "variant": spec.variant or None,
        "shared_with": [other.id for other in catalog.sharing_repo(spec)],
        "optional_engine": spec.optional_engine,
        "license_tier": spec.license_tier,
        "license_name": spec.license_name or None,
        "license_url": spec.license_url or None,
        "gated": spec.gated,
        "unavailable_reason": unavailable_reason(spec),
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

    reason = unavailable_reason(spec)
    if reason:
        raise ModelError(f"{spec.title} can't run on this machine. {reason}")

    # A gated repository refuses every request without a token, so say what to do
    # now instead of starting a job that fails with a 401 a moment later.
    if spec.gated and not hf_token.get():
        raise ModelError(gate_message(spec.title, spec.repo_id, has_token=False))

    with _jobs_lock:
        existing = _jobs.get(model_id)
        if existing and existing.state in ("queued", "downloading"):
            return existing
        job = DownloadJob(model_id=model_id, total_bytes=spec.download_estimate_bytes)
        _jobs[model_id] = job

    free = _free_bytes(config.models_dir())
    if free is not None and free < spec.download_estimate_bytes:
        job.state = "failed"
        job.error = (
            f"Not enough space in {config.models_dir()} — this model needs about "
            f"{max(1, spec.download_estimate_bytes // (1024**3))} GB."
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
        from huggingface_hub import hf_hub_download, snapshot_download  # noqa: PLC0415
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

    # Only a gated entry carries the app's token: sending a stale one to a public
    # repository would make that download fail with a 401 it doesn't deserve.
    token = hf_token.get() if spec.gated else None
    fetching = spec.repo_id   # the repository being fetched, for the error message
    try:
        snapshot_download(
            repo_id=spec.repo_id,
            cache_dir=str(directory),
            allow_patterns=list(spec.allow_patterns) or None,
            max_workers=4,
            token=token,
        )
        # Files an engine would otherwise fetch behind the user's back on its
        # first run (a second repo's codec weights, say).
        for extra in spec.extra_files:
            if job.cancel.is_set():
                break
            fetching = extra.repo_id
            hf_hub_download(
                repo_id=extra.repo_id,
                filename=extra.filename,
                cache_dir=str(directory),
                token=token,
            )
        if spec.companion and not job.cancel.is_set():
            ref = companion_ref(spec)
            if ref is None:
                raise RuntimeError(
                    "the downloaded model_config.json doesn't say which text encoder "
                    "the model uses, so it could not be made ready to run offline"
                )
            fetching = ref.repo_id
            _fetch_companion(spec, ref, directory, token)
        if job.cancel.is_set():
            job.state = "cancelled"
        else:
            job.state = "completed"
            job.downloaded_bytes = _spec_total(spec, directory)
            job.total_bytes = job.downloaded_bytes
            log.info("downloaded %s", spec.repo_id)
            # Profiles held back because these weights were missing can now be
            # cloned; queue them rather than making the user click Retry.
            from services import voice_service  # noqa: PLC0415 - import cycle

            voice_service.resume_pending()
    except Exception as exc:  # noqa: BLE001 - reported to the UI, never raised
        job.state = "cancelled" if job.cancel.is_set() else "failed"
        if spec.gated and _is_access_error(exc):
            job.error = gate_message(spec.title, fetching, has_token=token is not None)
        else:
            job.error = f"{type(exc).__name__}: {exc}"
        log.exception("download of %s failed", spec.repo_id)
    finally:
        stop.set()


def _fetch_companion(spec: ModelSpec, ref, directory: Path, token: str | None) -> None:
    """Download the second repository a just-downloaded config names.

    Nothing to do when the encoder sits in a subfolder of the model's own
    repository: the main download already brought it.
    """
    from huggingface_hub import snapshot_download  # noqa: PLC0415

    from backends import sa3_files  # noqa: PLC0415 - avoids an import cycle

    if ref.repo_id == spec.repo_id:
        return
    snapshot_download(
        repo_id=ref.repo_id,
        cache_dir=str(directory),
        allow_patterns=[f"{ref.subfolder.strip('/')}/*"] if ref.subfolder else None,
        ignore_patterns=list(sa3_files.ENCODER_IGNORE),
        max_workers=4,
        token=token,
    )


def _watch_progress(spec: ModelSpec, job: DownloadJob, stop: threading.Event) -> None:
    """Poll the cache directory so the UI has a real byte count to show."""
    while not stop.wait(1.0):
        size = _spec_total(spec)
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
    # deleted, and the engine holds one for as long as it stays loaded. Entries
    # sharing a repo go with it, so unload their engines too.
    removed = (spec, *catalog.sharing_repo(spec))

    # Another entry may keep *extra files* in this repo (the ACE-Step sft and XL
    # entries borrow the turbo repo's VAE and text encoder). Deleting the repo
    # would quietly break them, so make the user choose.
    gone = {entry.id for entry in removed}
    dependants = [
        other for other in catalog.MODELS
        if other.id not in gone
        and (
            any(extra.repo_id == spec.repo_id for extra in other.extra_files)
            # …or keeps its text encoder in a subfolder of this repository.
            or ((ref := companion_ref(other)) is not None and ref.repo_id == spec.repo_id)
        )
        and spec_downloaded(other)
    ]
    if dependants:
        names = ", ".join(other.title for other in dependants)
        raise ModelError(f"{names} still uses files from this download — delete it first")

    for engine in {entry.engine for entry in removed}:
        _unload_engine(engine)

    # The config that names a text encoder is about to be deleted with the repo,
    # so read which repositories that is first.
    companions = {
        ref.repo_id
        for entry in removed
        if (ref := companion_ref(entry)) is not None and ref.repo_id != entry.repo_id
    }

    shutil.rmtree(directory, ignore_errors=True)
    if directory.exists():
        raise ModelError(
            "the files are in use — close anything reading them and try again"
        )
    _delete_extra_repos(removed, companions)
    for engine in {entry.engine for entry in removed}:
        _forget_staged(engine)
    with _jobs_lock:
        _jobs.pop(model_id, None)
    log.info("deleted %s", spec.repo_id)


def _delete_extra_repos(
    removed: tuple[ModelSpec, ...], companions: set[str] | frozenset[str] = frozenset()
) -> None:
    """Remove second-repo files of the entries just deleted, unless another needs them.

    `companions` are the text-encoder repositories of the removed entries, found
    before their configs were deleted.
    """
    gone = {entry.id for entry in removed}
    second_repos = {extra.repo_id for entry in removed for extra in entry.extra_files}
    for repo_id in second_repos | set(companions):
        # Only entries that are actually on disk count: a catalog entry nobody
        # downloaded doesn't need its second repo kept around.
        in_use = any(
            other.id not in gone
            and spec_downloaded(other)
            and (
                other.repo_id == repo_id
                or any(extra.repo_id == repo_id for extra in other.extra_files)
                or ((ref := companion_ref(other)) is not None and ref.repo_id == repo_id)
            )
            for other in catalog.MODELS
        )
        if not in_use:
            shutil.rmtree(_repo_dir(repo_id), ignore_errors=True)


def select(model_id: str) -> None:
    """Make this checkpoint the one its engine loads from now on."""
    spec = catalog.get(model_id)
    if spec is None:
        raise ModelError(f"unknown model: {model_id}")
    if catalog.is_active(spec):
        return
    reason = unavailable_reason(spec)
    if reason:
        raise ModelError(f"{spec.title} can't run on this machine. {reason}")

    # Stored by model id: two entries can share a repo, so the repo id alone
    # wouldn't say which one was chosen. The pre-id settings key is dropped so
    # the two can never disagree.
    chosen = dict(config.load_settings().get(catalog.ACTIVE_SETTING) or {})
    chosen[spec.engine] = spec.id
    config.save_settings({catalog.ACTIVE_SETTING: chosen})
    legacy = catalog.LEGACY_SETTING_KEY.get(spec.engine)
    if legacy:
        config.clear_setting(legacy)
    # The engine is holding the previous weights; drop them so the next
    # generation loads the new choice instead of silently using the old one.
    _unload_engine(spec.engine)
    log.info("%s now uses %s (%s)", spec.engine, spec.id, spec.repo_id)


def _forget_staged(engine: str) -> None:
    """Drop links an engine built into the cache (ACE-Step's private checkpoint folder).

    A hard link or a copy would keep gigabytes alive after the user deleted the
    model, so the folder goes with it; the next load rebuilds what is left.
    """
    from backends import get_backend  # noqa: PLC0415 - avoids an import cycle

    try:
        clear = getattr(get_backend(engine), "clear_staged", None)
        if clear is not None:
            clear()
    except Exception:  # noqa: BLE001 - best effort, the weights are already gone
        log.warning("could not clear the staged files of %s", engine, exc_info=True)


def _unload_engine(engine: str) -> None:
    """Drop an engine's weights, without pulling them from under a running job.

    Called from a request (the Models page picks or deletes a model) it is queued
    on the job worker, so it runs after the job in progress; the worker itself
    (switching models at the start of a job) unloads at once.
    """
    from services import generation_service  # noqa: PLC0415 - avoids an import cycle

    generation_service.run_on_worker(_unload_now, engine)


def _unload_now(engine: str) -> None:
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
    for engine in catalog.engines():
        _unload_engine(engine)
    return resolved


def reset_models_dir() -> Path:
    """Go back to the Hugging Face default location."""
    config.clear_setting("models_dir")
    directory = config.models_dir()
    config.apply_models_dir_env(directory)
    for engine in catalog.engines():
        _unload_engine(engine)
    return directory


def shutdown() -> None:
    for job in list(_jobs.values()):
        job.cancel.set()
    _executor.shutdown(wait=False, cancel_futures=True)
