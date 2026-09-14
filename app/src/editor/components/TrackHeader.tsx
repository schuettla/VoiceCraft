import type { EditorTrack } from "../../lib/types";
import { cx, IconButton } from "../../components/ui";
import { TrashIcon } from "../../components/icons";
import { useEditor } from "../store";
import * as ops from "../ops";
import { HEADER_WIDTH } from "../constants";

const KIND_DOT: Record<EditorTrack["kind"], string> = {
  voice: "bg-signal-teal",
  music: "bg-pulse-green",
  sfx: "bg-coral-red",
  other: "bg-ink-400",
};

export function TrackHeader({ track, otherTracks }: { track: EditorTrack; otherTracks: EditorTrack[] }) {
  const editor = useEditor();
  const data = editor.state.data;
  const selectedClipId = [...editor.state.selection.clipIds][0];
  const selectedClip = data.clips.find((c) => c.id === selectedClipId);
  // "Active" = the track a clip is selected on, or the track itself is
  // selected (its header was clicked) — the only visual cue for which track
  // the Inspector is currently editing.
  const isActive = selectedClip ? selectedClip.track_id === track.id : editor.state.selection.trackId === track.id;

  function patch(next: Partial<EditorTrack>, coalesce?: string) {
    editor.apply(ops.updateTrack(data, track.id, next), { coalesce });
  }

  const duckAgainst = track.duck.against_track_ids[0] ?? "";

  return (
    <div
      className={cx(
        "flex h-full flex-col justify-center gap-1 border-r border-l-2 border-r-ink-700 px-2.5 py-1.5",
        isActive ? "border-l-accent bg-accent/[0.07]" : "border-l-transparent bg-ink-900",
      )}
      style={{ width: HEADER_WIDTH }}
      onClick={() => editor.select({ clipIds: new Set(), trackId: track.id })}
    >
      <div className="flex items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${KIND_DOT[track.kind]}`} />
        <input
          value={track.name}
          onChange={(e) => patch({ name: e.target.value }, `track:${track.id}:name`)}
          className={cx(
            "min-w-0 flex-1 truncate bg-transparent text-[12px] focus:outline-none",
            isActive ? "text-white" : "text-ink-100",
          )}
        />
        <IconButton
          label="Delete track"
          className="hover:text-coral-red"
          onClick={() => editor.apply(ops.removeTrack(data, track.id))}
        >
          <TrashIcon />
        </IconButton>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => patch({ mute: !track.mute })}
          className={`grid size-5 shrink-0 place-items-center rounded text-[10px] font-medium transition ${
            track.mute ? "bg-coral-red text-white" : "bg-white/5 text-ink-400 hover:text-ink-200"
          }`}
          title="Mute"
        >
          M
        </button>
        <button
          type="button"
          onClick={() => patch({ solo: !track.solo })}
          className={`grid size-5 shrink-0 place-items-center rounded text-[10px] font-medium transition ${
            track.solo ? "bg-accent text-ink-950" : "bg-white/5 text-ink-400 hover:text-ink-200"
          }`}
          title="Solo"
        >
          S
        </button>
        <input
          type="range"
          min={-60}
          max={12}
          step={1}
          value={track.gain_db}
          onChange={(e) => patch({ gain_db: Number(e.target.value) }, `track:${track.id}:gain`)}
          className="h-3 min-w-0 flex-1 accent-accent"
          title={`Gain ${track.gain_db} dB`}
        />
      </div>

      {otherTracks.length > 0 && (
        <label className="flex items-center gap-1 text-[10px] text-ink-400" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={track.duck.enabled}
            onChange={(e) =>
              editor.apply(
                ops.updateDuck(data, track.id, {
                  enabled: e.target.checked,
                  against_track_ids: track.duck.against_track_ids.length
                    ? track.duck.against_track_ids
                    : [otherTracks[0].id],
                }),
              )
            }
            className="size-3 accent-accent"
          />
          duck under
          <select
            disabled={!track.duck.enabled}
            value={duckAgainst}
            onChange={(e) =>
              editor.apply(ops.updateDuck(data, track.id, { against_track_ids: [e.target.value] }))
            }
            className="min-w-0 flex-1 truncate bg-transparent text-ink-300 disabled:opacity-40"
          >
            {otherTracks.map((t) => (
              <option key={t.id} value={t.id} className="bg-ink-900">
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
