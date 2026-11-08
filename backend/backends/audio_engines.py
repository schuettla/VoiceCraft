"""Music and sound-effect engines (docs/audio-roadmap.md §5.2, Phases 4–7).

Both engines are installed on demand, so nothing here imports their packages at
module load: `available()` only asks whether they could be imported.

Both engines make real calls: MOSS (sound effects) since Phase 6, ACE-Step
(music) since Phase 7. The API, queue and tests run against a fake engine
(`tests/test_audio.py`), and each adapter is tested against a fake package with
the same call shapes as the real one, read from the pinned commits.

What Phase 0 measured on the GTX 1060 6 GB decides `support()`; the numbers are
quoted next to the rules.
"""

from __future__ import annotations

import gc
import importlib.util
import logging
import os
import random
import shutil
import tempfile
import time
from pathlib import Path

import catalog
import config
from backends import checkpoint_stage
from backends import device as devices
from backends.base import AudioSpec, BackendUnavailable, Support, SynthesisResult

log = logging.getLogger(__name__)

GIB = 1024**3

# Total VRAM a card must report to be offered an engine at all. A 6 GB card
# reports about 6.0 GiB, and both engines peaked just under that (MOSS 5.86 GB,
# ACE-Step 5.2 GB), so the floor sits a little below it.
MIN_VRAM_BYTES = int(5.5 * GIB)

# ACE-Step: a 30 s clip took ~70 s on the 1060, a 2 minute clip hit the engine's
# own 600 s timeout. Cards below this much VRAM, or without bf16, get 30 s.
ACESTEP_COMFORT_VRAM_BYTES = 8 * GIB
ACESTEP_SHORT_CLIP_SECONDS = 30.0
ACESTEP_MAX_SECONDS = 600.0           # the model card's "up to 10 minutes"
ACESTEP_MIN_SECONDS = 10.0            # the engine's documented range is 10–600 s
# Which folder name the engine expects for each catalog entry, and its defaults:
# turbo is distilled to 8 steps and ignores guidance; ACE-Step's own table lists
# 50 steps (guidance 7) for sft. Only turbo was run on the 1060.
ACESTEP_DIT_DIRS = {
    "acestep-1.5-turbo": "acestep-v15-turbo",
    "acestep-1.5-sft": "acestep-v15-sft",
    "acestep-1.5-xl-turbo": "acestep-v15-xl-turbo",
}
ACESTEP_TURBO_MODELS = ("acestep-1.5-turbo", "acestep-1.5-xl-turbo")
ACESTEP_TURBO_STEPS = 8
ACESTEP_TURBO_GUIDANCE = 1.0
ACESTEP_BASE_STEPS = 50
ACESTEP_BASE_GUIDANCE = 7.0
ACESTEP_SILENT_PEAK = 0.01            # below this the clip is flagged as nearly silent

# MOSS always denoises a fixed 30 s latent and crops it.
MOSS_MAX_SECONDS = 30.0
MOSS_COMFORT_VRAM_BYTES = 12 * GIB    # all-on-GPU peaked at 12.9 GB
# The model card's default is 100 steps (~10 minutes on the 1060). 20 gave
# 117 s there; the quality difference was not measured, so it is a default the
# form can override, not a limit.
MOSS_DEFAULT_STEPS = 20
MOSS_DEFAULT_GUIDANCE = 4.0


def _importable(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):   # a half-installed or fake module
        return False


class PackagedAudioBackend:
    """Shared lifecycle for the on-demand audio engines.

    Subclasses set `name`, `kind`, `label`, `modules` and implement `support`,
    `_load`, `_generate` (and `_unload` if the engine holds more than a model).
    """

    name = ""
    kind = ""
    label = ""
    optional = True
    modules: tuple[str, ...] = ()

    def __init__(self) -> None:
        self._loaded = False
        self._device: str | None = None

    # --- lifecycle ------------------------------------------------------

    def available(self) -> bool:
        return bool(self.modules) and all(_importable(module) for module in self.modules)

    def is_loaded(self) -> bool:
        return self._loaded

    def device(self) -> str | None:
        return self._device if self._loaded else None

    def load(self) -> None:
        if self._loaded:
            return
        if not self.available():
            raise BackendUnavailable(
                f"{self.label} is not installed. Install it from the Models page."
            )
        self._load()
        self._loaded = True

    def generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        self.load()
        return self._generate(spec, out_path)

    def unload(self) -> None:
        was_loaded = self._loaded
        self._loaded = False
        self._device = None
        if was_loaded:
            self._unload()
            devices.release_gpu_memory()

    # --- hooks ----------------------------------------------------------

    def support(self) -> Support:
        raise NotImplementedError

    def defaults(self) -> tuple[int | None, float | None]:
        """(steps, guidance) used when a request names none; the forms show them."""
        return None, None

    def _load(self) -> None:
        raise BackendUnavailable(
            f"{self.label} is installed, but this build of VoiceCraft can't run it yet."
        )

    def _generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        raise BackendUnavailable(
            f"{self.label} is installed, but this build of VoiceCraft can't run it yet."
        )

    def _unload(self) -> None:
        pass


class AceStepBackend(PackagedAudioBackend):
    """ACE-Step 1.5 — text (and optional lyrics) to music.

    **What ran on the 6 GB GTX 1060** (Phase 0): the turbo DiT with CPU offload
    for the DiT and for everything else, no language model, 8 steps. A 30 s
    instrumental took 71 s (58 s to load) and peaked at 4.9 GB. Every card gets
    that recipe, as with MOSS: it is the only one that was run. The language
    model (`thinking`) is off: the 0.6B one added 107 s to a 30 s clip and is a
    separate 1.2 GB download the catalog doesn't offer yet.

    The engine insists on a `checkpoints/<name>/` folder and may rewrite code
    files in it, so it gets a private one built from links into the Hugging Face
    cache (`checkpoint_stage`). It never downloads: that is the Models page's job.
    """

    name = "acestep"
    kind = "music"
    label = "ACE-Step 1.5"
    # The GitHub repo's wheel (project `ace-step`) installs the `acestep` package.
    modules = ("acestep",)

    def __init__(self) -> None:
        super().__init__()
        self._dit = None

    # --- model ----------------------------------------------------------

    @staticmethod
    def stage_root() -> Path:
        return config.DATA_DIR / "engines" / "acestep"

    @classmethod
    def clear_staged(cls) -> None:
        """Forget the links built for the engine (the cache itself is untouched)."""
        checkpoint_stage.clear(cls.stage_root())

    def _active_spec(self):
        try:
            return catalog.active_model(self.name)
        except KeyError:
            return None

    def defaults(self) -> tuple[int, float]:
        spec = self._active_spec()
        if spec is None or spec.id in ACESTEP_TURBO_MODELS:
            return ACESTEP_TURBO_STEPS, ACESTEP_TURBO_GUIDANCE
        return ACESTEP_BASE_STEPS, ACESTEP_BASE_GUIDANCE

    def _stage(self, spec, dit_dir: str) -> Path:
        """Build the checkpoint folder the engine reads. Offline, links only."""
        from huggingface_hub import snapshot_download  # noqa: PLC0415
        from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

        def snapshot(repo_id: str) -> Path:
            try:
                return Path(snapshot_download(repo_id=repo_id, local_files_only=True))
            except LocalEntryNotFoundError as exc:
                raise BackendUnavailable(
                    f"{spec.title} is not downloaded. Get it from the Models page."
                ) from exc

        # The turbo repo carries the VAE and the text encoder for every variant;
        # sft and XL bring only their own DiT.
        main = snapshot(catalog.ACESTEP_REPO)
        dit_source = main / dit_dir if spec.repo_id == catalog.ACESTEP_REPO else snapshot(spec.repo_id)
        root = self.stage_root() / "checkpoints"
        checkpoint_stage.stage(main / "vae", root / "vae")
        checkpoint_stage.stage(main / "Qwen3-Embedding-0.6B", root / "Qwen3-Embedding-0.6B")
        checkpoint_stage.stage(dit_source, root / dit_dir, writable=True)
        shared_config = main / "config.json"
        if shared_config.is_file() and not (root / "config.json").exists():
            shutil.copyfile(shared_config, root / "config.json")
        return root

    def _load(self) -> None:
        hardware = devices.hardware()
        if not hardware.cuda:
            raise BackendUnavailable(
                "ACE-Step needs an NVIDIA GPU; there is none available to PyTorch."
            )
        spec = catalog.active_model(self.name)
        dit_dir = ACESTEP_DIT_DIRS.get(spec.id)
        if dit_dir is None:
            raise BackendUnavailable(f"{spec.title} is not something this build can run.")

        root = self._stage(spec, dit_dir)
        # Set explicitly so a stray variable in the user's environment can't send
        # the engine somewhere else (or to a download).
        os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(root)

        from acestep.handler import AceStepHandler  # noqa: PLC0415

        log.info("loading %s on %s (offloaded)", spec.id, hardware.name)
        handler = AceStepHandler()
        # Its own start-up fetches missing weights from the internet. A music job
        # must never turn into a 10 GB download, so that step is switched off;
        # what is missing then fails on the next line with a plain message.
        handler._ensure_models_present = lambda **_kwargs: None
        message, ok = handler.initialize_service(
            project_root=str(root.parent),
            config_path=dit_dir,
            device="auto",
            offload_to_cpu=True,
            offload_dit_to_cpu=True,
        )
        if not ok:
            del handler
            gc.collect()
            raise RuntimeError(f"ACE-Step could not start: {str(message)[-300:]}")
        self._dit = handler
        self._device = "cuda"

    def _unload(self) -> None:
        self._dit = None
        gc.collect()

    # --- generation -----------------------------------------------------

    def _generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
        from acestep.inference import (  # noqa: PLC0415
            GenerationConfig,
            GenerationParams,
            generate_music,
        )

        dit = self._dit
        if dit is None:  # unloaded between load() and here
            raise BackendUnavailable(f"{self.label} was unloaded; try again.")

        default_steps, default_guidance = self.defaults()
        seconds = min(max(float(spec.duration_seconds), ACESTEP_MIN_SECONDS), ACESTEP_MAX_SECONDS)
        seed = spec.seed if spec.seed is not None else random.randrange(2**31)
        steps = spec.steps or default_steps
        guidance = spec.guidance if spec.guidance is not None else default_guidance
        vocals = bool(spec.lyrics)

        params = GenerationParams(
            task_type="text2music",
            thinking=False,                       # the language model stays off (class docstring)
            caption=spec.prompt,
            lyrics=spec.lyrics if vocals else "[Instrumental]",
            instrumental=not vocals,
            vocal_language="unknown",             # let the model recognise the language
            duration=seconds,
            inference_steps=steps,
            guidance_scale=guidance,              # turbo ignores it and uses 1.0
            seed=seed,
        )
        generation = GenerationConfig(
            batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed]
        )

        log.info(
            "acestep: %.0f s, %d steps, %s, seed %d",
            seconds, steps, "vocals" if vocals else "instrumental", seed,
        )
        started = time.monotonic()
        config.TMP_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=config.TMP_DIR, prefix="acestep-") as scratch:
            try:
                # No language model handler: `thinking=False` doesn't touch it.
                result = generate_music(
                    dit, None, params=params, config=generation, save_dir=scratch
                )
            finally:
                devices.release_gpu_memory()
            produced = Path((result.audios[0].get("path") or "")) if result.audios else None
            if not result.success or produced is None or not produced.is_file():
                detail = result.error or result.status_message or "no audio came back"
                raise RuntimeError(f"ACE-Step failed: {str(detail)[-300:]}")

            wave, rate = sf.read(str(produced), dtype="float32", always_2d=True)
            # Only a float file can hold NaN; in a 16-bit one it shows up as
            # silence or noise, which the peak check below catches (silence).
            if not np.isfinite(wave).all():
                raise RuntimeError("ACE-Step produced invalid audio (NaN). Try another seed.")
            peak = float(np.abs(wave).max()) if wave.size else 0.0
            out_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(produced), str(out_path))

        log.info("acestep: wrote %.1f s in %.0f s", len(wave) / rate, time.monotonic() - started)
        return SynthesisResult(
            path=out_path,
            duration_seconds=len(wave) / rate,
            device="cuda",
            warning=(
                "The result is almost silent. Try another seed or describe the style in more detail."
                if peak < ACESTEP_SILENT_PEAK else None
            ),
        )

    def support(self) -> Support:
        hardware = devices.hardware()
        if not hardware.cuda:
            return Support(
                False,
                reason="ACE-Step needs an NVIDIA GPU; it has not been run on anything else.",
            )
        vram = hardware.vram_total_bytes or 0
        if vram < MIN_VRAM_BYTES:
            return Support(
                False,
                reason=f"ACE-Step needs about 6 GB of VRAM; this GPU has {vram / GIB:.1f} GB.",
            )
        major = hardware.capability[0] if hardware.capability else 0
        if vram < ACESTEP_COMFORT_VRAM_BYTES or major < 8:
            return Support(
                True,
                warning="On this GPU clips are limited to 30 seconds — longer ones "
                        "did not finish in testing.",
                max_duration_seconds=ACESTEP_SHORT_CLIP_SECONDS,
            )
        return Support(True, max_duration_seconds=ACESTEP_MAX_SECONDS)


class MossSfxBackend(PackagedAudioBackend):
    """MOSS-SoundEffect v2 — text to sound effect, up to 30 s.

    **The one recipe that was run on a 6 GB GPU** (Phase 0, GTX 1060): load on the
    CPU, cast only the DiT's *parameters* to bf16, then hand the engine a CUDA
    device with its own stage-wise offload switched on. It peaked at 5.86 GB and
    needed 117 s for 20 steps. Putting the whole pipeline on the GPU ran out of
    memory on the first step (12.9 GB), so there is no "fast path" for big cards
    here: it would be untested, and every card gets the tested one.
    """

    name = "moss_sfx"
    kind = "sfx"
    label = "MOSS-SoundEffect v2"
    # Installed from OpenMOSS/MOSS-TTS, subdirectory moss_soundeffect_v2 (Phase 5).
    modules = ("moss_soundeffect_v2",)

    def __init__(self) -> None:
        super().__init__()
        self._pipe = None

    def defaults(self) -> tuple[int, float]:
        return MOSS_DEFAULT_STEPS, MOSS_DEFAULT_GUIDANCE

    # --- model ----------------------------------------------------------

    @staticmethod
    def _disable_dynamo() -> None:
        """MOSS's modules call `torch.compile` with `triton.cudagraphs` at import
        time, which fails on Windows (no Triton). The environment variable is
        what the spike used; flipping the config too covers a torch whose
        `_dynamo` was imported before we got here.
        """
        os.environ["TORCHDYNAMO_DISABLE"] = "1"
        try:
            import torch._dynamo  # noqa: PLC0415

            torch._dynamo.config.disable = True
        except Exception:  # noqa: BLE001 - the variable alone is enough on a fresh process
            pass

    @staticmethod
    def _offload(pipe, torch) -> None:
        """Stage-wise offload (see the class docstring).

        Only parameters are cast: `module.to(bfloat16)` would also cast the
        complex RoPE `freqs` buffers and crash later in `rope_apply`.
        """
        engine = pipe.engine
        for parameter in engine.dit.parameters():
            parameter.data = parameter.data.to(torch.bfloat16)
        engine.device = torch.device("cuda")
        engine.vram_management_enabled = True

    def _load(self) -> None:
        hardware = devices.hardware()
        if not hardware.cuda:
            raise BackendUnavailable(
                "MOSS-SoundEffect needs an NVIDIA GPU; there is none available to PyTorch."
            )

        from huggingface_hub import snapshot_download  # noqa: PLC0415
        from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

        spec = catalog.active_model(self.name)
        try:
            # Offline on purpose: the Models page downloads weights (11 GB), a
            # generation never starts a download as a side effect.
            local = snapshot_download(repo_id=spec.repo_id, local_files_only=True)
        except LocalEntryNotFoundError as exc:
            raise BackendUnavailable(
                f"{spec.title} is not downloaded. Get it from the Models page."
            ) from exc

        self._disable_dynamo()
        import torch  # noqa: PLC0415
        from moss_soundeffect_v2 import MossSoundEffectPipeline  # noqa: PLC0415

        log.info("loading %s on the CPU, offloading to %s", spec.repo_id, hardware.name)
        pipe = MossSoundEffectPipeline.from_pretrained(
            local, torch_dtype=torch.bfloat16, device="cpu"
        )
        try:
            self._offload(pipe, torch)
        except Exception:
            del pipe  # don't hold 10 GB of CPU memory after a failed setup
            gc.collect()
            raise
        self._pipe = pipe
        self._device = "cuda"

    def _unload(self) -> None:
        self._pipe = None
        gc.collect()

    # --- generation -----------------------------------------------------

    def _generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
        import torch  # noqa: PLC0415

        pipe = self._pipe
        if pipe is None:  # unloaded between load() and here
            raise BackendUnavailable(f"{self.label} was unloaded; try again.")

        seconds = round(min(float(spec.duration_seconds), MOSS_MAX_SECONDS), 1)
        seed = spec.seed if spec.seed is not None else random.randrange(2**31)
        steps = spec.steps or MOSS_DEFAULT_STEPS
        guidance = spec.guidance if spec.guidance is not None else MOSS_DEFAULT_GUIDANCE

        log.info("moss: %.1f s, %d steps, guidance %g, seed %d", seconds, steps, guidance, seed)
        started = time.monotonic()
        try:
            audio = pipe(
                prompt=spec.prompt,
                seconds=seconds,
                num_inference_steps=steps,
                cfg_scale=guidance,
                seed=seed,
            )
        finally:
            devices.release_gpu_memory()

        # (batch, channels, samples) with one of each: the DAC codec is mono.
        wave = audio.detach().to("cpu", torch.float32)[0, 0].numpy()
        if not np.isfinite(wave).all():
            raise RuntimeError("MOSS produced invalid audio (NaN). Try another seed or more steps.")
        rate = int(pipe.sample_rate)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), np.clip(wave, -1.0, 1.0), rate)
        log.info("moss: wrote %.1f s in %.0f s", len(wave) / rate, time.monotonic() - started)
        return SynthesisResult(
            path=out_path,
            duration_seconds=len(wave) / rate,
            device="cuda",
        )

    def support(self) -> Support:
        hardware = devices.hardware()
        if not hardware.cuda:
            return Support(
                False,
                reason="MOSS-SoundEffect needs an NVIDIA GPU; its 11 GB model is far "
                       "too slow on a CPU.",
            )
        vram = hardware.vram_total_bytes or 0
        if vram < MIN_VRAM_BYTES:
            return Support(
                False,
                reason=f"MOSS-SoundEffect needs about 6 GB of VRAM; this GPU has {vram / GIB:.1f} GB.",
            )
        if vram < MOSS_COMFORT_VRAM_BYTES:
            return Support(
                True,
                warning="This GPU runs MOSS with offloading, which takes minutes per "
                        "clip. A 3 s effect costs as much as a 30 s one.",
                max_duration_seconds=MOSS_MAX_SECONDS,
            )
        return Support(True, max_duration_seconds=MOSS_MAX_SECONDS)
