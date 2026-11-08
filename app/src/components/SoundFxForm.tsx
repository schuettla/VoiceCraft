import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AudioEngine, AudioFormat, Generation } from "../lib/types";
import { AUDIO_FORMATS } from "../lib/format";
import { chooseEngine, ignoresGuidance, modelViews, type ModelView } from "../lib/engines";
import { usePreferences } from "../lib/preferences";
import { useRemembered } from "../lib/remember";
import { ClipEditPanel, EDIT_BUTTON, useClipEdit, type ClipSource } from "./ClipEdit";
import { AudioModelPicker } from "./AudioModelPicker";
import { EngineGate } from "./EngineGate";
import { useToast } from "./Toaster";
import { Field, OptionSelect } from "./common";
import { SpinnerIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";

const EXAMPLES = ["rain on a window", "crowd murmur", "whoosh", "keyboard typing"];

const ENGINE_MAX_SECONDS = 30;
const MAX_TAKES = 4;
const MAX_SEED = 2 ** 31 - 1;

const FALLBACK_STEPS = 20;

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
  source = null,
  onClearSource,
}: {
  /** Every sound-effect engine the backend knows, default first (null while loading). */
  engines: AudioEngine[] | null;
  loading: boolean;
  format: AudioFormat;
  onFormat: (next: AudioFormat) => void;
  onQueued: (rows: Generation[]) => void;
  onOpenModels: () => void;
  /** A finished clip to start from (variation / extend / replace a part). */
  source?: ClipSource | null;
  onClearSource: () => void;
}) {
  // The last model the user picked; used only while it is still ready.
  const [remembered, setRemembered] = useRemembered<string>("voicecraft.generate.model.sfx", "");
  // What was picked in the list this visit, even if it still needs a download.
  const [picked, setPicked] = useState("");
  const views = useMemo(() => modelViews(engines ?? []), [engines]);
  // Starting from a clip is something only some engines can do, so only they are offered.
  const editors = views.filter((item) => item.editing);
  const pool = source && editors.length ? editors : views;
  const { engine, passedOver } = chooseEngine(pool, remembered, picked);
  const pick = (id: string) => {
    setPicked(id);
    setRemembered(id);
  };
  return (
    <div className="space-y-5">
    <AudioModelPicker models={pool} chosen={engine} onPick={pick} onOpenModels={onOpenModels} />
    <EngineGate
      engine={engine}
      passedOver={passedOver}
      loading={loading}
      subject="Sound effects"
      noun="sound-effect"
      plural
      lead={source && engine ? `Starting from a clip needs ${engine.label}.` : null}
      onOpenModels={onOpenModels}
    >
      {(ready) => (
        <Form
          engine={ready}
          format={format}
          onFormat={onFormat}
          onQueued={onQueued}
          source={source}
          onClearSource={onClearSource}
        />
      )}
    </EngineGate>
    </div>
  );
}

function Form({
  engine,
  format,
  onFormat,
  onQueued,
  source,
  onClearSource,
}: {
  engine: ModelView;
  format: AudioFormat;
  onFormat: (next: AudioFormat) => void;
  onQueued: (rows: Generation[]) => void;
  source: ClipSource | null;
  onClearSource: () => void;
}) {
  const toast = useToast();
  const limit = Math.min(ENGINE_MAX_SECONDS, engine.max_duration_seconds ?? ENGINE_MAX_SECONDS);
  const defaultSteps = engine.default_steps ?? FALLBACK_STEPS;
  const [prompt, setPrompt] = useState("");
  // Untouched, these follow the Settings defaults (which may still be loading).
  const preferences = usePreferences();
  const [wantedSeconds, setSeconds] = useState<number | null>(null);
  const [chosenTakes, setTakes] = useState<number | null>(null);
  const takes = chosenTakes ?? preferences.default_sfx_takes;
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);

  // Starting from a clip: its own description is the best first guess for the new one.
  const edit = useClipEdit(source, limit);
  const editing = source ? edit.built : null;
  const sourceId = source?.id;
  const sourceText = source?.text;
  useEffect(() => {
    if (sourceText) setPrompt(sourceText.slice(0, 4000));
  }, [sourceId, sourceText]);

  // What was asked for is kept when the engine changes; what is used follows it.
  const seconds = Math.max(1, Math.min(wantedSeconds ?? preferences.default_sfx_seconds, limit));
  const guidanceIgnored = ignoresGuidance(engine);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || editing?.problem) return;
    setBusy(true);
    try {
      const rows = await api.generateAudio({
        kind: "sfx",
        engine: engine.name,
        ...(engine.model_id ? { model_id: engine.model_id } : {}),
        prompt,
        duration_seconds: editing ? editing.duration : seconds,
        ...(editing ? { edit: editing.edit } : {}),
        takes,
        output_format: format,
        ...(seed ? { seed: Math.min(Number(seed), MAX_SEED) } : {}),
        ...(steps ? { steps: Math.min(Math.max(Number(steps), 1), 200) } : {}),
        // A value typed for another model stays in the (disabled) box; don't send it.
        ...(guidance && !guidanceIgnored ? { guidance: Math.min(Number(guidance), 50) } : {}),
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
      {source && (
        <ClipEditPanel source={source} edit={edit} limit={limit} onClear={onClearSource} />
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

      <div className={source ? "grid gap-4 sm:grid-cols-[7rem]" : "grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]"}>
        {!source && (
          <Field label={`Length — ${seconds % 1 === 0 ? seconds : seconds.toFixed(1)} s`}>
            <Slider
              min={1}
              max={limit}
              step={0.5}
              value={[seconds]}
              onValueChange={([next]) => setSeconds(next)}
              className="py-2"
            />
          </Field>
        )}
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

      <div className="flex items-end justify-end gap-3">
        <Field label="Format" className="w-28">
          <OptionSelect
            value={format}
            onChange={(value) => onFormat(value as AudioFormat)}
            options={AUDIO_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))}
          />
        </Field>
        <Button type="submit" disabled={busy || !prompt.trim() || !!editing?.problem}>
          {busy && <SpinnerIcon />}
          {busy
            ? "Queueing…"
            : source
              ? takes > 1
                ? `${EDIT_BUTTON[edit.state.mode]} ×${takes}`
                : EDIT_BUTTON[edit.state.mode]
              : takes > 1
                ? `Generate ${takes} takes`
                : "Generate"}
        </Button>
      </div>
    </form>
  );
}
