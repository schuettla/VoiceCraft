import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AudioFormat, Engine, KittenStyle, Preferences, Settings } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { setCachedPreferences } from "../lib/preferences";
import { useToast } from "../components/Toaster";
import { useConfirm } from "../components/Confirm";
import { isTauri } from "../lib/tauri";
import { ATTRIBUTIONS } from "../lib/attributions";
import { ExternalLink } from "../components/ExternalLink";
import {
  Badge,
  Empty,
  Notice,
  OptionSelect,
  PageHeader,
  Section,
  SettingRow,
} from "../components/common";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";

/** Idle times offered for unloading models; a value saved some other way is added to the list. */
const IDLE_MINUTES = [0, 2, 5, 10, 30, 60, 120];

function idleLabel(minutes: number): string {
  if (minutes === 0) return "Never — keep loaded";
  return minutes >= 60 && minutes % 60 === 0
    ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}`
    : `${minutes} minutes`;
}

/** A slider with its value beside it, for the length defaults. */
function ValueSlider({
  value, min, max, step, text, onChange,
}: {
  value: number; min: number; max: number; step: number; text: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex w-64 items-center gap-3">
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next)} />
      <span className="w-14 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">{text}</span>
    </div>
  );
}

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
  const confirm = useConfirm();
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
    setSettings({ ...settings, preferences: next }); // no lag on a control
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
    const ok = await confirm({
      title: "Reclaim space?",
      description:
        "Delete temporary files and any audio no profile, generation, or asset " +
        "points at any more?\n\nAnything still listed in the app is kept.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
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
      <>
        <PageHeader title="Settings" />
        <Empty>{error ?? "Loading…"}</Empty>
      </>
    );
  }

  const { gpu, ffmpeg, preferences } = settings;
  const totalBytes = settings.directories.reduce((sum, dir) => sum + dir.bytes, 0);

  return (
    <>
      <PageHeader
        title="Settings"
        description="What VoiceCraft is running on and where it keeps things. Model downloads and their storage live on the Models page."
      />

      <div className="space-y-10">
        <Section title="Hardware" description="What the engines found on this machine">
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <Row label="GPU">
              {gpu.cuda ? (
                <span className="flex flex-wrap items-center gap-2">
                  {gpu.device_name}
                  <Badge tone="good">CUDA</Badge>
                  {gpu.capability && (
                    <span className="text-muted-foreground">compute {gpu.capability}</span>
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
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
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

          {gpu.detail && <Notice tone="warn">{gpu.detail}</Notice>}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "unload" || settings.engines_loaded.length === 0}
              onClick={() =>
                run("unload", api.unloadModels, "Models unloaded — VRAM released")
              }
            >
              Free VRAM
            </Button>
            <span className="text-xs text-muted-foreground">
              {settings.engines_loaded.length
                ? `Loaded: ${settings.engines_loaded.join(", ")}. Unloading frees the GPU; the next generation reloads them.`
                : "No model is loaded right now."}
            </span>
            {isTauri() && (
              <Button size="sm" variant="outline" className="ml-auto" onClick={onRunSetup}>
                Re-run setup
              </Button>
            )}
          </div>
        </Section>

        <Separator />

        <Section
          title="Defaults"
          description="What new profiles and exports start from — change any of them per job"
        >
          <div>
            <SettingRow label="Engine for new profiles">
              <OptionSelect
                className="w-64"
                value={preferences.default_engine}
                onChange={(value) => void savePreference({ default_engine: value as Engine })}
                options={[
                  { value: "qwen", label: "Qwen3-TTS — voice cloning" },
                  { value: "kitten", label: "KittenTTS 2 — cloning + presets" },
                  { value: "kokoro", label: "Kokoro — preset voices" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Language">
              <OptionSelect
                className="w-64"
                value={preferences.default_language}
                onChange={(value) => void savePreference({ default_language: value })}
                options={LANGUAGES.map(([code, label]) => ({ value: code, label }))}
              />
            </SettingRow>
            <SettingRow label="Export format">
              <OptionSelect
                className="w-64"
                value={preferences.default_output_format}
                onChange={(value) =>
                  void savePreference({ default_output_format: value as AudioFormat })
                }
                options={FORMATS.map((format) => ({
                  value: format,
                  label: format.toUpperCase(),
                }))}
              />
            </SettingRow>
            <SettingRow
              label="Crossfade"
              description="Applied between segments when assembling an episode."
            >
              <div className="flex w-64 items-center gap-3">
                <Slider
                  min={0}
                  max={500}
                  step={10}
                  value={[preferences.default_crossfade_ms]}
                  onValueChange={([next]) =>
                    void savePreference({ default_crossfade_ms: next })
                  }
                />
                <span className="w-14 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
                  {preferences.default_crossfade_ms} ms
                </span>
              </div>
            </SettingRow>
          </div>
        </Section>

        <Separator />

        <Section
          title="Music, sound effects and voices"
          description="Where the Generate forms start, and how long models stay in memory. Each form can still change them per job."
        >
          <div>
            <SettingRow
              label="Music length"
              description="Clamped to what the chosen model makes on this machine."
            >
              <ValueSlider
                min={10}
                max={300}
                step={5}
                value={preferences.default_music_seconds}
                text={formatDuration(preferences.default_music_seconds)}
                onChange={(next) => void savePreference({ default_music_seconds: next })}
              />
            </SettingRow>
            <SettingRow label="Music vocals" description="Models that can't sing stay instrumental.">
              <OptionSelect
                className="w-64"
                value={preferences.default_music_vocals}
                onChange={(value) =>
                  void savePreference({ default_music_vocals: value as Preferences["default_music_vocals"] })
                }
                options={[
                  { value: "instrumental", label: "Instrumental" },
                  { value: "vocals", label: "With lyrics" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Sound effect length">
              <ValueSlider
                min={1}
                max={30}
                step={0.5}
                value={preferences.default_sfx_seconds}
                text={`${preferences.default_sfx_seconds} s`}
                onChange={(next) => void savePreference({ default_sfx_seconds: next })}
              />
            </SettingRow>
            <SettingRow
              label="Sound effect takes"
              description="Variations made one after another. Each one takes as long as a single clip."
            >
              <OptionSelect
                className="w-64"
                value={String(preferences.default_sfx_takes)}
                onChange={(value) => void savePreference({ default_sfx_takes: Number(value) })}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </SettingRow>
            <SettingRow
              label="KittenTTS 2 style"
              description="Expressive is livelier but a little less steady."
            >
              <OptionSelect
                className="w-64"
                value={preferences.default_kitten_style}
                onChange={(value) => void savePreference({ default_kitten_style: value as KittenStyle })}
                options={[
                  { value: "stable", label: "Stable" },
                  { value: "expressive", label: "Expressive" },
                ]}
              />
            </SettingRow>
            <SettingRow
              label="Unload models when idle"
              description="Frees the GPU after this long without a job. The next job then reloads the model, which takes from seconds to about a minute."
            >
              <OptionSelect
                className="w-64"
                value={String(preferences.idle_unload_minutes)}
                onChange={(value) => void savePreference({ idle_unload_minutes: Number(value) })}
                options={[...new Set([...IDLE_MINUTES, preferences.idle_unload_minutes])]
                  .sort((a, b) => a - b)
                  .map((minutes) => ({ value: String(minutes), label: idleLabel(minutes) }))}
              />
            </SettingRow>
          </div>
        </Section>

        <Separator />

        <Section
          title="Storage"
          description={`${formatBytes(totalBytes)} in the data folder${
            settings.free_bytes != null
              ? ` · ${formatBytes(settings.free_bytes)} free on disk`
              : ""
          }`}
          actions={
            <Button size="sm" variant="outline" onClick={() => void api.openDirectory("data")}>
              Open folder
            </Button>
          }
        >
          <p className="truncate font-mono text-xs text-muted-foreground" title={settings.data_dir}>
            {settings.data_dir}
          </p>

          <ul className="divide-y border-y">
            {settings.directories.map((directory) => (
              <li key={directory.key} className="flex items-center gap-3 px-2 py-2.5">
                <span className="flex-1 text-sm text-foreground">{directory.label}</span>
                <span className="text-xs text-muted-foreground">
                  {directory.files} file{directory.files === 1 ? "" : "s"} ·{" "}
                  {formatBytes(directory.bytes)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.openDirectory(directory.key)}
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button size="sm" variant="outline" disabled={busy === "cleanup"} onClick={cleanup}>
              Reclaim space
            </Button>
            <span className="text-xs text-muted-foreground">
              Deletes scratch files and orphans — audio the app no longer lists.
              Everything you can still see stays.
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Database: <span className="font-mono">{settings.db_path}</span> ·{" "}
            {formatBytes(settings.db_bytes)}
          </p>
        </Section>

        <Separator />

        <Section
          title="About"
          description="VoiceCraft is MIT licensed. It ships no model weights: each one is downloaded from its authors, and its license applies to you."
        >
          <ul className="divide-y border-y">
            {ATTRIBUTIONS.map((item) => (
              <li key={item.name} className="space-y-0.5 px-2 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{item.role}</span>
                </div>
                {item.credit && <p className="text-[13px] text-foreground">{item.credit}</p>}
                <p className="text-xs text-muted-foreground">
                  License:{" "}
                  <ExternalLink href={item.licenseUrl} className="text-muted-foreground">
                    {item.license}
                  </ExternalLink>
                  {" · "}
                  <ExternalLink href={item.sourceUrl} className="text-muted-foreground">
                    Model page
                  </ExternalLink>
                </p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Some licenses (KittenTTS 2 and Stability AI's) set conditions such as a
            revenue limit or an attribution. The Models page shows each model's license
            before you download it, and the full terms are at the links above.
          </p>
        </Section>

        <p className="pb-2 text-xs text-muted-foreground">
          VoiceCraft keeps everything on this machine. The only network traffic is
          model downloads, which you start yourself on the Models page.
        </p>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}
