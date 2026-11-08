import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type {
  AudioEngine,
  AudioFormat,
  Generation,
  Health,
  KittenStyle,
  Model,
  Profile,
} from "../lib/types";
import { AUDIO_FORMATS, formatBytes, formatDuration, formatWhen, truncate } from "../lib/format";
import type { ModelState } from "../lib/engines";
import { usePreferences } from "../lib/preferences";
import { useRemembered } from "../lib/remember";
import type { ClipSource } from "../components/ClipEdit";
import { KindIcon } from "../components/KindIcon";
import { LicenseChip, ModelPicker, type ModelOption } from "../components/ModelPicker";
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
import { DownloadIcon, FolderIcon, SpinnerIcon, TrashIcon, WandIcon } from "../components/icons";

const ACTIVE: Generation["status"][] = ["queued", "processing"];

/** What the page makes: speech from a script, or a prompt for music / an effect. */
const MODES = ["speech", "music", "sfx"] as const;
type Mode = (typeof MODES)[number];

const MODE_DESCRIPTION: Record<Mode, string> = {
  speech: "Write a script and speak it in one of your voices.",
  music: "Describe a style, add lyrics if you like, and get a song.",
  sfx: "Describe a sound and get an effect or an ambience.",
};

/** Something the Library asks Generate to start from. */
export type GenerateHandoff =
  | { kind: "clip"; source: ClipSource }
  | { kind: "script"; profileId: string; text: string };

export function GeneratePage({
  health,
  onOpenModels,
  handoff,
  onHandoffUsed,
}: {
  health: Health | null;
  /** Take the user to the Models page (install an engine, download weights). */
  onOpenModels: () => void;
  handoff?: GenerateHandoff | null;
  /** Called once the hand-off has been applied, so it isn't applied twice. */
  onHandoffUsed?: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useRemembered<Mode>("voicecraft.generate.mode", "speech", MODES);
  const [engines, setEngines] = useState<AudioEngine[] | null>(null);
  // Every catalog entry (speech, music, sound effects): the voice form's model list
  // and the model names shown in the session list.
  const [models, setModels] = useState<Model[]>([]);
  // The model picked in the Voice form, per engine (a voice belongs to one engine).
  const [pickedModels, setPickedModels] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [profileId, setProfileId] = useState("");
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(1);
  const [chosenStyle, setStyle] = useState<KittenStyle | null>(null);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  // A finished clip the Music / Sound FX form starts from, when the user chose "Edit".
  const [source, setSource] = useState<ClipSource | null>(null);
  // The engines produce WAV; picking another format transcodes it with ffmpeg
  // as part of the job, so the file that lands is the one asked for.
  const preferences = usePreferences();
  const [chosenFormat, setFormat] = useState<AudioFormat | null>(null);
  const format = chosenFormat ?? preferences.default_output_format;
  const style = chosenStyle ?? preferences.default_kitten_style;

  useEffect(() => {
    if (!handoff) return;
    if (handoff.kind === "clip") {
      setMode(handoff.source.kind);
      setSource(handoff.source);
    } else {
      setMode("speech");
      setProfileId(handoff.profileId);
      setText(handoff.text);
    }
    onHandoffUsed?.();
  }, [handoff, onHandoffUsed, setMode]);

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

  // Downloads and "use this one" happen on the Models page; re-read when the mode changes.
  useEffect(() => {
    let current = true;
    api
      .listModels()
      .then((data) => current && setModels(data.models))
      .catch(() => undefined); // the header's health badge already reports an unreachable backend
    return () => {
      current = false;
    };
  }, [mode]);

  const pending = useMemo(
    () => generations.some((generation) => ACTIVE.includes(generation.status)),
    [generations],
  );

  // A finished job leaves its model active (the Models page's choice follows what was
  // used), so re-read the lists once the queue drains instead of showing stale flags.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      api.listModels().then((data) => setModels(data.models)).catch(() => undefined);
      if (mode !== "speech") {
        api.listAudioEngines().then(setEngines).catch(() => undefined);
      }
    }
    wasPending.current = pending;
  }, [pending, mode]);

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

  function startEdit(clip: Generation) {
    if (clip.kind === "speech" || !clip.duration_seconds) return;
    setSource({
      id: clip.id,
      kind: clip.kind,
      text: clip.text,
      seconds: clip.duration_seconds,
    });
    // The form is above the session list; bring it into view.
    document.getElementById("generate-top")?.scrollIntoView({ behavior: "smooth" });
  }

  const profile = profiles.find((item) => item.id === profileId);
  const engineStatus = health?.engines.find((item) => item.name === profile?.engine);
  const kitten = profile?.engine === "kitten";

  // The models this voice's engine can run, and the one the form will use: the pick,
  // else the engine's active model if it is ready, else the first ready one.
  const voiceModels = useMemo(
    () => models.filter((item) => item.category === "speech" && item.engine === profile?.engine),
    [models, profile?.engine],
  );
  const pickedId = profile ? pickedModels[profile.engine] : undefined;
  const voiceModel =
    voiceModels.find((item) => item.id === pickedId) ??
    voiceModels.find((item) => item.active && speechState(item) === "ready") ??
    voiceModels.find((item) => speechState(item) === "ready") ??
    voiceModels.find((item) => item.active) ??
    voiceModels[0];
  const modelState = voiceModel ? speechState(voiceModel) : "ready";
  const modelTitles = useMemo(
    () => new Map(models.map((item) => [item.id, item.title])),
    [models],
  );
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
        ...(voiceModel ? { model_id: voiceModel.id } : {}),
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
      <div id="generate-top" />
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
          source={source?.kind === "music" ? source : null}
          onClearSource={() => setSource(null)}
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
          source={source?.kind === "sfx" ? source : null}
          onClearSource={() => setSource(null)}
        />
      )}

      <form onSubmit={submit} className={mode === "speech" ? "space-y-5" : "hidden"}>
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

        {voiceModels.length > 0 && (
          <ModelPicker
            options={voiceModels.map(
              (item): ModelOption => ({
                id: item.id,
                title: item.title,
                group: item.engine,
                state: speechState(item),
                note:
                  speechState(item) === "download"
                    ? `not downloaded · ${formatBytes(item.download_estimate_bytes)}`
                    : undefined,
              }),
            )}
            value={voiceModel?.id ?? ""}
            onChange={(id) => profile && setPickedModels((c) => ({ ...c, [profile.engine]: id }))}
            onOpenModels={onOpenModels}
            detail={voiceModel && <SpeechDetail model={voiceModel} />}
          />
        )}

        {voiceModel && modelState !== "ready" && (
          <Notice tone="warn">
            {voiceModel.title} {MODEL_STATE_NOTICE[modelState]} Open the Models page to fix that,
            or pick another model above.
          </Notice>
        )}

        {engineStatus && !engineStatus.available && (
          <Notice tone="bad">
            {engineStatus.name} is not installed, so this generation will fail.
            Use “Re-run setup” in Settings to repair the install.
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

        <div className="flex items-end gap-6">
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
          <span className="ml-auto pb-2 text-[13px] tabular-nums text-muted-foreground">
            {words} {words === 1 ? "word" : "words"}
          </span>
          <Field label="Format" className="w-28">
            <OptionSelect
              value={format}
              onChange={(value) => setFormat(value as AudioFormat)}
              options={AUDIO_FORMATS.map((value) => ({
                value,
                label: value.toUpperCase(),
              }))}
            />
          </Field>
          <Button
            type="submit"
            disabled={busy || !profileId || !text.trim() || modelState !== "ready"}
          >
            {busy && <SpinnerIcon />}
            {busy ? "Queueing…" : "Generate"}
          </Button>
        </div>
      </form>

      <Separator className="my-8" />

      <SessionPanel
        mode={mode}
        generations={generations}
        names={names}
        modelTitles={modelTitles}
        exportFormat={preferences.default_output_format}
        onChanged={refresh}
        onEdit={startEdit}
      />
    </>
  );
}

/** The `Generation.kind` each Generate mode produces. */
const MODE_KIND: Record<Mode, Generation["kind"]> = {
  speech: "speech",
  music: "music",
  sfx: "sfx",
};

const EMPTY_TEXT: Record<Mode, string> = {
  speech: "Nothing generated yet — write a script, then press Generate.",
  music: "No music yet — describe a style, then press Generate.",
  sfx: "No sound effects yet — describe a sound, then press Generate.",
};

const EDIT_LABEL: Record<string, string> = {
  variation: "Variation",
  extend: "Extended",
  replace: "Part replaced",
};

/** "Variation" / "Extended" / "Part replaced" for a clip made from another clip. */
function editLabel(clip: Generation): string | undefined {
  const mode = clip.params?.edit;
  return typeof mode === "string" ? EDIT_LABEL[mode] : undefined;
}

function SessionPanel({
  mode,
  generations: all,
  names,
  modelTitles,
  exportFormat,
  onChanged,
  onEdit,
}: {
  /** Only the clips of this mode are listed. */
  mode: Mode;
  generations: Generation[];
  names: Map<string, string>;
  /** Catalog id → title, for the model each clip was made with. */
  modelTitles: Map<string, string>;
  exportFormat: AudioFormat;
  onChanged: () => void | Promise<void>;
  /** Start a new clip from this one (music and effects only). */
  onEdit: (clip: Generation) => void;
}) {
  const toast = useToast();
  const generations = all.filter((g) => g.kind === MODE_KIND[mode]);
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
        <Empty>{EMPTY_TEXT[mode]}</Empty>
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
            const made = typeof g.params?.model === "string" ? g.params.model : undefined;
            const model = made ? (modelTitles.get(made) ?? made) : undefined;
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
                        subtitle: [who, model, formatWhen(g.created_at)]
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
                      model,
                      editLabel(g),
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
                        {g.kind !== "speech" && (
                          <IconButton label="Start a new clip from this one" onClick={() => onEdit(g)}>
                            <WandIcon />
                          </IconButton>
                        )}
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

/** What a speech model needs before it can run, judged from the Models list. */
function speechState(model: Model): ModelState {
  if (model.unavailable_reason) return "unsupported";
  if (!model.engine_available) return "install";
  return model.downloaded ? "ready" : "download";
}

const MODEL_STATE_NOTICE: Record<ModelState, string> = {
  ready: "",
  install: "needs its engine installed.",
  download: "isn't downloaded yet, so this generation would be refused.",
  unsupported: "can't run on this machine.",
};

function SpeechDetail({ model }: { model: Model }) {
  return (
    <>
      <LicenseChip tier={model.license_tier} name={model.license_name} />
      <Badge>{model.clones_voices ? "Clones voices" : "Preset voices"}</Badge>
      {model.languages.length > 0 && (
        <Badge>
          {model.languages.length} language{model.languages.length === 1 ? "" : "s"}
        </Badge>
      )}
      {model.needs_gpu && <Badge>GPU recommended</Badge>}
      <span className="basis-full pt-0.5 leading-relaxed">{model.summary}</span>
    </>
  );
}
