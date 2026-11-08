mod backend;
mod setup;

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

use backend::BackendProcess;
use setup::{EngineAction, SetupLock, SetupStatus};

/// What the onboarding screen polls: engine install state + whether the
/// backend is up.
#[tauri::command]
fn setup_status(app: AppHandle) -> SetupStatus {
    let mut status = setup::status();
    status.ready = status.ready && backend::is_running(&app);
    status
}

/// Kick off the install on a worker thread; progress arrives as events.
#[tauri::command]
fn setup_install(app: AppHandle, lock: State<'_, SetupLock>, force_cpu: bool) -> Result<(), String> {
    if lock.0.swap(true, Ordering::SeqCst) {
        return Err("Setup is already running.".into());
    }
    let flag = lock.0.clone();
    std::thread::spawn(move || {
        let result = setup::install(app.clone(), force_cpu);
        flag.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => {
                // Spawning the backend touches the shell plugin's channels, so
                // it has to happen on the async runtime — not on this worker
                // thread, where it silently fails.
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    match backend::start(&handle) {
                        Ok(()) => {
                            let _ = tauri::Emitter::emit(&handle, "setup:done", ());
                        }
                        Err(error) => {
                            let _ = tauri::Emitter::emit(&handle, "setup:failed", error);
                        }
                    }
                });
            }
            Err(error) => {
                let _ = tauri::Emitter::emit(&app, "setup:failed", error);
            }
        }
    });
    Ok(())
}

/// Install or remove a music / SFX engine on a worker thread. Shares the setup
/// lock, so it can't overlap first-run setup or another engine job.
fn spawn_engine_job(
    app: AppHandle,
    lock: &SetupLock,
    name: String,
    action: EngineAction,
) -> Result<(), String> {
    let spec = setup::audio_engine(&name)?; // reject an unknown name before taking the lock
    let engine = spec.name;
    if lock.0.swap(true, Ordering::SeqCst) {
        return Err("Another install is already running.".into());
    }
    let flag = lock.0.clone();
    std::thread::spawn(move || {
        let result = setup::run_engine_job(&app, engine, action);
        flag.store(false, Ordering::SeqCst);
        // The backend was stopped for the job; bring it back whatever happened.
        // As in `setup_install`, that has to run on the async runtime.
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let restart = backend::start(&handle);
            let (state, detail) = match (result, restart) {
                (Ok(()), Ok(())) => ("done", None),
                (Ok(()), Err(error)) => ("failed", Some(format!("Done, but the backend did not restart: {error}"))),
                (Err(error), _) => ("failed", Some(error)),
            };
            setup::engine_event(&handle, engine, action, state, detail);
        });
    });
    Ok(())
}

#[tauri::command]
fn engine_install(app: AppHandle, lock: State<'_, SetupLock>, name: String) -> Result<(), String> {
    spawn_engine_job(app, &lock, name, EngineAction::Install)
}

#[tauri::command]
fn engine_uninstall(app: AppHandle, lock: State<'_, SetupLock>, name: String) -> Result<(), String> {
    spawn_engine_job(app, &lock, name, EngineAction::Uninstall)
}

/// Retry starting the backend (after setup, or after a crash).
#[tauri::command]
fn backend_start(app: AppHandle) -> Result<(), String> {
    backend::start(&app)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Only plain `https://` links are opened: the page names the license and
/// project links itself, so nothing else (a `file:` path, a custom scheme, a
/// command line smuggled in as a URL) has any business being launched.
fn checked_url(url: &str) -> Result<&str, String> {
    let ok = url.starts_with("https://")
        && url.len() <= 2048
        && url.chars().all(|c| c.is_ascii_graphic());
    if ok {
        Ok(url)
    } else {
        Err("Only https links can be opened.".to_string())
    }
}

/// Open a link in the user's default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = checked_url(&url)?;
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::checked_url;

    #[test]
    fn only_https_links_pass() {
        assert!(checked_url("https://www.apache.org/licenses/LICENSE-2.0").is_ok());
        assert!(checked_url("https://huggingface.co/a/b/blob/main/LICENSE.md?x=1&y=2").is_ok());
        assert!(checked_url("http://example.com").is_err());
        assert!(checked_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(checked_url("calc.exe").is_err());
        assert!(checked_url("https://a.com/ b").is_err());
        assert!(checked_url("https://a.com/\nb").is_err());
        assert!(checked_url("").is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess::default())
        .manage(SetupLock::default())
        .invoke_handler(tauri::generate_handler![
            setup_status,
            setup_install,
            engine_install,
            engine_uninstall,
            backend_start,
            open_path,
            open_url
        ])
        .setup(|app| {
            // Best effort: if the runtime isn't installed yet this fails and
            // the UI shows the setup wizard instead.
            let _ = backend::start(&app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                backend::stop(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start VoiceCraft")
        .run(|app, event| {
            // Belt and braces: kill the backend on every exit path (FR12). The
            // Python side also watches our pid in case we die uncleanly.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                backend::stop(app);
            }
        });
}
