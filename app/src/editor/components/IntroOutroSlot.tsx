import type { Asset, IntroOutroSlot as Slot } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { Waveform } from "./Waveform";

/* The intro/outro are pinned, non-draggable blocks at the very ends of the
 * timeline — kept visually distinct (a teal tint, the DESIGN.md decorative
 * accent rather than the acid-lime action color) so they read as a fixed
 * frame around the body, not just two more clips. */

type SlotChange = (patch: Partial<Slot>, coalesce?: string) => void;

/** Compact picker for an empty slot — lives in the timeline header bar, so
 * it never sits on top of the lanes where clips are dropped. */
export function IntroOutroPicker({
  kind,
  options,
  onChange,
}: {
  kind: "intro" | "outro";
  options: Asset[];
  onChange: SlotChange;
}) {
  return (
    <select
      value=""
      onChange={(e) => e.target.value && onChange({ asset_id: e.target.value })}
      className="max-w-[140px] truncate rounded border border-dashed border-signal-teal/40 bg-transparent px-1.5 py-0.5 text-[11px] text-signal-teal focus:outline-none"
      title={options.length ? `Set the ${kind}` : `Import an ${kind} in the media bin first`}
    >
      <option value="" className="bg-ink-900">
        + {kind}
      </option>
      {options.map((a) => (
        <option key={a.id} value={a.id} className="bg-ink-900">
          {a.name}
        </option>
      ))}
    </select>
  );
}

/** An assigned slot drawn across all lanes. The block itself lets pointer
 * events through (clips under a crossfade stay clickable, drops past the
 * body's end still land on a lane); only its controls capture the mouse. */
export function IntroOutroBlock({
  kind,
  slot,
  left,
  top,
  width,
  height,
  duration,
  onChange,
}: {
  kind: "intro" | "outro";
  slot: Slot & { asset_id: string };
  left: number;
  top: number;
  width: number;
  height: number;
  duration: number;
  onChange: SlotChange;
}) {
  return (
    <div
      className="pointer-events-none absolute z-10 flex flex-col overflow-hidden rounded-md border border-signal-teal/50 bg-signal-teal/10"
      style={{ left, top, width: Math.max(60, width), height }}
    >
      <div className="relative flex-1">
        <Waveform source={{ asset_id: slot.asset_id }} inPoint={0} outPoint={duration} color="rgba(2,184,204,0.7)" />
        <div className="absolute inset-x-1.5 top-0.5 truncate text-[10px] text-signal-teal">
          {kind} · {formatDuration(duration)}
        </div>
        <button
          type="button"
          onClick={() => onChange({ asset_id: null })}
          className="pointer-events-auto absolute right-1 top-0.5 text-[10px] text-ink-400 hover:text-coral-red"
          title={`Remove ${kind}`}
        >
          ×
        </button>
      </div>
      <div className="pointer-events-auto flex items-center gap-1 border-t border-signal-teal/30 bg-ink-950/60 px-1.5 py-0.5 text-[10px] text-signal-teal/80">
        <span>xfade</span>
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={slot.crossfade_ms}
          onChange={(e) => onChange({ crossfade_ms: Number(e.target.value) }, `${kind}:xfade`)}
          className="h-2 min-w-0 flex-1 accent-signal-teal"
        />
        <span className="w-9 text-right font-mono">{slot.crossfade_ms}ms</span>
      </div>
    </div>
  );
}
