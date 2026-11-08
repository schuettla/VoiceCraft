"""Give an engine its own checkpoint folder without copying gigabytes.

ACE-Step wants `<checkpoints>/<name>/…` on disk and, at load time, may rewrite
the `.py` files in a model folder to match the installed code. Pointing it at the
Hugging Face cache would let it write into the cache (through a symlink that
means into a blob shared with every other tool). So the engine gets a private
folder instead, built from the cache:

* read-only parts (VAE, text encoder) are one directory link — a junction on
  Windows, which needs no privileges — or, if links are refused, per-file links;
* the DiT folder is a real directory: small files are copied (the engine may
  rewrite them) and the big weight files are linked, falling back from a
  symlink to a hard link to a copy.

Everything here can be rebuilt from the cache, so `clear` just deletes the
folder. A marker records which cache folder a real directory was built from, so
moving the models folder rebuilds it instead of serving stale weights.
"""

from __future__ import annotations

import logging
import os
import shutil
import stat
from pathlib import Path

log = logging.getLogger(__name__)

# Files smaller than this are copied, so an engine that rewrites its own code
# files never touches the cache. Weights are far above it.
COPY_BELOW_BYTES = 4 * 1024 * 1024
MARKER = ".staged-from"
_SKIP = {".gitattributes", MARKER}
_REPARSE_POINT = 0x400   # Windows: a junction or a symlink


def _is_link(path: Path) -> bool:
    """A symlink or a Windows junction (which `islink` does not report on 3.11)."""
    if os.path.islink(path):
        return True
    try:
        attributes = os.lstat(path).st_file_attributes  # Windows only
    except (OSError, AttributeError):
        return False
    return bool(attributes & _REPARSE_POINT)


def _remove(path: Path) -> None:
    """Delete a file, a link of either kind, or a real directory — never the link's target."""
    if not os.path.lexists(path):
        return
    if _is_link(path):
        try:
            os.unlink(path)
        except OSError:
            os.rmdir(path)   # a directory junction
        return
    if path.is_dir():
        shutil.rmtree(path, onerror=_clear_readonly)
    else:
        path.unlink()


def _clear_readonly(function, path, _excinfo) -> None:
    os.chmod(path, stat.S_IWRITE)
    function(path)


def _link_directory(source: Path, target: Path) -> bool:
    """Make `target` a directory link to `source`. False if the platform refuses."""
    try:
        if os.name == "nt":
            import _winapi  # noqa: PLC0415 - Windows only

            _winapi.CreateJunction(str(source), str(target))
        else:
            os.symlink(source, target, target_is_directory=True)
        return True
    except (OSError, AttributeError, ImportError):
        return False


def _same(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))


def _link_file(source: Path, target: Path) -> str:
    """Symlink, else hard link, else copy. Returns which one worked."""
    try:
        os.symlink(source, target)
        return "symlink"
    except OSError:
        pass
    try:
        os.link(source, target)
        return "hardlink"
    except OSError:
        pass
    shutil.copyfile(source, target)
    return "copy"


def _stage_files(source: Path, target: Path, *, copy_small: bool) -> None:
    for entry in sorted(source.rglob("*")):
        relative = entry.relative_to(source)
        if entry.name in _SKIP or any(part.startswith(".") for part in relative.parts):
            continue
        destination = target / relative
        if entry.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        if not entry.is_file():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        size = entry.stat().st_size
        as_copy = copy_small and size < COPY_BELOW_BYTES
        if os.path.lexists(destination):
            # A copy may hold the engine's own edit, so it stays whatever its size;
            # a link is right if it still resolves to a file of the same size.
            if destination.exists() and (as_copy or destination.stat().st_size == size):
                continue
            _remove(destination)   # a dangling link, or a half-written file
        if as_copy:
            shutil.copyfile(entry, destination)
        else:
            how = _link_file(entry.resolve(), destination)
            if how != "symlink":
                log.info("staged %s as a %s", relative.as_posix(), how)


def stage(source: Path, target: Path, *, writable: bool = False) -> None:
    """Make `target` show the files of `source`.

    `writable` is for a folder the engine may edit (small files are then real
    copies); otherwise one directory link is tried first.
    """
    source = Path(source).resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"no such folder: {source}")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)

    if not writable:
        if _is_link(target):
            if _same(target, source):
                return
            _remove(target)
        elif os.path.lexists(target):
            _remove(target)   # an earlier per-file build; try the cheap form again
        if _link_directory(source, target):
            return
        log.info("directory links are not available; linking %s file by file", source.name)

    if _is_link(target):
        _remove(target)
    marker = target / MARKER
    if target.is_dir():
        try:
            built_from = marker.read_text(encoding="utf-8").strip()
        except OSError:
            built_from = ""
        if built_from != str(source):
            _remove(target)
    target.mkdir(parents=True, exist_ok=True)
    _stage_files(source, target, copy_small=writable)
    marker.write_text(str(source), encoding="utf-8")


def clear(root: Path) -> None:
    """Delete a staged checkpoint folder (links and copies only; the cache is untouched)."""
    root = Path(root)
    if not os.path.lexists(root):
        return
    # Unlink the directory links first so a recursive delete can never follow one
    # into the cache.
    for child in list(root.iterdir()):
        if _is_link(child):
            _remove(child)
    shutil.rmtree(root, onerror=_clear_readonly, ignore_errors=False)
