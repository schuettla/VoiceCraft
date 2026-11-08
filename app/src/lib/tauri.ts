import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

/** False when the UI is opened in a plain browser (`npm run app:dev`). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface SetupStatus {
  ready: boolean;
  python_version: string | null;
  runtime_python: string | null;
  torch: string | null;
  engines: boolean;
  model_downloaded: boolean;
  ffmpeg: string | null;
  gpu: string | null;
  data_dir: string;
  platform: string;
  /** The installed runtime is older than this app needs; setup rebuilds it. */
  needs_runtime_update: boolean;
}

export interface SetupStep {
  step: "python" | "runtime" | "ffmpeg" | "torch" | "engines" | "model";
  state: "running" | "done" | "failed" | "skipped";
  detail: string | null;
}

/** Progress of a music / SFX engine install or uninstall (`engine:state`). */
export interface EngineState {
  engine: string;
  action: "install" | "uninstall";
  /** "done" arrives after the backend has been started again. */
  state: "running" | "done" | "failed";
  detail: string | null;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Only available in the desktop app.");
  return tauriInvoke<T>(command, args);
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const unlisten = await tauriListen<T>(event, (e) => handler(e.payload));
  return unlisten;
}

export const setupApi = {
  status: () => invoke<SetupStatus>("setup_status"),
  install: (forceCpu: boolean) => invoke<void>("setup_install", { forceCpu }),
  /** Install a music / SFX engine's Python packages. Stops and restarts the backend. */
  installEngine: (name: string) => invoke<void>("engine_install", { name }),
  /** Remove an engine's packages (weights are deleted from the Models list). */
  uninstallEngine: (name: string) => invoke<void>("engine_uninstall", { name }),
  startBackend: () => invoke<void>("backend_start"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  /** Open an https link in the default browser (the shell has no opener plugin). */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

/** Open a link outside the app: the system browser in the desktop shell, a new
 * tab in a plain browser. Falls back to doing nothing visible only if both fail. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await setupApi.openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
