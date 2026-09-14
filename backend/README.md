# VoiceCraft backend

FastAPI service on `127.0.0.1:17610`. Nothing leaves the machine except
Hugging Face model downloads on first use.

## Install (developer checkout)

Python **3.11** is the target (PyTorch has no CUDA wheels for 3.13/3.14 yet).
In the shipped app, first-run setup installs a private Python and does this
for you — this section is only for running the backend directly.

```powershell
py -3.11 -m venv .venv
.venv\Scripts\activate

# 1. torch FIRST — a plain `pip install torch` silently installs the CPU-only
#    wheel on Windows/Linux, which is the pain point the PRD calls out.
#    Windows/Linux + NVIDIA:
pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121
#    macOS (Apple Silicon) — the default PyPI wheel already includes Metal
#    (MPS) support, so no --index-url is needed:
pip install torch==2.5.1 torchaudio==2.5.1
#    CPU only (any platform):
pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu

# 2. everything else
pip install -r backend/requirements.txt

# 3. verify
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`ffmpeg` and `ffprobe` must be on `PATH` (or set `VOICECRAFT_FFMPEG` /
`VOICECRAFT_FFPROBE`). Check with `ffmpeg -version`.

## Run

```powershell
python backend/main.py            # http://127.0.0.1:17610/docs
python backend/main.py --reload   # autoreload while developing
python backend/tests/test_smoke.py  # 32 checks, needs ffmpeg only
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
voicecraft.db SQLite
```

## Engines

| Engine | Cloning | Device | Notes |
|---|---|---|---|
| `qwen` (Qwen3-TTS-12Hz-0.6B-**Base**) | yes, zero-shot from a sample | CUDA (float32 on pre-Ampere cards), Apple Silicon MPS, CPU fallback with a warning | only the `*-Base` checkpoints clone; CustomVoice/VoiceDesign are preset-timbre models. A profile with a sample transcript clones better than one without |
| `kokoro` (Kokoro-82M) | **no** | CPU | picks one of ~50 preset voices; fast enough for drafts |

## Cloning a voice

Creating a `qwen` profile queues a **voice print** extraction rather than only
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
