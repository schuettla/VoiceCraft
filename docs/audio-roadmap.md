# Plan: KittenTTS 2, music and sound effects

Status: proposal · 2026-11-07

This document merges two earlier plans:
- `docs/kittentts2-integration-plan.md` (commit 7b390fb)
- `AUDIO_GENERATION_PLAN.md` (uncommitted draft, 2026-09-22, revised 2026-11-05)

Neither plan had been implemented when they were merged: `setup.rs` was still on Python 3.11 and torch 2.5.1 (cu121). They were merged because both needed the same runtime upgrade, and had already drifted apart on it (torch 2.7.1 vs 2.9.1).

## Summary

| Feature | What it adds | Default engine | License |
|---|---|---|---|
| **KittenTTS 2** | A second voice-cloning family (zero-shot cloning + 47 preset voices) | `KittenML/kitten-tts-2` (1.7B, ternary weights, 0.5–0.9 GB) | Code Apache 2.0, weights Stellon Labs Community License (Conditional tier, §1.2) |
| **Sound FX** | New generation type: text → effect / ambience | MOSS-SoundEffect v2.0 (1.3B) | Apache 2.0 |
| **Music** | New generation type: text (+ lyrics) → song | ACE-Step 1.5 | MIT |
| **Lite engines** (v1.1) | CPU / low-VRAM music + SFX, first macOS path | Stable Audio 3 Small (0.6B) | Stability Community, gated |

All of them sit on a **shared foundation** that is built once:
1. One runtime upgrade (§2): Python 3.12, a new torch chosen by the spike, a per-GPU torch build, one constraints file and one migration screen.
2. Shared plumbing (§3): a device/precision helper, `ModelSpec` fields, download extras, the `params` column and license tiers.

**Key decisions**
- **One venv, one backend process** for all engines. A per-engine venv is the fallback for an engine that can't coexist.
- **Torch target: 2.7.1 first, 2.9.1 only if needed.** KittenTTS, ACE-Step (Windows) and Stable Audio 3 all point at 2.7.1, and Kitten's dependency resolution is already proven there. 2.9.1 was picked earlier only because of MOSS's optional extra.
- **Order:** spike → runtime → shared plumbing → KittenTTS → SFX → Music → Lite engines. Kitten goes first because it is the smallest feature, its dependencies are already checked, and it proves the new runtime with an engine type users already know.
- **License restrictions pass through to users** and the app must show them (§1.1).

---

## 1. Model survey and licensing

Sources are model cards, repo READMEs, license files and (for Kitten) the published `kittenml==0.9.4` sdist, unless marked *(secondary)*. Anything marked *(secondary)* or *(unverified)* gets re-checked in the Phase 0 spike.

### 1.1 "Non-commercial project, so licenses don't matter": only partly true

VoiceCraft is MIT-licensed and does not ship model weights. Users download them from Hugging Face or GitHub onto their own machine. So the project is not the party "using" the weights commercially. **The user is**, and VoiceCraft's users are creators scoring podcasts, videos and games. A CC BY-NC weights license means a clip made with that model can't go into a monetised YouTube video or a paid podcast. The restriction doesn't disappear because the app is free. It passes through to the user, so the app must say so.

The Stability AI Community License needs extra care. Free use is capped at $1M annual revenue. Commercial use needs registration. If we **distribute** the materials, we must pass on the license text and show "Powered by Stability AI". Whether a free open-source app counts as "commercial purpose" under its Section III is not clear from the text. Treat this as a question for the Stability licensing contact, not something to assume.

Three tiers, shown as a badge on every Models-page entry:

| Tier | Examples | Handling |
|---|---|---|
| **Open** | MIT, Apache 2.0 (Qwen3-TTS, Kokoro, ACE-Step, MOSS, HeartMuLa) | In the default catalog, no prompts. |
| **Conditional** | Stability AI Community License (gated download, revenue cap, Gemma terms for the text encoder). KittenTTS 2's Stellon Labs Community License (not gated, same $1M cap). | Badge plus a link to the terms. Gated repos get a one-time "accept terms" step and a Hugging Face token field. Required attributions go in About. |
| **Non-commercial** | CC BY-NC 4.0 weights (Woosh, MMAudio, TangoFlux) | Hidden unless the user turns on "Show non-commercial models". Install needs a confirmation: *"Output from this model can't be used commercially."* Clips made with it carry an **NC** chip in the session list and Library. |

**KittenTTS 2 is in the Conditional tier.** Its license was read on 2026-11-07; see §1.2.

This is not legal advice. Read the full license texts before shipping anything outside the Open tier.

### 1.2 Speech: KittenTTS 2

From the README, `docs/api.md` and the `kittenml==0.9.4` source (`pip install kittenml`, github.com/KittenML/KittenTTS):
- A 1.7B speech LM with **ternary (1.6-bit) packed weights**. The download is 947 MiB, or 506 MiB with `weights="emb4"`. Qwen 1.7B is about 5 GB.
- **Zero-shot cloning** from 5–30 s of audio: `m.generate(text, reference=wav, reference_text=...)`. Also **47 built-in voices** (`voice="Bruno"`), so one engine covers both cloned and preset profiles.
- 20 languages, all of Qwen's 10 among them. Output is 24 kHz float32, the same rate as both current engines.
- Emotion and event tags (`[joyful]`, `<laugh>`, `(((emphasis)))`), `preset="stable"|"expressive"`, a `seed`, and built-in sentence chunking for long scripts.
- CUDA or CPU (about 2–3× slower than real time on CPU, much faster than Qwen on CPU). **No MPS path**, so Apple Silicon runs on CPU.
- **No watermarking.** `resemble-perth` is declared as a dependency but never imported.

**Weights license: Stellon Labs Community License** (`LICENSE.md` in the HF repo, "last updated July 5, 2024"; read 2026-11-07). It is nearly word for word the Stability AI Community License. The repo is **not gated**. `speaker/` (pyannote) is MIT, and `kittenml` is Apache 2.0.

| Clause | What it says | What it means for VoiceCraft |
|---|---|---|
| Research & non-commercial | Free, revocable license. Non-commercial means "personal use (i.e., hobbyist) or evaluation and testing". | Hobbyist users are covered. |
| Commercial | Covers "creating or distributing your product or service", hosted services and internal business use. Free below **$1M annual revenue *and* $1M total funding**, but "You must register with Stellon Labs". Above the threshold the license terminates. | A user who puts Kitten output into a monetised podcast or video is doing commercial use. They must register (free) while under $1M. Whether a free open-source app that only *downloads* the weights counts as "distributing a product" is not clear. Registering the project once is the cheap way to remove the doubt. |
| Integrated products | Someone who receives the materials "as part of an integrated end-user product from a licensee" is exempt from Section III. | If VoiceCraft registers as the licensee, this probably covers its users too. That is a reading, not a certainty. Ask Stellon Labs when registering. |
| Outputs | "You own outputs to the extent permitted by applicable law." Outputs are not Derivative Works. | Users own their audio. Not non-commercial. |
| Attribution (on distribution) | A copy of the license, a `NOTICE` file with "This Stellon Labs Model is licensed under the Stellon Labs Community License" and "Copyright © Stellon Labs Inc. All Rights Reserved.", and **"Powered by KittenML"** shown in a UI, about page or docs. | VoiceCraft doesn't ship the weights, so this may not strictly apply. Do it anyway: "Powered by KittenML" in Settings → About and on the Models page entry, plus the license link. |
| Training on outputs | No using the materials or outputs to train, distill or transfer capabilities into another model (fine-tunes and LoRAs excepted). | Not relevant to VoiceCraft today. Mention it on the Models page entry. |
| AUP | Incorporated by reference, but only "available by contacting us". | Not public. **Request it when registering.** Voice-cloning consent and impersonation rules, if any, would be there. The license itself says nothing about them. |
| Other | Revocable on breach, indemnity, California law. | Standard. |

Not recommended: the legacy ONNX models (nano, micro, mini; 15–80M, no cloning), which duplicate Kokoro's role, and the optional vLLM backend (Linux-only, too heavy for a desktop app).

### 1.3 Music models

| Model | Size | Output | Hardware | License | Verdict |
|---|---|---|---|---|---|
| **ACE-Step 1.5** (`ACE-Step/Ace-Step1.5` turbo, `acestep-v15-sft`, `acestep-v15-base`; XL: `acestep-v15-xl-{turbo,sft,base}`) | LM 0.6B / 1.7B / 4B, DiT 2B (XL 4B–5B) | Vocals or instrumental, 50+ languages, up to 10 min | Card says "less than 4 GB VRAM"; verify | MIT | **v1 default.** |
| **Stable Audio 3 Small Music** (`stabilityai/stable-audio-3-small-music`) | 0.6B | Music up to 2 min, 8 steps, audio-to-audio, inpainting, LoRA. Vocals not documented. | Runs on CPU. Peak 1.7–2.4 GB VRAM (H200). "A few seconds" on an M4 MacBook. | Stability Community, **gated** | **"Lite" engine** (v1.1). The only candidate that clearly fits the 6 GB GTX 1060 and Macs. |
| **Stable Audio 3 Medium** (`stabilityai/stable-audio-3-medium`) | 2B | Music up to 6:20, same editing features | 5–6.5 GB VRAM, **needs Flash Attention 2** (Ampere+, awkward on Windows) | Stability Community, gated | Later, RTX 30xx+ only. |
| Stable Audio 3 Large | n/a | n/a | API only | n/a | Not available. |
| **HeartMuLa 3B** (`HeartMuLa/heartlib`) | 3B + HeartCodec | Lyrics-controlled vocals | ~6.2 GB with lazy load, 16 GB+ comfortable *(secondary)* | Apache 2.0 | Candidate second vocal engine. |
| DiffRhythm (`ASLP-lab/DiffRhythm`) | n/a | Songs up to 4:45, 44.1 kHz | 8 GB only with `--chunked` | Apache 2.0 | Watch. DiffRhythm 2 *(unverified)*. |
| YuE | 7B-class | Full songs | 24 GB+, 80 GB for long songs | Apache 2.0 | Too heavy. |
| MiniMax Music 3 (`MiniMaxAI/MiniMax-Music3`) | 8B LM + 2.4B flow | Songs up to ~5 min, lyrics | CUDA only, SGLang-Omni, ~22 GB with offload (README says two GPUs) | MiniMax Community License: free below $20M revenue, "MiniMax-Music3" shown in the UI of commercial products, AUP. Not CC BY-NC, as an earlier draft said. | **Rejected on hardware.** |
| LeVo / SongGeneration (Tencent) | n/a | Songs | 10 GB min *(secondary)* | *(unverified)* | Watch. |
| MusicGen | n/a | n/a | n/a | CC BY-NC | Rejected. |

### 1.4 Sound-effect models

| Model | Output | Hardware | License | Verdict |
|---|---|---|---|---|
| **MOSS-SoundEffect v2.0** (`OpenMOSS-Team/MOSS-SoundEffect-v2.0`) | Text to SFX, up to 30 s, 48 kHz, 1.3B | bf16; VRAM not stated. First call compiles with Triton; `TORCHDYNAMO_DISABLE=1` may be needed. | Apache 2.0 | **v1 default.** |
| **Stable Audio 3 Small SFX** (`stabilityai/stable-audio-3-small-sfx`) | Text to SFX, 0.6B, 8 steps. Trained on 1.28M recordings: AudioSparx (licensed) plus Freesound (CC0, CC-BY, CC-Sampling+). | CPU-capable. About 1.9 GB peak VRAM for 30 s. | Stability Community, **gated** | **"Lite" engine** (v1.1). |
| Woosh (Sony AI) | Text to audio (Flow, distilled DFlow) and video to audio (VFlow) | `uv sync --extra cuda` / `--extra cpu`. Weights from GitHub releases, not Hugging Face. | Code MIT/Apache, **weights CC BY-NC 4.0** | Non-commercial tier. Video-to-audio would suit the Editor. |
| MMAudio | Video to audio | n/a | Weights CC BY-NC 4.0 | Non-commercial tier. Not text to SFX. |
| TangoFlux | Text to audio | n/a | "Non-commercial research" (WavCaps data) | Non-commercial tier. |
| AudioLDM 2 | Text to audio | n/a | CC BY-NC-SA *(secondary)* | Non-commercial tier. |
| HunyuanVideo-Foley | Video to audio only | n/a | Tencent Hunyuan Community License; territory and scale terms *(unverified)* | Not text to SFX. Watch for a video-foley feature. |
| Stable Audio Open 1.0 | Text to audio, ~47 s | n/a | Stability Community, gated | Superseded by SA3 Small SFX. |

### 1.5 Lineup

1. **v1:** KittenTTS 2 (speech), MOSS-SoundEffect v2 (SFX), ACE-Step 1.5 (music). No accounts or tokens needed.
2. **v1.1:** Stable Audio 3 Small as a "Lite" engine for music and SFX.
   - It is the only option that clearly works on a 6 GB Pascal card and on CPU, and it generates in seconds.
   - Its repo ships MLX, CoreML and TFLite runtimes, which turns macOS from "not supported" into "possible".
   - It costs a gated-download flow: Hugging Face token plus license acceptance.
3. **Later:** Stable Audio 3 Medium (Ampere+), HeartMuLa, the Non-commercial tier (Woosh), and audio-to-audio / inpainting ("extend this clip", "replace these 2 seconds").

---

## 2. Shared runtime

### 2.1 Where we are

`src-tauri/src/setup.rs` builds a private venv with `PYTHON_VERSION = "3.11"` (line 25) and installs `torch==2.5.1 torchaudio==2.5.1` (line 598) from `CUDA_INDEX = .../whl/cu121` (line 28). It installs torch and the engine packages in **two separate pip calls**. So a package that needs a newer torch (such as `kittenml`, which needs `torch>=2.6`) silently makes pip replace the CUDA torch with PyPI's torch. On Windows that is the **CPU wheel**, which breaks Qwen's GPU path without any error at install time.

torch 2.5.1 cu121 also has no kernels for RTX 50-series cards.

### 2.2 What each engine requires

| | Python | torch | transformers | Other |
|---|---|---|---|---|
| Qwen3-TTS (`qwen-tts`) | ≥3.9 | not pinned | **==4.57.3** | accelerate==1.12.0 |
| Kokoro 0.9.4 | 3.10–3.12 | not pinned | not pinned | |
| KittenTTS 2 (`kittenml==0.9.4`) | resolved on 3.11; 3.12 unverified | **≥2.6** | ≥4.55 | diffusers, hydra-core, omegaconf, s3tokenizer, resemble-perth, pyloudnorm, kitten-text-processing, phonemizer, espeakng_loader. All pure Python or wheels. |
| MOSS-SoundEffect v2 | **≥3.12** | 2.9.0 (optional extra) | ==4.57.1 | numpy==1.26.4, diffusers==0.37.1 |
| ACE-Step 1.5 | 3.11–3.12 | Win **2.7.1** · Linux 2.10 · Mac ≥2.9.1 | 4.51–4.57 | diffusers≥0.37, accelerate≥1.12 |
| Stable Audio 3 (`stable-audio-3`, v1.1) | not stated (`.python-version` file) | pinned **2.7.1** (CUDA 12.6 default) | not stated | Medium needs `flash-attn` 2; Small does not. Own `uv` lock file. |

Already proven for Kitten (`uv pip compile`, Python 3.11, Windows/Linux/macOS, over the `setup.rs` package list plus `kittenml==0.9.4`):
- With `torch==2.5.1`: **unsatisfiable** on all three ("kittenml depends on torchaudio>=2.6").
- With `torch==2.7.1`: **resolves** on all three. transformers 4.57.3, accelerate 1.12.0, qwen-tts 0.1.1, kokoro 0.9.4, misaki 0.9.4, numpy 2.4.6, diffusers 0.39.0, s3tokenizer 0.3.0, onnxruntime 1.31 (1.23.2 on macOS). Qwen's Python stack is unchanged apart from torch.

### 2.3 Target

| | Choice | Why |
|---|---|---|
| Python | **3.12** | MOSS needs ≥3.12; everything else accepts it. |
| torch | **2.7.1**, fall back to 2.9.1 | Kitten is proven there, ACE-Step (Windows) and Stable Audio 3 pin it. Only MOSS points higher, and only through an optional extra. Move to 2.9.1 only if the spike shows MOSS (or another engine) failing on 2.7.1 and working on 2.9.1. |
| transformers | **4.57.3** | Qwen pins it exactly; MOSS's 4.57.1 is a patch-level difference. |
| numpy | **2.x** preferred | Kitten's stack resolves to 2.4.6. MOSS pins 1.26.4. Test MOSS on 2.x first; only pin 1.26.4 if MOSS breaks, and then re-test Kitten and Kokoro on it. |
| diffusers | **0.39** preferred | Kitten resolved 0.39, ACE-Step needs ≥0.37, MOSS pins 0.37.1. Same rule as numpy. |

Why one shared venv over isolation: one torch install instead of several (several GB each), no IPC layer, no second model-lifecycle system, and the existing in-process `unload()` handles VRAM.

### 2.4 One constraints file for every install

`setup.rs` owns one overrides file (`runtime-overrides.txt`) and passes it to **every** `uv pip install`: first-run setup, the KittenTTS install, and `install_audio_engine` later. That fixes the silent-CPU-torch problem from §2.1 and the exact-pin conflicts in the new engines' metadata:

```
torch==2.7.1              # or 2.9.1, per the spike
torchaudio==2.7.1
transformers==4.57.3      # MOSS pins 4.57.1
numpy==2.x.y              # MOSS pins 1.26.4; spike decides
diffusers==0.39.x         # MOSS pins 0.37.1; spike decides
```

Also:
- Install torch and the engine packages **in one resolve** where possible, not two pip calls.
- **Install only what inference needs.** ACE-Step's `pyproject.toml` also pulls training and demo deps (gradio, lightning, tensorboard, peft, lycoris-lora, modelscope). Install `ace-step` with `--no-deps` plus a curated dependency list. The same goes for MOSS (skip gradio, `finetune` and its `torch-cu128` extra) and `stable-audio-3`.
- **`nano-vllm`** (vendored in ACE-Step) is only for the vLLM LM backend. v1 uses the plain PyTorch LM path and skips it.
- **Pin every engine** to a version or commit (`kittenml==0.9.4`, `ace-step==1.5.0`, MOSS by git commit).

### 2.5 Torch build per GPU

`setup.rs` chooses the torch index by compute capability (`nvidia-smi --query-gpu=compute_cap`):

| GPU | Compute cap | torch index |
|---|---|---|
| GTX 9xx / 10xx (Maxwell, Pascal) | 5.x – 6.x | `cu126` |
| RTX 20xx and newer, incl. RTX 50xx (Blackwell) | ≥ 7.5 | `cu128` |
| Apple Silicon | n/a | default PyPI wheel |
| No NVIDIA GPU | n/a | CPU wheel |

Pascal details (the dev machine is a GTX 1060 6GB, compute cap 6.1):
- cu126 still ships Pascal (sm_61) kernels. cu128 dropped Maxwell/Pascal from torch 2.8 on, and CUDA 13 builds drop Pascal entirely. Maxwell (sm_5x) is not in the Windows cu126 build, so GTX 9xx cards fall back to CPU.
- After install, setup checks that the card's arch is in `torch.cuda.get_arch_list()`. If it isn't, it reinstalls the CPU wheel and says why, instead of shipping a runtime that crashes on the first generation.
- Pin Pascal machines to the last torch that ships a cu126 wheel, and keep that pin in `setup.rs`.

### 2.6 Migrating existing installs

`setup.rs` already writes a runtime marker (`python_version`, flavour). Add a **runtime version** to it. On launch, if the recorded version is older than the current one (Python 3.11 / torch 2.5.1), show the setup screen: *"VoiceCraft needs to update its engine runtime (one-time download, ~X GB)."* Rebuild the venv in place. Model weights (HF cache), voice prints (`voices/`) and the database are never touched. The rebuild must be resumable.

This one mechanism covers both features. There is only **one** forced update for users.

### 2.7 Which engines install when

- **First-run setup:** the speech stack, now including `kittenml==0.9.4` (Python packages only). KittenTTS weights download from the Models page, not at setup.
- **On demand from the Models page:** Music and SFX engines, through `install_audio_engine(name)` in `setup.rs`. It runs `uv pip install` with the overrides file into the same venv and streams progress like first-run setup. Weights download separately through the existing download flow.

### 2.8 Fallback

If the spike finds an engine that can't coexist (wrong numerics, a native-extension conflict), move only *that* engine into its own `uv` venv and run it as a worker subprocess (JSON over stdin/stdout). The backend protocols hide the difference. If Qwen3-TTS or Kokoro regress on the new runtime, stop and reassess.

---

## 3. Shared plumbing

### 3.1 Device and precision helper

KittenTTS (hard-coded bf16), MOSS (bf16) and Stable Audio 3 (fp16) all meet GPUs without native bf16. Add one helper, `backends/device.py`, and use it in every backend instead of copying `QwenBackend._pick_device`:

```python
def pick_device(*, wants_bf16: bool, supports_mps: bool) -> tuple[str, "torch.dtype", str | None]:
    """Return (device, dtype, warning). CUDA CC >= 8 → bf16 if wanted;
    CUDA CC < 8 → fp32 (or fp16 where the engine allows it) with a warning;
    MPS only if the engine supports it; otherwise CPU with a warning."""
```

On CPU, call `torch.set_num_threads(min(8, os.cpu_count()))`. Move `_load_reference` (downmix + peak-normalize) from `qwen_backend.py` into `utils/audio.py`, so Kitten can reuse it.

### 3.2 Generation columns

Add three columns to `Generation`, using the existing `ALTER TABLE … ADD COLUMN` helper in `database/session.py`:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `kind` | `String(8)` | `"speech"` | `speech` / `music` / `sfx` |
| `engine` | `String(32)` | null | `qwen`, `kokoro`, `kitten`, `acestep`, `moss_sfx`, `sa3_small` (later: `sa3_medium`, `heartmula`, `woosh`). Speech rows can keep resolving it through the profile. |
| `params` | `Text` (JSON) | null | Per-generation options. Speech: Kitten `preset` and `seed`. Music/SFX: lyrics, duration, seed, steps, guidance, takes. |

`params` answers the Kitten plan's open question of where `preset` and `seed` go: not into `VoiceSpec`, but into this column, which the job reads. `text` stays non-null and holds the script (speech), the style prompt (music) or the description (sfx).

### 3.3 Catalog and `ModelSpec`

New `ModelSpec` fields, all with defaults so existing entries don't change:

| Field | Used by | Purpose |
|---|---|---|
| `variant` | Kitten | `packed` / `emb4`; two entries share one repo. |
| `extra_files` | Kitten | Files from other repos that load would otherwise fetch on its own. Kitten's `S3Codec` downloads `s3gen_meanflow.safetensors` from `ResembleAI/chatterbox-turbo` (`vocoder.py:25,58`). `_can_run` must check them too. |
| `optional_engine` | Music, SFX | The Models page shows an "Install engine" step first. |
| `license_tier`, `license_url` | all | Badge and link (§1.1). |
| `gated` | Stable Audio 3 | The download asks for a Hugging Face token. The token is stored like other secrets, not in the database in plain text. |
| `source` | Woosh | `hf` (default) or `github_release`. |

The "active model" setting must store the **model id**, not the repo id, because Kitten's two variants share a repo. Adjust `active_repo_id`, `model_service.describe` and `select` accordingly.

New categories: `("music", "Music generation")`, `("sfx", "Sound effects")`. All entries:

| Catalog id | Repo | Kind | Tier | Phase | Notes |
|---|---|---|---|---|---|
| `kitten-tts-2` | `KittenML/kitten-tts-2` | speech | conditional | v1 | 947 MiB, lossless. Default for the engine. |
| `kitten-tts-2-emb4` | `KittenML/kitten-tts-2` | speech | conditional | v1 | 506 MiB, smaller. |
| `acestep-1.5-turbo` | `ACE-Step/Ace-Step1.5` | music | open | v1 | Default. Card claims <4 GB VRAM; verify. |
| `acestep-1.5-sft` | `ACE-Step/acestep-v15-sft` | music | open | v1 | "Quality" preset. |
| `acestep-1.5-xl-turbo` | `ACE-Step/acestep-v15-xl-turbo` | music | open | v1 | Large GPUs only. `-diffusers` variants (4B) are an alternative to the native 5B repos. |
| `moss-sfx-v2` | `OpenMOSS-Team/MOSS-SoundEffect-v2.0` | sfx | open | v1 | Default SFX. |
| `sa3-small-music` | `stabilityai/stable-audio-3-small-music` | music | conditional, gated | v1.1 | CPU-capable "Lite". |
| `sa3-small-sfx` | `stabilityai/stable-audio-3-small-sfx` | sfx | conditional, gated | v1.1 | CPU-capable "Lite". |
| `sa3-medium` | `stabilityai/stable-audio-3-medium` | music | conditional, gated | later | Needs Flash Attention 2 (Ampere+). |
| `heartmula-3b` | HeartMuLa org (check repo ID) | music | open | later | Second vocal engine. |
| `woosh-dflow` | GitHub release v1.0.0 | sfx | noncommercial | later | Behind the NC toggle. |

Kitten's `allow_patterns` skip the `cpp/` GGUF files and the `full` bf16 weights: `config.json`, `lm/<chosen>*`, `speaker/*`, `voices/*`, `decoders/<default>*`, taken from the repo's `config.json` at implementation time. Confirm every repo ID and download size in the spike.

### 3.4 GPU scheduling

All jobs still go through the single executor in `generation_service.py`, so only one generation runs at a time:
- Before a job, call `unload()` on every loaded engine other than the one the job needs, then `torch.cuda.empty_cache()`. This now matters for speech too: Qwen and Kitten would otherwise both sit in VRAM.
- An idle timer unloads the active model after 10 minutes.
- The health endpoint marks optional engines with `optional: true`, so the header doesn't warn about engines the user never installed.

---

## 4. KittenTTS 2 (speech)

Kitten fits the existing `TTSBackend` protocol (`load`, `prepare_voice`, `synthesize`, `unload`, `supports_cloning`) one to one. It becomes a third backend file next to `qwen_backend.py`. File-level detail is in **Appendix A**.

Rules specific to Kitten:
1. **Transcript required for clones.** Without `reference_text`, kittenml downloads `openai/whisper-large-v3` (about 3 GB) to transcribe the clip. The UI makes the transcript mandatory for Kitten clone profiles and `profile_service` validates it. This keeps the "no hidden multi-GB download" rule from `voice_service._can_run`.
2. **Precision.** bf16 is hard-coded (`kittentts2/model.py:171`, from the repo's `config.json` `dtype`). On CUDA below compute cap 8, load with `dtype: "fp32"` through a patched config passed into `KittenTTS2(repo_dir, config, ...)`, using the helper from §3.1. If that fails, fall back to CPU with a warning.
3. **Voice prints use private API.** Persisting a clone needs `model.speaker_encoder`, `model.codec.encode_reference`, `model._build_reference` and `model._reference_cache`. All of these exist in 0.9.4. Pin `kittenml==0.9.4`, and fall back to plain `generate(reference=...)` if they are missing. `_build_reference` still needs the reference WAV on disk, so the voice print supplements the sample rather than replacing it. Profiles already keep the sample.
4. **Second weight repo.** `ResembleAI/chatterbox-turbo` (`extra_files`, §3.3).

UI: a Kitten profile is **either** a clone (sample + required transcript) **or** a preset (one of 47 voices), never both. Generate shows a **Stable / Expressive** selector, an optional seed and the expression-tag hint for Kitten profiles (§5.1).

---

## 5. Music and sound effects

### 5.1 UX: one Generate view with a mode switch

**Keep one "Generate" nav item. Put a segmented control at the top of the view: `Voice | Music | Sound FX`.**

Why this beats a second view or a nav dropdown:
- **Everything except the form is shared.** The "This session" panel, the output format, the job queue and polling are identical for all three types. Two views would duplicate them or split one queue across two screens.
- **The nav has no dropdowns today.** It's a flat row of six buttons. A dropdown adds a hidden click and a new pattern for one item.
- **Switching is cheap and visible.** A creator scoring a podcast episode goes voice → music bed → a whoosh → voice. A segmented control makes that one click, with the session list staying on screen.
- **Room to grow.** A future type (such as speech-to-speech) becomes a fourth segment, not a seventh nav item.

Details:
- The last-used mode is remembered in `lib/preferences.ts`.
- The nav hint changes from "Script → cloned-voice audio" to "Voice, music and sound effects".
- A mode whose engine isn't installed stays selectable. It shows an install card instead of the form, so the feature is discoverable.

**Voice mode** (existing form, plus Kitten options):

```
┌ Generate ─────────────────────────────────────────────────────────────┐
│ [ Voice ][ Music ][ Sound FX ]                                         │
├──────────────────────────────────────────┬────────────────────────────┤
│ Script                                   │ This session               │
│ Voice profile  [ Anna — kitten      ▾]   │ ● Queued  [M] lofi beat…    │
│ Text           [                      ]  │ ──────────────────────────  │
│                [                      ]  │ ▶ [V] Welcome back…  0:42   │
│ Tags: [joyful] <laugh> (((word)))        │ ▶ [S] door slam…     0:03   │  ← Kitten only
│ Style  [ Stable ▾ ]   Seed [      ]      │ ▶ [M] upbeat intro…  0:30   │  ← Kitten only
│ Speed — 1.00×  ───────●────────          │                            │
│ ──────────────────────────────────────── │                            │
│ Format [WAV▾]   124 words     [Generate] │                            │
└──────────────────────────────────────────┴────────────────────────────┘
```

The CPU warning in `Generate.tsx` (around line 123) extends to Kitten.

**Music mode:**

```
│ Music                                    │
│ Style          [ lo-fi hip hop, warm   ] │  ← tags / description
│                [ Rhodes, 85 bpm        ] │
│ Lyrics         ( ) Instrumental (•) Vocals
│                [ [verse]               ] │  ← only when Vocals
│                [ ...                   ] │
│ Duration — 0:30  ──●──────────  (10 s – 4 min)
│ Engine         [ ACE-Step 1.5 ▾ ]        │  ← only when 2+ engines are installed
│ Quality        [ Fast (turbo) ▾ ]        │  ← per-engine presets
│ ▸ Advanced: seed, guidance, steps        │
│ ──────────────────────────────────────── │
│ Format [WAV▾]   ~20 s on this GPU  [Generate]
```

**Sound FX mode:**

```
│ Sound effect                             │
│ Describe it    [ heavy wooden door     ] │
│                [ slamming in a hallway ] │
│ Try: rain on window · crowd murmur · whoosh · keyboard typing
│ Engine         [ MOSS-SoundEffect v2 ▾ ] ← only when 2+ engines are installed
│ Duration — 3 s  ●─────────────  (1–30 s)
│ Takes          [ 1 ▾ ]  (1–4 variations, run in sequence)
│ ▸ Advanced: seed, guidance, steps        │
│ ──────────────────────────────────────── │
│ Format [WAV▾]                   [Generate]
```

**Engine not installed:**

```
│ Music generation isn't installed yet     │
│ ACE-Step 1.5 · MIT · ~X GB download      │
│ Needs an NVIDIA GPU (8 GB+ recommended). │
│                        [Install engine]  │  → Models page, Music section
```

Where the engine isn't supported, the card says so plainly. If a lighter engine would run there (Stable Audio 3 Small on CPU or a Mac), the card offers that one instead. A card for a gated engine also shows the Hugging Face token field.

**Rest of the app:**

| Area | Change |
|---|---|
| **Session panel** | Each row gets a type icon (voice / music / sfx). Title = script, style or prompt. Meta shows the voice name only for Voice. Clips from NC-tier engines carry an **NC** chip. |
| **Library** | New "Type" filter (All / Voice / Music / Sound FX). The voice filter shows only when Type is All or Voice. Rows without a `profile_id` no longer show "deleted voice" (`Library.tsx:269`). **NC** chip as above. |
| **Models** | New "Music generation" and "Sound effects" sections with an **Install engine** step before the weights download. Every entry shows its license tier badge. A "Show non-commercial models" toggle reveals the NC tier. Kitten needs no special handling; the page is catalog-driven. |
| **Profiles** | Kitten option with a Clone / Preset toggle (Appendix A). |
| **Header health badges** | Optional engines that aren't installed must **not** show "not installed" warnings. |
| **Editor** | Music and SFX appear in the Media Bin like voice clips. Check that MediaBin doesn't filter on `profile_id`. |
| **Settings** | `kitten` in the default-engine dropdown. About: attributions for ACE-Step (MIT), MOSS (Apache 2.0), "Powered by KittenML" with the Stellon Labs license link, later "Powered by Stability AI". |
| **Setup** | Step text: "Qwen3-TTS, KittenTTS, Kokoro". |

### 5.2 Engine protocol

`TTSBackend` is built around a voice (`VoiceSpec`, `prepare_voice`) and doesn't fit music or SFX. Add a sibling protocol in `backends/base.py`:

```python
@dataclass(slots=True)
class AudioSpec:
    prompt: str
    duration_seconds: float
    lyrics: str | None = None        # music only; None = instrumental
    seed: int | None = None
    steps: int | None = None
    guidance: float | None = None

class AudioBackend(Protocol):
    name: str
    kind: str                         # "music" | "sfx"
    def available(self) -> bool: ...
    def is_loaded(self) -> bool: ...
    def device(self) -> str | None: ...
    def load(self) -> None: ...
    def generate(self, spec: AudioSpec, out_path: Path) -> SynthesisResult: ...
    def unload(self) -> None: ...
```

`SynthesisResult` is reused, so `_run_job`'s WAV → ffmpeg conversion and status writes work as-is.

### 5.3 API

- `POST /api/generations/audio` with body `{kind: "music"|"sfx", engine?, prompt, duration_seconds, lyrics?, seed?, steps?, guidance?, takes?, output_format}` returns 202 with a `queued` row. `engine` defaults to the kind's default and must be installed. `takes > 1` creates N rows (sfx only).
- `GET /api/audio-engines` lists engines per kind with `installed`, `supported` (and why not), `license_tier`, `gated` and `default`. The Generate view and Models page both read it.
- `GET /api/generations` gains an optional `?kind=` filter. Rows include `kind`, `engine` and `params`.
- `POST /api/generations` for speech gains optional `preset` and `seed` (stored in `params`; used by Kitten, ignored by other engines).
- The output filename slug for music/SFX comes from the first words of the prompt (for example `door-slam-1a2b3c4d.wav`).

---

## 6. Phases

**Phase 0: Combined spike (Windows + CUDA first).** Build a fresh Python 3.12 venv with torch **2.7.1**, the overrides file from §2.4, `qwen-tts`, `kokoro`, `kittenml==0.9.4`, and the new engines (`--no-deps` + curated deps). Then:
1. **Resolve.** Re-run the `uv pip compile` check from §2.2 on Python 3.12 with every engine in it, on Windows, Linux and macOS. Run `pip check`.
2. **Regression first.** Clone a voice with Qwen3-TTS 0.6B and generate with Kokoro. Compare by ear and speed against today's 3.11 / torch 2.5.1 runtime on the same script.
3. **On the GTX 1060 6GB with cu126:** confirm `sm_61` is in `torch.cuda.get_arch_list()`. Then run:
   - **KittenTTS:** the fp32 path, one preset and one cloned sentence, real-time factor. Also on CPU.
   - **ACE-Step:** test its <4 GB VRAM claim with the LM off and with the 0.6B LM.
   - **MOSS:** fp32 + offload, since there's no fast bf16 on Pascal. Does it run, and how long does it take?
   - **Stable Audio 3 Small:** fp16 and fp32, and on CPU.
   Record peak VRAM and time (10 s / 30 s SFX, 2 / 3 min song). The results decide what the Models page tells 6 GB and pre-Ampere users.
4. ~~**On an RTX 20xx+ card with cu128:** the same runs, briefly.~~ Dropped: no such card is available. cu128 stays untested until someone with an RTX 20xx+/50xx card reports back.
5. **MOSS:** on torch 2.7.1, numpy 2.x and diffusers 0.39. On Windows, does first-run `torch.compile`/Triton fail, and does `TORCHDYNAMO_DISABLE=1` fix it? If MOSS fails on 2.7.1, repeat the spike on 2.9.1 (§2.3).
6. **Stable Audio 3:** the gated-download flow with a Hugging Face token. Check whether the repo's code license (the sidebar says MIT, the README points to the Community License) matches the weights license.
7. **Vocals bake-off** (optional): ACE-Step vs HeartMuLa on the same lyrics.
8. **Licenses:** re-check every *(secondary)* / *(unverified)* entry in §1. No registration or vendor outreach: VoiceCraft ships no weights, and each user is responsible for the licenses of the weights they download. The app only shows the license badge and link (§1.1).

### Phase 0 results (2026-11-07, GTX 1060 6GB, cc 6.1, Windows)

Runtime: Python 3.12.9, torch 2.7.1+cu126, one resolve with the `setup.rs` packages + `kittenml==0.9.4`. `uv pip compile` also resolves on Linux and macOS. `pip check`: clean (157 packages). `sm_61` is in `torch.cuda.get_arch_list()`; CUDA matmul OK.

| Run | Load | Audio | Real-time factor | Peak VRAM |
|---|---|---|---|---|
| Kokoro, GPU (new runtime) | 14.7 s | 3.7 s | 0.82 | n/a |
| Kokoro, GPU (today: py3.11 / torch 2.5.1) | 4.1 s | 3.7 s | 0.65 | n/a |
| Qwen3-TTS 0.6B clone, fp32 (new) | 7.6 s | 3.3 s | 4.94 | 4.77 GB |
| Qwen3-TTS 0.6B clone, fp32 (today) | 11.6 s | 3.5 s | 6.80 | 4.80 GB |
| Kitten emb4 preset, GPU (bf16) | 50 s | 4.4 s | 3.16 | 4.74 GB |
| Kitten emb4 clone, GPU (bf16, reference cached) | 47 s | 5.0 s | 2.49 | 4.77 GB |
| Kitten emb4 preset, CPU | 45 s | 4.7 s | 15.0 | n/a |

Single runs, no NaNs in any output. The by-ear comparison against today's runtime is still to do.

Findings that change this plan:
- **Kitten has 115 preset voices, not 47** (`available_voices`, 0.9.4). Take the list from the model, not a hard-coded one (§4, Appendix A).
- **bf16 runs on Pascal** and gives clean audio, so the fp32 path (§4 rule 2, §2 risks) is not needed. Patching the config to `dtype: "fp32"` fails with `mat1 and mat2 must have the same dtype` (some weights stay bf16).
- **Kitten on CPU is about 15x slower than real time**, not 2-3x. Say so on the Models page.
- **Windows needs `PYTHONUTF8=1`** for Kitten: `kittentts2/model.py:267` (`_load_voices`) calls `json.load` without an encoding and crashes under cp1252. Set it when the backend launches (Phase 1).
- The private hooks used for voice prints exist in 0.9.4: `speaker_encoder` (embedding shape `[512]`), `codec.encode_reference`, `_build_reference`, `_reference_cache`.
- Disk: `KittenML/kitten-tts-2` (emb4) is 560 MB; `ResembleAI/chatterbox-turbo` is about 1 GB in the cache.

**MOSS-SoundEffect v2 on the 1060** (step 3 and 5), torch 2.7.1+cu126, numpy 2.5.4, diffusers 0.39, transformers 4.57.3:
- Installs from git (`OpenMOSS/MOSS-TTS`, subdirectory `moss_soundeffect_v2`, `--no-deps`) plus curated deps (einops, ftfy, regex, imageio, descript-audiotools, pillow, safetensors). It imports and generates on numpy 2.x and diffusers 0.39, so MOSS's own pins (numpy 1.26.4, diffusers 0.37.1, transformers 4.57.1) are not needed.
- `descript-audiotools` declares `protobuf<3.20` and drags it down, which breaks onnx/onnxruntime. It works with protobuf 7.x, so the install needs a uv `--override protobuf>=6.31.1`. A constraints file cannot loosen another package's bound (§2.4 needs an overrides file).
- Weights are 11.2 GB. The DiT file is fp32 (5.7 GB), so `torch_dtype=bf16` still loads 10.6 GB. All-on-GPU: out of memory on the first step (peak 12.9 GB, Windows spilled into shared memory first).
- Works with stage-wise offload: load on CPU, cast only the DiT *parameters* to bf16 (`.to(bfloat16)` on the module also casts the complex RoPE `freqs` buffers and crashes in `rope_apply`), set `engine.device = cuda` and `engine.vram_management_enabled = True`. Result: 20 steps = 117 s (5.85 s/step), 176 s total for a 3.0 s clip, peak 5.86 GB of 6 GB, 48 kHz output. The default 100 steps would be about 10 minutes.
- The pipeline always denoises a fixed 30 s latent and crops, so a 3 s effect costs as much as a 30 s one. A time estimate in the UI is a constant per steps, not per duration.
- `TORCHDYNAMO_DISABLE=1` is required on Windows (module-level `torch.compile` with `triton.cudagraphs`). Set it in the backend, not optional (§7).
- Download was 41 minutes without `hf_xet`. Add `hf_xet` to the engine install list.
- Verdict for 6 GB / pre-Ampere users: MOSS runs but takes minutes per clip at the edge of VRAM. Say so on the Models page and point to the Lite engine (Stable Audio 3 Small) for those cards.

**ACE-Step** (step 3): `ace-step` on PyPI is 0.1.0 (the old 1.0 line) and pins `transformers==4.50.0`, which cannot coexist with Qwen. ACE-Step 1.5 is GitHub-only (`ACE-Step/ACE-Step-1.5`, version 1.5.0): pin a git commit instead of `ace-step==1.5.0` (§2.4). Its pyproject lists training/demo deps (gradio 6.2, peft, lycoris-lora, lightning, tensorboard, modelscope, nano-vllm) that the curated `--no-deps` install must skip.

Tested at commit `ca1e85fe` (2026-08-29) on the 1060, torch 2.7.1+cu126, numpy 2.x, diffusers 0.39, transformers 4.57.3, turbo DiT, 8 steps, instrumental, CPU offload on, no int8:

| Run | Load | Generation | Peak VRAM |
|---|---|---|---|
| 30 s, no LM | 58 s | 71 s | 4.91 GB |
| 30 s, 0.6B LM (PyTorch backend) | 76 s | 178 s (LM 61 s) | 5.21 GB |
| 120 s, no LM | 73 s | **failed**: ACE-Step's own 600 s generation timeout | 5.18 GB |

- Positive for short clips: 48 kHz stereo, no NaNs, normal levels. ACE-Step picks fp16 itself on pre-Ampere cards, and forces the PyTorch LM backend on pre-Volta GPUs, so no patching is needed.
- Installs with the repo on the path plus curated deps only: `loguru`, `einops`, `numba`, `vector-quantize-pytorch`, `scipy`, `toml`, `diskcache`, `pytorch-wavelets`, `pywavelets`. No PEFT, Lightning or gradio needed.
- **Limit for 6 GB / pre-Ampere cards:** clips of about 30 s work; 2 minutes does not finish in time with offload. The Models page must say so, and the app should cap duration on these cards. Longer songs need more VRAM (untested here).
- Weights: `ACE-Step/Ace-Step1.5` is 10.1 GB (turbo DiT 4.8, 1.7B LM 3.7, text encoder 1.2, VAE 0.3), not ~5 GB. The 0.6B LM is a separate 1.2 GB repo (`ACE-Step/acestep-5Hz-lm-0.6B`).
- Layout: ACE-Step expects `<project_root>/checkpoints/<name>/` and downloads into it on first use if missing. The backend should point it at the HF-cache snapshot folder of the main repo and link the 0.6B LM into it (Phase 4-5), so one copy serves the app.
- After MOSS and ACE-Step are installed, `pip check` warns about MOSS's exact pins (regex, safetensors, soundfile, tqdm, transformers). The packages work; the earlier "clean" result predates them.

Not run: ACE-Step vocals, int8 quantization, 180 s clips.

**Stable Audio 3 Small** (step 6): generation **not tested**. Both small repos are gated (`auto`) and this machine has no Hugging Face access (401 `GatedRepoError`), so the weights could not be downloaded. Optional and parked for v1.1 (Phase 9); it does not block Phase 1. Found without weights (repo commit `790793b`, 2026-11-02):
- The `stable-audio-3` code is **MIT**. The weights stay under the Stability Community License plus the gated step.
- Download per engine: model 2.3 GB + T5Gemma text encoder 1.2 GB.
- The package declares `transformers>=5.8.0` and `huggingface-hub>=1.7.1` (we pin 4.57.3 / 0.36.2) and `torch==2.7.1`. Its core only imports `T5GemmaEncoderModel`, `AutoTokenizer`, `AutoConfig`, `hf_hub_download` and `try_to_load_from_cache`, which all import in our venv. A `--no-deps` install is therefore plausible but unverified; the per-engine-venv fallback (§2.8) applies if it fails.
- To run the test later: log in to Hugging Face yourself, accept the terms on both model pages, then a short low-load run is enough.

**Go/no-go.** Any new engine that fails moves to the per-engine-venv fallback (§2.8). If Qwen3-TTS or Kokoro regress, stop and reassess.

**Phase 1: Runtime upgrade (ships on its own).** In `setup.rs`: Python 3.12, the torch version from Phase 0, the per-GPU index choice with the arch check, the overrides file for every install, one resolve for torch + engines, the runtime version marker and the "update runtime" screen. Update `backend/requirements.txt` (torch comment and command) and `backend/README.md`. This fixes RTX 50-series support even before any new feature ships.

**Phase 1 status (2026-11-07): code done, not yet run end to end.**
- `src-tauri/src/setup.rs`: Python 3.12; torch 2.7.1; torch build by compute capability (cu126 below 7.5, cu128 from 7.5, CPU wheel for Maxwell on Windows or no GPU, default wheel on macOS); `runtime-overrides.txt` (torch/torchaudio local pins + `transformers==4.57.3`) passed to every install; torch, the core packages and the engines (now including `kittenml==0.9.4`) in **one** `uv pip install`; after a CUDA install a self-test checks the arch list and runs a matmul, and swaps in the CPU wheel if it fails; `runtime_version` in the marker (`RUNTIME_VERSION = 2`); an older runtime is rebuilt in place (backend stopped, only the venv files wiped, ffmpeg/marker kept, `model_downloaded` kept, HF cache/voices/DB untouched, resumable because the version is recorded as soon as the new venv exists).
- `src-tauri/src/backend.rs`: refuses to start the backend while an update is pending; sets `PYTHONUTF8=1`.
- Setup screen: "Update the engine runtime" message and button, Python 3.12 and KittenTTS step texts. `backend/requirements.txt` and `backend/README.md` updated.
- Verified: `cargo check` and `tsc --noEmit` pass. `uv pip install --dry-run` into an empty Python 3.12 venv with the exact flags resolves 157 packages for cu126, cu128 and cpu, with the right torch wheel each time.
- **Not verified:** a real install through the app, the migration of an existing runtime, the macOS path, the CPU-wheel fallback on a card whose arch is missing. Running the app once on an old runtime performs the migration and re-downloads torch (about 2–3 GB).

**Phase 2: Shared plumbing.** `backends/device.py`, `_load_reference` moved to `utils/audio.py`, the three `Generation` columns, the new `ModelSpec` fields with the model-id-based active setting, `extra_files` download support, license tier badges on the Models page, unload-before-job and idle unload, the health `optional` flag.

**Phase 2 status (2026-11-07): code done and tested without models.**
- `backends/device.py`: `pick_device()` returns a `DevicePlan` (device, dtype, warning) for bf16 / fp16 / fp32 / MPS / CPU, caps CPU threads at 8, and `release_gpu_memory()`. `QwenBackend` now uses it (same behaviour: bf16 on Ampere+, fp32 below, SDPA unless FlashAttention is installed). `utils/audio.load_reference()` replaces `qwen_backend._load_reference`.
- `Generation` gained `kind` (default `speech`), `engine` and `params` (JSON text, exposed as an object). `_ADDED_COLUMNS` adds them to existing databases; `enqueue` fills `kind` and `engine` for speech.
- `ModelSpec` gained `variant`, `extra_files` (`ExtraFile(repo_id, filename, size)`), `optional_engine`, `license_tier`, `license_name`, `license_url`, `gated` and `source`. The three existing entries are tagged Apache 2.0 / open.
- The active model is stored **by model id** in `settings.json` (`active_models`). A repo id saved by an older build (`qwen_model`, `kokoro_model`) is still read and is replaced when the user picks a model. `VOICECRAFT_QWEN_MODEL` / `VOICECRAFT_KOKORO_MODEL` still win and may name a repo outside the catalog. `config.qwen_model_id()` / `kokoro_model_id()` are gone; use `catalog.active_repo_id(engine)`.
- Download state is per entry, not per repo (`model_service.spec_downloaded`): every `allow_patterns` pattern must match a file, every `extra_files` entry must be present, and an in-flight `.incomplete` blob means "not downloaded". Downloads fetch the extra files after the main repo and count them in the progress bar and the free-space check. Deleting an entry removes its repo (and with it any variant sharing the repo, which the UI says), then removes extra repos that no other downloaded entry needs.
- Scheduling in `generation_service`: before each job (speech and voice preparation share the queue) every other loaded engine is unloaded; an idle watcher unloads everything after `VOICECRAFT_IDLE_UNLOAD_SECONDS` (default 600, `0` disables) when nothing is queued or running.
- `GET /api/health` reports `optional` and `model_id` per engine, and the header skips an optional engine that isn't installed. The Models page shows a license chip (open stays plain, conditional is amber, non-commercial is red) and a license line.
- **(Superseded in Phase 8: links are clickable through a new `open_url` command.)** **License links are plain, selectable text.** The desktop shell grants only `core:default` and has no external-link opener, so an anchor would do nothing. Making them clickable needs a small Rust command or the opener plugin; do it with the About page in Phase 8.
- Tests: `backend/tests/test_plumbing.py` (61 checks: device selection with a patched compute capability, reference loading, id-based selection and the legacy fallback, variants sharing a repo, extras, `.incomplete`, deletion, kind/engine/params and the column migration on a database that had them dropped, health flags, unload-except, idle unload, pending-job accounting). `test_smoke.py` (57) and `test_timeline.py` (47) still pass; `tsc --noEmit` is clean. No weights were loaded and nothing touched the GPU beyond importing torch.
- **Not verified:** a real download with an `extra_files` entry (no catalog entry uses one until Kitten, Phase 3); the idle unload against a really loaded Qwen model; the Models page rendering in the running app.

**Phase 3: KittenTTS 2.** Everything in Appendix A. Ships as a normal speech engine.

**Phase 3 status (2026-11-07): code done and tested without the real model.**
- `backends/kitten_backend.py`: `KittenBackend` (`kitten`, cloning, not optional), registered in `_REGISTRY`; `Engine.kitten`. It loads from the local snapshot with `local_files_only=True` (a missing download says "get it from the Models page" and never fetches), uses the catalog entry's `variant` as `weights=`, and keeps the weights exactly as published: bf16, no config patch (Phase 0 showed fp32 fails and bf16 is fine on Pascal). CPU runs carry a "~15x slower than real time" warning on the generation.
- Deviations from Appendix A, all from Phase 0/2 findings:
  - **115 presets, not 47.** `KITTEN_PRESET_VOICES` is bundled so the form works before the download; `preset_voices()` reads the downloaded model's `voices.json` (as UTF-8) when there is one, and `load()` warns if the two differ.
  - **No `config.kitten_model_id()` / env override and no `SETTING_KEY` entry.** The variants share one repo, so the choice is the model id in `active_models` (Phase 2). A repo-id override could not say which variant it meant.
  - **No temporary mono WAV.** kittenml loads clips through librosa, so the stored sample is passed as is. The voice print is an `.npz` of `version`, `model_id`, `embedding`, `reference_tokens`, `transcript`, `sample_path` (`np.savez`, `allow_pickle=False`).
  - **Options travel in `VoiceSpec.options`**, filled from the generation's `params` (`preset`, `seed`), rather than new `VoiceSpec` fields per engine. Only Kitten profiles record them.
  - `PYTHONUTF8=1` was already set by `backend.rs` (Phase 1).
- Profiles: a Kitten profile is a clone (sample + **required, trimmed** transcript, so Whisper is never downloaded; the backend re-checks) or a preset, never both. `voice_service.is_clone` replaces the `supports_cloning` checks, so a preset profile is `not_needed` and never queues extraction. `GET /api/profiles/voices?engine=` returns Kokoro's, Kitten's or (Qwen) an empty list; Kokoro stays the default for old clients.
- Catalog: `kitten-tts-2` (default, `packed`, ~1.05 GB) and `kitten-tts-2-emb4` (~0.56 GB), both conditional / Stellon Labs Community License with its link, the chatterbox-turbo vocoder as an `extra_files` entry (~1.06 GB, shown in the estimate and the free-space check), and `allow_patterns` that skip the `cpp/` GGUF bundle and the other weight packings. "Powered by KittenML" is on the Models entry; **Settings → About was added in Phase 8.**
- UI: Profiles has Kitten with a Clone / Preset toggle (transcript required in Clone mode, language field hidden because the model follows the text); Generate shows Style (Stable / Expressive), an optional seed (up to 9 digits), the tag hint, the CPU warning, and replaces the speed slider with a note (Kitten has no speed control); Settings lists Kitten as a default engine.
- Tests: `test_kitten.py` (59 checks against a fake model: argument forwarding, voice-print round trip and reuse, stale/corrupt prints, no-transcript refusal before any model work, catalog and download state with the vocoder). `test_plumbing.py` 72, `test_smoke.py` 75, `test_timeline.py` 47 pass; `tsc --noEmit` is clean. `test_generate_kitten.py` is written and skips itself without kittenml and weights.
- **Not verified:** anything that loads the real model through the app. The app's runtime is still the old Python 3.11 one (no kittenml), so `test_generate_kitten.py` skipped here; verification steps 2 and 3 of Appendix A (real-time factor in the README table, clone → restart → reuse, no Whisper download) wait for the Phase 1 runtime migration. The private-API voice-print reuse is covered against a fake only. The spike did run the real `generate(reference=...)` path on the 1060.

**Phase 4: Audio backend.** `AudioBackend`, `/api/generations/audio`, `/api/audio-engines`, the `?kind=` filter, catalog entries for music and SFX. Tests use a fake `AudioBackend` that writes a sine WAV, so CI needs no models.

**Phase 4 status (2026-11-07): code done and tested without models.**
- `backends/base.py`: `AudioSpec`, the `AudioBackend` protocol (§5.2) and a `Support` result. **Added to the protocol:** `support()`, because what a machine can run is engine-specific (a 30 s cap for ACE-Step on 6 GB, a VRAM floor for MOSS), and the API must refuse an over-long clip instead of letting the job hit the engine's own timeout.
- `backends/audio_engines.py`: `AceStepBackend` (`acestep`, music) and `MossSfxBackend` (`moss_sfx`, sfx) on a shared base (lifecycle, `find_spec` availability, unload). `support()` encodes the Phase 0 numbers: no CUDA → unsupported; under ~5.5 GiB VRAM → unsupported; ACE-Step capped at 30 s with a warning under 8 GB or without bf16, 600 s otherwise (untested above the 1060); MOSS warns "minutes per clip" under 12 GB, cap 30 s. `devices.hardware()` is the one GPU probe.
- **(Superseded: MOSS got real calls in Phase 6, ACE-Step in Phase 7.)** The adapters did not call the models yet. `_load` / `_generate` raised `BackendUnavailable` ("installed, but this build can't run it yet"). The packages can't be installed through the app before Phase 5, and the import names (`acestep`, `moss_soundeffect_v2`) are unconfirmed. The real calls belong to Phase 6 (MOSS) and Phase 7 (ACE-Step), where they can be checked against the real models.
- **One registry for all engines.** Audio engines live in the same `_REGISTRY` as speech, so unload-before-job, the idle unload and `unload_except` needed no change and see the heaviest models. `GET /api/health` therefore lists them with `optional: true` (the header already skips an optional engine that isn't installed). `ModelOut.engine` is now a plain string.
- `generation_service`: `_run_job` became a thin wrapper over `_execute`, which `run_audio_job` shares: same status writes, ffmpeg transcode and failure cleanup. `list_generations` takes `kind`.
- `services/audio_service.py` and the routes. **Deviation from §5.3:** `POST /api/generations/audio` always returns a **list** of rows (one for music, `takes` for SFX), not a single row. Refusals, in the order a user can fix them: unknown engine / wrong kind (400); not installed, weights not downloaded, unsupported hardware (409, each says what to do); clip over this machine's limit (400). Request validation (422): SFX ≤ 30 s, no lyrics on SFX, several takes only for SFX, music ≤ 600 s, seed/steps/guidance ranges. With a fixed `seed`, take *i* uses `seed + i` and the row records it. Files are named from the first four words of the prompt.
- Catalog: categories `music` and `sfx`; `acestep-1.5-turbo` (default, whole `ACE-Step/Ace-Step1.5` repo, 10.09 GB), `acestep-1.5-sft` (4.79 GB DiT) and `acestep-1.5-xl-turbo` (19.95 GB), and `moss-sfx-v2` (11.23 GB). Sizes and file lists were read from the Hugging Face API (metadata only). The sft and XL repos hold only a DiT, so they list the VAE and text-encoder files of the turbo repo as `extra_files` (~1.5 GB). The 0.6B LM repo is not an entry yet.
- Two fixes this needed in `model_service`: turbo has explicit `allow_patterns`, so files another entry borrowed into its repo can't make it look downloaded; deleting an entry whose repo another downloaded entry borrows from is refused ("delete it first"); and the borrowed-files cleanup now asks `spec_downloaded` (not "any file exists") so a half-borrowed repo doesn't leak 1.5 GB.
- Frontend: `AudioEngine` type, `api.listAudioEngines`, `api.generateAudio`, `api.listGenerations(limit, kind)`. No UI yet (Phases 6 and 7). `tsc --noEmit` is clean.
- Tests: `backend/tests/test_audio.py` (97 checks: catalog and shared-file downloads, the hardware rules against patched GPUs, the honest-stub behaviour, and the whole API against a fake sine engine: readiness refusals, validation, takes and seeds, lyrics, mp3 transcode, failure cleanup, unload both ways, `?kind=`). `test_plumbing` 72, `test_smoke` 79, `test_kitten` 59, `test_timeline` 47 still pass. Breaking the unload-before-job line makes three checks fail. No weights, no CUDA initialisation, nothing downloaded.
- **Not verified:** any real ACE-Step or MOSS call (see above); the sft / XL / MOSS downloads (the catalog was checked against API metadata, not by downloading); whether the shared-file layout works for ACE-Step's `checkpoints/` expectations (Phase 5/7: point it at the HF snapshot and link the LM); the 0.6B LM is untested through the app.

**Phase 5: Engine install flow.** `install_audio_engine` in `setup.rs`, the Models page "Install engine" step with streamed progress, and uninstall (remove the engine's packages and weights).

**Phase 5 status (2026-11-07): code done; the real install has not been run.**
- `src-tauri/src/setup.rs`: an `AudioEngineSpec` table (ACE-Step, MOSS) and `run_engine_job` (install / uninstall). An install writes the shared overrides file, runs **two** `uv pip install` calls (the curated dependency list, then the engine package with `--no-deps`) and finally imports the module, so a broken install fails now and not on the first generation. Uninstall removes only the engine's own package (`ace-step`, `moss-soundeffect-v2`); its small dependencies are shared and stay.
- **Pinned source archives, not `git+https`.** Both engines install from `https://github.com/<repo>/archive/<full commit>.zip` (MOSS with `#subdirectory=moss_soundeffect_v2`). This keeps the app dependency-free: a clean machine has no git, and a git URL would fail there. Commits are the ones the spike ran (ACE-Step `ca1e85fe…`, MOSS `934d6826…`). A Rust test checks that both pins are full 40-digit commits and that no engine list names torch.
- **Confirmed from the spike's venv:** the import names are `acestep` (hatchling wheel of the `acestep` and `openrouter` packages, project `ace-step`) and `moss_soundeffect_v2` (class `MossSoundEffectPipeline`, API as in `spike_moss.py`). The stub adapters can now use them in Phase 6/7.
- MOSS gets an extra override file for its install only (`protobuf>=6.31.1`, §Phase 0); `hf_xet` is in both lists (the 41-minute MOSS download). `TORCHDYNAMO_DISABLE=1` is set for the import check; **setting it for real runs is part of the Phase 6 adapter**, which is where MOSS is first called.
- **The backend is stopped for the job and started again afterwards**, whatever the result. It has torch, onnx and protobuf loaded, and Windows won't let uv replace a `.pyd` that's in use. A generation that is running is interrupted (the confirm dialog says so; the next start marks it failed). One install at a time: it shares the setup lock with first-run setup.
- Refuses on a runtime that is outdated or has no recorded torch build, so on today's Python 3.11 runtime it says "needs its own update first" instead of installing next to torch 2.5.1.
- Events: `setup:log` (same lines as first-run setup) and a new `engine:state` (`running` → `done` | `failed`, the final one sent after the backend restart). Commands `engine_install` / `engine_uninstall`, wrapped as `setupApi.installEngine` / `uninstallEngine`.
- UI: `components/EnginePanel.tsx` above the Music and Sound-effects lists on the Models page. It shows installed / not installed / "can't run here" (with the reason from `/api/audio-engines`), the hardware warning and the clip cap, a confirm dialog with the download note, a log tail while it runs, and the failure message. Install is disabled for hardware that can't run the engine and outside the desktop app. After a job it polls until the backend answers again.
- Checked without installing anything: `cargo check` and 3 `cargo test` checks, `tsc --noEmit` clean, and `uv pip install --dry-run` of both source archives (`--no-deps`) and both dependency lists, with the shared overrides plus MOSS's extra file, into an empty Python 3.12 venv. All resolve (the MOSS list resolves protobuf 7.36 and torch 2.7.1+cu126 from the override).
- **Not verified:** a real install, uninstall or import in the app. That needs the Phase 1 runtime migration (re-downloads torch, 2–3 GB) first. Also unverified: that `uv` replaces `protobuf` while nothing holds it (the backend is stopped, but a stray Python process could); how the log reads in the live UI; navigating away from the Models page mid-install (the job continues, the page forgets it; a second click shows "Another install is already running").

**Phase 6: Sound FX mode.** The segmented control in `Generate.tsx`, the SFX form, the install card, type icons in the session panel. SFX goes first because its form is simpler.

**Phase 6 status (2026-11-07): code done and tested against a fake pipeline; the real MOSS call through the app has not been run.**
- `backends/audio_engines.py`: `MossSfxBackend` now makes real calls. `_load` reads the snapshot from the HF cache **offline** (`local_files_only=True`; a missing download says "get it from the Models page"), switches `torch.compile` off, loads `MossSoundEffectPipeline.from_pretrained(snapshot, torch_dtype=bf16, device="cpu")`, casts only the DiT's parameters to bf16, then sets `engine.device = cuda` and `engine.vram_management_enabled = True` (the Phase 0 recipe). `_generate` calls `pipe(prompt, seconds, num_inference_steps, cfg_scale, seed)`, takes `audio[0, 0]`, refuses NaN output, and writes a mono 48 kHz WAV with `soundfile`. Defaults: **20 steps** (the card's 100 would be ~10 minutes on the 1060), guidance 4, a random seed when none is given; the length is clamped to 30 s.
- **`TORCHDYNAMO_DISABLE=1` is set by the adapter**, in the environment and as `torch._dynamo.config.disable`, because the backend has usually imported torch before MOSS is loaded and the variable alone is only read at torch's first `_dynamo` import. The side effect is that `torch.compile` is off for the rest of that backend process; no other engine here uses it.
- **One recipe for every card.** The offload recipe is the only one that was run (all-on-GPU ran out of memory at 12.9 GB). A 24 GB card would probably be faster all-on-GPU, but that is untested, so every card gets the tested path. `support()` still warns only below 12 GB.
- UI: **Voice | Sound FX** segmented control on the Generate page (the last mode is remembered in `localStorage` through `lib/remember.ts`, wrapped so blocked storage can't break the page). **Music was added to the control in Phase 7.** Switching modes keeps the script you wrote (the voice form is hidden, not unmounted).
- `components/SoundFxForm.tsx`: before the form it checks the engine, in the order a user can fix it, and shows a card instead of the form for: backend without the engine, hardware that can't run it (with the reason), engine not installed (button to the Models page), weights not downloaded (button to the Models page). The form has the description, four example phrases, a length slider (1–30 s, capped to this machine's limit), takes (1–4), the format, and an "Advanced" fold with seed, steps and guidance.
- **Time estimate** ("Roughly N minutes on a 6 GB GPU, measured on a GTX 1060") is shown only when the engine reports the offloading warning: 5.85 s per step × steps × takes + ~60 s for the load. On any other card it would be a guess, so there is no number there.
- Session panel: every row has a kind icon (`components/KindIcon.tsx`: voice / music / effect; `TrackRow` got an optional `leading` slot), the voice name is shown for speech only, and the empty text covers both modes. The nav hint now reads "Voice and sound effects".
- Tests: `test_audio.py` has 22 new checks (119 in total) against a fake pipeline that has the real signatures (read from the package in the spike's venv): no CUDA refuses, missing weights refuse without loading, the cache is read offline for the catalog's repo, the load is on the CPU as bf16, only DiT parameters are cast, the engine gets CUDA + offload, torch.compile is off, defaults and explicit seed/steps/guidance reach the pipeline, a mono 48 kHz WAV of the right length, clamping at 30 s, NaN is an error, unload drops the pipeline, and a failing offload step leaves the engine unloaded. `test_plumbing` 72, `test_smoke` 79, `test_kitten` 59 and `test_timeline` 47 still pass; `tsc --noEmit` is clean.
- **Not verified:** a real MOSS generation through the app. It needs the Phase 1 runtime migration, the Phase 5 engine install and the 11 GB model download first. Also unverified: that the fake's signatures still match the commit the app installs (`934d6826`; they were read from the spike's copy of the same commit), what the form looks like in the running app, whether the 16-bit WAV that `soundfile` writes (its default for float input, after clipping to ±1) sounds right next to the speech clips, and whether 20 steps sound acceptable (the spike measured time, not quality).

**Phase 7: Music mode.** Music form (style, instrumental/vocals, lyrics, duration, quality preset) and a time estimate from Phase 0 numbers.

**Phase 7 status (2026-11-07): code done and tested against a fake `acestep` package; no real song has been generated through the app.**
- `backends/audio_engines.py`: `AceStepBackend` now makes real calls, following `spike_ace.py`: `AceStepHandler().initialize_service(project_root, config_path="acestep-v15-turbo", device="auto", offload_to_cpu=True, offload_dit_to_cpu=True)`, then `generate_music(dit, None, GenerationParams(thinking=False, caption, lyrics, instrumental, duration, inference_steps, guidance_scale, seed), GenerationConfig(batch_size=1, audio_format="wav", seeds=[seed]), save_dir)`. The result's WAV is moved to the job's output path. **One recipe for every card**, as with MOSS: it is the only one that ran (30 s instrumental: 71 s generation, 58 s load, 4.9 GB peak).
- **The language model stays off** (`thinking=False`, no LM handler). The spike's 0.6B LM added 107 s to a 30 s clip, and it is a separate 1.2 GB repo that has no catalog entry. The 1.7B LM is inside the turbo download, but it was never run on a small card, so it is not offered either. A "plan with the language model" option is a later addition, not part of v1.
- **Defaults per model** come from the adapter and reach the forms through two new fields on `GET /api/audio-engines` (`default_steps`, `default_guidance`; MOSS 20 / 4, ACE-Step turbo 8 / 1, sft 50 / 7 from ACE-Step's own table; turbo ignores guidance). Only turbo was run; sft and XL are unmeasured.
- **A private checkpoint folder.** ACE-Step wants `checkpoints/<name>/` and rewrites `.py` files in a model folder on start-up when they differ from its own copies, so pointing it at the Hugging Face cache would let it write into the cache. `backends/checkpoint_stage.py` builds `%LOCALAPPDATA%/VoiceCraft/engines/acestep/checkpoints` instead: the VAE and the text encoder are one directory link each (a junction on Windows, which needs no privileges — checked here), the DiT folder is a real directory (small files copied, weights linked: symlink, else hard link, else copy). On this Windows machine file symlinks are refused and hard links work, but **a hard link needs the models folder and the app data on the same drive**; across drives the 4.8 GB DiT file is copied once. A marker rebuilds the folder if the models folder moves, and **deleting a music model on the Models page removes the folder** (`model_service._forget_staged`), so hard links never keep a deleted model alive. `ACESTEP_CHECKPOINTS_DIR` is set explicitly so a stray value in the user's environment can't redirect the engine.
- **No download from inside a job.** ACE-Step's own start-up fetches missing weights from the internet; the adapter replaces that one step (`_ensure_models_present`) with a no-op, so a missing piece fails with the engine's message and a job can never turn into a 10 GB download. This reaches into a private method of the pinned commit (`ca1e85fe`); the test fails if the fake notices a download.
- **Request rules for music** (`models.py`, from ACE-Step's documented ranges): at least 10 s, a style of at most 512 characters, lyrics of at most 4096. The adapter also clamps to 10–600 s and flags a nearly silent result (peak < 0.01) as a warning on the row. NaN output is an error, but only a float WAV can hold NaN; in a 16-bit file it shows up as silence, which the same warning catches.
- Install check (`setup.rs`): the engine now has to import `acestep.handler` and `acestep.inference`, the two modules the adapter uses, so a missing dependency fails the install and not the first song. (String change only; the Rust side was not rebuilt.)
- UI: the Generate control is now **Voice | Music | Sound FX**. `components/EngineGate.tsx` is the install / unsupported / not-downloaded card, shared by both prompt modes (it was inside `SoundFxForm`). `components/MusicForm.tsx`: style (512-character counter, four examples), **Instrumental / With lyrics** (the lyrics box appears for the second, with a hint about `[verse]` / `[chorus]` tags, and Generate stays off while it is empty), a length slider from 10 s to this machine's limit (30 s on a small card), format, an Advanced fold (seed, steps, guidance; guidance is greyed out for turbo), and a line saying which model is used and that it changes on the Models page.
- **Time estimate** ("Roughly N including loading the model, on a 6 GB GPU, measured on a GTX 1060, instrumental") is shown only on an offloaded card **and** for the turbo model: 60 s load + 71 s × (length / 30) × (steps / 8). That is the one measured point scaled linearly, so it is only good near 30 s and 8 steps. No number for sft or XL (never run), none for other cards.
- **Deviations from the plan.** No "Quality preset" select: the quality choice already exists as the model on the Models page (turbo / quality / XL), and a second control for the same thing would let the form and the Models page disagree. No Engine select (one music engine until Phase 9).
- Tests: `test_audio.py` is at 175 checks (was 119). New: staging (13: reads through a link, restage keeps the engine's own edits and never touches the cache, a moved cache rebuilds, clearing never follows a link into the cache) and the adapter against a fake `acestep` package with the real signatures (36: cache read offline, the Phase 0 recipe, a private folder holding DiT, VAE and text encoder, nothing downloaded even when a piece is missing, instrumental vs. vocals, seed/steps/guidance forwarded, clamps, silent and NaN output, a failed run surfaces the engine's reason, sft folder and defaults, a failed start leaves nothing loaded); plus the request limits, the new default fields and the delete hook. `test_plumbing` 72, `test_smoke` 79, `test_kitten` 59, `test_timeline` 47 still pass; `tsc --noEmit` is clean.
- **Not verified:** any real song through the app (needs the Phase 1 runtime migration, the engine install, and the 10 GB download). **Vocals have never been run**, on any card, with or without the language model; the form offers them because the engine documents them. Also unverified: that the fake's signatures match the commit the app installs (read from the spike's copy of `ca1e85fe`); that the engine accepts the private folder and the hard-linked weights on a real run (the junction and hard-link calls were checked on this machine, not the engine reading through them); that a 16-bit WAV from `generate_music(audio_format="wav")` is what it writes; sft and XL on any card; and what the form looks like in the running app.

**Phase 8: Integration.** Library type filter, Editor Media Bin check, About attributions, README sections and engine tables.

**Phase 8 status (2026-11-07): code and docs done; the Rust change is not compiled and nothing was run in the app.**
- **Library:** a Type select (All types / Voice / Music / Sound FX) in front of the voice select. The voice select is hidden, and its value ignored, unless Type is All or Voice. Each row has the kind icon. "deleted voice" now only appears for speech rows whose profile is gone; music and SFX rows never have a voice line. The NC chip stays with Phase 10 (no NC tier exists yet).
- **Editor Media Bin:** the check found no `profile_id` filter, so music and SFX already appeared, but `MediaContext` labelled every generation `voice`. It now keeps `music` / `sfx` as kinds, the bin shows a "music" / "sound fx" badge, and the filter select has Music and Sound FX entries.
- **Clickable links:** new Rust command `open_url` (`lib.rs`) opens a link in the default browser (explorer / open / xdg-open) and accepts only `https://` URLs without whitespace (`checked_url`, with a unit test). No opener plugin was added, so `capabilities/default.json` is unchanged. Frontend: `openExternal` in `lib/tauri.ts` (falls back to `window.open` in a plain browser) and `components/ExternalLink.tsx`. The Models page license link now uses it (the Phase 2 note above that said "plain text" is superseded).
- **About:** a new section at the bottom of Settings, data in `app/src/lib/attributions.ts`: Qwen3-TTS, Kokoro, KittenTTS 2 ("Powered by KittenML", Stellon Labs license link), ACE-Step 1.5 and MOSS-SoundEffect v2, each with license and model-page links. "Powered by Stability AI" waits for Phase 9. `test_audio.py::test_attributions` fails if a catalog license link, a repo link or the KittenML credit goes missing.
- **README:** Python 3.12 and the Engine setup wording, the Generate Music / Sound FX modes, Library type filter and Editor media bin, a "Music and sound effects" section with the install steps and the one measured table (GTX 1060: ACE-Step turbo 30 s in ~70 s, MOSS ~3 min per clip; quality, XL and vocals marked as not run), a Models table with every catalog entry (size, license), the KittenML credit, and the NVIDIA-only note.
- Checks: `test_audio` 180 (was 175), `tsc --noEmit` clean.
- **Not verified:** that `open_url` compiles or opens a browser (Rust not built here; the rest of the shell was last built before Phase 5); how the Library filter row, the Media Bin select and the About section look in the running app; the README's sizes are the catalog's, not re-downloaded.

**Phase 9: Lite engines (v1.1).** Stable Audio 3 Small for music and SFX: the engine selector in both forms, the gated-download flow (token field, license acceptance, token storage), "Powered by Stability AI" and the license text in About, and the engine fallback on the install card.

**Phase 9 status (2026-11-07): code and docs done and tested against fakes; the model has never run, on any machine.**
- **Why it's untested:** both repositories are gated and this machine has no Hugging Face access, so there are no weights. The adapter was written against the library's source (the spike's copy, commit `790793b8…`), not against a run. Whether the real model loads, sounds right, or how fast it is on the 1060 or a CPU is unknown, so the forms show **no time estimate** for it.
- **Two engines, one package:** `sa3_music` and `sa3_sfx` (`backends/sa3_engines.py`), registered like the others. The roadmap's single `sa3_small` name was split because the registry keys engines by what they make. One `stable-audio-3` install serves both, and the Models page says so before installing or removing it. Rust: two `AudioEngineSpec` rows with the same pinned archive (`Stability-AI/stable-audio-3` at `790793b8…`, `--no-deps`; the runtime keeps transformers 4.57.3 rather than the package's declared `>=5.8`). Checked: the archive URL answers 200, `uv pip install --dry-run` resolves the dependency list (`einops`, `packaging`, `safetensors`, `tqdm`, `soundfile`, `hf_xet`) and the source, and the package and `StableAudioModel.generate`'s signature import in the Phase 0 venv.
- **Offline loading.** `StableAudioModel.from_pretrained` downloads on every call and its text encoder fetches a second repository, so the adapter rebuilds what it does (read `model_config.json` → `load_diffusion_cond` → `StableAudioModel`) from the cache, with the config's text-encoder entry pinned to the local folder in memory (the file is never rewritten). fp16 on compute capability ≥ 7, fp32 on Pascal (a guess: half precision is slow there), fp32 on CPU. `model.generate(prompt, duration, steps, cfg_scale, seed, batch_size, sample_size)` with the config's own `sample_size`; stereo 44.1 kHz output written with `soundfile`; defaults 8 steps / guidance 1 (post-trained checkpoints ignore guidance). Music is capped at the checkpoint's 120 s, effects at the app's 30 s.
- **The text encoder is a second download, read from the config.** Which repository it is (`repo_id` / `model_name` / a `subfolder`, default `google/t5gemma-b-b-ul2`) sits in the gated `model_config.json`, which could not be read here. `backends/sa3_files.py` reads it at run time (the key path comes from the library's `factory.py`); `ModelSpec.companion` makes the Models page download it after the model, count it in the size and the free-space check, require it for "downloaded", and delete it with the last entry that uses it. If that repository is itself gated (Google's Gemma terms are the likely case), the failure names it and says to accept its terms.
- **Gated downloads.** `services/hf_token.py` + `GET/PUT/DELETE /api/models/hf-token`: write-only (status is `{configured, source}`), stored in `<data dir>/secrets/hf_token` with owner-only permissions where the OS has them, never in the database or `settings.json`, never logged or returned. A token from the user's own Hugging Face login is used when the app has none. Downloading a gated entry without a token is refused up front with the steps; a 401/403 mid-download is turned into the same steps naming the repository. The token is sent only with gated entries, so a stale one can't break a public download. UI: `HfTokenField` in a "Hugging Face access" section on the Models page (shown when any model is gated) and on the install card of a gated engine; Download is disabled until a token exists.
- **Engine selector and fallback.** Music and Sound FX forms now take the whole list of engines of their kind. They pick the last choice if still ready, else the first ready one, else the default if this machine can run it, else the first engine it *can* run (on a PC without NVIDIA that is Stable Audio 3, with a note on the card saying why ACE-Step/MOSS was passed over). An **Engine** select appears when two engines are ready, and the choice is remembered per kind in `localStorage`. The music form hides "With lyrics" for an engine that can't sing (the API also refuses lyrics for it with a 400), clamps the length to the engine's limit when it changes, and greys guidance out for distilled models. A bug this exposed: the Sound FX time estimate was keyed on "the engine has a warning", which would have shown MOSS's 5.85 s/step on a Stable Audio CPU run; it is now MOSS-only.
- **About:** "Powered by Stability AI" and the Community License link, one entry per model with its model-page link (`attributions.ts`; `test_attributions` covers both repos and the credit). The license is **linked, not reproduced**: VoiceCraft doesn't distribute the weights, and Phase 8 handled Stellon Labs' identical clause the same way.
- Tests: new `backend/tests/test_sa3.py` (123 checks): the config reading, the token store (shape checks, never echoed, precedence of app token over a login), the catalog entries, the full download flow against a fake hub (no token → refused before any request; the encoder's own gate; the model's own gate; success; shared encoder kept until the last entry goes; subfolder encoder; config without an encoder; token not sent to a public repo), the adapter against a fake `stable_audio_3` with the library's signatures (offline reads, pinned config and the file untouched, per-GPU precision, defaults, clamps, lyrics refused, silent and NaN output, unload), and the API (token routes, engine list, lyrics refusal, wrong kind, not installed). Updated for the new engines: `test_audio` 183 (was 180), `test_smoke` 79, `test_plumbing` 72. `test_kitten` 59 and `test_timeline` 47 unchanged. `tsc --noEmit` is clean.
- **Not verified:** any real Stable Audio 3 run (load, speed, sound, fp16/fp32 behaviour on Pascal, the CPU path, whether the tokenizer loads from a local folder without extra packages); what `model_config.json` really names as the text encoder and whether that repository is gated; that the 3.5 GB estimate matches the real download; `cargo check` / `cargo test` of the two new engine rows (nothing was built, to spare the machine); how the token field, the engine select and the fallback note look in the running app; that the install check import (`stable_audio_3.model, stable_audio_3.loading_utils`) passes in the real runtime (it did in the spike's venv, which has no `einops-exts`, so that package is not needed).
- **Still open from §7:** whether a free open-source app that downloads Stability's weights counts as a "Commercial Purpose" under the Community License. Per the standing decision there is **no vendor outreach**; the app shows the license tier and link and the user accepts Stability's terms themselves on the model page.

**Phase 10: Later.** Stable Audio 3 Medium (Ampere+), HeartMuLa, the Non-commercial tier with its toggle and **NC** chips, audio-to-audio / inpainting UI ("extend", "replace this section"), macOS via Stable Audio 3's MLX/CoreML runtimes.

---

## 7. Risks and open questions

**Runtime**
- **Shared-env fragility.** One engine's upgrade can break another. Mitigations: every engine pinned, one overrides file owned by `setup.rs`, and the Phase 0 regression check re-run whenever a pin changes.
- **Untested combinations.** Kitten is only resolver-checked on Python 3.11. ACE-Step and Stable Audio 3 have never been run next to Kitten. MOSS has never been run on torch 2.7.1 or numpy 2.x.
- **Stuck on transformers 4.57** until `qwen-tts` supports 5.x. A future engine that needs transformers 5 goes to the per-engine-venv fallback.
- **Runtime migration** re-downloads torch (~2–3 GB) for every existing user once. It must be resumable and must never touch `voices/`, the database or the HF cache.
- **Disk.** One torch install for everything. Added cost per engine is its Python deps plus weights (Kitten 0.5–0.9 GB, ACE-Step turbo ~5 GB, XL ~9 GB, MOSS TBD). The Models page shows sizes before installing.
- **Triton / torch.compile on Windows** may fail or be slow for MOSS. Fallback: always set `TORCHDYNAMO_DISABLE=1` on Windows.

**KittenTTS**
- **Pascal and bf16.** The fp32 path on the 1060 is unverified. It may be slow or fail; CPU is the fallback.
- **Private API.** Voice prints depend on underscore-prefixed kittenml internals. A version bump can break them; the pin and the plain-`generate` fallback cover this.
- **Hidden downloads.** Whisper large-v3 (if the transcript is missing) and the chatterbox-turbo vocoder file. Both are handled (§4) but need tests.
- **License: Conditional, not blocking** (§1.2). Open items: registration with Stellon Labs, whether the integrated-product exemption covers VoiceCraft's users, and the non-public AUP (possible voice-cloning consent rules). The license is revocable, and above $1M revenue or funding it terminates.

**Music and SFX**
- **macOS.** MOSS documents only CUDA. ACE-Step uses MLX on Apple Silicon, not PyTorch/Metal. v1 targets Windows/Linux + NVIDIA. Stable Audio 3 Small has MLX, CoreML and TFLite runtimes and is the likely first macOS engine, but those runtimes live outside the PyTorch venv, so packaging is open.
- **Licensing passes through to users** (§1.1). Open question: does a free open-source app that downloads Stability weights count as a "Commercial Purpose" under the Community License? Ask Stability before shipping Phase 9.
- **Gated downloads.** Stable Audio 3 repos require a Hugging Face account, accepted terms and a token. The token must be stored safely, and the error for a missing or unaccepted license must say what to do.
- **Survey quality.** HeartMuLa VRAM, DiffRhythm 2, AudioLDM 2 and HunyuanVideo-Foley licenses and LeVo come from secondary pages. None of them is in v1.
- **Fast-moving field.** Several model families appeared in the last six months. Keep the catalog data-driven (one `catalog.py` entry plus one backend class per engine).
- **Long music jobs have no progress.** A `progress` column fed by the engines' step callbacks is a nice-to-have after v1.
- **Takes.** N SFX variations run one after another. Batch generation in one call would be faster if MOSS supports it; check in the spike.

---

## Appendix A: KittenTTS 2, file by file

Runtime and dependency changes are covered by Phase 1 (§2). What remains:

**Backend engine: `backend/backends/kitten_backend.py` (new).** A `KittenBackend` class with `name = "kitten"` and `supports_cloning = True`, modelled on `qwen_backend.py`:
- `available()`: `find_spec("kittenml")` and `find_spec("torch")`.
- Device: `pick_device(wants_bf16=True, supports_mps=False)` from §3.1.
- `load()`: resolve the repo from `config.kitten_model_id()`. Read the `weights` variant from the catalog entry (`packed` or `emb4`). Construct through `kittenml.KittenTTS(repo, device=..., weights=...)`. For fp32, construct `KittenTTS2` with a config copy that sets `dtype="fp32"`.
- `prepare_voice()`: for cloned profiles, compute `embedding = m.speaker_encoder(path)` and `tokens = m.codec.encode_reference(path)`. Write an `.npz`-style payload to `out_path` containing `version`, `model_id`, `embedding`, `reference_tokens`, `transcript` and `sample_path`, using `np.savez` (no pickle). Seed `m._reference_cache` with the result. Return a `VoicePrint(mode="icl", ...)`. Run `_load_reference` from `utils/audio.py` first, and write a temporary mono WAV, because kittenml takes a path.
- `synthesize()`: for preset profiles, `m.generate(text, voice=preset, preset=..., advanced={"seed": ...})`. For cloned profiles, rebuild the reference from the voice print through `_build_reference` and inject it into the cache under the `("clone", resolve_reference_path(wav), transcript)` key, then `m.generate(text, reference=path, reference_text=transcript)`. `preset` and `seed` come from the job's `params`. Write with `soundfile` at `m.sample_rate`.
- `unload()`: drop the model and call `torch.cuda.empty_cache()`.
- Export `KITTEN_PRESET_VOICES`, a static list of the 47 names copied from `docs/voices-and-expression.md`, so the profile UI works before the weights are downloaded. Cross-check it against `m.available_voices` at load time.
- Register it in `backend/backends/__init__.py` under `_REGISTRY["kitten"]`.

**Config, catalog, models.**
- `backend/config.py`: `DEFAULT_KITTEN_MODEL_ID = "KittenML/kitten-tts-2"` and `kitten_model_id()`, which reads `VOICECRAFT_KITTEN_MODEL`, then the `kitten_model` setting, then the default. This mirrors `kokoro_model_id()`.
- `backend/catalog.py`: the two Kitten entries from §3.3 with `engine="kitten"`, `clones_voices=True`, `variant`, `allow_patterns` and `extra_files`. Add `"kitten": "kitten_model"` to `SETTING_KEY` and a branch in `active_repo_id`.
- `backend/models.py`: `Engine.kitten = "kitten"`.

**Profiles and voice preparation.**
- `backend/services/profile_service.py`: a Kitten profile is either a clone (sample + **required** `sample_text`) or a preset (`preset_voice` from `KITTEN_PRESET_VOICES`), never both. `voice_status` is `pending` for clones and `not_needed` for presets. Generalize the current `Engine.qwen` / `Engine.kokoro` branches into a capability check (`backend.supports_cloning` plus "has a preset list").
- `backend/routes/profiles.py`: `/api/profiles/voices` takes `?engine=` and returns Kokoro's or Kitten's preset list.
- `backend/services/voice_service.py`: no logic change (engine-agnostic through `get_backend`); update the docstring.
- `backend/database/models.py`: no profile schema change; `engine` is already `String(32)`.

**Frontend (`app/src`).**
- `lib/types.ts`: `Engine = "qwen" | "kokoro" | "kitten"`.
- `lib/api.ts`: `presetVoices(engine)` replaces `kokoroVoices()`.
- `pages/Profiles.tsx`: a "KittenTTS 2 — voice cloning + 47 presets" option with a Clone / Preset toggle. In Clone mode the transcript field is required, with the hint "5–30 s, single speaker".
- `pages/Generate.tsx`: Stable / Expressive selector, optional seed and tag hint for Kitten profiles (§5.1). Pass `preset` and `seed` to `POST /api/generations`.
- `pages/Settings.tsx`: `kitten` in the default-engine dropdown.
- `pages/Setup.tsx`: step text.

**Tests.**
- `backend/tests/test_smoke.py`: engine set `{"qwen", "kokoro", "kitten"}`. Kitten presets are exposed (`"Bruno"` among them). A Kitten clone profile without a transcript is rejected. A Kitten preset profile is created as `not_needed`. The catalog lists `kitten-tts-2`.
- `backend/tests/test_generate_kitten.py` (new), modelled on `test_generate_kokoro.py`. Skips if kittenml or the weights are missing. Generates one preset and one cloned sentence, prepares a voice print, and checks that it reloads after `unload()`.

**Verification.**
1. `npm run backend:test`: smoke tests pass with no models present.
2. Download `kitten-tts-2-emb4` from the Models page and run `python backend/tests/test_generate_kitten.py` on the 1060 (fp32 path), CPU-only and an Apple Silicon Mac (CPU path). Record the real-time factor in README's milestone table.
3. In `npm run dev`: create a Kitten clone profile and confirm the voice print is ready. Generate a two-paragraph script, restart the app, and generate again. The log should show the voice print being reused. Confirm no Whisper download happens.
4. README, the Models page entry and Settings → About show "Powered by KittenML" and link the Stellon Labs Community License.

## Appendix B: KittenTTS verification log (from the original plan)

Checked against the published `kittenml==0.9.4` sdist from PyPI, not only the README:
- ✅ Public API: `KittenTTS(model_name, cache_dir, backend, device, hf_token, decoder, weights)`, `generate(text, voice|reference, reference_text, preset, advanced={"seed":…})`, `sample_rate`, `available_voices`.
- ✅ The private hooks for voice prints exist: `speaker_encoder(wav)`, `codec.encode_reference(wav)`, `_build_reference(embedding, reference_tokens, transcript, reference_wav)`, `_reference_cache`, and the cache key `("clone", resolve_reference_path(wav), text)`.
- ✅ Hard-coded bf16 (`model.py:171`) and cuda-or-cpu device detection with no MPS.
- ✅ No watermarking: `resemble-perth` is never imported.
- ⚠️ Second weight repo: `S3Codec` downloads `s3gen_meanflow.safetensors` from `ResembleAI/chatterbox-turbo` (`vocoder.py:25,58`) at load time.
- ✅ Dependency resolution with `uv pip compile` on Python 3.11 (Windows, Linux, macOS): unsatisfiable with torch 2.5.1, resolves with torch 2.7.1 (§2.2).
- ✅ Weights license read on 2026-11-07: Stellon Labs Community License, Conditional tier (§1.2).
- ❌ Not checked: runtime behaviour on torch 2.7.1+cu126 on the GTX 1060 (needs the machine), and the AUP (only available on request).
