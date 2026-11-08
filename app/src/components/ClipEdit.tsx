import { useEffect, useState } from "react";
import type { AudioEditMode, AudioEditRequest, AudioKind } from "../lib/types";
import { formatDuration } from "../lib/format";
import { Field, Segmented } from "./common";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/**
 * Starting from an existing clip instead of from nothing: a new take of it
 * (variation), a longer version (extend), or one part regenerated (replace).
 *
 * The Music and Sound FX forms own the prompt, the engine and the Generate
 * button; this file owns what is specific to editing: which clip, which of the
 * three, and their one setting each.
 */

/** The clip an edit starts from: a finished music or effect clip. */
export interface ClipSource {
  /** The generation's id. */
  id: string;
  kind: AudioKind;
  /** What it was made from; becomes the starting prompt. */
  text: string;
  seconds: number;
}

interface EditState {
  mode: AudioEditMode;
  /** Variation: 0.05–1, how far the result may move from the clip. */
  strength: number;
  /** Extend: seconds added after the clip. */
  add: number;
  /** Replace: the part to regenerate, in seconds from the clip's start. */
  region: [number, number];
}

const MIN_ADD_SECONDS = 2;
const DEFAULT_ADD_SECONDS = 10;
const STEP = 0.5;

function initialEdit(seconds: number): EditState {
  const third = Math.max(seconds / 3, STEP);
  const start = Math.floor(third / STEP) * STEP;
  const end = Math.min(seconds, Math.ceil((third * 2) / STEP) * STEP);
  return {
    mode: "variation",
    strength: 0.5,
    add: DEFAULT_ADD_SECONDS,
    region: [start, Math.max(end, start + STEP)],
  };
}

/** The most an extension may add: what fits under `limit`, in slider steps (at least the minimum). */
function extendRoom(limit: number, seconds: number): number {
  return Math.max(MIN_ADD_SECONDS, Math.floor((limit - seconds) / STEP) * STEP);
}

/** What the form sends, plus why it can't send it (null when it can). */
export interface BuiltEdit {
  edit: AudioEditRequest;
  /** The result's length: the clip's own, or the clip plus what is added. */
  duration: number;
  problem: string | null;
}

/**
 * The edit's state and the request it adds up to. `limit` is the longest clip the
 * chosen engine makes here. Safe to call without a source (everything is null).
 */
export function useClipEdit(source: ClipSource | null, limit: number) {
  const [state, setState] = useState<EditState>(() => initialEdit(source?.seconds ?? 0));
  const sourceId = source?.id;
  const seconds = source?.seconds ?? 0;
  // A different clip starts from fresh settings: the region of the last one means nothing here.
  useEffect(() => {
    setState(initialEdit(seconds));
  }, [sourceId, seconds]);

  let built: BuiltEdit | null = null;
  if (source) {
    const base = { generation_id: source.id } as const;
    const tooLong =
      source.seconds > limit
        ? `This clip is ${formatDuration(source.seconds)} long; the longest this engine edits here is ${formatDuration(limit)}.`
        : null;
    if (state.mode === "variation") {
      built = {
        edit: { ...base, mode: "variation", strength: state.strength },
        duration: source.seconds,
        problem: tooLong,
      };
    } else if (state.mode === "replace") {
      built = {
        edit: {
          ...base,
          mode: "replace",
          start_seconds: state.region[0],
          end_seconds: Math.min(state.region[1], source.seconds),
        },
        duration: source.seconds,
        problem: tooLong,
      };
    } else {
      const room = limit - source.seconds;
      // What the slider shows is what is sent: never more than fits under the limit.
      const add = Math.min(state.add, extendRoom(limit, source.seconds));
      // Rounded up so what the backend measures never comes out a hair short of "+2 s",
      // but never past the limit itself.
      const duration = Math.min(Math.ceil((source.seconds + add) * 10) / 10, limit);
      built = {
        edit: { ...base, mode: "extend" },
        duration,
        problem:
          room < MIN_ADD_SECONDS
            ? `This clip is already about as long as this engine makes here (${formatDuration(limit)}).`
            : null,
      };
    }
  }
  return { state, setState, built };
}

const MODE_LABEL: Record<AudioEditMode, string> = {
  variation: "Variation",
  extend: "Extend",
  replace: "Replace a part",
};

/** The text on the Generate button for each way of editing. */
export const EDIT_BUTTON: Record<AudioEditMode, string> = {
  variation: "Make variation",
  extend: "Extend",
  replace: "Replace part",
};

const MODE_HINT: Record<AudioEditMode, string> = {
  variation: "A new take that stays close to the clip. The description steers what changes.",
  extend: "Keeps the whole clip and continues it. The description says how it goes on.",
  replace: "Regenerates the marked part and keeps the rest. The description says what goes there.",
};

export function ClipEditPanel({
  source,
  edit,
  limit,
  onClear,
}: {
  source: ClipSource;
  edit: ReturnType<typeof useClipEdit>;
  limit: number;
  onClear: () => void;
}) {
  const { state, setState, built } = edit;
  const room = extendRoom(limit, source.seconds);

  return (
    <div className="space-y-4 rounded-md border bg-card/40 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">Starting from a clip</p>
          <p className="truncate text-xs text-muted-foreground">
            “{source.text}” · {formatDuration(source.seconds)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Start from scratch
        </Button>
      </div>

      <Segmented<AudioEditMode>
        value={state.mode}
        onChange={(mode) => setState((current) => ({ ...current, mode }))}
        className="justify-self-start"
        options={(Object.keys(MODE_LABEL) as AudioEditMode[]).map((value) => ({
          value,
          label: MODE_LABEL[value],
        }))}
      />
      <p className="text-xs text-muted-foreground">{MODE_HINT[state.mode]}</p>

      {state.mode === "variation" && (
        <Field
          label={`How much may change — ${Math.round(state.strength * 100)} %`}
          hint="Low stays nearly the same, high drifts far from the clip."
        >
          <Slider
            min={5}
            max={100}
            step={5}
            value={[Math.round(state.strength * 100)]}
            onValueChange={([next]) =>
              setState((current) => ({ ...current, strength: next / 100 }))
            }
            className="py-2"
          />
        </Field>
      )}

      {state.mode === "extend" && (
        <Field
          label={`Add — ${formatDuration(Math.min(state.add, room))} (result ${formatDuration(
            built?.duration ?? source.seconds,
          )})`}
        >
          <Slider
            min={MIN_ADD_SECONDS}
            max={room}
            step={STEP}
            value={[Math.min(state.add, room)]}
            disabled={room <= MIN_ADD_SECONDS}
            onValueChange={([next]) => setState((current) => ({ ...current, add: next }))}
            className="py-2"
          />
        </Field>
      )}

      {state.mode === "replace" && (
        <Field
          label={`Replace ${state.region[0].toFixed(1)} – ${state.region[1].toFixed(1)} s of ${source.seconds.toFixed(1)} s`}
          hint="Drag the two ends over the part to regenerate."
        >
          <Slider
            min={0}
            max={Math.max(source.seconds, STEP)}
            step={0.1}
            minStepsBetweenThumbs={1}
            value={state.region}
            onValueChange={(next) =>
              setState((current) => ({ ...current, region: [next[0], next[1]] }))
            }
            className="py-2"
          />
        </Field>
      )}

      {built?.problem && <p className="text-[13px] text-coral-red">{built.problem}</p>}
    </div>
  );
}
