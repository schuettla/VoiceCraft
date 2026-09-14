//! First-run setup: everything needed to make the app self-sufficient.
//!
//! The app must work from a double-click on a completely clean machine — no
//! Python, no ffmpeg, nothing preinstalled. Setup downloads a private Python
//! 3.11 via `uv` (never touches or depends on a system Python), builds a
//! managed runtime under the OS's app-data folder, downloads ffmpeg if it
//! isn't already on PATH, installs PyTorch (CUDA on NVIDIA, MPS on Apple
//! Silicon, CPU otherwise) plus the TTS engines, and downloads the Kokoro
//! weights — streaming every line to the UI so the user can see what is
//! happening instead of watching a spinner.

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

const PYTHON_VERSION: &str = "3.11";
const UV_BASE: &str = "https://github.com/astral-sh/uv/releases/latest/download";

const CUDA_INDEX: &str = "https://download.pytorch.org/whl/cu121";
const CPU_INDEX: &str = "https://download.pytorch.org/whl/cpu";

// Kept in sync with backend/requirements.txt.
const CORE_PACKAGES: [&str; 8] = [
    "fastapi==0.115.6",
    "uvicorn[standard]==0.34.0",
    "pydantic==2.10.4",
    "sqlalchemy==2.0.36",
    "python-multipart==0.0.20",
    "soundfile==0.12.1",
    "numpy>=1.26,<3",
    "huggingface_hub>=0.26",
];

const ENGINE_PACKAGES: [&str; 5] = [
    "qwen-tts",
    "transformers>=4.47",
    "accelerate>=1.2",
    "kokoro==0.9.4",
    "misaki[en]==0.9.4",
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
}

/// Written once setup succeeds, so status checks stay instant on later runs.
#[derive(Serialize, Deserialize, Default, Clone)]
struct Marker {
    python: Option<String>,
    torch: Option<String>,
    engines: bool,
    model_downloaded: bool,
    installed_at: Option<String>,
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

pub fn status() -> SetupStatus {
    let marker = read_marker();
    let runtime = runtime_python();
    SetupStatus {
        ready: runtime.is_some() && marker.engines,
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

/// Private Python 3.11 + venv, entirely under `data_dir()`. Never touches or
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
        &["venv", "--seed", "--python", PYTHON_VERSION, &runtime_dir().to_string_lossy()],
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

    // 1. private Python + runtime venv --------------------------------------
    step(&app, "python", "running", None);
    let runtime_py = ensure_runtime(&app)?;
    let version = capture(&runtime_py, &["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"])
        .unwrap_or_else(|| PYTHON_VERSION.to_string());
    log(&app, format!("Using Python {version} at {}", runtime_py.display()));
    marker.python = Some(version.clone());
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

    // 3. torch ----------------------------------------------------------------
    step(&app, "torch", "running", None);
    let (index, flavour): (Option<&str>, &str) = if cfg!(target_os = "macos") {
        log(&app, "Apple Silicon detected — installing the build with Metal (MPS) support.");
        (None, "mps")
    } else {
        let gpu = if force_cpu { None } else { detect_gpu() };
        match &gpu {
            Some(name) => {
                log(&app, format!("NVIDIA GPU detected: {name} — installing the CUDA build."));
                (Some(CUDA_INDEX), "cuda 12.1")
            }
            None => {
                log(&app, "No NVIDIA GPU detected — installing the CPU build (generation will be slower).");
                (Some(CPU_INDEX), "cpu")
            }
        }
    };
    log(&app, "Downloading PyTorch. This is a large download and can take a while.");
    let mut torch_args = vec!["torch==2.5.1", "torchaudio==2.5.1"];
    if let Some(index) = index {
        torch_args.extend(["--index-url", index]);
    }
    pip(&app, &runtime_py, &torch_args, "Installing PyTorch")?;
    marker.torch = Some(flavour.to_string());
    write_marker(&marker);
    step(&app, "torch", "done", Some(flavour.to_string()));

    // 4. backend + engine packages ----------------------------------------
    step(&app, "engines", "running", None);
    let mut packages: Vec<&str> = CORE_PACKAGES.to_vec();
    packages.extend_from_slice(&ENGINE_PACKAGES);
    pip(&app, &runtime_py, &packages, "Installing the backend and TTS engines")?;
    marker.engines = true;
    write_marker(&marker);
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
