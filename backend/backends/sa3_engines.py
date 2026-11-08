"""Stable Audio 3 Small — the lite music and sound-effect engines (Phase 9).

Two engines, one Python package: `sa3_music` and `sa3_sfx` each load their own
checkpoint (`stable-audio-3-small-music` / `-sfx`) through the same
`stable_audio_3` code. The registry keys engines by what they make, so there are
two, but a single install of the package serves both.

Unlike ACE-Step and MOSS this engine **has not been run anywhere**: both
repositories are gated and the machine this was built on has no Hugging Face
access, so there are no weights to load. What is checked is the shape of the calls
against the package's own source (commit `790793b`, read in the spike) and a fake
package with the same signatures in `tests/test_audio.py`. `support()` therefore
makes no promise about speed, and no time estimate is shown in the forms.

How it loads, and why it doesn't use `StableAudioModel.from_pretrained`: that
helper downloads from the Hub on every call (`hf_hub_download` without
`local_files_only`) and its text encoder then fetches a second repository.
VoiceCraft never lets a generation start a download, so this adapter does what
`from_pretrained` does — read the config, build the model with
`load_diffusion_cond`, wrap it in `StableAudioModel` — from files the Models page
already downloaded, with the config pointing the text encoder at its local folder.
"""

from __future__ import annotations

import gc
import logging
import random
import tempfile
import time
from pathlib import Path

import catalog
from utils import audio as media
from backends import device as devices
from backends import sa3_files
from backends.audio_engines import PackagedAudioBackend
from backends.base import AudioSpec, BackendUnavailable, Support, SynthesisResult

log = logging.getLogger(__name__)

# The model card's numbers: 8 steps, and guidance only matters for the base
# checkpoints ("these parameters have no effect on post-trained checkpoints").
SA3_STEPS = 8
SA3_GUIDANCE = 1.0
# The checkpoints are trained for up to 120 s (`sample_size` 5 292 032 at 44.1 kHz).
SA3_MAX_SECONDS = 120.0
SA3_MIN_SECONDS = 1.0
SA3_SILENT_PEAK = 0.01   # below this the clip is flagged as nearly silent
# fp16 is the library's own default on CUDA. Below compute capability 7 (Pascal)
# half precision runs at a fraction of fp32 speed, so those cards get fp32; the
# model is small enough for that on 6 GB. Neither was run.
FP16_MIN_CAPABILITY = 7


def read_source(path: str | Path) -> tuple["np.ndarray", int]:
    """Decode the clip an edit starts from: float32, (samples, channels), and its rate.

    soundfile reads WAV, FLAC and OGG everywhere and MP3 on a recent libsndfile;
    anything it refuses goes through ffmpeg, which the app already depends on.
    """
    import soundfile as sf  # noqa: PLC0415

    try:
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 - any decode failure falls back to ffmpeg
        with tempfile.TemporaryDirectory() as folder:
            wav = Path(folder) / "source.wav"
            media.convert(path, wav)
            data, rate = sf.read(str(wav), dtype="float32", always_2d=True)
    if data.shape[0] == 0:
        raise ValueError(f"{Path(path).name} has no audio in it")
    return data, int(rate)


class Sa3Backend(PackagedAudioBackend):
    """Shared by the music and sound-effect engines; subclasses name themselves."""

    # `stable-audio-3` installs the `stable_audio_3` package (hatchling wheel).
    modules = ("stable_audio_3",)
    # Documented for neither checkpoint, so a request with lyrics is refused
    # instead of being quietly sung as "text".
    supports_lyrics = False
    # Variation, extending a clip and replacing a part of it (the library's
    # `init_audio` and `inpaint_audio` inputs).
    supports_editing = True
    max_seconds = SA3_MAX_SECONDS
    # A hard ceiling for the engine's kind whatever the checkpoint can do (0 = none).
    cap_seconds = 0.0

    def __init__(self) -> None:
        super().__init__()
        self._model = None

    def defaults(self) -> tuple[int, float]:
        return SA3_STEPS, SA3_GUIDANCE

    # --- model ----------------------------------------------------------

    def _load(self) -> None:
        from huggingface_hub import hf_hub_download, snapshot_download  # noqa: PLC0415
        from huggingface_hub.errors import LocalEntryNotFoundError  # noqa: PLC0415

        spec = catalog.active_model(self.name)

        def offline(label: str, fetch):
            try:
                return fetch()
            except LocalEntryNotFoundError as exc:
                # A generation never starts a download: send the user to the page
                # that does, and say which piece is missing.
                raise BackendUnavailable(
                    f"{label} is missing from the model cache. Download {spec.title} "
                    "again from the Models page."
                ) from exc

        config_file = offline(
            "The model configuration",
            lambda: hf_hub_download(
                repo_id=spec.repo_id, filename=sa3_files.CONFIG_NAME, local_files_only=True
            ),
        )
        checkpoint = offline(
            "The model weights",
            lambda: hf_hub_download(
                repo_id=spec.repo_id, filename=sa3_files.WEIGHTS_NAME, local_files_only=True
            ),
        )
        try:
            model_config = sa3_files.read_config(Path(config_file))
            encoder = sa3_files.encoder_ref(model_config)
        except sa3_files.EncoderConfigError as exc:
            raise BackendUnavailable(f"{spec.title} can't be loaded: {exc}.") from exc
        folder = offline(
            f"The text encoder ({encoder.repo_id})",
            lambda: snapshot_download(repo_id=encoder.repo_id, local_files_only=True),
        )
        sa3_files.pin_encoder(model_config, folder)

        hardware = devices.hardware()
        on_cuda = hardware.cuda
        major = hardware.capability[0] if hardware.capability else 0
        half = on_cuda and major >= FP16_MIN_CAPABILITY
        device = "cuda" if on_cuda else "cpu"
        if not on_cuda:
            devices.set_cpu_threads()

        from stable_audio_3.loading_utils import load_diffusion_cond  # noqa: PLC0415
        from stable_audio_3.model import StableAudioModel  # noqa: PLC0415

        log.info(
            "loading %s on %s (%s)",
            spec.repo_id, device, "float16" if half else "float32",
        )
        network = load_diffusion_cond(model_config, checkpoint, device=device, model_half=half)
        # What `StableAudioModel.from_pretrained` sets after building the network.
        network.use_lora = False
        network.lora_names = []
        self._model = StableAudioModel(network, model_config, device, half)
        self._device = device

    def _unload(self) -> None:
        self._model = None
        gc.collect()

    # --- generation -----------------------------------------------------

    def _generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult:
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
        import torch  # noqa: PLC0415

        model = self._model
        if model is None:  # unloaded between load() and here
            raise BackendUnavailable(f"{self.label} was unloaded; try again.")
        if spec.lyrics:
            raise ValueError(f"{self.label} can't sing lyrics; use ACE-Step for vocals.")

        seconds = min(max(float(spec.duration_seconds), SA3_MIN_SECONDS), self._limit())
        seed = spec.seed if spec.seed is not None else random.randrange(2**31)
        steps = spec.steps or SA3_STEPS
        guidance = spec.guidance if spec.guidance is not None else SA3_GUIDANCE

        edits = self._edit_inputs(spec, seconds)
        log.info(
            "%s: %.1f s, %d steps, seed %d%s", self.name, seconds, steps, seed,
            f", {spec.edit}" if spec.edit else "",
        )
        started = time.monotonic()
        try:
            audio = model.generate(
                prompt=spec.prompt,
                duration=seconds,
                steps=steps,
                cfg_scale=guidance,
                seed=seed,
                batch_size=1,
                # The same value the library's own CLI passes: the checkpoint's
                # trained length, from which the real latent size is derived.
                sample_size=model.model_config["sample_size"],
                **edits,
            )
        finally:
            devices.release_gpu_memory()

        # (batch, channels, samples) → (samples, channels) for soundfile.
        wave = audio.detach().to("cpu", torch.float32)[0].numpy().T
        if not np.isfinite(wave).all():
            raise RuntimeError(f"{self.label} produced invalid audio (NaN). Try another seed.")
        rate = int(model.model.sample_rate)
        peak = float(np.abs(wave).max()) if wave.size else 0.0
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_path), np.clip(wave, -1.0, 1.0), rate)
        log.info("%s: wrote %.1f s in %.0f s", self.name, len(wave) / rate, time.monotonic() - started)
        return SynthesisResult(
            path=out_path,
            duration_seconds=len(wave) / rate,
            device=self._device or "cpu",
            warning=(
                "The result is almost silent. Try another seed or describe it in more detail."
                if peak < SA3_SILENT_PEAK else None
            ),
        )

    @staticmethod
    def _edit_inputs(spec: AudioSpec, seconds: float) -> dict:
        """The extra `generate()` arguments for a variation, an extension or a replacement.

        - variation: the clip is the starting point and `init_noise_level` is how
          much of it is thrown away (1.0 = all of it);
        - replace: the clip is the inpaint source and the region is masked out
          (mask 0 = regenerate), the rest is kept;
        - extend: the same, with the "region" being everything after the clip.
        """
        if not spec.edit:
            return {}
        if not spec.source_path:
            raise ValueError("an edit needs the clip to start from")
        data, rate = read_source(spec.source_path)
        source = (rate, data)
        if spec.edit == "variation":
            strength = 0.5 if spec.strength is None else spec.strength
            return {"init_audio": source, "init_noise_level": min(max(strength, 0.0), 1.0)}
        if spec.edit == "replace":
            if not spec.region:
                raise ValueError("say which part to replace")
            start, end = spec.region
            return {
                "inpaint_audio": source,
                "inpaint_mask_start_seconds": float(start),
                "inpaint_mask_end_seconds": float(end),
            }
        if spec.edit == "extend":
            length = data.shape[0] / rate
            if seconds <= length:
                raise ValueError("the result has to be longer than the clip it extends")
            return {
                "inpaint_audio": source,
                "inpaint_mask_start_seconds": float(length),
                "inpaint_mask_end_seconds": float(seconds),
            }
        raise ValueError(f"unknown edit {spec.edit!r}")

    @property
    def label(self) -> str:  # type: ignore[override]
        """"Stable Audio 3 Small" or "... Medium", whichever checkpoint is chosen."""
        try:
            return catalog.active_model(self.name).title.split(" (")[0]
        except KeyError:
            return "Stable Audio 3"

    def _limit(self) -> float:
        """The longest clip the checkpoint in use makes (Medium does more than Small)."""
        try:
            chosen = catalog.active_model(self.name).max_seconds
        except KeyError:
            chosen = 0.0
        limit = chosen or self.max_seconds
        return min(limit, self.cap_seconds) if self.cap_seconds else limit

    def support(self) -> Support:
        hardware = devices.hardware()
        # A bigger checkpoint chosen on the Models page needs a better card. Say so
        # instead of letting the load fail.
        try:
            spec = catalog.active_model(self.name)
        except KeyError:
            spec = None
        if spec is not None and spec.min_capability:
            major = hardware.capability[0] if hardware.capability else 0
            if not hardware.cuda or major < spec.min_capability:
                return Support(
                    False,
                    reason=f"{spec.title} can't run on this machine. {spec.requirement} "
                           "Pick the Small model on the Models page.",
                )
        if hardware.cuda:
            return Support(True, max_duration_seconds=self._limit())
        return Support(
            True,
            warning="No NVIDIA GPU was found, so this runs on the CPU. The model is "
                    "built for that, but how long a clip takes on this machine has not "
                    "been measured.",
            max_duration_seconds=self._limit(),
        )


class Sa3MusicBackend(Sa3Backend):
    name = "sa3_music"
    kind = "music"
    max_seconds = SA3_MAX_SECONDS


class Sa3SfxBackend(Sa3Backend):
    name = "sa3_sfx"
    kind = "sfx"
    # The checkpoint can do 120 s, but a sound effect request is capped at 30 s
    # for every engine (`models.SFX_MAX_SECONDS`), so say what the app will accept.
    max_seconds = 30.0
    cap_seconds = 30.0
