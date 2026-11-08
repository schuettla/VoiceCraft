import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type {
  AudioEngine,
  AudioFormat,
  Generation,
  Health,
  KittenStyle,
  Profile,
} from "../lib/types";
import { AUDIO_FORMATS, formatDuration, formatWhen, truncate } from "../lib/format";
import { usePreferences } from "../lib/preferences";
import { useRemembered } from "../lib/remember";
import { KindIcon } from "../components/KindIcon";
import { MusicForm } from "../components/MusicForm";
import { SoundFxForm } from "../components/SoundFxForm";
import { useToast } from "../components/Toaster";
import { TrackRow } from "../components/TrackRow";
import {
  Badge,
  Empty,
  Field,
  IconButton,
  Notice,
  OptionSelect,
  PageHeader,
  Section,
  Segmented,
} from "../components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { DownloadIcon, FolderIcon, SpinnerIcon, TrashIcon } from "../components/icons";

const ACTIVE: Generation["status"][] = ["queued", "processing"];

/** What the page makes: speech from a script, or a prompt for music / an effect. */
const MODES = ["speech", "music", "sfx"] as const;
type Mode = (typeof MODES)[number];

const MODE_DESCRIPTION: Record<Mode, string> = {
  speech: "Write a script and speak it in one of your voices.",
  music: "Describe a style, add lyrics if you like, and get a song.",
  sfx: "Describe a sound and get an effect or an ambience.",
};

export function GeneratePage({
  health,
  onOpenModels,
}: {
  health: Health | null;
  /** Take the user to the Models page (install an engine, download weights). */
  onOpenModels: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useRemembered<Mode>("voicecraft.generate.mode", "speech", MODES);
  const [engines, setEngines] = useState<AudioEngine[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [profileId, setProfileId] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [style, setStyle] = useState<KittenStyle>("stable");
  const [seed, setSeed] = useState("");
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

  // The engine list is what decides between the form and the install card, and
  // it changes on the Models page. Re-read it whenever Music or Sound FX opens.
  useEffect(() => {
    if (mode === "speech") return;
    let current = true;
    api
      .listAudioEngines()
      .then((list) => current && setEngines(list))
      .catch(() => current && setEngines([])); // an unreachable backend is shown by the header
    return () => {
      current = false;
    };
  }, [mode]);

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

  const queued = useCallback(
    (rows: Generation[]) => setGenerations((current) => [...rows, ...current]),
    [],
  );

  const profile = profiles.find((item) => item.id === profileId);
  const engineStatus = health?.engines.find((item) => item.name === profile?.engine);
  const kitten = profile?.engine === "kitten";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!profileId) return;
    setBusy(true);
    try {
      const generation = await api.generate({
        profile_id: profileId,
        text,
        speed: kitten ? 1 : speed,
        output_format: format,
        // Only KittenTTS 2 reads these; the backend ignores them elsewhere.
        ...(kitten ? { preset: style, ...(seed ? { seed: Number(seed) } : {}) } : {}),
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
    <>
      <PageHeader
        title="Generate"
        description={MODE_DESCRIPTION[mode]}
        actions={
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "speech", label: "Voice" },
              { value: "music", label: "Music" },
              { value: "sfx", label: "Sound FX" },
            ]}
          />
        }
      />

      {mode === "music" && (
        <MusicForm
          engines={engines?.filter((item) => item.kind === "music") ?? null}
          loading={engines === null}
          format={format}
          onFormat={setFormat}
          onQueued={queued}
          onOpenModels={onOpenModels}
        />
      )}

      {mode === "sfx" && (
        <SoundFxForm
          engines={engines?.filter((item) => item.kind === "sfx") ?? null}
          loading={engines === null}
          format={format}
          onFormat={setFormat}
          onQueued={queued}
          onOpenModels={onOpenModels}
        />
      )}

      <form onSubmit={submit} className={mode === "speech" ? "space-y-5" : "hidden"}>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <Field label="Voice">
            <OptionSelect
              value={profileId}
              onChange={setProfileId}
              disabled={profiles.length === 0}
              placeholder="No profiles yet"
              options={profiles.map((item) => ({
                value: item.id,
                label: `${item.name} — ${item.engine}${item.preset_voice ? ` (${item.preset_voice})` : ""}`,
              }))}
            />
          </Field>
          <Field label="Format">
            <OptionSelect
              value={format}
              onChange={(value) => setFormat(value as AudioFormat)}
              options={AUDIO_FORMATS.map((value) => ({
                value,
                label: value.toUpperCase(),
              }))}
            />
          </Field>
        </div>

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
        {kitten && engineStatus?.device === "cpu" && (
          <Notice tone="warn">
            CUDA unavailable — KittenTTS 2 is running on CPU, about 15× slower than real
            time. A short line takes a minute or more.
          </Notice>
        )}

        <Field label="Script">
          <Textarea
            rows={12}
            required
            value={text}
            placeholder="Welcome back to the show…"
            onChange={(e) => setText(e.target.value)}
            className="min-h-64 resize-y text-[15px] leading-relaxed"
          />
        </Field>

        {kitten && (
          <div className="space-y-2">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,10rem)]">
              <Field label="Style" hint="Expressive is livelier but a little less steady.">
                <OptionSelect
                  value={style}
                  onChange={(value) => setStyle(value as KittenStyle)}
                  options={[
                    { value: "stable", label: "Stable" },
                    { value: "expressive", label: "Expressive" },
                  ]}
                />
              </Field>
              <Field label="Seed (optional)" hint="Same seed, same take.">
                <Input
                  value={seed}
                  inputMode="numeric"
                  placeholder="random"
                  onChange={(e) => setSeed(e.target.value.replace(/\D/g, "").slice(0, 9))}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Tags: start a line with an emotion like <code>[joyful]</code>, add sounds such
              as <code>&lt;laugh&gt;</code>, and stress a word with <code>(((word)))</code>.
            </p>
          </div>
        )}

        <div className="flex items-center gap-6">
          {kitten ? (
            // KittenTTS 2 has no speed control; saying so beats a slider that does nothing.
            <p className="w-64 text-xs text-muted-foreground">
              KittenTTS 2 sets its own pace — there is no speed control.
            </p>
          ) : (
            <Field label={`Speed — ${speed.toFixed(2)}×`} className="w-64">
              <Slider
                min={0.5}
                max={2}
                step={0.05}
                value={[speed]}
                onValueChange={([next]) => setSpeed(next)}
                className="py-2"
              />
            </Field>
          )}
          <span className="ml-auto self-end pb-2 text-[13px] tabular-nums text-muted-foreground">
            {words} {words === 1 ? "word" : "words"}
          </span>
          <Button type="submit" className="self-end" disabled={busy || !profileId || !text.trim()}>
            {busy && <SpinnerIcon />}
            {busy ? "Queueing…" : "Generate"}
          </Button>
        </div>
      </form>

      <Separator className="my-8" />

      <SessionPanel
        generations={generations}
        names={names}
        exportFormat={preferences.default_output_format}
        onChanged={refresh}
      />
    </>
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
    <Section
      title="This session"
      description={
        generations.length
          ? `${generations.length} generation${generations.length === 1 ? "" : "s"} · newest first`
          : "Results land here as they finish"
      }
    >
      {recent.length === 0 ? (
        <Empty>Nothing generated yet — write a script or describe a sound, then press Generate.</Empty>
      ) : (
        <div className="divide-y border-y">
          {running.map((g) => (
            <TrackRow
              key={g.id}
              busy
              leading={<KindIcon kind={g.kind} />}
              title={truncate(g.text, 90)}
              meta={g.status === "processing" ? "Generating…" : "Queued"}
              badge={<Badge tone="busy">{g.status}</Badge>}
            />
          ))}
          {rest.map((g) => {
            const done = g.status === "completed" && !!g.audio_path;
            // The voice's name belongs to speech; music and effects have none.
            const who = g.kind === "speech" && g.profile_id ? names.get(g.profile_id) : undefined;
            return (
              <TrackRow
                key={g.id}
                leading={<KindIcon kind={g.kind} />}
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
    </Section>
  );
}
