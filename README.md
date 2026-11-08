# VoiceCraft

Local-first voice cloning, music and sound effects, plus podcast assembly.
Clone a voice, generate speech from a script, make a music bed or a sound
effect from a text description, then arrange it all on a multitrack timeline
and export — without leaving the app and without anything touching the network
(apart from the model downloads you start yourself).

```
app/         React + TypeScript + Tailwind (Vite)  — Profiles, Generate, Library, Editor, Models, Settings
src-tauri/   Tauri (Rust) shell, launches the backend as a child process
backend/     FastAPI + SQLite + ffmpeg  (see backend/README.md)
```

## Install and run (as a user)

Download the installer for your OS from the [Releases](../../releases) page
(each tagged release is built by CI for all three platforms — see
"Packaging & releases" below).

- **Windows** — run the `.exe`. It's unsigned, so SmartScreen will warn once:
  click **More info → Run anyway**.
- **Linux (AppImage)** — `chmod +x VoiceCraft_*.AppImage`, then run it. On
  Ubuntu 22.04+ you may need `sudo apt install libfuse2` first.
- **macOS (Apple Silicon only)** — open the `.dmg` and drag VoiceCraft into
  Applications. The app isn't notarized, so the first launch is blocked by
  Gatekeeper: on macOS 15+, right-click → Open no longer works — go to
  **System Settings → Privacy & Security → "Open Anyway"** instead, or run
  `xattr -cr /Applications/VoiceCraft.app` in Terminal.

No console window, no manual Python install, no terminal required otherwise.
On first launch the app shows a setup screen that:

1. detects your GPU (CUDA on NVIDIA, Metal on Apple Silicon, CPU otherwise),
2. downloads a **private Python 3.12** and ffmpeg if they aren't already
   present — nothing is installed system-wide or needs admin rights,
3. creates a runtime environment in the app's data folder,
4. installs PyTorch and the speech engines (Qwen3-TTS, KittenTTS, Kokoro),
   streaming progress into the window,
5. downloads the Kokoro voice model,
6. starts the backend and drops you into the studio.

Internet access is needed for that download and for each model you add later.
Re-run setup any time from **Engine setup** in the sidebar (or **Settings →
Re-run setup**). If an update needs a newer runtime than the one on your
machine, the setup screen offers to rebuild it; your voices, library and
downloaded models are not touched.

Music and sound-effect engines are not part of first-run setup. Each one is
installed from the **Models** page when you want it (see "Music and sound
effects" below).

## Developing

```powershell
# 1. backend deps — see backend/README.md for the platform-specific torch command first
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

# 2. frontend + tauri CLI
npm install
npm --prefix app install

# 3. run the whole app (Tauri starts the backend itself)
npm run dev
```

macOS / Linux equivalents for step 1:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
```

Backend or frontend alone:

```powershell
npm run backend:dev    # http://127.0.0.1:17610/docs
npm run app:dev        # http://localhost:5173
npm run backend:test   # ffmpeg-backed smoke test, no models needed
```

`npm run dev` starts the Python backend by shelling out to `.venv\Scripts\python.exe`
(`.venv/bin/python` on macOS/Linux) or `python`. To attach your own backend
instead:

```powershell
$env:VOICECRAFT_BACKEND_CMD = "none"   # Tauri won't spawn one
```

(`export VOICECRAFT_BACKEND_CMD=none` on macOS/Linux.)

## Producing an episode

1. **Profiles** — upload a 10–30s reference clip, pick Qwen3-TTS, name it.
   Creating it clones the voice: the clip is run through the model once and the
   voice print is stored in the app data folder's `voices/` directory, so the
   card goes from *cloning…* to *voice ready* and every later generation
   reuses it. **Test
   voice** speaks a line so you can judge the clone before writing a script.
   Type the clip's transcript in and the clone is noticeably closer — without it
   the model has only the speaker embedding to work from.
   (Or pick Kokoro + a preset voice for a fast CPU draft — Kokoro cannot clone.)
2. **Generate** — paste the script, pick the profile and the output format
   (WAV, MP3, OGG, FLAC), generate, preview it. The engines only speak WAV, so
   anything else is transcoded by ffmpeg as part of the job — the file that
   lands is the one you asked for. Status is persisted, so history survives a
   restart.
   The same page has **Music** and **Sound FX** modes (next section).
3. **Library** — every past generation, searchable and filterable by type
   (voice, music, sound FX), voice and status, each with playback, **Open file**
   (shows it in Explorer) and **Export** to another format. Exports are new
   files listed beside it; the original is never touched.
4. **Editor** — a multitrack timeline. Voice, music and sound-effect clips all
   appear in the media bin (filter by type), next to your imported clips and
   intro/outro, and can be dragged onto any track.
5. **Reveal** — the finished file is in the app data folder's `edits/` directory.

Every edit writes a new file; sources are never overwritten.

## Music and sound effects

The **Generate** page switches between **Voice**, **Music** and **Sound FX**.
Both new modes are text-to-audio, run on your machine, and only appear ready
once their engine is installed and a model is downloaded. Until then the page
shows a card that says what is missing and links to the Models page.

- **Music** — a style description (genre, instruments, mood, tempo), either
  instrumental or with lyrics, a length from 10 s up to what your GPU can do,
  and an optional seed, step count and guidance. The form shows a time estimate
  only where there is a measurement behind it (see the table below).
- **Sound FX** — a description of the sound, a length, an optional seed.
- Both write WAV and are transcoded to MP3, OGG or FLAC like speech is.
- **ACE-Step** (music) and **MOSS** (sound effects) need an **NVIDIA GPU** (about
  5.5 GB of VRAM at the very least). Without one they are listed as "can't run
  here" with the reason; speech still works.
- **Stable Audio 3 Small** is the lite alternative for both: it is built to run on
  a CPU or a small GPU, so on a PC without NVIDIA the Music and Sound FX pages
  offer it instead. It makes instrumentals only (no lyrics), and its models are
  **gated** (see below). It has not been run on any machine yet, so the app shows
  no time estimate for it.
- When two engines of a kind are ready, the form shows an **Engine** selector and
  remembers your choice.
- Music and sound effects are not supported on macOS yet.

To start: **Models → Music generation** (or **Sound effects**) → **Install
engine** (installs the engine's Python packages into the app's runtime, then
restarts the backend) → **Download** a model. Removing a model on that page
also removes the files the app prepared for it. Stable Audio 3 Small is one
package for both lists, so installing or removing it applies to both.

**Gated models (Stable Audio 3).** Hugging Face only serves these to an account
that accepted the model's terms. Once: sign in at huggingface.co, open each
model's page and accept the terms, create a **read** token at
huggingface.co/settings/tokens, and paste it under **Models → Hugging Face
access** (or on the install card in Generate). VoiceCraft uses it only for those
downloads and keeps it in its own data folder (`secrets/hf_token`), not in the
library or `settings.json`; the app never shows it again. A token from your own
Hugging Face login (`HF_TOKEN`, `huggingface-cli login`) is used if you haven't
pasted one. The download also fetches the model's text encoder (a second
repository named in the model's own config, about 1.2 GB), which may carry its own
terms; if Hugging Face refuses it, the message names the repository.

What was measured, on one machine — a GTX 1060 with 6 GB, the smallest card the
engines run on. Other cards have not been tested:

| Engine | Model | Result on 6 GB |
|---|---|---|
| ACE-Step 1.5 | turbo | 30 s instrumental in about 70 s after about a minute to load the model; clips are capped at 30 s there, because a 2 minute clip did not finish |
| ACE-Step 1.5 | quality, XL | not run on any card |
| ACE-Step 1.5 | vocals | not run on any card |
| MOSS-SoundEffect v2 | v2 | about 3 minutes per clip, and a 3 s effect costs as much as a 30 s one |

The app data folder is `%LOCALAPPDATA%\VoiceCraft` on Windows,
`~/Library/Application Support/VoiceCraft` on macOS, and
`~/.local/share/VoiceCraft` (or `$XDG_DATA_HOME`) on Linux.

## Models

The **Models** tab is where weights are downloaded, removed, and chosen:

| Model | Use | Size | License |
|---|---|---|---|
| Qwen3-TTS 0.6B (Base) | speech, cloning; the default, fits a 6 GB card | ~2.2 GB | Apache 2.0 |
| Qwen3-TTS 1.7B (Base) | speech, cloning; wants 8 GB of VRAM | ~5.4 GB | Apache 2.0 |
| Kokoro 82M | speech, 28 preset voices, runs on CPU | ~0.4 GB | Apache 2.0 |
| KittenTTS 2 | speech, cloning and 115 preset voices; GPU strongly advised | ~1.1 GB + a ~1 GB vocoder file | Stellon Labs Community License |
| KittenTTS 2 (small) | the same, smaller weights | ~0.6 GB + the vocoder file | Stellon Labs Community License |
| ACE-Step 1.5 (turbo) | music, the default | ~10.8 GB | MIT |
| ACE-Step 1.5 (quality) | music, slower, aimed at quality | ~5.1 GB, plus ~1.5 GB it shares with turbo | MIT |
| ACE-Step 1.5 XL (turbo) | music, larger model | ~21.4 GB | MIT |
| MOSS-SoundEffect v2 | sound effects and ambience, up to 30 s | ~12.1 GB | Apache 2.0 |
| Stable Audio 3 Small (music) | lite music, CPU or small GPU, up to 2 min, instrumental, gated | ~2.3 GB + ~1.2 GB text encoder | Stability AI Community License |
| Stable Audio 3 Small (sound effects) | lite sound effects, CPU or small GPU, gated | ~2.3 GB + ~1.2 GB text encoder | Stability AI Community License |

Sizes are what the Models page shows before you start a download (the Stable
Audio 3 figures are the published ones; they have not been downloaded here).
VoiceCraft ships no weights: each model comes from its authors' repository, and
its license is between you and them. The Models page shows the license of every
entry and links to its terms; **Settings → About** lists the credits.

**KittenTTS 2 — Powered by KittenML.** Its weights are under the
[Stellon Labs Community License](https://huggingface.co/KittenML/kitten-tts-2/blob/main/LICENSE.md):
free for personal use, with commercial use subject to the license's terms
(including a revenue limit). Read it before using the output commercially.

**Stable Audio 3 — Powered by Stability AI.** Its weights are under the
[Stability AI Community License](https://stability.ai/license): free for personal
use and for organisations below $1M annual revenue, with larger ones needing a
licence from Stability. The `stable-audio-3` code the app installs is MIT. Read
the license before using the output commercially.

"Use this model" picks which checkpoint an engine loads; the choice is written
to `settings.json` in the app data folder and the engine is unloaded so the
next generation picks it up. `VOICECRAFT_QWEN_MODEL` / `VOICECRAFT_KOKORO_MODEL`
still override it if set.

Weights live in the **Hugging Face hub cache**, not the app data dir, so they
are shared with every other HF tool on the machine. **Change** points the app
at a different cache — useful when `C:` is full — and copies nothing: models
already in the new folder show up immediately, models left behind in the old
one show as not downloaded. **Reset** goes back to the HF default
(`~/.cache/huggingface/hub`, or whatever `HF_HOME`/`HF_HUB_CACHE` say).

## Settings

The **Settings** tab covers everything that isn't a model download: the GPU and
precision the engines picked, VRAM in use with a **Free VRAM** button, the
ffmpeg binaries in use, the defaults new profiles and exports start from, and
the data folder broken down by kind with **Reclaim space** — which deletes
scratch files and orphans, never anything the app still lists. **About** at the
bottom credits the model authors and links their licenses.

The backend listens on **17610**, not the 17600 the PRD names: Dropbox already
holds 17600 on this machine, so uvicorn could not bind. `VOICECRAFT_PORT` still
overrides it (change `app/src/lib/api.ts`, `src-tauri/src/backend.rs`, and the
CSP in `tauri.conf.json` to match).

## Requirements

**To run the built app:**
- Windows 10 1803+ or Windows 11; a modern x86_64 Linux desktop (AppImage);
  or macOS 11+ on Apple Silicon (Intel Macs are not supported)
- An NVIDIA GPU is optional for speech — CPU works but is slow, and the app
  says so. Apple Silicon gets Metal (MPS) acceleration automatically.
  ACE-Step and MOSS need an NVIDIA GPU; Stable Audio 3 Small runs without one
  (see above)
- Disk: the shared runtime is a few GB; each model adds its own download, from
  ~0.4 GB for Kokoro up to ~21 GB for ACE-Step XL
- Nothing else — Python and ffmpeg are installed by the app itself

**To build or develop it:**
- Python 3.12, Node 20+, Rust (stable)
- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
  OS: Windows needs MSVC build tools + WebView2; Linux needs
  `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`,
  `patchelf`; macOS needs Xcode command line tools
- `ffmpeg`/`ffprobe` on `PATH` for running the backend directly

## Packaging & releases

`npm run build` builds the installer for the current OS (NSIS on Windows,
AppImage on Linux, `.app`/`.dmg` on macOS) into
`src-tauri/target/release/bundle/`.

Pushing a `v*` tag (e.g. `v0.1.0`) triggers [.github/workflows/release.yml](.github/workflows/release.yml),
which builds all three platforms on GitHub Actions and attaches the
installers to a **draft** GitHub Release for review before publishing.


