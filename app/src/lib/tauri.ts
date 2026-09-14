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
}

export interface SetupStep {
  step: "python" | "runtime" | "ffmpeg" | "torch" | "engines" | "model";
  state: "running" | "done" | "failed" | "skipped";
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
  startBackend: () => invoke<void>("backend_start"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
};
