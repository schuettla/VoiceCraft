import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AudioFormat, Engine, Preferences, Settings } from "../lib/types";
import { formatBytes } from "../lib/format";
import { setCachedPreferences } from "../lib/preferences";
import { useToast } from "../components/Toaster";
import { isTauri } from "../lib/tauri";
import { Badge, Button, Empty, Field, Panel, Select } from "../components/ui";

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
] as const;

const FORMATS: AudioFormat[] = ["wav", "mp3", "ogg", "flac"];

export function SettingsPage({ onRunSetup }: { onRunSetup: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.settings();
      setSettings(next);
      setCachedPreferences(next.preferences);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(id: string, action: () => Promise<unknown>, done?: string) {
    setBusy(id);
    try {
      await action();
      await refresh();
      if (done) toast(done, "success");
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function savePreference(patch: Partial<Preferences>) {
    if (!settings) return;
    const next = { ...settings.preferences, ...patch };
    setSettings({ ...settings, preferences: next }); // no lag on a <select>
    setCachedPreferences(next);
    try {
      const saved = await api.savePreferences(next);
      setSettings(saved);
      setCachedPreferences(saved.preferences);
    } catch (caught) {
      toast((caught as Error).message, "error");
      await refresh();
    }
  }

  async function cleanup() {
    if (
      !window.confirm(
        "Delete temporary files and any audio no profile, generation, or asset " +
          "points at any more?\n\nAnything still listed in the app is kept.",
      )
    ) {
      return;
    }
    setBusy("cleanup");
    try {
      const result = await api.cleanup();
      await refresh();
      toast(
        result.files_removed
          ? `Removed ${result.files_removed} file(s), freed ${formatBytes(result.bytes_freed)}`
          : "Nothing to clean up",
        "success",
      );
    } catch (caught) {
      toast((caught as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  if (!settings) {
    return (
      <div className="mx-auto max-w-4xl">
        <Panel title="Settings">
          <Empty>{error ?? "Loading…"}</Empty>
        </Panel>
      </div>
    );
  }

  const { gpu, ffmpeg, preferences } = settings;
  const totalBytes = settings.directories.reduce((sum, dir) => sum + dir.bytes, 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-medium text-white">Settings</h1>
        <p className="mt-1 text-sm text-ink-400">
          What VoiceCraft is running on and where it keeps things. Model
          downloads and their storage live on the Models tab.
        </p>
      </div>

      <Panel title="Hardware" subtitle="What the engines found on this machine">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Row label="GPU">
            {gpu.cuda ? (
              <span className="flex flex-wrap items-center gap-2">
                {gpu.device_name}
                <Badge tone="good">CUDA</Badge>
                {gpu.capability && (
                  <span className="text-ink-400">compute {gpu.capability}</span>
                )}
              </span>
            ) : (
              <Badge tone="warn">no CUDA device</Badge>
            )}
          </Row>
          <Row label="VRAM">
            {gpu.vram_total_bytes
              ? `${formatBytes(gpu.vram_free_bytes)} free of ${formatBytes(gpu.vram_total_bytes)}`
              : "—"}
          </Row>
          <Row label="PyTorch">{gpu.torch ?? "not installed"}</Row>
          <Row label="Precision">{gpu.precision ?? "—"}</Row>
          <Row label="ffmpeg">
            {ffmpeg.available ? (
              <span className="flex items-center gap-2">
                <Badge tone="good">found</Badge>
                <span className="truncate font-mono text-[11px] text-ink-400">
                  {ffmpeg.ffmpeg_path}
                </span>
              </span>
            ) : (
              <Badge tone="bad">not found — trim, assemble and convert will fail</Badge>
            )}
          </Row>
          <Row label="Backend">
            <span className="font-mono text-[11px]">
              {settings.host}:{settings.port}
            </span>
          </Row>
        </dl>

        {gpu.detail && (
          <p className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            {gpu.detail}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy === "unload" || settings.engines_loaded.length === 0}
            onClick={() =>
              run("unload", api.unloadModels, "Models unloaded — VRAM released")
            }
          >
            Free VRAM
          </Button>
          <span className="text-xs text-ink-400">
            {settings.engines_loaded.length
              ? `Loaded: ${settings.engines_loaded.join(", ")}. Unloading frees the GPU; the next generation reloads them.`
              : "No model is loaded right now."}
          </span>
          {isTauri() && (
            <Button size="sm" className="ml-auto" onClick={onRunSetup}>
              Re-run setup
            </Button>
          )}
        </div>
      </Panel>

      <Panel
        title="Defaults"
        subtitle="What new profiles and exports start from — change any of them per job"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Engine for new profiles">
            <Select
              value={preferences.default_engine}
              onChange={(event) =>
                void savePreference({ default_engine: event.target.value as Engine })
              }
            >
              <option value="qwen">Qwen3-TTS — voice cloning</option>
              <option value="kokoro">Kokoro — preset voices</option>
            </Select>
          </Field>

          <Field label="Language">
            <Select
              value={preferences.default_language}
              onChange={(event) =>
                void savePreference({ default_language: event.target.value })
              }
            >
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Export format">
            <Select
              value={preferences.default_output_format}
              onChange={(event) =>
                void savePreference({
                  default_output_format: event.target.value as AudioFormat,
                })
              }
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={`Crossfade — ${preferences.default_crossfade_ms} ms`}
            hint="Applied between segments when assembling an episode."
          >
            <input
              type="range"
              min={0}
              max={500}
              step={10}
              value={preferences.default_crossfade_ms}
              onChange={(event) =>
                void savePreference({
                  default_crossfade_ms: Number(event.target.value),
                })
              }
              className="w-full accent-accent"
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Storage"
        subtitle={`${formatBytes(totalBytes)} in the data folder${
          settings.free_bytes != null ? ` · ${formatBytes(settings.free_bytes)} free on disk` : ""
        }`}
        actions={
          <Button size="sm" onClick={() => void api.openDirectory("data")}>
            Open folder
          </Button>
        }
      >
        <p className="mb-3 truncate font-mono text-xs text-ink-400" title={settings.data_dir}>
          {settings.data_dir}
        </p>

        <ul className="divide-y divide-ink-700 overflow-hidden rounded-lg border border-ink-700">
          {settings.directories.map((directory) => (
            <li
              key={directory.key}
              className="flex items-center gap-3 bg-ink-800/40 px-3 py-2"
            >
              <span className="flex-1 text-sm text-ink-200">{directory.label}</span>
              <span className="text-xs text-ink-400">
                {directory.files} file{directory.files === 1 ? "" : "s"} ·{" "}
                {formatBytes(directory.bytes)}
              </span>
              <Button size="sm" onClick={() => void api.openDirectory(directory.key)}>
                Open
              </Button>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy === "cleanup"} onClick={cleanup}>
            Reclaim space
          </Button>
          <span className="text-xs text-ink-400">
            Deletes scratch files and orphans — audio the app no longer lists.
            Everything you can still see stays.
          </span>
        </div>

        <p className="mt-3 text-xs text-ink-400">
          Database: <span className="font-mono">{settings.db_path}</span> ·{" "}
          {formatBytes(settings.db_bytes)}
        </p>
      </Panel>

      <p className="px-1 pb-2 text-xs text-ink-400">
        VoiceCraft keeps everything on this machine. The only network traffic is
        model downloads, which you start yourself on the Models tab.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-ink-200">{children}</dd>
    </div>
  );
}
