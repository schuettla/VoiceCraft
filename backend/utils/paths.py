"""Filename hygiene and path containment checks."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import config

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def slugify(value: str, fallback: str = "clip") -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    value = _UNSAFE.sub("-", value).strip("-._")
    return (value or fallback)[:80]


def unique_path(directory: Path, stem: str, suffix: str) -> Path:
    """`directory/stem.suffix`, with -2, -3 … appended until it's free."""
    directory.mkdir(parents=True, exist_ok=True)
    suffix = suffix if suffix.startswith(".") else f".{suffix}"
    candidate = directory / f"{stem}{suffix}"
    counter = 2
    while candidate.exists():
        candidate = directory / f"{stem}-{counter}{suffix}"
        counter += 1
    return candidate


def is_managed(path: str | Path) -> bool:
    """True if `path` lives inside one of the app's data directories.

    Guards the file-serving and reveal-in-folder routes: the backend listens on
    localhost, but a path arriving from the client is still untrusted input and
    must not be able to escape the data dir.
    """
    try:
        resolved = Path(path).resolve()
    except OSError:
        return False
    for root in config.SAFE_ROOTS:
        try:
            resolved.relative_to(root.resolve())
            return True
        except ValueError:
            continue
    return False
