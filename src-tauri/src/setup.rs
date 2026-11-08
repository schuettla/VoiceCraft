//! First-run setup: everything needed to make the app self-sufficient.
//!
//! The app must work from a double-click on a completely clean machine — no
//! Python, no ffmpeg, nothing preinstalled. Setup downloads a private Python
//! 3.12 via `uv` (never touches or depends on a system Python), builds a
//! managed runtime under the OS's app-data folder, downloads ffmpeg if it
//! isn't already on PATH, installs PyTorch (CUDA on NVIDIA, MPS on Apple
//! Silicon, CPU otherwise) plus the TTS engines, and downloads the Kokoro
//! weights — streaming every line to the UI so the user can see what is
//! happening instead of watching a spinner.
//!
//! Every package install goes through one `uv pip install` with the same
//! overrides file (`runtime-overrides.txt`), so no later install can silently
//! swap the CUDA torch for PyPI's CPU wheel. A runtime version in the marker
//! lets a newer app rebuild an older runtime in place (`RUNTIME_VERSION`).

use std::ffi::OsStr;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PYTHON_VERSION: &str = "3.12";
const UV_BASE: &str = "https://github.com/astral-sh/uv/releases/latest/download";

/// Bumped whenever the shared runtime changes in a way that needs a rebuild.
/// 1 = Python 3.11 / torch 2.5.1 (before the marker had this field);
/// 2 = Python 3.12 / torch 2.7.1 + KittenTTS 2.
const RUNTIME_VERSION: u32 = 2;

const TORCH_VERSION: &str = "2.7.1";
const TORCH_INDEX_BASE: &str = "https://download.pytorch.org/whl";
/// Qwen3-TTS pins this exactly; the audio engines added later accept it.
const TRANSFORMERS_PIN: &str = "4.57.3";

// Kept in sync with backend/requirements.txt.
const CORE_PACKAGES: [&str; 9] = [
    "fastapi==0.115.6",
    "uvicorn[standard]==0.34.0",
    "pydantic==2.10.4",
    "sqlalchemy==2.0.36",
    "python-multipart==0.0.20",
    "soundfile==0.12.1",
    "numpy>=1.26,<3",
    "huggingface_hub>=0.26",
    "psutil>=5.9",
];

const ENGINE_PACKAGES: [&str; 6] = [
    "qwen-tts",
    "transformers>=4.47", // pinned to TRANSFORMERS_PIN by the overrides file
    "accelerate>=1.2",
    "kokoro==0.9.4",
    "misaki[en]==0.9.4",
    "kittenml==0.9.4",
];

/// A music / SFX engine that installs on demand from the Models page.
///
/// Both come from GitHub only (ACE-Step's PyPI package is the old 1.0 line and
/// pins transformers 4.50), so each is pinned to the commit the Phase 0 spike
/// ran. They are fetched as source *archives*, not `git+https` URLs: that keeps
/// the app dependency-free (no git on a clean machine) and is just as exact.
/// The package itself goes in with `--no-deps`; `deps` is the curated list the
/// spike found sufficient, which leaves out training and demo extras (gradio,
/// lightning, peft, tensorboard, …).
pub struct AudioEngineSpec {
    /// Registry name in `backend/backends/__init__.py`.
    pub name: &'static str,
    pub label: &'static str,
    /// Module that must import afterwards.
    import: &'static str,
    deps: &'static [&'static str],
    /// Installed last, with `--no-deps`.
    source: &'static str,
    /// Distribution names to remove on uninstall — the engine's own package
    /// only; its small dependencies are shared and stay.
    dists: &'static [&'static str],
    /// Override lines for this engine's install only, on top of the shared file.
    overrides: &'static [&'static str],
}

/// Stable Audio 3 (Phase 9) is one package serving two engines — music and sound
/// effects each have their own registry name and checkpoint, so each gets a row on
/// the Models page, but both install and remove the same `stable-audio-3`. The
/// package is MIT; its weights are gated and under Stability's Community License.
///
/// Commit 790793b8 (2026-11-02) is the one whose source the spike read. Its
/// declared dependencies (`transformers>=5.8`, `huggingface-hub>=1.7`) are not
/// installed — the runtime pins transformers 4.57.3 — and `--no-deps` is what
/// makes that work: the package's core only imports names that exist there (the
/// spike checked the import in the Phase 0 venv).
const SA3_SOURCE: &str = "stable-audio-3 @ https://github.com/Stability-AI/stable-audio-3/archive/790793b89ddceea612be9ce42ff6830d18f6fa57.zip";
const SA3_DEPS: &[&str] = &["einops", "packaging", "safetensors", "tqdm", "soundfile", "hf_xet"];
/// The two modules the backend adapter imports.
const SA3_IMPORT: &str = "stable_audio_3.model, stable_audio_3.loading_utils";

const AUDIO_ENGINES: [AudioEngineSpec; 4] = [
    AudioEngineSpec {
        name: "acestep",
        label: "ACE-Step 1.5",
        // The two modules the backend adapter imports, so a missing dependency
        // (numba, vector-quantize-pytorch, …) fails the install and not the
        // first song. `import a, b` is valid Python.
        import: "acestep.handler, acestep.inference",
        deps: &[
            "diffusers>=0.37",
            "accelerate>=1.2",
            "loguru",
            "einops",
            "numba",
            "vector-quantize-pytorch",
            "scipy",
            "toml",
            "diskcache",
            "pytorch-wavelets",
            "pywavelets",
            "hf_xet",
        ],
        // Commit ca1e85fe (2026-08-29), the one the spike ran on the GTX 1060.
        source: "https://github.com/ACE-Step/ACE-Step-1.5/archive/ca1e85fe9430179831e6bc6be790c332190a3866.zip",
        dists: &["ace-step"],
        overrides: &[],
    },
    AudioEngineSpec {
        name: "moss_sfx",
        label: "MOSS-SoundEffect v2",
        import: "moss_soundeffect_v2",
        deps: &[
            "diffusers>=0.37",
            "einops",
            "ftfy",
            "regex",
            "imageio",
            "descript-audiotools",
            "pillow",
            "safetensors",
            "hf_xet",
        ],
        // Commit 934d6826, the one the spike ran. The package lives in a
        // subdirectory of the MOSS-TTS repository.
        source: "moss-soundeffect-v2 @ https://github.com/OpenMOSS/MOSS-TTS/archive/934d6826b084c46a0d033402174d5f8ac4ed2519.zip#subdirectory=moss_soundeffect_v2",
        dists: &["moss-soundeffect-v2"],
        // descript-audiotools declares protobuf<3.20, which breaks onnx. It runs
        // fine on protobuf 7, and only an override (not a constraint) may loosen
        // another package's bound.
        overrides: &["protobuf>=6.31.1"],
    },
    AudioEngineSpec {
        name: "sa3_music",
        label: "Stable Audio 3 Small",
        import: SA3_IMPORT,
        deps: SA3_DEPS,
        source: SA3_SOURCE,
        dists: &["stable-audio-3"],
        overrides: &[],
    },
    AudioEngineSpec {
        name: "sa3_sfx",
        label: "Stable Audio 3 Small",
        import: SA3_IMPORT,
        deps: SA3_DEPS,
        source: SA3_SOURCE,
        dists: &["stable-audio-3"],
        overrides: &[],
    },
];

/// What the onboarding screen renders. Cheap to compute — no subprocesses
/// except the one-off GPU probe, which is cached by the caller.
#[derive(Serialize, Clone, Default)]
pub struct SetupStatus {
    pub ready: bool,
    pub python_version: Option<String>,
    pub runtime_python: Option<String>,
    pub torch: Option<String>,
    pub engines: bool,
    pub model_downloaded: bool,
    pub ffmpeg: Option<String>,
    pub gpu: Option<String>,
    pub data_dir: String,
    pub platform: String,
    /// The installed runtime is older than this app needs; setup rebuilds it.
    pub needs_runtime_update: bool,
}

/// Written once setup succeeds, so status checks stay instant on later runs.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Marker {
    python: Option<String>,
    torch: Option<String>,
    engines: bool,
    model_downloaded: bool,
    installed_at: Option<String>,
    /// `RUNTIME_VERSION` the venv was built for. Missing = built before the field existed.
    #[serde(default)]
    runtime_version: Option<u32>,
}

#[derive(Serialize, Clone)]
struct StepEvent {
    step: &'static str,
    state: &'static str, // running | done | failed | skipped
    detail: Option<String>,
}

/// Guards against a second Install click while one is already running.
#[derive(Default)]
pub struct SetupLock(pub Arc<AtomicBool>);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("VoiceCraft")
    }
    #[cfg(target_os = "macos")]
    {
        home()
            .join("Library")
            .join("Application Support")
            .join("VoiceCraft")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local").join("share"))
            .join("VoiceCraft")
    }
}

fn runtime_dir() -> PathBuf {
    data_dir().join("runtime")
}

fn tools_dir() -> PathBuf {
    data_dir().join("tools")
}

/// Appends `.exe` on Windows; leaves the name alone everywhere else.
fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn runtime_python() -> Option<PathBuf> {
    let path = if cfg!(windows) {
        runtime_dir().join("Scripts").join("python.exe")
    } else {
        runtime_dir().join("bin").join("python")
    };
    path.is_file().then_some(path)
}

fn marker_path() -> PathBuf {
    runtime_dir().join("setup.json")
}

fn read_marker() -> Marker {
    std::fs::read_to_string(marker_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_marker(marker: &Marker) {
    let _ = std::fs::create_dir_all(runtime_dir());
    if let Ok(text) = serde_json::to_string_pretty(marker) {
        let _ = std::fs::write(marker_path(), text);
    }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/// The environment children should inherit. Inside an AppImage (`APPIMAGE`
/// is set) the launcher's library/GTK overrides would break a private
/// Python and ffmpeg, so those are stripped.
pub fn child_env() -> Vec<(String, String)> {
    let in_appimage = std::env::var_os("APPIMAGE").is_some();
    std::env::vars()
        .filter(|(key, _)| {
            !in_appimage
                || !(matches!(
                    key.as_str(),
                    "LD_LIBRARY_PATH" | "LD_PRELOAD" | "PYTHONHOME" | "PYTHONPATH" | "GSETTINGS_SCHEMA_DIR"
                ) || key.starts_with("GDK_")
                    || key.starts_with("GTK_")
                    || key.starts_with("GIO_"))
        })
        .collect()
}

fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.env_clear().envs(child_env());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn capture(program: impl AsRef<OsStr>, args: &[&str]) -> Option<String> {
    let output = command(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Pure-Rust PATH search — `where`/`which` aren't available everywhere
/// (minimal Linux installs lack `which`; GUI-launched macOS apps don't
/// inherit a shell-initialized PATH with Homebrew's `/opt/homebrew/bin`).
fn find_on_path(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(&file))
            .find(|p| p.is_file())
    })
}

/// GPU model name, or None when there is no usable NVIDIA device.
pub fn detect_gpu() -> Option<String> {
    capture(
        "nvidia-smi",
        &["--query-gpu=name", "--format=csv,noheader"],
    )
    .and_then(|out| out.lines().next().map(|line| line.trim().to_string()))
    .filter(|name| !name.is_empty())
}

/// CUDA compute capability of the first NVIDIA GPU (e.g. 6.1 for a GTX 1060).
fn detect_compute_cap() -> Option<f32> {
    capture(
        "nvidia-smi",
        &["--query-gpu=compute_cap", "--format=csv,noheader"],
    )
    .and_then(|out| out.lines().next().and_then(|line| line.trim().parse::<f32>().ok()))
}

/// Which PyTorch wheel family this machine gets.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TorchBuild {
    /// GTX 9xx/10xx/Volta: cu128 dropped Pascal, cu126 still ships sm_61.
    Cuda126,
    /// RTX 20xx and newer, including Blackwell (RTX 50xx).
    Cuda128,
    Cpu,
    /// Apple Silicon: the default PyPI wheel has Metal support.
    Mps,
}

impl TorchBuild {
    /// The `+tag` of the local version and the name of the index path.
    fn tag(self) -> Option<&'static str> {
        match self {
            TorchBuild::Cuda126 => Some("cu126"),
            TorchBuild::Cuda128 => Some("cu128"),
            TorchBuild::Cpu => Some("cpu"),
            TorchBuild::Mps => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            TorchBuild::Cuda126 => "cuda 12.6",
            TorchBuild::Cuda128 => "cuda 12.8",
            TorchBuild::Cpu => "cpu",
            TorchBuild::Mps => "mps",
        }
    }

    /// The inverse of `label`, for the build recorded in the setup marker.
    fn from_label(label: &str) -> Option<TorchBuild> {
        [TorchBuild::Cuda126, TorchBuild::Cuda128, TorchBuild::Cpu, TorchBuild::Mps]
            .into_iter()
            .find(|build| build.label() == label)
    }

    fn is_cuda(self) -> bool {
        matches!(self, TorchBuild::Cuda126 | TorchBuild::Cuda128)
    }

    fn index_url(self) -> Option<String> {
        self.tag().map(|tag| format!("{TORCH_INDEX_BASE}/{tag}"))
    }

    /// `2.7.1+cu126` — the local version pins which wheel family uv picks.
    fn version_pin(self) -> String {
        match self.tag() {
            Some(tag) => format!("{TORCH_VERSION}+{tag}"),
            None => TORCH_VERSION.to_string(),
        }
    }
}

fn choose_torch_build(app: &AppHandle, force_cpu: bool) -> TorchBuild {
    if cfg!(target_os = "macos") {
        log(app, "Apple Silicon detected — installing the build with Metal (MPS) support.");
        return TorchBuild::Mps;
    }
    let gpu = if force_cpu { None } else { detect_gpu() };
    let Some(name) = gpu else {
        log(app, "No NVIDIA GPU detected — installing the CPU build (generation will be slower).");
        return TorchBuild::Cpu;
    };
    match detect_compute_cap() {
        // Windows cu126 wheels have no Maxwell (sm_5x) kernels.
        Some(cap) if cap < 6.0 && cfg!(windows) => {
            log(app, format!(
                "NVIDIA GPU detected: {name} (compute {cap}) — too old for the Windows CUDA build, installing the CPU build."
            ));
            TorchBuild::Cpu
        }
        Some(cap) if cap >= 7.5 => {
            log(app, format!("NVIDIA GPU detected: {name} (compute {cap}) — installing the CUDA 12.8 build."));
            TorchBuild::Cuda128
        }
        Some(cap) => {
            log(app, format!("NVIDIA GPU detected: {name} (compute {cap}) — installing the CUDA 12.6 build."));
            TorchBuild::Cuda126
        }
        None => {
            log(app, format!("NVIDIA GPU detected: {name} — installing the CUDA 12.6 build."));
            TorchBuild::Cuda126
        }
    }
}

/// Run after a CUDA install: the card's architecture must be in the wheel and
/// a kernel must actually run, otherwise the first generation would crash.
const CUDA_SELFTEST: &str = "\
import torch
if not torch.cuda.is_available():
    print('no-cuda'); raise SystemExit
major, minor = torch.cuda.get_device_capability(0)
arches = torch.cuda.get_arch_list()
native = f'sm_{major}{minor}' in arches
ptx = any(a.startswith('compute_') and int(a[8:]) <= major * 10 + minor for a in arches)
if not (native or ptx):
    print('no-arch sm_%d%d in %s' % (major, minor, arches)); raise SystemExit
x = torch.ones(16, 16, device='cuda')
print('ok' if float((x @ x).sum()) == 4096.0 else 'bad-math')
";

fn cuda_selftest(python: &Path) -> Result<(), String> {
    match capture(python, &["-c", CUDA_SELFTEST]) {
        Some(out) if out.trim() == "ok" => Ok(()),
        Some(out) => Err(out),
        None => Err("the self-test crashed".to_string()),
    }
}

fn ffmpeg_bin_dir() -> PathBuf {
    runtime_dir().join("ffmpeg").join("bin")
}

pub fn find_ffmpeg() -> Option<PathBuf> {
    let bundled = ffmpeg_bin_dir().join(exe("ffmpeg"));
    if bundled.is_file() {
        return Some(bundled);
    }
    find_on_path("ffmpeg")
}

/// A managed runtime exists but was built for an older `RUNTIME_VERSION`.
/// A fresh machine (no runtime yet) is not "outdated", it simply needs setup.
pub fn needs_runtime_update() -> bool {
    runtime_python().is_some() && marker_outdated(&read_marker())
}

fn marker_outdated(marker: &Marker) -> bool {
    marker.runtime_version.map_or(true, |version| version < RUNTIME_VERSION)
}

pub fn status() -> SetupStatus {
    let marker = read_marker();
    let runtime = runtime_python();
    let outdated = runtime.is_some() && marker_outdated(&marker);
    SetupStatus {
        ready: runtime.is_some() && marker.engines && !outdated,
        needs_runtime_update: outdated,
        python_version: marker.python.clone(),
        runtime_python: runtime.map(|p| p.to_string_lossy().to_string()),
        torch: marker.torch,
        engines: marker.engines,
        model_downloaded: marker.model_downloaded,
        ffmpeg: find_ffmpeg().map(|p| p.to_string_lossy().to_string()),
        gpu: detect_gpu(),
        data_dir: data_dir().to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Download / extract helpers
// ---------------------------------------------------------------------------

/// Absolute path on Windows so Git-for-Windows' GNU `tar` (can't read zip,
/// misparses `C:\` paths) never shadows the native System32 one on PATH.
fn system_tool(name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        root.join("System32").join(format!("{name}.exe"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(name)
    }
}

fn download(app: &AppHandle, url: &str, dest: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(dest.parent().ok_or("bad download path")?).map_err(|e| e.to_string())?;
    run_streaming(
        app,
        &system_tool("curl"),
        &[
            "-fL".into(),
            "--retry".into(),
            "3".into(),
            "-o".into(),
            dest.to_string_lossy().into(),
            url.into(),
        ],
        &[],
        label,
    )
}

/// Windows' bsdtar reads zip directly; macOS zips go through `unzip`
/// (always present); .tar.gz/.tar.xz everywhere use `tar -xf` (compression
/// auto-detected).
fn extract(app: &AppHandle, archive: &Path, dest: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let zip = archive.extension().is_some_and(|e| e == "zip");
    if zip && cfg!(target_os = "macos") {
        run_streaming(
            app,
            Path::new("unzip"),
            &[
                "-o".into(),
                archive.to_string_lossy().into(),
                "-d".into(),
                dest.to_string_lossy().into(),
            ],
            &[],
            label,
        )
    } else {
        run_streaming(
            app,
            &system_tool("tar"),
            &["-xf".into(), archive.to_string_lossy().into(), "-C".into(), dest.to_string_lossy().into()],
            &[],
            label,
        )
    }
}

/// Archive layouts belong to third parties (uv wraps in a triple-named dir,
/// BtbN's top dir embeds a version) — search rather than hardcode.
fn find_file_named(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|f| f == name) {
                return Some(path);
            }
        }
    }
    None
}

/// Download `url`, extract it, and copy each named executable into `dest_dir`.
fn fetch_executables(
    app: &AppHandle,
    url: &str,
    archive_name: &str,
    names: &[&str],
    dest_dir: &Path,
    label: &str,
) -> Result<(), String> {
    let scratch = tools_dir().join("_download");
    let _ = std::fs::remove_dir_all(&scratch);
    let archive = scratch.join(archive_name);
    download(app, url, &archive, &format!("Downloading {label}"))?;
    let unpacked = scratch.join("unpacked");
    extract(app, &archive, &unpacked, &format!("Extracting {label}"))?;
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    for name in names {
        let file = exe(name);
        let found = find_file_named(&unpacked, &file)
            .ok_or_else(|| format!("{file} was not found in the {label} download"))?;
        let target = dest_dir.join(&file);
        std::fs::copy(&found, &target).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    Ok(())
}

// ---------------------------------------------------------------------------
// uv + private Python runtime
// ---------------------------------------------------------------------------

fn uv_asset() -> &'static str {
    if cfg!(windows) {
        "uv-x86_64-pc-windows-msvc.zip"
    } else if cfg!(target_os = "macos") {
        "uv-aarch64-apple-darwin.tar.gz"
    } else {
        "uv-x86_64-unknown-linux-gnu.tar.gz"
    }
}

fn ensure_uv(app: &AppHandle) -> Result<PathBuf, String> {
    let uv = tools_dir().join(exe("uv"));
    if !uv.is_file() {
        log(app, "Downloading uv, which installs a private Python for VoiceCraft.");
        fetch_executables(
            app,
            &format!("{UV_BASE}/{}", uv_asset()),
            uv_asset(),
            &["uv"],
            &tools_dir(),
            "uv",
        )?;
    }
    Ok(uv)
}

/// Removes the venv's own files so it can be rebuilt for a new Python/torch.
/// `runtime/` also holds ffmpeg, the marker and the overrides file, which stay.
/// Voices, the database and the Hugging Face cache live elsewhere entirely.
fn wipe_venv() -> Result<(), String> {
    let dir = runtime_dir();
    for name in ["Scripts", "Lib", "Include", "bin", "lib", "lib64", "include", "pyvenv.cfg"] {
        let path = dir.join(name);
        // Windows may still hold python.exe for a moment after the backend stops.
        let mut last_error = None;
        for _ in 0..10 {
            let result = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else if path.is_file() {
                std::fs::remove_file(&path)
            } else {
                Ok(())
            };
            match result {
                Ok(()) => {
                    last_error = None;
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
        if let Some(error) = last_error {
            return Err(format!(
                "Could not remove the old runtime ({}): {error}. Close other VoiceCraft windows and try again.",
                path.display()
            ));
        }
    }
    Ok(())
}

fn overrides_path() -> PathBuf {
    runtime_dir().join("runtime-overrides.txt")
}

/// The one overrides file every `uv pip install` receives. It pins the torch
/// build chosen for this machine (so no dependency can swap it for another
/// wheel family) and the shared transformers version.
fn write_overrides(build: TorchBuild) -> Result<(), String> {
    let pin = build.version_pin();
    let text = format!("torch=={pin}\ntorchaudio=={pin}\ntransformers=={TRANSFORMERS_PIN}\n");
    std::fs::create_dir_all(runtime_dir()).map_err(|e| e.to_string())?;
    std::fs::write(overrides_path(), text)
        .map_err(|e| format!("could not write {}: {e}", overrides_path().display()))
}

/// `uv pip install` into the runtime with the shared overrides. The torch
/// index is added next to PyPI, not instead of it.
///
/// `flags` are extra `uv pip install` options (`--no-deps`, a second
/// `--override` file) that go before the package list.
fn uv_install(
    app: &AppHandle,
    uv: &Path,
    python: &Path,
    build: TorchBuild,
    flags: &[String],
    packages: &[&str],
    label: &str,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "pip".into(),
        "install".into(),
        "--python".into(),
        python.to_string_lossy().to_string(),
        "--override".into(),
        overrides_path().to_string_lossy().to_string(),
        "--index-strategy".into(),
        "unsafe-best-match".into(),
    ];
    if let Some(index) = build.index_url() {
        args.extend(["--extra-index-url".into(), index]);
    }
    args.extend(flags.iter().cloned());
    args.extend(packages.iter().map(|p| p.to_string()));
    run_streaming(app, uv, &args, &[], label)
}

/// Private Python 3.12 + venv, entirely under `data_dir()`. Never touches or
/// depends on a system Python.
fn ensure_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(python) = runtime_python() {
        log(app, "Runtime environment already exists — reusing it.");
        return Ok(python);
    }
    let uv = ensure_uv(app)?;
    let python_dir = tools_dir().join("python").to_string_lossy().to_string();
    let uv_env: [(&str, &str); 1] = [("UV_PYTHON_INSTALL_DIR", python_dir.as_str())];

    let uv_run = |args: &[&str], label: &str| -> Result<(), String> {
        let mut full: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        full.extend(["--python-preference".into(), "only-managed".into()]);
        run_streaming(app, &uv, &full, &uv_env, label)
    };

    uv_run(&["python", "install", PYTHON_VERSION], "Installing Python")?;
    uv_run(
        // runtime/ may already hold ffmpeg and the marker from an earlier install.
        &["venv", "--seed", "--allow-existing", "--python", PYTHON_VERSION, &runtime_dir().to_string_lossy()],
        "Creating the runtime environment",
    )
    .map_err(|e| format!("{e}\nCheck your internet connection and run setup again."))?;
    runtime_python().ok_or_else(|| "the runtime environment was not created".to_string())
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn ffmpeg_sources() -> &'static [(&'static str, &'static str, &'static [&'static str])] {
    &[(
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        "ffmpeg.zip",
        &["ffmpeg", "ffprobe"],
    )]
}

#[cfg(target_os = "linux")]
fn ffmpeg_sources() -> &'static [(&'static str, &'static str, &'static [&'static str])] {
    &[(
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
        "ffmpeg.tar.xz",
        &["ffmpeg", "ffprobe"],
    )]
}

#[cfg(target_os = "macos")]
fn ffmpeg_sources() -> &'static [(&'static str, &'static str, &'static [&'static str])] {
    &[
        (
            "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
            "ffmpeg.zip",
            &["ffmpeg"],
        ),
        (
            "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
            "ffprobe.zip",
            &["ffprobe"],
        ),
    ]
}

fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(found) = find_ffmpeg() {
        return Ok(found);
    }
    log(app, "Downloading ffmpeg (used for trimming, mixing and exporting).");
    for (url, archive_name, names) in ffmpeg_sources() {
        fetch_executables(app, url, archive_name, names, &ffmpeg_bin_dir(), "ffmpeg")?;
    }
    find_ffmpeg().ok_or_else(|| "ffmpeg was downloaded but not found afterwards".into())
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

fn log(app: &AppHandle, line: impl Into<String>) {
    let _ = app.emit("setup:log", line.into());
}

fn step(app: &AppHandle, step: &'static str, state: &'static str, detail: Option<String>) {
    let _ = app.emit("setup:step", StepEvent { step, state, detail });
}

/// Run a child process, forwarding both streams to the UI line by line.
fn run_streaming(
    app: &AppHandle,
    program: &Path,
    args: &[String],
    env: &[(&str, &str)],
    label: &str,
) -> Result<(), String> {
    log(app, format!("$ {} {}", program.display(), args.join(" ")));

    let mut child = command(program)
        .args(args)
        .envs(env.iter().map(|(k, v)| (*k, *v)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{label} could not start: {error}"))?;

    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log(&app, line);
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            log(app, line);
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("{label} failed: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{label} exited with {}", status))
    }
}

fn pip(app: &AppHandle, python: &Path, args: &[&str], label: &str) -> Result<(), String> {
    let mut full = vec![
        "-m".to_string(),
        "pip".to_string(),
        "install".to_string(),
        "--disable-pip-version-check".to_string(),
        "--no-input".to_string(),
    ];
    full.extend(args.iter().map(|arg| arg.to_string()));
    run_streaming(app, python, &full, &[], label)
}

/// The whole first-run install. Runs on a worker thread; progress arrives as
/// `setup:log` / `setup:step` events.
pub fn install(app: AppHandle, force_cpu: bool) -> Result<(), String> {
    let mut marker = read_marker();

    // 0. an older runtime is rebuilt in place ---------------------------------
    // The backend runs on the old venv, so stop it first. Weights (HF cache),
    // voices and the database are outside `runtime/` and are never touched.
    // The marker keeps `model_downloaded`; everything else is reinstalled.
    if runtime_python().is_some() && marker_outdated(&marker) {
        log(&app, "The engine runtime is outdated — rebuilding it (your voices, projects and downloaded models are kept).");
        crate::backend::stop(&app);
        wipe_venv()?;
        marker = Marker {
            model_downloaded: marker.model_downloaded,
            ..Marker::default()
        };
        write_marker(&marker);
    }

    // 1. private Python + runtime venv --------------------------------------
    step(&app, "python", "running", None);
    let runtime_py = ensure_runtime(&app)?;
    let version = capture(&runtime_py, &["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"])
        .unwrap_or_else(|| PYTHON_VERSION.to_string());
    log(&app, format!("Using Python {version} at {}", runtime_py.display()));
    marker.python = Some(version.clone());
    // Recorded as soon as the new venv exists, so an interrupted install
    // resumes into it instead of wiping it again.
    marker.runtime_version = Some(RUNTIME_VERSION);
    write_marker(&marker);
    step(&app, "python", "done", Some(format!("Python {version}")));

    step(&app, "runtime", "running", None);
    pip(&app, &runtime_py, &["--upgrade", "pip"], "Updating pip")?;
    step(&app, "runtime", "done", Some(runtime_dir().to_string_lossy().to_string()));

    // 2. ffmpeg (non-fatal — generation to WAV still works without it) -----
    step(&app, "ffmpeg", "running", None);
    match ensure_ffmpeg(&app) {
        Ok(path) => step(&app, "ffmpeg", "done", Some(path.to_string_lossy().to_string())),
        Err(error) => {
            log(&app, format!("ffmpeg setup failed: {error}"));
            step(&app, "ffmpeg", "skipped", Some(error));
        }
    }

    // 3 + 4. torch and the engines, in ONE resolve --------------------------
    // Two separate installs let a later package pull a newer torch and replace
    // the CUDA build with PyPI's CPU wheel. One resolve plus the overrides
    // file makes the chosen build the only one that can be installed.
    step(&app, "torch", "running", None);
    step(&app, "engines", "running", None);
    let uv = ensure_uv(&app)?;
    let mut build = choose_torch_build(&app, force_cpu);
    write_overrides(build)?;
    log(&app, "Downloading PyTorch and the engines. This is a large download and can take a while.");
    let mut packages: Vec<&str> = vec!["torch", "torchaudio"];
    packages.extend_from_slice(&CORE_PACKAGES);
    packages.extend_from_slice(&ENGINE_PACKAGES);
    uv_install(&app, &uv, &runtime_py, build, &[], &packages, "Installing PyTorch and the engines")?;

    // A CUDA build that lacks this card's kernels would crash on the first
    // generation, so prove it works now and fall back to the CPU wheel if not.
    if build.is_cuda() {
        match cuda_selftest(&runtime_py) {
            Ok(()) => log(&app, "GPU self-test passed."),
            Err(reason) => {
                log(&app, format!("The GPU self-test failed ({reason}) — switching to the CPU build."));
                build = TorchBuild::Cpu;
                write_overrides(build)?;
                uv_install(
                    &app,
                    &uv,
                    &runtime_py,
                    build,
                    &[],
                    &["torch", "torchaudio"],
                    "Installing the CPU build of PyTorch",
                )?;
            }
        }
    }
    marker.torch = Some(build.label().to_string());
    marker.engines = true;
    write_marker(&marker);
    step(&app, "torch", "done", Some(build.label().to_string()));
    step(&app, "engines", "done", None);

    // 5. model weights -----------------------------------------------------
    step(&app, "model", "running", None);
    log(&app, "Downloading the Kokoro voice model (~330 MB, cached for offline use).");
    match run_streaming(
        &app,
        &runtime_py,
        &["-c".to_string(), WARM_KOKORO.to_string()],
        &[],
        "Downloading the Kokoro model",
    ) {
        Ok(()) => {
            marker.model_downloaded = true;
            step(&app, "model", "done", None);
        }
        Err(error) => {
            // Not fatal: the model downloads on first generation instead.
            log(&app, format!("Model download failed: {error}"));
            log(&app, "It will be downloaded on your first generation instead.");
            step(&app, "model", "skipped", Some(error));
        }
    }

    marker.installed_at = Some(now());
    write_marker(&marker);
    Ok(())
}

// ---------------------------------------------------------------------------
// Music / SFX engines (installed on demand from the Models page)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EngineAction {
    Install,
    Uninstall,
}

impl EngineAction {
    fn as_str(self) -> &'static str {
        match self {
            EngineAction::Install => "install",
            EngineAction::Uninstall => "uninstall",
        }
    }
}

/// Progress of an engine install / uninstall, on the `engine:state` event.
#[derive(Serialize, Clone)]
struct EngineEvent {
    engine: String,
    action: &'static str,
    state: &'static str, // running | done | failed
    detail: Option<String>,
}

pub fn audio_engine(name: &str) -> Result<&'static AudioEngineSpec, String> {
    AUDIO_ENGINES
        .iter()
        .find(|spec| spec.name == name)
        .ok_or_else(|| format!("unknown engine \"{name}\""))
}

pub fn engine_event(
    app: &AppHandle,
    engine: &str,
    action: EngineAction,
    state: &'static str,
    detail: Option<String>,
) {
    let _ = app.emit(
        "engine:state",
        EngineEvent {
            engine: engine.to_string(),
            action: action.as_str(),
            state,
            detail,
        },
    );
}

/// Install or remove one engine's packages. Output streams to `setup:log`.
///
/// The backend is stopped first: it has torch, onnx and protobuf loaded, and
/// Windows won't let uv replace a `.pyd` that is in use. The caller starts it
/// again whatever the outcome, and then sends the final `engine:state`.
/// Weights are not touched either way — they have their own download / delete.
pub fn run_engine_job(app: &AppHandle, name: &str, action: EngineAction) -> Result<(), String> {
    let spec = audio_engine(name)?;
    engine_event(app, spec.name, action, "running", None);
    let python = runtime_python()
        .ok_or_else(|| "The engine runtime isn't installed yet — run setup first.".to_string())?;
    let marker = read_marker();
    if marker_outdated(&marker) || !marker.engines {
        return Err("The engine runtime needs its own update first — open setup.".to_string());
    }
    let build = marker
        .torch
        .as_deref()
        .and_then(TorchBuild::from_label)
        .ok_or_else(|| "The setup record is missing the PyTorch build — run setup again.".to_string())?;
    let uv = ensure_uv(app)?;

    crate::backend::stop(app);
    // The killed process can hold its files for a moment.
    std::thread::sleep(std::time::Duration::from_millis(1500));

    match action {
        EngineAction::Install => install_audio_engine(app, spec, &uv, &python, build),
        EngineAction::Uninstall => uninstall_audio_engine(app, spec, &uv, &python),
    }
}

fn install_audio_engine(
    app: &AppHandle,
    spec: &AudioEngineSpec,
    uv: &Path,
    python: &Path,
    build: TorchBuild,
) -> Result<(), String> {
    log(app, format!("Installing {} (the PyTorch build and your models are not touched).", spec.label));
    // Re-assert the shared overrides so this install can't swap the torch build.
    write_overrides(build)?;

    let mut flags: Vec<String> = Vec::new();
    if !spec.overrides.is_empty() {
        let path = runtime_dir().join(format!("engine-overrides-{}.txt", spec.name));
        std::fs::write(&path, format!("{}\n", spec.overrides.join("\n")))
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        flags.extend(["--override".to_string(), path.to_string_lossy().to_string()]);
    }

    uv_install(
        app,
        uv,
        python,
        build,
        &flags,
        spec.deps,
        &format!("Installing the {} dependencies", spec.label),
    )?;
    uv_install(
        app,
        uv,
        python,
        build,
        &["--no-deps".to_string()],
        &[spec.source],
        &format!("Installing {}", spec.label),
    )?;

    // Prove it imports now, rather than on the user's first generation. Setting
    // TORCHDYNAMO_DISABLE here mirrors how the backend will run it on Windows.
    log(app, format!("Checking that {} imports…", spec.label));
    run_streaming(
        app,
        python,
        &["-c".to_string(), format!("import {m}; print('{m} imports')", m = spec.import)],
        &[("TORCHDYNAMO_DISABLE", "1")],
        &format!("Importing {}", spec.label),
    )
    .map_err(|error| {
        format!("{} installed but does not import ({error}). The log above has the details.", spec.label)
    })
}

fn uninstall_audio_engine(
    app: &AppHandle,
    spec: &AudioEngineSpec,
    uv: &Path,
    python: &Path,
) -> Result<(), String> {
    log(app, format!(
        "Removing {}. Its small shared dependencies stay; downloaded weights are removed from the Models page.",
        spec.label
    ));
    let mut args: Vec<String> = vec![
        "pip".into(),
        "uninstall".into(),
        "--python".into(),
        python.to_string_lossy().to_string(),
    ];
    args.extend(spec.dists.iter().map(|d| d.to_string()));
    run_streaming(app, uv, &args, &[], &format!("Removing {}", spec.label))
}

const WARM_KOKORO: &str = "\
import warnings; warnings.filterwarnings('ignore')
from kokoro import KPipeline
KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
print('Kokoro model ready')
";

fn now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_engines_are_pinned_to_a_full_commit() {
        for spec in &AUDIO_ENGINES {
            let hash = spec
                .source
                .split("/archive/")
                .nth(1)
                .and_then(|rest| rest.split(".zip").next())
                .unwrap_or_else(|| panic!("{} is not a GitHub archive URL", spec.name));
            assert_eq!(hash.len(), 40, "{} must pin a full commit, got {hash:?}", spec.name);
            assert!(hash.chars().all(|c| c.is_ascii_hexdigit()), "{} pin is not hex", spec.name);
            assert!(!spec.dists.is_empty() && !spec.deps.is_empty());
            assert!(
                !spec.deps.iter().any(|dep| dep.starts_with("torch")),
                "{}: torch is installed by setup and pinned by the overrides, never here",
                spec.name
            );
        }
    }

    #[test]
    fn audio_engine_names_are_unique_and_found() {
        for spec in &AUDIO_ENGINES {
            assert_eq!(AUDIO_ENGINES.iter().filter(|s| s.name == spec.name).count(), 1);
            assert_eq!(audio_engine(spec.name).unwrap().label, spec.label);
        }
        assert!(audio_engine("nope").is_err());
    }

    #[test]
    fn both_stable_audio_engines_install_the_same_package() {
        let music = audio_engine("sa3_music").unwrap();
        let sfx = audio_engine("sa3_sfx").unwrap();
        assert_eq!(music.source, sfx.source);
        assert_eq!(music.dists, sfx.dists);
        assert_eq!(music.import, sfx.import);
    }

    #[test]
    fn torch_build_survives_the_marker_round_trip() {
        for build in [TorchBuild::Cuda126, TorchBuild::Cuda128, TorchBuild::Cpu, TorchBuild::Mps] {
            assert!(TorchBuild::from_label(build.label()) == Some(build));
        }
        assert!(TorchBuild::from_label("rocm").is_none());
    }
}
