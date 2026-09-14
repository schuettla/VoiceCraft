import type { EditorTrack, TimelineClip } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { Button, Field, Panel } from "../../components/ui";
import { useToast } from "../../components/Toaster";
import { api } from "../../lib/api";
import { useAudio } from "../../components/AudioPlayer";
import { useEditor } from "../store";
import { useMedia } from "../MediaContext";
import { useLayout } from "../useLayout";
import * as ops from "../ops";
import { EffectsChain } from "./EffectsChain";

export function Inspector() {
  const editor = useEditor();
  const data = editor.state.data;
  const selectedClipId = [...editor.state.selection.clipIds][0];
  const selectedClip = data.clips.find((c) => c.id === selectedClipId);
  const trackId = selectedClip?.track_id ?? editor.state.selection.trackId;
  const track = data.tracks.find((t) => t.id === trackId);

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 overflow-x-hidden overflow-y-auto border-l border-ink-700 bg-ink-950 p-3">
      {selectedClip ? (
        <ClipPanel clip={selectedClip} />
      ) : (
        <Panel title="Clip" className="!rounded-none" bodyClassName="p-3">
          <p className="text-[12px] text-ink-500">Select a clip on the timeline to edit it.</p>
        </Panel>
      )}
      {track && <TrackPanel track={track} />}
      <MasterPanel />
    </div>
  );
}

function ClipPanel({ clip }: { clip: TimelineClip }) {
  const editor = useEditor();
  const media = useMedia();
  const toast = useToast();
  const audio = useAudio();
  const { bodyOffset } = useLayout().layout;
  const data = editor.state.data;
  const source = media.byKey.get(ops.sourceKey(clip.source));
  const duration = source?.duration ?? 0;
  const length = ops.clipLength(clip, duration);

  /** Sliders pass the field name so one drag collapses into one undo step. */
  function patch(next: Partial<TimelineClip>, field?: string) {
    editor.apply(ops.updateClip(data, clip.id, next), field ? { coalesce: `clip:${clip.id}:${field}` } : undefined);
  }

  async function auditionEffect() {
    try {
      const { path } = await api.previewClip(clip.id, data);
      audio.play({ id: `preview:${clip.id}`, path, title: `${source?.title ?? "clip"} (preview)` });
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  /** Freeze this clip's effect chain into a new, reusable clip asset — the
   * source is untouched, so this is purely a shortcut for reusing an edit. */
  async function bounce() {
    try {
      const asset = await api.bounce({ clip_id: clip.id, data, name: `${source?.title ?? "clip"} (bounced)` });
      await media.refresh();
      toast(`Bounced to "${asset.name}"`, "success");
    } catch (error) {
      toast((error as Error).message, "error");
    }
  }

  return (
    <Panel title="Clip" subtitle={source?.title} className="!rounded-none" bodyClassName="p-3">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-[11px] text-ink-400">
          <span>Start {formatDuration(clip.start)}</span>
          <span>Length {formatDuration(length)}</span>
        </div>
        <Field label={`Gain — ${clip.gain_db.toFixed(1)} dB`}>
          <input
            type="range" min={-60} max={24} step={0.5} value={clip.gain_db}
            onChange={(e) => patch({ gain_db: Number(e.target.value) }, "gain")}
            className="w-full accent-accent"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Fade in — ${clip.fade_in.toFixed(2)}s`}>
            <input
              type="range" min={0} max={Math.min(10, length)} step={0.05} value={clip.fade_in}
              onChange={(e) => patch({ fade_in: Number(e.target.value) }, "fade_in")}
              className="w-full accent-accent"
            />
          </Field>
          <Field label={`Fade out — ${clip.fade_out.toFixed(2)}s`}>
            <input
              type="range" min={0} max={Math.min(10, length)} step={0.05} value={clip.fade_out}
              onChange={(e) => patch({ fade_out: Number(e.target.value) }, "fade_out")}
              className="w-full accent-accent"
            />
          </Field>
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-300">
          <input
            type="checkbox" checked={clip.muted}
            onChange={(e) => patch({ muted: e.target.checked })}
            className="size-3.5 accent-accent"
          />
          Muted
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            onClick={() => editor.apply(ops.duplicateClip(data, clip.id, duration))}
          >
            Duplicate
          </Button>
          <Button
            size="sm"
            onClick={() =>
              editor.apply(ops.splitClip(data, clip.id, editor.state.playhead - bodyOffset))
            }
          >
            Split at playhead
          </Button>
          <Button size="sm" onClick={() => void bounce()} title="Freeze this clip's effects into a reusable asset">
            Bounce to clip
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              editor.apply(ops.removeClip(data, clip.id));
              editor.selectClip(null);
            }}
          >
            Delete
          </Button>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-300">Effects</p>
          <EffectsChain
            effects={clip.effects}
            onChange={(effects, coalesce) =>
              editor.apply(ops.setClipEffects(data, clip.id, effects), { coalesce })
            }
            onAudition={auditionEffect}
          />
        </div>
      </div>
    </Panel>
  );
}

function TrackPanel({ track }: { track: EditorTrack }) {
  const editor = useEditor();
  const data = editor.state.data;

  function patch(next: Partial<EditorTrack>, field: string) {
    editor.apply(ops.updateTrack(data, track.id, next), { coalesce: `track:${track.id}:${field}` });
  }

  return (
    <Panel title="Track" subtitle={track.name} className="!rounded-none" bodyClassName="p-3">
      <div className="space-y-3">
        <Field label={`Gain — ${track.gain_db.toFixed(1)} dB`}>
          <input
            type="range" min={-60} max={12} step={0.5} value={track.gain_db}
            onChange={(e) => patch({ gain_db: Number(e.target.value) }, "gain")}
            className="w-full accent-accent"
          />
        </Field>
        <Field label={`Pan — ${track.pan.toFixed(2)}`}>
          <input
            type="range" min={-1} max={1} step={0.05} value={track.pan}
            onChange={(e) => patch({ pan: Number(e.target.value) }, "pan")}
            className="w-full accent-accent"
          />
        </Field>
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-300">Effects</p>
          <EffectsChain
            effects={track.effects}
            onChange={(effects, coalesce) =>
              editor.apply(ops.setTrackEffects(data, track.id, effects), { coalesce })
            }
          />
        </div>
      </div>
    </Panel>
  );
}

function MasterPanel() {
  const editor = useEditor();
  const data = editor.state.data;

  function patchLoudness(next: Partial<typeof data.master.loudness>, coalesce?: string) {
    editor.apply(
      { ...data, master: { ...data.master, loudness: { ...data.master.loudness, ...next } } },
      { coalesce },
    );
  }

  return (
    <Panel title="Master" className="!rounded-none" bodyClassName="p-3">
      <div className="space-y-3">
        <label className="flex items-center gap-1.5 text-[12px] text-ink-300">
          <input
            type="checkbox" checked={data.master.loudness.enabled}
            onChange={(e) => patchLoudness({ enabled: e.target.checked })}
            className="size-3.5 accent-accent"
          />
          Normalize loudness on export
        </label>
        {data.master.loudness.enabled && (
          <Field label={`Target — ${data.master.loudness.target_lufs.toFixed(0)} LUFS`}>
            <input
              type="range" min={-40} max={-8} step={1} value={data.master.loudness.target_lufs}
              onChange={(e) => patchLoudness({ target_lufs: Number(e.target.value) }, "master:lufs")}
              className="w-full accent-accent"
            />
          </Field>
        )}
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-ink-300">Master effects</p>
          <EffectsChain
            effects={data.master.effects}
            onChange={(effects, coalesce) => editor.apply(ops.setMasterEffects(data, effects), { coalesce })}
          />
        </div>
      </div>
    </Panel>
  );
}
