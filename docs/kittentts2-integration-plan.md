# Plan: add KittenTTS 2 as a second cloning model family

## Context

VoiceCraft clones voices with Qwen3-TTS (0.6B/1.7B Base) and uses Kokoro-82M for preset voices. The Qwen
checkpoints are now several months old. The user asked whether **KittenTTS 2** (github.com/KittenML/KittenTTS,
`pip install kittenml`, v0.9.4) could be added as a second family for voice cloning and voice creation, and
whether it fits the current stack.

## Evaluation: will it fit?

**Short answer: yes, with one required stack change (PyTorch ≥ 2.6) and two things to verify on real hardware.**

What KittenTTS 2 offers, from the README, `docs/api.md` and the source:
- A 1.7B speech LM with **ternary (1.6-bit) packed weights**. The download is 947 MiB, or 506 MiB with
  `weights="emb4"`. Qwen 1.7B is about 5 GB, so this is much smaller.
- **Zero-shot cloning** from 5–30 s of audio: `m.generate(text, reference=wav, reference_text=...)`. It also
  has **47 built-in voices** (`voice="Bruno"`), so one engine covers both cloned and preset profiles.
- 20 languages, all of Qwen's 10 among them. Output is 24 kHz float32 numpy, the same rate as both current engines.
- Emotion and event tags (`[joyful]`, `<laugh>`, `(((emphasis)))`), `preset="stable"|"expressive"`, a `seed`
  for reproducibility, and built-in sentence chunking for long scripts. All of these suit podcast work.
- Runs on CUDA or CPU (about 2–3× slower than real time on CPU, much faster than Qwen on CPU). There is **no
  MPS path**, so Apple Silicon runs on CPU.

Fit against this repo's architecture:
- `backend/backends/base.py`'s `TTSBackend` protocol (`load`, `prepare_voice`, `synthesize`, `unload`,
  `supports_cloning`) maps one to one. The engine is a third file next to `qwen_backend.py`.
- Voice prints map cleanly. KittenTTS's built-in voices are stored as an `.npz` of `embedding` and
  `reference_tokens` plus a transcript, and `_clone_reference` builds the same thing from a clip. We can persist
  that to `voices/<id>.vprint` exactly as Qwen does.
- `kittenml` downloads through `huggingface_hub`, so the Models page (`services/model_service.py`
  `snapshot_download` and `catalog.py`) can own the download.

Blockers and risks:
1. **PyTorch pin conflict (required change).** `kittenml` needs `torch>=2.6, torchaudio>=2.6`. Setup pins
   `torch==2.5.1` from the **cu121** index (`src-tauri/src/setup.rs:28,597`). If nothing changes, `pip install kittenml`
   silently replaces it with PyPI's torch, which is the **CPU wheel on Windows**, and that breaks Qwen's GPU path.
   Fix: move to `torch==2.7.1 torchaudio==2.7.1` from the **cu126** index. cu126 still ships Pascal (sm_61)
   kernels, so the GTX 1060 keeps working. cu128 would drop Pascal, so avoid it. Qwen must then be re-verified on torch 2.7.
2. **Other dependencies are compatible.** `qwen-tts` pins `transformers==4.57.3`, which satisfies kittenml's
   `>=4.55`. `onnxruntime`, `librosa` and `einops` are already pulled in by qwen-tts. The new packages are
   `diffusers`, `hydra-core`, `omegaconf`, `s3tokenizer`, `resemble-perth`, `pyloudnorm`,
   `kitten-text-processing`, `phonemizer` and `espeakng_loader`. All are pure-Python or have wheels, so no compiler is needed.
3. **Whisper large-v3 trap.** If `reference_text` is omitted, kittenml downloads `openai/whisper-large-v3`
   (about 3 GB) to transcribe the clip. Profiles already have an optional `sample_text`. The plan is to
   **require a transcript for Kitten cloning profiles**: the UI makes the field mandatory for that engine and
   `profile_service` validates it. That keeps the "no hidden multi-GB download" rule from `voice_service._can_run`.
4. **bf16 is hard-coded** (`kittentts2/model.py:171`, read from the repo's `config.json` `dtype`). Pre-Ampere GPUs
   such as the GTX 1060 lack native bf16. It may run slowly through emulation or fail. Mitigation in the backend:
   on CUDA with compute capability below 8, load with `dtype: "fp32"` by passing a patched config into
   `KittenTTS2(repo_dir, config, ...)`. If that fails, fall back to CPU with a warning. Same pattern as
   `QwenBackend._pick_device`. **Must be verified on the 1060.**
5. **Private API for voice prints.** Persisting and reusing a clone requires `model.speaker_encoder`,
   `model.codec.encode_reference`, `model._build_reference` and `model._reference_cache`. Pin `kittenml==0.9.4`
   and fall back to plain `generate(reference=...)` if those attributes are missing.
6. **License.** The code is Apache-2.0. The **weights use the "Stellon Labs Community License"**, a separate license
   I couldn't fetch from this sandbox because huggingface.co is blocked. Read it before shipping: check the
   commercial/revenue terms, attribution, and voice-cloning consent clauses. kittenml also depends on
   `resemble-perth`, a neural watermarker. Check whether outputs are watermarked and say so in the UI if they are.

Not recommended for now: the legacy ONNX models (nano, micro, mini; 15–80M, no cloning). They duplicate Kokoro's role.
The optional vLLM backend is Linux-only and too heavy for a desktop app.

### Verification status (what was checked, and how)
Checked against the **published `kittenml==0.9.4` sdist from PyPI**, not only the README:
- ✅ Public API: `KittenTTS(model_name, cache_dir, backend, device, hf_token, decoder, weights)`,
  `generate(text, voice|reference, reference_text, preset, advanced={"seed":…})`, `sample_rate`, `available_voices`.
- ✅ The private hooks used for voice prints exist: `speaker_encoder(wav)`, `codec.encode_reference(wav)`,
  `_build_reference(embedding, reference_tokens, transcript, reference_wav)`, `_reference_cache`, and the cache key
  `("clone", resolve_reference_path(wav), text)`. Note that `_build_reference` still needs the **reference WAV on disk**
  for the vocoder conditioning, so the voice print supplements the sample and does not replace it. Profiles already keep it.
- ✅ Hard-coded bf16 (`model.py:171`, read from `config["dtype"]`) and device auto-detection of cuda or cpu with no MPS are both confirmed.
- ✅ **No watermarking.** `resemble-perth` is declared as a dependency but never imported.
- ⚠️ **New: a second weight repo.** `S3Codec` downloads `s3gen_meanflow.safetensors` from `ResembleAI/chatterbox-turbo`
  (`vocoder.py:25,58`) at load time, even though the README says "every weight ships in its own repository". The
  catalog must download this file too, and `_can_run` must check it. Otherwise loading triggers a hidden download.
- ✅ **Dependency resolution is proven** with `uv pip compile` (Python 3.11, on Windows, Linux and macOS) over the exact
  `setup.rs` package list plus `kittenml==0.9.4`:
  - With `torch==2.5.1`, it is **unsatisfiable** on all three platforms: "kittenml depends on torchaudio>=2.6".
    setup.rs installs torch and the engines in two separate pip calls, so in practice pip would silently replace the
    CUDA torch with PyPI's torch.
  - With `torch==2.7.1`, it **resolves** on all three platforms: transformers 4.57.3, accelerate 1.12.0, qwen-tts 0.1.1,
    kokoro 0.9.4, misaki 0.9.4, numpy 2.4.6, diffusers 0.39.0, s3tokenizer 0.3.0, onnxruntime 1.31 (1.23.2 on macOS).
    transformers and accelerate resolve to the versions qwen-tts already pulls in today, so Qwen's Python stack is
    unchanged apart from torch itself.
  - Still unverified, because it needs real hardware: Qwen and Kitten **runtime** behaviour on torch 2.7.1+cu126 on the
    GTX 1060 (Pascal, bf16). download.pytorch.org is blocked from this sandbox, so the cu126 wheel itself could not be
    fetched. Its Pascal support has to be confirmed on the machine.
- ❌ Context7: monthly quota exceeded, not used. ❌ The weights license (Stellon Labs) could not be read because
  huggingface.co is blocked from the sandbox.

## Implementation plan

### 1. Runtime and dependencies
- `src-tauri/src/setup.rs`: set `CUDA_INDEX` to `.../whl/cu126` and the torch args to `torch==2.7.1`,
  `torchaudio==2.7.1`. Label the flavour `"cuda 12.6"`. Add `"kittenml==0.9.4"` to `ENGINE_PACKAGES` and bump
  the array length. Existing installs have a torch-2.5.1 marker, so treat a marker with an old torch as "needs setup".
  That way users get re-prompted instead of having pip upgrade torch to the CPU wheel. Optionally pre-warm KittenTTS in
  step 5, like `WARM_KOKORO`, or leave the download to the Models page. **Recommended: Models page only**, since it is ~0.5–1 GB.
- `backend/requirements.txt`: update the torch comment to the cu126 / 2.7.1 command and add `kittenml==0.9.4`.
- `backend/README.md` and root `README.md`: update the engine tables and install commands.

### 2. Backend engine `backend/backends/kitten_backend.py` (new)
A `KittenBackend` class with `name = "kitten"` and `supports_cloning = True`, modelled on `qwen_backend.py`:
- `available()`: `find_spec("kittenml")` and `find_spec("torch")`.
- `_pick_device()`: cuda if CC ≥ 8 (bf16), cuda+fp32 if CC < 8 (with a warning), otherwise cpu with a warning.
  On CPU, call `torch.set_num_threads(min(8, os.cpu_count()))`, as the API docs recommend.
- `load()`: resolve the repo from `config.kitten_model_id()`. Read the `weights` variant from the catalog entry
  (`packed` or `emb4`). Construct through `kittenml.KittenTTS(repo, device=..., weights=...)`. For the fp32 case,
  construct `KittenTTS2` with a config copy that sets `dtype="fp32"`.
- `prepare_voice()`: for cloned profiles, compute `embedding = m.speaker_encoder(path)` and
  `tokens = m.codec.encode_reference(path)`. Write an `.npz`-style payload to `out_path` containing
  `version`, `model_id`, `embedding`, `reference_tokens`, `transcript` and `sample_path`, using `np.savez`
  (no pickle). Seed `m._reference_cache` with the result. Return a `VoicePrint(mode="icl", ...)`. Reuse
  `_load_reference` from `qwen_backend.py`, moved into `utils/audio.py`, to downmix and peak-normalize first.
  Write a temporary mono WAV, because kittenml takes a path.
- `synthesize()`: for preset profiles call `m.generate(text, voice=preset, preset=..., advanced={"seed":...})`.
  For cloned profiles, rebuild the reference from the voice print through `_build_reference` and inject it into the
  cache under the `("clone", resolved_path, transcript)` key. Then call `m.generate(text, reference=path, reference_text=transcript)`.
  Write with `soundfile` at `m.sample_rate`.
- `unload()`: drop the model and call `torch.cuda.empty_cache()`.
- Export `KITTEN_PRESET_VOICES`, a static list of the 47 names copied from `docs/voices-and-expression.md`, so the
  profile UI works before the weights are downloaded. Cross-check it against `m.available_voices` at load time.

Register it in `backend/backends/__init__.py` under `_REGISTRY["kitten"]`.

### 3. Config, catalog and models
- `backend/config.py`: add `DEFAULT_KITTEN_MODEL_ID = "KittenML/kitten-tts-2"` and `kitten_model_id()`, which reads
  the `VOICECRAFT_KITTEN_MODEL` environment variable, then the `kitten_model` setting, then the default. This mirrors `kokoro_model_id()`.
- `backend/catalog.py`: add two `ModelSpec`s with `engine="kitten"` and `clones_voices=True`. Both use the same
  `repo_id`, so add a `variant` field (`"packed"` or `"emb4"`) to `ModelSpec`:
  - `kitten-tts-2` (947 MiB, lossless). The default for the engine.
  - `kitten-tts-2-emb4` (506 MiB, smaller).

  Set `allow_patterns` so the `cpp/` GGUF files and the `full` bf16 weights are not downloaded. The exact patterns
  are `config.json`, `lm/<chosen>*`, `speaker/*`, `voices/*` and `decoders/<default>*`, taken from the repo's
  `config.json` at implementation time. Also check whether `S3Codec` pulls weights from a second repo. If it does,
  that repo needs its own catalog entry or a pre-download, so `_can_run` doesn't hide a download.
  Add `"kitten": "kitten_model"` to `SETTING_KEY` and a branch in `active_repo_id`. Since both variants share a
  repo, the "active" setting must store the **model id**, not the repo id, for this engine. Adjust `active_repo_id`
  and `model_service.describe` / `select` accordingly.
- `backend/models.py`: add `Engine.kitten = "kitten"`.

### 4. Profiles and voice preparation
- `backend/services/profile_service.py`: a Kitten profile is **either** a clone (sample plus a **required**
  `sample_text`) **or** a preset (`preset_voice` from `KITTEN_PRESET_VOICES`), never both. Set `voice_status` to
  `pending` for clones and `not_needed` for presets. Generalize the current `Engine.qwen` and `Engine.kokoro`
  branches into a capability check (`backend.supports_cloning` plus "has a preset list").
- `backend/routes/profiles.py`: change `/api/profiles/voices` to take `?engine=` and return Kokoro's or Kitten's preset list.
- `backend/services/voice_service.py` needs no logic change, since it is engine-agnostic through `get_backend`.
  Only the docstring needs updating.
- `backend/database/models.py`: no schema change. `engine` is already `String(32)`.

### 5. Frontend (`app/src`)
- `lib/types.ts`: `Engine = "qwen" | "kokoro" | "kitten"`.
- `lib/api.ts`: `presetVoices(engine)` replaces `kokoroVoices()`.
- `pages/Profiles.tsx`: add a "KittenTTS 2 — voice cloning + 47 presets" option. When it is selected, show a
  Clone / Preset toggle. In Clone mode the transcript field is required, with the hint "5–30 s, single speaker".
- `pages/Generate.tsx`: for Kitten profiles, add a **Stable / Expressive** preset selector and an optional seed.
  Show the expression-tag hint (`[joyful]`, `<laugh>`, `(((word)))`). Extend the CPU warning at line 123 to Kitten.
  Pass `preset` and `seed` through `routes/generate.py` and add them to `VoiceSpec`, or to a small `options` dict on the job.
- `pages/Settings.tsx`: add `kitten` to the default-engine dropdown. `pages/Models.tsx` needs no change, since it is catalog-driven.
- `pages/Setup.tsx`: update the step text ("Qwen3-TTS, KittenTTS, Kokoro").

### 6. Tests
- `backend/tests/test_smoke.py`: change the engine set to `{"qwen", "kokoro", "kitten"}`. Check that Kitten presets
  are exposed (`"Bruno"` among them), that a Kitten clone profile without a transcript is rejected, that a Kitten
  preset profile is created as `not_needed`, and that the catalog lists `kitten-tts-2`.
- New `backend/tests/test_generate_kitten.py`, modelled on `test_generate_kokoro.py`. It skips if kittenml or the
  weights are missing, generates one preset sentence and one cloned sentence, prepares a voice print, and checks
  that it reloads after `unload()`.

## Verification
1. `npm run backend:test`: the smoke tests pass without any models present.
2. In a fresh venv with torch 2.7.1+cu126 and `pip install -r backend/requirements.txt`, check that
   `python -c "import torch; print(torch.__version__, torch.cuda.is_available())"` still reports CUDA.
   Run `pip check` to confirm there are no conflicts.
3. **Regression:** run Qwen cloning on the GTX 1060 under torch 2.7 (`test_generate_*` and a manual generation in the app).
4. Download `kitten-tts-2-emb4` from the Models page, then run `python backend/tests/test_generate_kitten.py`
   on the 1060 (the fp32 path), on CPU-only, and on an Apple Silicon Mac (CPU path). Record the real-time factor
   in README's milestone table.
5. In `npm run dev`, create a Kitten clone profile and confirm the voice print is ready. Generate a two-paragraph
   script, restart the app, and generate again. The voice print should be reused, per the log line. Confirm no
   Whisper download happens.
6. Before release, read the Stellon Labs Community License and check for the perth watermark. Note both in the README and on the Models page entry.
