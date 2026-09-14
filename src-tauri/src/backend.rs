//! Spawns and supervises the FastAPI backend (FR12).
//!
//! In an installed app the Python sources ship as Tauri resources and run on
//! the managed runtime that first-run setup built. In a source checkout the
//! repo's own `backend/` and `.venv` are used instead, so `npm run dev` works
//! without going through setup.
//!
//! Whichever path is taken, the child receives `--parent-pid` so it exits on
//! its own if this process is killed without running its shutdown handler.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::setup;

pub const PORT: u16 = 17610;

/// Holds the running backend so it can be killed on app exit.
#[derive(Default)]
pub struct BackendProcess(pub Mutex<Option<CommandChild>>);

type Spawned = (tauri::async_runtime::Receiver<CommandEvent>, CommandChild);

/// Start the backend if it isn't already running. Returns why it couldn't.
pub fn start(app: &AppHandle) -> Result<(), String> {
    {
        let state = app.state::<BackendProcess>();
        let guard = state.0.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
    }

    if let Ok(value) = std::env::var("VOICECRAFT_BACKEND_CMD") {
        if value.eq_ignore_ascii_case("none") {
            println!("[voicecraft] VOICECRAFT_BACKEND_CMD=none — not starting a backend");
            return Ok(());
        }
    }

    let args = vec![
        "--parent-pid".to_string(),
        std::process::id().to_string(),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        PORT.to_string(),
    ];

    match spawn_python(app, &args) {
        Ok((mut events, child)) => {
            *app.state::<BackendProcess>().0.lock().unwrap() = Some(child);
            // Forward backend logs to the console in dev builds.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            print!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Terminated(status) => {
                            println!("[voicecraft] backend exited: {status:?}");
                            break;
                        }
                        _ => {}
                    }
                }
            });
            Ok(())
        }
        Err(error) => {
            eprintln!("[voicecraft] could not start the backend: {error}");
            Err(error)
        }
    }
}

pub fn is_running(app: &AppHandle) -> bool {
    app.state::<BackendProcess>().0.lock().unwrap().is_some()
}

fn spawn_python(app: &AppHandle, args: &[String]) -> Result<Spawned, String> {
    let script = find_backend_script(app).ok_or_else(|| {
        "The backend files are missing from this installation.".to_string()
    })?;
    let python = find_python(&script).ok_or_else(|| {
        "The Python runtime is not installed yet — run setup first.".to_string()
    })?;
    println!(
        "[voicecraft] starting backend: {} {}",
        python.display(),
        script.display()
    );

    let mut command_args = vec![script.to_string_lossy().to_string()];
    command_args.extend_from_slice(args);

    let mut env: HashMap<String, String> = setup::child_env().into_iter().collect();
    if let Some(ffmpeg) = setup::find_ffmpeg() {
        // The bundled ffmpeg isn't on PATH, so hand the backend its location.
        if let Some(dir) = ffmpeg.parent() {
            let ffprobe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
            env.insert(
                "VOICECRAFT_FFPROBE".into(),
                dir.join(ffprobe_name).to_string_lossy().to_string(),
            );
        }
        env.insert("VOICECRAFT_FFMPEG".into(), ffmpeg.to_string_lossy().to_string());
    }

    app.shell()
        .command(python.to_string_lossy().to_string())
        .args(command_args)
        .env_clear()
        .envs(env)
        .spawn()
        .map_err(|e| e.to_string())
}

/// Bundled resources first, then a source checkout.
fn find_backend_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("backend").join("main.py");
        if bundled.is_file() {
            return Some(bundled);
        }
    }

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(cwd.ancestors().map(Path::to_path_buf));
    }
    roots
        .into_iter()
        .map(|root| root.join("backend").join("main.py"))
        .find(|candidate| candidate.is_file())
}

/// The managed runtime wins; a checkout's `.venv` is the developer fallback.
fn find_python(script: &Path) -> Option<PathBuf> {
    if let Some(runtime) = setup::runtime_python() {
        return Some(runtime);
    }
    let repo_root = script.parent().and_then(Path::parent)?;
    [
        repo_root.join(".venv/Scripts/python.exe"),
        repo_root.join(".venv/bin/python"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

pub fn stop(app: &AppHandle) {
    if let Some(child) = app.state::<BackendProcess>().0.lock().unwrap().take() {
        println!("[voicecraft] stopping backend");
        let _ = child.kill();
    }
}
