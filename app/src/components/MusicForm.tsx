import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AudioEngine, AudioFormat, Generation } from "../lib/types";
import { AUDIO_FORMATS, formatDuration, formatMinutes } from "../lib/format";
import { chooseEngine, ignoresGuidance, readyEngines } from "../lib/engines";
import { useRemembered } from "../lib/remember";
import { EngineGate } from "./EngineGate";
import { useToast } from "./Toaster";
import { Field, Notice, OptionSelect, Segmented } from "./common";
import { SpinnerIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

const EXAMPLES = [
  "lo-fi hip hop, warm Rhodes, soft drums, 85 bpm",
  "cinematic orchestral, slow build, strings and timpani",
  "upbeat synthwave, driving bass, 120 bpm",
  "gentle acoustic guitar, folk, warm and intimate",
];

// The limits the backend enforces (models.py): the engine's documented ranges.
const MIN_SECONDS = 10;
const DEFAULT_SECONDS = 30;
const ENGINE_MAX_SECONDS = 600;
const STYLE_MAX_CHARS = 512;
const LYRICS_MAX_CHARS = 4096;
const MAX_SEED = 2 ** 31 - 1;

/**
 * What the one measured card did (GTX 1060 6 GB, Phase 0, turbo, 8 steps,
 * instrumental, no language model): about a minute to load the model, and 71 s
 * for a 30 s clip. Scaled linearly with length and steps, and shown only when
 * the engine reports an offloaded card, for the turbo model, so it is never a
 * guess about hardware or a model that wasn't measured.
 */
const MEASURED_LOAD_SECONDS = 60;
const MEASURED_SECONDS_PER_30S_AT_8_STEPS = 71;
const MEASURED_MODEL = "acestep-1.5-turbo";
const MEASURED_STEPS = 8;

type Vocals = "instrumental" | "vocals";

/**
 * The Music mode of the Generate page. Until the engine is installed, supported
 * and has its weights, the form is replaced by a card that says what is missing
 * (`EngineGate`).
 */
export function MusicForm({
  engines,
  loading,
  format,
  onFormat,
  onQueued,
  onOpenModels,
}: {
  /** Every music engine the backend knows, default first (null while loading). */
  engines: AudioEngine[] | null;
  loading: boolean;
  format: AudioFormat;
  onFormat: (next: AudioFormat) => void;
  onQueued: (rows: Generation[]) => void;
  onOpenModels: () => void;
}) {
  // The last engine the user picked; used only while it is still ready.
  const [remembered, setRemembered] = useRemembered<string>("voicecraft.generate.engine.music", "");
  const { engine, passedOver } = chooseEngine(engines ?? [], remembered);
  const choices = readyEngines(engines ?? []);
  return (
    <EngineGate
      engine={engine}
      passedOver={passedOver}
      loading={loading}
      subject="Music generation"
      noun="music"
      onOpenModels={onOpenModels}
    >
      {(ready) => (
        <Form
          engine={ready}
          choices={choices}
          onEngine={setRemembered}
          format={format}
          onFormat={onFormat}
          onQueued={onQueued}
        />
      )}
    </EngineGate>
  );
}

function Form({
  engine,
  choices,
  onEngine,
  format,
  onFormat,
  onQueued,
}: {
  engine: AudioEngine;
  /** Engines that would run right now; a selector shows when there are two or more. */
  choices: AudioEngine[];
  onEngine: (name: string) => void;
  format: AudioFormat;
  onFormat: (next: AudioFormat) => void;
  onQueued: (rows: Generation[]) => void;
}) {
  const toast = useToast();
  const limit = Math.max(
    MIN_SECONDS,
    Math.min(ENGINE_MAX_SECONDS, engine.max_duration_seconds ?? ENGINE_MAX_SECONDS),
  );
  const [style, setStyle] = useState("");
  const [wantedVocals, setVocals] = useState<Vocals>("instrumental");
  const [lyrics, setLyrics] = useState("");
  const [wantedSeconds, setSeconds] = useState(DEFAULT_SECONDS);
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);

  // A different engine can have a shorter limit or no vocals; what was asked for
  // is kept, and what is used follows the engine on screen.
  const seconds = Math.min(wantedSeconds, limit);
  const vocals: Vocals = engine.lyrics ? wantedVocals : "instrumental";

  const guidanceIgnored = ignoresGuidance(engine);
  const defaultSteps = engine.default_steps ?? MEASURED_STEPS;

  const estimate = useMemo(() => {
    if (!engine.warning || engine.model_id !== MEASURED_MODEL) return null;
    const render =
      MEASURED_SECONDS_PER_30S_AT_8_STEPS *
      (seconds / 30) *
      ((Number(steps) || defaultSteps) / MEASURED_STEPS);
    return MEASURED_LOAD_SECONDS + render;
  }, [engine.warning, engine.model_id, seconds, steps, defaultSteps]);

  const needsLyrics = vocals === "vocals" && !lyrics.trim();
  const ready = !!style.trim() && !needsLyrics;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const rows = await api.generateAudio({
        kind: "music",
        engine: engine.name,
        prompt: style,
        duration_seconds: seconds,
        output_format: format,
        ...(vocals === "vocals" ? { lyrics } : {}),
        ...(seed ? { seed: Math.min(Number(seed), MAX_SEED) } : {}),
        ...(steps ? { steps: Math.min(Math.max(Number(steps), 1), 200) } : {}),
        ...(guidance ? { guidance: Math.min(Number(guidance), 50) } : {}),
      });
      onQueued(rows);
      toast("Generation queued", "success");
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {engine.warning && <Notice tone="warn">{engine.warning}</Notice>}

      {choices.length > 1 && (
        <Field label="Engine">
          <OptionSelect
            value={engine.name}
            onChange={onEngine}
            options={choices.map((choice) => ({ value: choice.name, label: choice.label }))}
          />
        </Field>
      )}

      <Field
        label="Style"
        hint={`${style.length} / ${STYLE_MAX_CHARS}. Genre, instruments, mood, tempo.`}
      >
        <Textarea
          rows={3}
          required
          maxLength={STYLE_MAX_CHARS}
          value={style}
          placeholder="lo-fi hip hop, warm Rhodes, soft drums, 85 bpm, relaxed"
          onChange={(e) => setStyle(e.target.value)}
          className="resize-y text-[15px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setStyle(example)}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              {example.split(",")[0]}
            </button>
          ))}
        </div>
      </Field>

      {engine.lyrics ? (
        <Field label="Vocals">
          <Segmented<Vocals>
            value={vocals}
            onChange={setVocals}
            className="justify-self-start"
            options={[
              { value: "instrumental", label: "Instrumental" },
              { value: "vocals", label: "With lyrics" },
            ]}
          />
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">
          {engine.label} makes instrumentals only. Pick another engine for vocals.
        </p>
      )}

      {vocals === "vocals" && (
        <Field
          label="Lyrics"
          hint={
            <>
              {lyrics.length} / {LYRICS_MAX_CHARS}. Mark sections with tags like{" "}
              <code>[verse]</code>, <code>[chorus]</code> and <code>[bridge]</code>.
            </>
          }
        >
          <Textarea
            rows={9}
            maxLength={LYRICS_MAX_CHARS}
            value={lyrics}
            placeholder={"[verse]\nWalking home beneath the rain\n\n[chorus]\nWe keep on going"}
            onChange={(e) => setLyrics(e.target.value)}
            className="min-h-40 resize-y text-[15px] leading-relaxed"
          />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <Field
          label={`Length — ${formatDuration(seconds)}`}
          hint={
            engine.max_duration_seconds && engine.max_duration_seconds < ENGINE_MAX_SECONDS
              ? `Up to ${formatDuration(engine.max_duration_seconds)} on this GPU.`
              : undefined
          }
        >
          <Slider
            min={MIN_SECONDS}
            max={limit}
            step={limit > 60 ? 5 : 1}
            value={[seconds]}
            onValueChange={([next]) => setSeconds(next)}
            className="py-2"
          />
        </Field>
        <Field label="Format">
          <OptionSelect
            value={format}
            onChange={(value) => onFormat(value as AudioFormat)}
            options={AUDIO_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))}
          />
        </Field>
      </div>

      <details className="group rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-[13px] text-muted-foreground select-none group-open:mb-3">
          Advanced: seed, steps, guidance
        </summary>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Seed (optional)" hint="Same seed, same song.">
            <Input
              value={seed}
              inputMode="numeric"
              placeholder="random"
              onChange={(e) => setSeed(e.target.value.replace(/\D/g, "").slice(0, 10))}
            />
          </Field>
          <Field label="Steps" hint="More steps are slower.">
            <Input
              value={steps}
              inputMode="numeric"
              placeholder={String(defaultSteps)}
              onChange={(e) => setSteps(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
          </Field>
          <Field
            label="Guidance"
            hint={guidanceIgnored ? "This model ignores this." : "How closely it follows the style."}
          >
            <Input
              value={guidance}
              inputMode="decimal"
              disabled={guidanceIgnored}
              placeholder={String(engine.default_guidance ?? 7)}
              onChange={(e) => setGuidance(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))}
            />
          </Field>
        </div>
      </details>

      <div className="flex items-center gap-4">
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {estimate && (
            <p>
              Roughly {formatMinutes(estimate)} including loading the model, on a 6 GB GPU
              (measured on a GTX 1060, instrumental).
            </p>
          )}
          {engine.model_title && <p>Model: {engine.model_title}. Change it on the Models page.</p>}
        </div>
        <Button type="submit" className="ml-auto" disabled={busy || !ready}>
          {busy && <SpinnerIcon />}
          {busy ? "Queueing…" : "Generate"}
        </Button>
      </div>
    </form>
  );
}
