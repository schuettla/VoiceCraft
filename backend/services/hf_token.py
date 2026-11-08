"""The Hugging Face access token that gated downloads need (Stable Audio 3).

Stability's repositories are gated: the account must have accepted the terms on
the model page, and every download carries a token for that account. VoiceCraft
holds the token only for those downloads — an engine never needs it, because it
loads from the cache offline.

Where it lives: one file in the app's data folder (`secrets/hf_token`), written
with owner-only permissions on systems that have them (on Windows the data folder
sits under the user's profile, which other accounts can't read). It is **not** in
the database or in `settings.json`, it is never logged, and the API only ever
says *whether* there is a token, never what it is.

A token the user already set up for Hugging Face's own tools (`HF_TOKEN`, or
`huggingface-cli login`) is used when the app has none of its own, so someone
who is signed in doesn't have to paste it again.
"""

from __future__ import annotations

import logging
import os
import re

import config

log = logging.getLogger(__name__)

# What Hugging Face issues today: "hf_" and a long run of letters and digits.
_SHAPE = re.compile(r"^hf_[A-Za-z0-9]{20,200}$")

SOURCE_APP = "app"
SOURCE_HUGGINGFACE = "huggingface"   # HF_TOKEN or a `huggingface-cli login`


class TokenError(ValueError):
    """The text isn't something Hugging Face would have issued."""


def _path():
    return config.SECRETS_DIR / "hf_token"


def _read_app() -> str | None:
    try:
        text = _path().read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _read_environment() -> str | None:
    try:
        from huggingface_hub import get_token  # noqa: PLC0415
    except ImportError:
        return None
    try:
        return get_token() or None
    except Exception:  # noqa: BLE001 - an unreadable token file is "no token"
        return None


def get() -> str | None:
    """The token to download with, or None when there is none to use."""
    return _read_app() or _read_environment()


def status() -> dict:
    """What the UI may know: whether a token exists and where it came from."""
    if _read_app():
        return {"configured": True, "source": SOURCE_APP}
    if _read_environment():
        return {"configured": True, "source": SOURCE_HUGGINGFACE}
    return {"configured": False, "source": None}


def save(raw: str) -> dict:
    """Store the token the user pasted. Replaces any earlier one."""
    token = (raw or "").strip()
    if not _SHAPE.match(token):
        raise TokenError(
            "That doesn't look like a Hugging Face token. It starts with hf_ — "
            "create one under Settings → Access Tokens on huggingface.co "
            "(a read token is enough)."
        )
    target = _path()
    target.parent.mkdir(parents=True, exist_ok=True)
    scratch = target.with_name(target.name + ".tmp")
    # Created owner-only from the start, so there is no moment it is world-readable.
    fd = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token)
    os.replace(scratch, target)
    try:
        os.chmod(target, 0o600)
    except OSError:  # Windows: the permission bits mean little, the profile ACL applies
        pass
    log.info("a Hugging Face token was saved")
    return status()


def clear() -> dict:
    """Forget the app's own token (one from the environment stays in effect)."""
    try:
        _path().unlink()
    except FileNotFoundError:
        pass
    log.info("the saved Hugging Face token was removed")
    return status()
