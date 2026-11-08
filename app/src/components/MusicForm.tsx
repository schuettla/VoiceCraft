import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { AudioEngine, AudioFormat, Generation } from "../lib/types";
import { AUDIO_FORMATS, formatDuration } from "../lib/format";
import { chooseEngine, ignoresGuidance, modelViews, type ModelView } from "../lib/engines";
import { usePreferences } from "../lib/preferences";
import { useRemembered } from "../lib/remember";
import { ClipEditPanel, EDIT_BUTTON, useClipEdit, type ClipSource } from "./ClipEdit";
import { AudioModelPicker } from "./AudioModelPicker";
import { EngineGate } from "./EngineGate";
import { useToast } from "./Toaster";
import { Field, OptionSelect, Segmented } from "./common";
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
const ENGINE_MAX_SECONDS = 600;
const STYLE_MAX_CHARS = 512;
const LYRICS_MAX_CHARS = 4096;
const MAX_SEED = 2 ** 31 - 1;

const FALLBACK_STEPS = 8;

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
  source = null,
  onClearSource,
}: {
  /** Every music engine the backend knows, default first (null while loading). */
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
  const [remembered, setRemembered] = useRemembered<string>("voicecraft.generate.model.music", "");
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
      subject="Music generation"
      noun="music"
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
  const limit = Math.max(
    MIN_SECONDS,
    Math.min(ENGINE_MAX_SECONDS, engine.max_duration_seconds ?? ENGINE_MAX_SECONDS),
  );
  const [style, setStyle] = useState("");
  // Untouched, these follow the Settings defaults (which may still be loading).
  const preferences = usePreferences();
  const [chosenVocals, setVocals] = useState<Vocals | null>(null);
  const [lyrics, setLyrics] = useState("");
  const [wantedSeconds, setSeconds] = useState<number | null>(null);
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
    if (sourceText) setStyle(sourceText.slice(0, STYLE_MAX_CHARS));
  }, [sourceId, sourceText]);

  // A different engine can have a shorter limit or no vocals; what was asked for
  // is kept, and what is used follows the engine on screen.
  const seconds = Math.min(wantedSeconds ?? preferences.default_music_seconds, limit);
  const vocals: Vocals = engine.lyrics && !source ? (chosenVocals ?? preferences.default_music_vocals) : "instrumental";

  const guidanceIgnored = ignoresGuidance(engine);
  const defaultSteps = engine.default_steps ?? FALLBACK_STEPS;

  const needsLyrics = vocals === "vocals" && !lyrics.trim();
  const ready = !!style.trim() && !needsLyrics && !editing?.problem;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const rows = await api.generateAudio({
        kind: "music",
        engine: engine.name,
        ...(engine.model_id ? { model_id: engine.model_id } : {}),
        prompt: style,
        duration_seconds: editing ? editing.duration : seconds,
        output_format: format,
        ...(editing ? { edit: editing.edit } : {}),
        ...(vocals === "vocals" ? { lyrics } : {}),
        ...(seed ? { seed: Math.min(Number(seed), MAX_SEED) } : {}),
        ...(steps ? { steps: Math.min(Math.max(Number(steps), 1), 200) } : {}),
        // A value typed for another model stays in the (disabled) box; don't send it.
        ...(guidance && !guidanceIgnored ? { guidance: Math.min(Number(guidance), 50) } : {}),
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
      {source && (
        <ClipEditPanel source={source} edit={edit} limit={limit} onClear={onClearSource} />
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

      {source ? null : engine.lyrics ? (
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
          {engine.label} makes instrumentals only. Pick another model for vocals.
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

      {!source && (
        <Field label={`Length — ${formatDuration(seconds)}`}>
          <Slider
            min={MIN_SECONDS}
            max={limit}
            step={limit > 60 ? 5 : 1}
            value={[seconds]}
            onValueChange={([next]) => setSeconds(next)}
            className="py-2"
          />
        </Field>
      )}

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

      <div className="flex items-end gap-3">
        <Field label="Format" className="ml-auto w-28">
          <OptionSelect
            value={format}
            onChange={(value) => onFormat(value as AudioFormat)}
            options={AUDIO_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))}
          />
        </Field>
        <Button type="submit" disabled={busy || !ready}>
          {busy && <SpinnerIcon />}
          {busy ? "Queueing…" : source ? EDIT_BUTTON[edit.state.mode] : "Generate"}
        </Button>
      </div>
    </form>
  );
}
