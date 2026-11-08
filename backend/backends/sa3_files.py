"""Where Stable Audio 3 keeps its second download, read from its own config.

A Stable Audio 3 repository holds the diffusion model and its autoencoder
(`model.safetensors`) plus a `model_config.json`. The *text encoder* — a T5Gemma
the model reads the prompt through — is not in that file: the config names it,
and the library fetches it from the Hub the first time the model loads.

VoiceCraft never lets a generation start a download, so that second repository is
part of the model's download on the Models page, and the engine loads it from the
cache with the config rewritten to point at the local folder. Both steps need the
same answer to "which repository, which subfolder", so it lives here, with no
torch import: the Models page asks it without loading anything.

The config key path was read from the library's own `factory.py`
(`model["conditioning"]["configs"][i]` with `type == "t5gemma"`) at the commit the
app installs. The *values* — which repo, whether a subfolder — sit in the gated
`model_config.json` and are read at run time, not assumed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import catalog

# What a catalog entry's `companion` says when it has a text encoder to fetch.
COMPANION = catalog.COMPANION_SA3_TEXT_ENCODER

# The library's own default when a config names none.
DEFAULT_ENCODER_REPO = "google/t5gemma-b-b-ul2"

# Skipped when the encoder is fetched: formats the PyTorch loader never reads.
ENCODER_IGNORE = ("*.msgpack", "*.h5", "*.ot", "*.onnx", "*.tflite", "*.gguf", "original/*")

CONFIG_NAME = "model_config.json"
WEIGHTS_NAME = "model.safetensors"


class EncoderConfigError(ValueError):
    """The model config doesn't describe a text encoder this build understands."""


@dataclass(frozen=True, slots=True)
class EncoderRef:
    repo_id: str
    subfolder: str | None = None

    @property
    def url(self) -> str:
        return f"https://huggingface.co/{self.repo_id}"


def read_config(path: Path) -> dict:
    try:
        loaded = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise EncoderConfigError(f"could not read {CONFIG_NAME}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise EncoderConfigError(f"{CONFIG_NAME} is not a JSON object")
    return loaded


def _conditioner(config: dict) -> dict:
    """The `config` dict of the T5Gemma conditioner (created if absent)."""
    try:
        entries = config["model"]["conditioning"]["configs"]
    except (KeyError, TypeError) as exc:
        raise EncoderConfigError(f"{CONFIG_NAME} has no conditioning section") from exc
    for entry in entries if isinstance(entries, list) else ():
        if isinstance(entry, dict) and entry.get("type") == "t5gemma":
            inner = entry.get("config")
            if inner is None:
                inner = entry["config"] = {}
            if not isinstance(inner, dict):
                break
            return inner
    raise EncoderConfigError(f"{CONFIG_NAME} names no T5Gemma text encoder")


def encoder_ref(config: dict) -> EncoderRef:
    """The repository (and subfolder) the library would load the encoder from.

    Mirrors `T5GemmaConditioner`: `model_path or repo_id or model_name`. A
    `model_path` already in the config is a path on the authors' machine, so it
    is ignored here and replaced by `pin_encoder`.
    """
    inner = _conditioner(config)
    repo = inner.get("repo_id") or inner.get("model_name") or DEFAULT_ENCODER_REPO
    subfolder = inner.get("subfolder") or None
    if not isinstance(repo, str) or "/" not in repo:
        raise EncoderConfigError(f"the text encoder's repository ({repo!r}) is not a Hub id")
    return EncoderRef(repo_id=repo, subfolder=subfolder if isinstance(subfolder, str) else None)


def pin_encoder(config: dict, folder: str) -> None:
    """Point the encoder at a local folder, so loading it can't touch the network.

    `model_path` wins over `repo_id` in the library; its `subfolder` (if any) is
    applied on top of the local folder, which is why the snapshot *root* goes in.
    """
    _conditioner(config)["model_path"] = str(folder)
