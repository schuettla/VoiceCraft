"""One place that decides where an engine runs and in which precision.

Every engine meets the same hardware problem: bfloat16 and FlashAttention 2
need Ampere (compute capability 8.0) or newer, and float16 is not safe for
every model. Before this module each backend carried its own copy of that
decision (`QwenBackend._pick_device`); KittenTTS, MOSS and Stable Audio would
each have added another.

`pick_device` answers it once. It imports torch lazily so that the module — and
therefore every backend's `available()` check — stays cheap.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

log = logging.getLogger(__name__)

# Past this many threads PyTorch's CPU kernels stop scaling and start fighting
# the rest of the app (and the audio player) for cores.
MAX_CPU_THREADS = 8


@dataclass(frozen=True, slots=True)
class DevicePlan:
    """Where to run, how, and what to tell the user about it."""

    device: str            # torch device string: "cuda:0" | "mps" | "cpu"
    kind: str              # "cuda" | "mps" | "cpu" — what the UI shows
    dtype: object          # torch.dtype
    dtype_name: str        # "bfloat16" | "float16" | "float32"
    warning: str | None = None


def cuda_capability() -> tuple[int, int] | None:
    """Compute capability of GPU 0, or None without a usable CUDA device."""
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            return torch.cuda.get_device_capability()
    except Exception:  # noqa: BLE001 - a broken driver is the same as no GPU here
        pass
    return None


@dataclass(frozen=True, slots=True)
class Hardware:
    """What the GPU offers, for deciding whether a heavy engine is worth running."""

    cuda: bool = False
    capability: tuple[int, int] | None = None
    vram_total_bytes: int | None = None
    name: str | None = None


def hardware() -> Hardware:
    """GPU 0 as torch sees it. Imports torch, so call it from a request, not at import."""
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            _free, total = torch.cuda.mem_get_info()
            return Hardware(
                cuda=True,
                capability=torch.cuda.get_device_capability(),
                vram_total_bytes=int(total),
                name=torch.cuda.get_device_name(0),
            )
    except Exception:  # noqa: BLE001 - a broken driver is the same as no GPU here
        pass
    return Hardware()


def set_cpu_threads() -> None:
    """Cap PyTorch's CPU thread pool. Safe to call more than once."""
    import torch  # noqa: PLC0415

    wanted = max(1, min(MAX_CPU_THREADS, os.cpu_count() or 1))
    if torch.get_num_threads() != wanted:
        torch.set_num_threads(wanted)


def pick_device(
    *,
    engine: str = "this engine",
    wants_bf16: bool = False,
    allow_fp16: bool = False,
    supports_mps: bool = False,
    mps_dtype: str = "float16",
) -> DevicePlan:
    """Choose a device and dtype for an engine.

    * CUDA, compute capability >= 8 — bfloat16 if `wants_bf16`, else float32.
    * CUDA, compute capability < 8 — float16 if the engine tolerates it
      (`allow_fp16`), otherwise float32, with a warning either way: the card
      has no native bfloat16, so the engine is slower or heavier than on a
      newer one.
    * Apple Silicon — MPS, only if `supports_mps`.
    * Everything else — CPU, with a warning, and the thread pool capped.

    `engine` only shapes the warning text.
    """
    import torch  # noqa: PLC0415

    capability = cuda_capability()
    if capability is not None:
        major, _minor = capability
        if major >= 8:
            name = "bfloat16" if wants_bf16 else "float32"
            return DevicePlan("cuda:0", "cuda", getattr(torch, name), name)
        if allow_fp16:
            return DevicePlan(
                "cuda:0",
                "cuda",
                torch.float16,
                "float16",
                f"This GPU predates bfloat16, so {engine} runs in float16.",
            )
        return DevicePlan(
            "cuda:0",
            "cuda",
            torch.float32,
            "float32",
            f"This GPU predates bfloat16, so {engine} runs in float32 — correct, "
            "but slower and heavier on VRAM.",
        )

    mps = getattr(torch.backends, "mps", None)
    if supports_mps and mps is not None and mps.is_available():
        return DevicePlan("mps", "mps", getattr(torch, mps_dtype), mps_dtype)

    set_cpu_threads()
    return DevicePlan(
        "cpu",
        "cpu",
        torch.float32,
        "float32",
        f"No GPU acceleration is available — {engine} is running on the CPU and "
        "will be slow. Install a CUDA build of PyTorch (re-run setup).",
    )


def release_gpu_memory() -> None:
    """Hand cached VRAM back to the driver. A no-op without CUDA or torch."""
    try:
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - best effort
        pass
