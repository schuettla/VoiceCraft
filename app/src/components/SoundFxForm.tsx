import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AudioEngine, AudioFormat, Generation } from "../lib/types";
import { AUDIO_FORMATS, formatMinutes } from "../lib/format";
import { chooseEngine, ignoresGuidance, readyEngines } from "../lib/engines";
import { useRemembered } from "../lib/remember";
import { EngineGate } from "./EngineGate";
import { useToast } from "./Toaster";
import { Field, Notice, OptionSelect } from "./common";
import { SpinnerIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

const EXAMPLES = ["rain on a window", "crowd murmur", "whoosh", "keyboard typing"];

const DEFAULT_SECONDS = 3;
const ENGINE_MAX_SECONDS = 30;
const MAX_TAKES = 4;
const MAX_SEED = 2 ** 31 - 1;

/**
 * Time on the one GPU this was measured on (GTX 1060 6 GB, Phase 0): 5.85 s per
 * step, plus about a minute to load the model and decode. It is shown only when
 * the engine reports that the card needs offloading, because on any other card
 * it would be a guess dressed as a measurement.
 */
const SECONDS_PER_STEP_OFFLOADED = 5.85;
const LOAD_SECONDS = 60;
const FALLBACK_STEPS = 20;
const MEASURED_ENGINE = "moss_sfx";

/**
 * The Sound FX mode of the Generate page. Until the engine is installed,
 * supported and has its weights, the form is replaced by a card that says what
 * is missing (`EngineGate`).
 */
export function SoundFxForm({
  engines,
  loading,
  format,
  onFormat,
  onQueued,
  onOpenModels,
}: {
  /** Every sound-effect engine the backend knows, default first (null while loading). */
  engines: AudioEngine[] | null;
  loading: boolean;
  format: AudioFormat;
  onFormat: (next: AudioFormat) => void;
  onQueued: (rows: Generation[]) => void;
  onOpenModels: () => void;
}) {
  // The last engine the user picked; used only while it is still ready.
  const [remembered, setRemembered] = useRemembered<string>("voicecraft.generate.engine.sfx", "");
  const { engine, passedOver } = chooseEngine(engines ?? [], remembered);
  const choices = readyEngines(engines ?? []);
  return (
    <EngineGate
      engine={engine}
      passedOver={passedOver}
      loading={loading}
      subject="Sound effects"
      noun="sound-effect"
      plural
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
  const limit = Math.min(ENGINE_MAX_SECONDS, engine.max_duration_seconds ?? ENGINE_MAX_SECONDS);
  const defaultSteps = engine.default_steps ?? FALLBACK_STEPS;
  const [prompt, setPrompt] = useState("");
  const [wantedSeconds, setSeconds] = useState(DEFAULT_SECONDS);
  const [takes, setTakes] = useState(1);
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);

  // What was asked for is kept when the engine changes; what is used follows it.
  const seconds = Math.min(wantedSeconds, limit);
  const guidanceIgnored = ignoresGuidance(engine);

  // Measured for MOSS on the one offloaded card only. Another engine with a
  // warning (Stable Audio 3 on a CPU) would get the wrong number.
  const estimate = useMemo(() => {
    if (engine.name !== MEASURED_ENGINE || !engine.warning) return null;
    const perClip = (Number(steps) || defaultSteps) * SECONDS_PER_STEP_OFFLOADED;
    return perClip * takes + LOAD_SECONDS;
  }, [engine.name, engine.warning, steps, takes, defaultSteps]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const rows = await api.generateAudio({
        kind: "sfx",
        engine: engine.name,
        prompt,
        duration_seconds: seconds,
        takes,
        output_format: format,
        ...(seed ? { seed: Math.min(Number(seed), MAX_SEED) } : {}),
        ...(steps ? { steps: Math.min(Math.max(Number(steps), 1), 200) } : {}),
        ...(guidance ? { guidance: Math.min(Number(guidance), 50) } : {}),
      });
      onQueued(rows);
      toast(rows.length > 1 ? `${rows.length} takes queued` : "Generation queued", "success");
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

      <Field label="Describe it">
        <Textarea
          rows={3}
          required
          maxLength={4000}
          value={prompt}
          placeholder="Heavy wooden door slamming in an empty stone hallway"
          onChange={(e) => setPrompt(e.target.value)}
          className="resize-y text-[15px] leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setPrompt(example)}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              {example}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem_7rem]">
        <Field
          label={`Length — ${seconds % 1 === 0 ? seconds : seconds.toFixed(1)} s`}
          hint={
            engine.name === MEASURED_ENGINE && engine.warning
              ? "Rendering takes the same time whatever the length, so ask for the length you need."
              : undefined
          }
        >
          <Slider
            min={1}
            max={limit}
            step={0.5}
            value={[seconds]}
            onValueChange={([next]) => setSeconds(next)}
            className="py-2"
          />
        </Field>
        <Field label="Takes" hint="Variations, one after another.">
          <OptionSelect
            value={String(takes)}
            onChange={(value) => setTakes(Number(value))}
            options={Array.from({ length: MAX_TAKES }, (_, i) => ({
              value: String(i + 1),
              label: String(i + 1),
            }))}
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
          <Field label="Seed (optional)" hint="Same seed, same take. Several takes count up from it.">
            <Input
              value={seed}
              inputMode="numeric"
              placeholder="random"
              onChange={(e) => setSeed(e.target.value.replace(/\D/g, "").slice(0, 10))}
            />
          </Field>
          <Field label="Steps" hint="More steps are slower, and sound a little cleaner.">
            <Input
              value={steps}
              inputMode="numeric"
              placeholder={String(defaultSteps)}
              onChange={(e) => setSteps(e.target.value.replace(/\D/g, "").slice(0, 3))}
            />
          </Field>
          <Field
            label="Guidance"
            hint={guidanceIgnored ? "This model ignores this." : "How closely it follows the text."}
          >
            <Input
              value={guidance}
              inputMode="decimal"
              disabled={guidanceIgnored}
              placeholder={String(engine.default_guidance ?? 4)}
              onChange={(e) => setGuidance(e.target.value.replace(/[^\d.]/g, "").slice(0, 5))}
            />
          </Field>
        </div>
      </details>

      <div className="flex items-center gap-4">
        <p className="text-xs text-muted-foreground">
          {estimate
            ? `Roughly ${formatMinutes(estimate)} on a 6 GB GPU, measured on a GTX 1060.`
            : ""}
        </p>
        <Button
          type="submit"
          className="ml-auto"
          disabled={busy || !prompt.trim()}
        >
          {busy && <SpinnerIcon />}
          {busy ? "Queueing…" : takes > 1 ? `Generate ${takes} takes` : "Generate"}
        </Button>
      </div>
    </form>
  );
}
