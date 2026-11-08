# VoiceCraft backend

FastAPI service on `127.0.0.1:17610`. Nothing leaves the machine except
Hugging Face model downloads on first use.

## Install (developer checkout)

Python **3.12** is the target (the shipped runtime is Python 3.12 + torch 2.7.1;
PyTorch has no CUDA wheels for 3.13/3.14 yet). In the shipped app, first-run
setup installs a private Python and does this for you — this section is only
for running the backend directly.

```powershell
py -3.12 -m venv .venv
.venv\Scripts\activate

# 1. torch FIRST — a plain `pip install torch` silently installs the CPU-only
#    wheel on Windows/Linux, which is the pain point the PRD calls out.
#    Windows/Linux + NVIDIA, GTX 9xx/10xx/Volta (compute capability < 7.5;
#    cu128 dropped Pascal):
pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126
#    Windows/Linux + NVIDIA, RTX 20xx and newer (incl. RTX 50xx). Check yours
#    with: nvidia-smi --query-gpu=compute_cap --format=csv
pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu128
#    macOS (Apple Silicon) — the default PyPI wheel already includes Metal
#    (MPS) support, so no --index-url is needed:
pip install torch==2.7.1 torchaudio==2.7.1
#    CPU only (any platform):
pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cpu

# 2. everything else (pins transformers==4.57.3, which every engine shares)
pip install -r backend/requirements.txt

# 3. verify
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

On Windows set `PYTHONUTF8=1` when running the backend by hand; the app does
this itself (KittenTTS 2 reads a bundled JSON file without an encoding).

`ffmpeg` and `ffprobe` must be on `PATH` (or set `VOICECRAFT_FFMPEG` /
`VOICECRAFT_FFPROBE`). Check with `ffmpeg -version`.

## Run

```powershell
python backend/main.py            # http://127.0.0.1:17610/docs
python backend/main.py --reload   # autoreload while developing
python backend/tests/test_smoke.py     # API end to end, needs ffmpeg only
python backend/tests/test_plumbing.py  # device helper, catalog, downloads, scheduling (no weights)
python backend/tests/test_kitten.py    # KittenTTS 2 backend against a fake model (no weights)
python backend/tests/test_audio.py     # music / SFX backend, API and queue against a fake engine (no weights, no GPU)
python backend/tests/test_sa3.py       # Stable Audio 3: gated downloads, token store, adapter against a fake package
python backend/tests/test_generate_kitten.py  # live: loads the model; skips without kittenml + weights
```

## Layout

| Path | Role |
|---|---|
| `main.py` | entrypoint, `--parent-pid` watchdog for the Tauri shell |
| `app.py` | FastAPI app, `/api/health`, `/api/files` |
| `config.py` | ports, data directories, ffmpeg paths, model ids |
| `models.py` | pydantic request/response schemas |
| `routes/` | HTTP layer only |
| `services/` | profile, voice, generation, model, and edit logic |
| `services/voice_service.py` | the cloning step — extracts and stores voice prints |
| `backends/` | TTS engines behind one protocol + registry |
| `backends/device.py` | one device / precision decision for every engine (`pick_device`), plus `hardware()` |
| `backends/audio_engines.py` | the music / SFX engines (`acestep`, `moss_sfx`): lifecycle and per-machine limits |
| `backends/sa3_engines.py`, `backends/sa3_files.py` | Stable Audio 3 Small (`sa3_music`, `sa3_sfx`) and the config reading that finds its text encoder |
| `services/hf_token.py` | the Hugging Face token for gated downloads (write-only) |
| `services/audio_service.py` | music / SFX jobs: readiness checks, takes, file names |
| `catalog.py` | the downloadable checkpoints, their licenses, and which one each engine uses |
| `database/` | SQLAlchemy models and session |
| `utils/audio.py` | every ffmpeg invocation |

## Data directory

`%LOCALAPPDATA%\VoiceCraft` on Windows, `~/Library/Application Support/VoiceCraft`
on macOS, `~/.local/share/VoiceCraft` (or `$XDG_DATA_HOME`) on Linux by default
(`VOICECRAFT_DATA_DIR` to override):

```
samples/      reference clips for cloning
voices/       extracted voice prints — one per cloning profile
generations/  TTS output, in the format the request asked for
assets/       intro/outro clips you uploaded
edits/        trim / assemble / convert results  ← finished episodes land here
tmp/          ffmpeg intermediates
secrets/      the Hugging Face token, if you pasted one (not listed, served or cleaned)
voicecraft.db SQLite
```

## Engines

| Engine | Cloning | Device | Notes |
|---|---|---|---|
| `qwen` (Qwen3-TTS-12Hz-0.6B-**Base**) | yes, zero-shot from a sample | CUDA (float32 on pre-Ampere cards), Apple Silicon MPS, CPU fallback with a warning | only the `*-Base` checkpoints clone; CustomVoice/VoiceDesign are preset-timbre models. A profile with a sample transcript clones better than one without |
| `kokoro` (Kokoro-82M) | **no** | CPU | picks one of ~50 preset voices; fast enough for drafts |
| `kitten` (KittenTTS 2, 1.7B ternary) | yes, from a 5–30 s clip **and its transcript** | CUDA (bf16, also on Pascal), CPU about 15× slower than real time; no MPS | a profile is *either* a clone *or* one of 115 preset voices. 20 languages, `[joyful]` / `<laugh>` / `(((emphasis)))` tags, `stable` / `expressive` style, seed. No speed control. Weights: Stellon Labs Community License (conditional tier) |

### Music and sound effects

`acestep` (ACE-Step 1.5, music), `moss_sfx` (MOSS-SoundEffect v2, SFX) and the
two Stable Audio 3 Small engines `sa3_music` / `sa3_sfx` are `AudioBackend`s: no
voice, just a prompt (`AudioSpec`). They sit in the same registry as the speech
engines, so the one-job-at-a-time rule, unload-before-job and the idle unload cover
them. All are `optional` (installed on demand). ACE-Step and MOSS are open-licensed;
Stable Audio 3 is **gated** and under Stability's Community License.

| Endpoint | What it does |
|---|---|
| `GET /api/audio-engines` | per engine: `installed`, `supported` (+ `unsupported_reason`), `warning`, `max_duration_seconds`, the catalog entry and whether its weights are on disk, license tier, `gated`, `lyrics` (can it sing), `editing` (can it start from a clip), `default`, `ready`, and `models[]` (every checkpoint of the engine with its own `downloaded`, `unavailable_reason`, `ready`, length limit and default steps) |
| `GET` / `PUT` / `DELETE /api/models/hf-token` | the Hugging Face token for gated downloads. Write-only: `GET` and `PUT` answer `{configured, source}` (`app` or `huggingface`), never the token |
| `POST /api/generations/audio` | `{kind, engine?, model_id?, prompt, duration_seconds, lyrics?, seed?, steps?, guidance?, takes?, output_format, edit?}` → **202 with a list** of `queued` rows (`takes` of them for SFX, one for music). `model_id` is a catalog entry (it names its engine; the worker makes it the engine's active model before the job); `edit` starts from an existing clip, see below |
| `GET /api/generations?kind=speech\|music\|sfx` | the history, narrowed to one type |
| `PATCH /api/generations/{id}` | `{favorite: bool}` → the updated row. Stars a generation in the Library |

A request is refused up front, in this order: unknown engine or wrong kind (400),
not installed, weights not downloaded, hardware can't run it (all 409, each says
what to do), clip longer than this machine allows (400). ACE-Step is capped at 30 s on a
card with under 8 GB or without bf16, and MOSS is offered from about 6 GB.

**Starting from a clip.** `edit` is `{mode, generation_id | asset_id, strength?,
start_seconds?, end_seconds?}`. `mode` is `variation` (a new take close to the clip;
`strength` 0.05–1 is how far it may move), `extend` (keep the clip and continue it;
`duration_seconds` is the *result's* length and must be at least a second longer than
the clip) or `replace` (regenerate `start_seconds`–`end_seconds` and keep the rest). For
`variation` and `replace` the result has the clip's own length, whatever
`duration_seconds` says, and a music clip may then be shorter than the usual 10 s. Only
engines with `editing: true` take it (the two Stable Audio 3 engines); without an
`engine` the request goes to one of those, and a named engine that can't gets a 400 that
names one that can. The source is any finished generation or an Editor asset, in any
format ffmpeg reads.

Rows have `profile_id: null`; `text` is the prompt and `params` holds
`duration_seconds`, `lyrics`, `seed`, `steps`, `guidance` and, for several takes,
`take` / `takes`. With a fixed `seed` each take offsets it by its index (otherwise
every take would be the same clip), and the row records the seed it used. Files
are named from the first words of the prompt (`heavy-wooden-door-slamming-1a2b3c4d.wav`).

A request with `lyrics` for an engine that can't sing (`lyrics: false`) is refused
with a 400 before readiness is checked.

**Stable Audio 3 and the gate.** `sa3_music` and `sa3_sfx` load
`stabilityai/stable-audio-3-small-{music,sfx}` through the `stable_audio_3`
package without ever touching the network: `sa3_engines.py` rebuilds what
`StableAudioModel.from_pretrained` does (config → `load_diffusion_cond` →
`StableAudioModel`) from the cache, because `from_pretrained` downloads on every
call. The model's text encoder is a *second repository* named in its own
`model_config.json` (`backends/sa3_files.py` reads it); the Models page downloads
it along with the model (`ModelSpec.companion`), and the adapter pins the config
to the local folder. Downloads of a gated entry carry the token from
`services/hf_token.py` (stored in `<data dir>/secrets/hf_token`, never logged or
returned) and turn the Hub's 401/403 into steps a person can follow.

**Status:** MOSS and Stable Audio 3 Small (music, and its variation / extend /
replace modes) have been run for real through the app. ACE-Step was run as far as the
Phase 0 spike. The Stable Audio 3 adapter is also tested against a fake package with
the call shapes read from the library's source (`tests/test_sa3.py`). Not yet run for
real: Stable Audio 3 sound effects, ACE-Step through the app, and vocals on any engine.

## Cloning a voice

Creating a `qwen` profile (or a `kitten` clone) queues a **voice print** extraction rather than only
writing a row: the reference clip is run through the model's speaker encoder
(and, with a transcript, its speech tokenizer) once, and the result is saved to
`voices/<profile id>.vprint`. Generation loads that file instead of re-analysing
the clip, so a script of twenty paragraphs pays the cost once and the clone
survives a restart.

The profile carries the state — `pending`, `preparing`, `ready`, `failed`, or
`not_needed` for preset engines — and the Profiles page shows it, with **Test
voice** to hear the result and **Re-clone** to redo it.

Preparation waits for the engine's weights: if the checkpoint isn't downloaded,
the profile sits at `pending` with a note pointing at the Models page, and is
queued automatically when that download finishes. Startup re-queues anything
unfinished, so profiles created before this step existed get one on first run.

`POST /api/profiles/{id}/prepare` re-extracts; `POST /api/profiles/{id}/preview`
speaks a fixed test line as an ordinary generation.

KittenTTS 2 clones **require the sample's transcript**. Without one, kittenml
would download Whisper large-v3 (~3 GB) to transcribe the clip, so profile
creation refuses and the backend double-checks. Its voice print is an `.npz`
(`np.savez`, loaded with `allow_pickle=False`) holding the speaker embedding,
the reference codec tokens and the transcript; the sample stays on disk because
kittenml rebuilds its vocoder conditioning from it. The hooks used
(`speaker_encoder`, `codec.encode_reference`, `_build_reference`,
`_reference_cache`) are private, hence `kittenml==0.9.4`; if they change, the
clip is analysed on every generation instead, which is slower, not wrong.
`GET /api/profiles/voices?engine=kitten` lists the presets (read from the
downloaded model, else the bundled list). `POST /api/generations` accepts
`preset` (`stable`|`expressive`) and `seed` for Kitten profiles; they are kept
in the generation's `params`. It also takes `model_id`, a checkpoint of the voice's
engine (Qwen 0.6B / 1.7B, Kitten packed / small); omitted, the engine's active
model is used. Either way `params.model` records which one made the clip.

## Models and GPU use

Each engine loads one checkpoint from `catalog.py`. The choice is saved in
`settings.json` under `active_models` by **model id** (two entries may share a
Hugging Face repo and differ only in the files they fetch); a `qwen_model` /
`kokoro_model` repo id written by an older build is still read until the Models
page replaces it. `VOICECRAFT_QWEN_MODEL` / `VOICECRAFT_KOKORO_MODEL` override
the choice with any repo id. KittenTTS 2 has no such override: its two variants
(`kitten-tts-2`, `kitten-tts-2-emb4`) share one repo, so a repo id could not say
which one is meant; pick it on the Models page.
Downloading either also fetches `s3gen_meanflow.safetensors` (~1 GB) from
`ResembleAI/chatterbox-turbo`, which Kitten's vocoder would otherwise fetch on first use.

Jobs run one at a time. Before a job every other loaded engine is unloaded and
VRAM is returned to the driver, so two engines never share a 6 GB card, and
after `VOICECRAFT_IDLE_UNLOAD_SECONDS` without work the loaded engine is
unloaded too. `GET /api/health` marks engines installed on demand with
`optional: true`.

Generations carry `kind` (`speech`, `music` or `sfx`), `engine` and a JSON
`params` object; databases from older builds gain the columns on startup.

## Output formats

`POST /api/generations` takes `output_format` (`wav` | `mp3` | `ogg` | `flac`,
default `wav`). The engines only write WAV, so any other format synthesizes to
a WAV beside the target, transcodes it with ffmpeg, and deletes the
intermediate — the row's `audio_path` and derived `format` describe the file
that actually exists. `POST /api/edit/convert` re-exports an existing
generation into another format as a new file in `edits/`, leaving the original
alone (FR10).

## Environment variables

| Variable | Default |
|---|---|
| `VOICECRAFT_HOST` / `VOICECRAFT_PORT` | `127.0.0.1` / `17610` |
| `VOICECRAFT_DATA_DIR` | the OS-appropriate app data folder (see "Data directory" above) |
| `VOICECRAFT_FFMPEG` / `VOICECRAFT_FFPROBE` | discovered on `PATH` |
| `VOICECRAFT_QWEN_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` (1.7B-Base if you have the VRAM) |
| `VOICECRAFT_KOKORO_MODEL` | `hexgrad/Kokoro-82M` |
| `VOICECRAFT_AUTO_PREPARE` | `1` — set `0` to skip voice-print extraction (the test suite does) |
| `VOICECRAFT_IDLE_UNLOAD_SECONDS` | unload loaded models after this long without a job; `0` disables. Unset: the `idle_unload_minutes` preference (default 10 minutes) decides |
