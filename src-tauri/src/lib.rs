mod backend;
mod setup;

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

use backend::BackendProcess;
use setup::{SetupLock, SetupStatus};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess::default())
        .manage(SetupLock::default())
        .invoke_handler(tauri::generate_handler![
            setup_status,
            setup_install,
            backend_start,
            open_path
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
