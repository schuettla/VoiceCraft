import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AudioFormat, Generation, Health, Profile } from "../lib/types";
import { AUDIO_FORMATS, formatDuration, formatWhen, truncate } from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useToast } from "../components/Toaster";
import { TrackRow } from "../components/TrackRow";
import {
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Notice,
  Panel,
  Select,
  Textarea,
} from "../components/ui";
import { DownloadIcon, FolderIcon, TrashIcon } from "../components/icons";

const ACTIVE: Generation["status"][] = ["queued", "processing"];

export function GeneratePage({ health }: { health: Health | null }) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [profileId, setProfileId] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  // The engines produce WAV; picking another format transcodes it with ffmpeg
  // as part of the job, so the file that lands is the one asked for.
  const preferences = usePreferences();
  const [chosenFormat, setFormat] = useState<AudioFormat | null>(null);
  const format = chosenFormat ?? preferences.default_output_format;

  const refresh = useCallback(async () => {
    try {
      setGenerations(await api.listGenerations());
    } catch {
      /* the header's health badge already reports an unreachable backend */
    }
  }, []);

  useEffect(() => {
    api
      .listProfiles()
      .then((list) => {
        setProfiles(list);
        setProfileId((current) => current || list[0]?.id || "");
      })
      .catch((error: Error) => toast(error.message, "error"));
    void refresh();
  }, [refresh, toast]);

  const pending = useMemo(
    () => generations.some((generation) => ACTIVE.includes(generation.status)),
    [generations],
  );

  useEffect(() => {
    if (!pending) return;
    // Poll only while something is actually running (FR5).
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

  const profile = profiles.find((item) => item.id === profileId);
  const engineStatus = health?.engines.find((item) => item.name === profile?.engine);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!profileId) return;
    setBusy(true);
    try {
      const generation = await api.generate({
        profile_id: profileId,
        text,
        speed,
        output_format: format,
      });
      setGenerations((current) => [generation, ...current]);
      toast("Generation queued", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const names = useMemo(
    () => new Map(profiles.map((p) => [p.id, p.name])),
    [profiles],
  );

  return (
    <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <Panel title="Script" subtitle="Paste the text to speak in the selected voice">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Voice profile">
            <Select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              disabled={profiles.length === 0}
            >
              {profiles.length === 0 && <option value="">No profiles yet</option>}
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {item.engine}
                  {item.preset_voice ? ` (${item.preset_voice})` : ""}
                </option>
              ))}
            </Select>
          </Field>

          {engineStatus && !engineStatus.available && (
            <Notice tone="bad">
              {engineStatus.name} is not installed, so this generation will fail.
              See backend/README.md for the install command.
            </Notice>
          )}
          {profile?.engine === "qwen" && engineStatus?.device === "cpu" && (
            <Notice tone="warn">
              CUDA unavailable — Qwen3-TTS is running on CPU and will be slow.
            </Notice>
          )}

          <Field label="Text">
            <Textarea
              rows={12}
              required
              value={text}
              placeholder="Welcome back to the show…"
              onChange={(e) => setText(e.target.value)}
            />
          </Field>

          <Field label={`Speed — ${speed.toFixed(2)}×`}>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </Field>

          <div className="flex items-end gap-3 border-t border-ink-700 pt-4">
            <div className="w-28">
              <Field label="Format">
                <Select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as AudioFormat)}
                >
                  {AUDIO_FORMATS.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <span className="pb-2 text-[13px] text-ink-400">{words} words</span>
            <Button
              type="submit"
              variant="primary"
              className="ml-auto"
              disabled={busy || !profileId || !text.trim()}
            >
              {busy ? "Queueing…" : "Generate"}
            </Button>
          </div>
        </form>
      </Panel>

      <SessionPanel
        generations={generations}
        names={names}
        exportFormat={preferences.default_output_format}
        onChanged={refresh}
      />
    </div>
  );
}

function SessionPanel({
  generations,
  names,
  exportFormat,
  onChanged,
}: {
  generations: Generation[];
  names: Map<string, string>;
  exportFormat: AudioFormat;
  onChanged: () => void | Promise<void>;
}) {
  const toast = useToast();
  const recent = generations.slice(0, 20);
  const running = recent.filter((g) => ACTIVE.includes(g.status));
  const rest = recent.filter((g) => !ACTIVE.includes(g.status));

  async function reveal(path: string | null) {
    if (!path) return;
    try {
      await api.reveal(path);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function exportAs(id: string) {
    try {
      const asset = await api.convert({ generation_id: id, output_format: exportFormat });
      toast(`Exported ${asset.name}`, "success");
      await onChanged();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteGeneration(id);
      await onChanged();
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <Panel
      title="This session"
      subtitle={
        generations.length
          ? `${generations.length} generation${generations.length === 1 ? "" : "s"} · newest first`
          : "Results land here as they finish"
      }
    >
      {recent.length === 0 ? (
        <Empty>Nothing generated yet — write a script and press Generate.</Empty>
      ) : (
        <div className="space-y-1">
          {running.map((g) => (
            <TrackRow
              key={g.id}
              busy
              title={truncate(g.text, 90)}
              meta={g.status === "processing" ? "Generating…" : "Queued"}
              badge={<Badge tone="busy">{g.status}</Badge>}
            />
          ))}
          {running.length > 0 && rest.length > 0 && (
            <div className="my-2 border-t border-ink-700" />
          )}
          {rest.map((g) => {
            const done = g.status === "completed" && !!g.audio_path;
            const who = g.profile_id ? names.get(g.profile_id) : undefined;
            return (
              <TrackRow
                key={g.id}
                track={
                  done
                    ? {
                        id: g.id,
                        path: g.audio_path!,
                        title: truncate(g.text, 90),
                        subtitle: [who, formatWhen(g.created_at)]
                          .filter(Boolean)
                          .join(" · "),
                      }
                    : undefined
                }
                meta={
                  g.status === "failed" ? (
                    <span className="text-coral-red">{g.error ?? "Generation failed"}</span>
                  ) : (
                    [
                      who,
                      formatWhen(g.created_at),
                      g.duration_seconds != null && formatDuration(g.duration_seconds),
                      g.format?.toUpperCase(),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  )
                }
                badge={
                  g.status === "failed" ? <Badge tone="bad">failed</Badge> : undefined
                }
                actions={
                  <>
                    {done && (
                      <>
                        <IconButton label="Show file" onClick={() => reveal(g.audio_path)}>
                          <FolderIcon />
                        </IconButton>
                        <IconButton
                          label={`Export as ${exportFormat.toUpperCase()}`}
                          onClick={() => exportAs(g.id)}
                        >
                          <DownloadIcon />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      label="Delete"
                      className="hover:text-coral-red"
                      onClick={() => remove(g.id)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}
