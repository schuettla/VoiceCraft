# VoiceCraft

Local-first voice cloning + podcast assembly. Clone a voice, generate speech
from a script, then trim / stitch an intro and outro / export to MP3 — without
leaving the app and without anything touching the network.

Implements [PRD.md](PRD.md). Windows, Linux, and Apple Silicon macOS.

```
app/         React + TypeScript + Tailwind (Vite)  — Profiles, Generate, Library, Edit, Models, Settings
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
2. downloads a **private Python 3.11** and ffmpeg if they aren't already
   present — nothing is installed system-wide or needs admin rights,
3. creates a runtime environment in the app's data folder,
4. installs PyTorch and the TTS engines, streaming progress into the window,
5. downloads the Kokoro voice model,
6. starts the backend and drops you into the studio.

Internet access is needed once, for that download. Re-run setup any time from
the **Setup** button in the header.

## Developing

```powershell
# 1. backend deps — see backend/README.md for the platform-specific torch command first
py -3.11 -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

# 2. frontend + tauri CLI
npm install
npm --prefix app install

# 3. run the whole app (Tauri starts the backend itself)
npm run dev
```

macOS / Linux equivalents for step 1:

```bash
python3.11 -m venv .venv
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
3. **Library** — every past generation, searchable and filterable by voice and
   status, each with playback, **Open file** (shows it in Explorer) and
   **Export** to another format. Exports are new files listed beside it; the
   original is never touched.
4. **Edit** — upload your intro/outro once, then Assemble
   intro → generation(s) → outro with a 0–500 ms crossfade, output MP3.
   Trim and Convert live on the same page.
5. **Reveal** — the finished file is in the app data folder's `edits/` directory.

Every edit writes a new file; sources are never overwritten.

The app data folder is `%LOCALAPPDATA%\VoiceCraft` on Windows,
`~/Library/Application Support/VoiceCraft` on macOS, and
`~/.local/share/VoiceCraft` (or `$XDG_DATA_HOME`) on Linux.

## Models

The **Models** tab is where weights are downloaded, removed, and chosen:

| | |
|---|---|
| Qwen3-TTS 0.6B (Base) | cloning, ~2 GB, the default — fits a 6 GB card |
| Qwen3-TTS 1.7B (Base) | cloning, ~5 GB, wants 8 GB of VRAM |
| Kokoro 82M | 28 preset voices, ~330 MB, CPU |

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
scratch files and orphans, never anything the app still lists.

The backend listens on **17610**, not the 17600 the PRD names: Dropbox already
holds 17600 on this machine, so uvicorn could not bind. `VOICECRAFT_PORT` still
overrides it (change `app/src/lib/api.ts`, `src-tauri/src/backend.rs`, and the
CSP in `tauri.conf.json` to match).

## Requirements

**To run the built app:**
- Windows 10 1803+ or Windows 11; a modern x86_64 Linux desktop (AppImage);
  or macOS 11+ on Apple Silicon (Intel Macs are not supported)
- An NVIDIA GPU is optional — CPU works but is slow, and the app says so.
  Apple Silicon gets Metal (MPS) acceleration automatically
- Nothing else — Python and ffmpeg are installed by the app itself

**To build or develop it:**
- Python 3.11, Node 20+, Rust (stable)
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

## Status against the PRD milestones

| | |
|---|---|
| M1 backend skeleton, profile CRUD, DB | done |
| M2 Qwen3-TTS + Kokoro generation | both verified on this machine: Kokoro on CPU, and Qwen3-TTS cloning on a GTX 1060 (3.7s of audio in 70s, float32) |
| M3 trim / assemble / convert | done, covered by `backend/tests/test_smoke.py` (57 checks) |
| M4 Tauri shell + UI | done — Profiles, Generate, Library, Edit, Models, Settings; the shell spawns the backend, and the watchdog was tested by killing the shell |
| M5 first real episode | yours to run |
| M6 installer | NSIS/AppImage/dmg installers build for all three platforms via CI; first-run setup is self-sufficient (no preinstalled Python or ffmpeg required) |
