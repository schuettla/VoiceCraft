import type { ReactNode } from "react";
import type { EditorTrack, TimelineClip } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { Field } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "../../components/Toaster";
import { api } from "../../lib/api";
import { useAudio } from "../../components/AudioPlayer";
import { useEditor } from "../store";
import { useMedia } from "../MediaContext";
import { useLayout } from "../useLayout";
import * as ops from "../ops";
import { EffectsChain } from "./EffectsChain";

/** The inspector is one continuous column: sections are divided by hairlines,
 * not wrapped in boxes. */
function InspectorSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b px-4 py-4">
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

/** A labelled slider that reports plain numbers. */
function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
        className="py-1.5"
      />
    </Field>
  );
}

export function Inspector() {
  const editor = useEditor();
  const data = editor.state.data;
  const selectedClipId = [...editor.state.selection.clipIds][0];
  const selectedClip = data.clips.find((c) => c.id === selectedClipId);
  const trackId = selectedClip?.track_id ?? editor.state.selection.trackId;
  const track = data.tracks.find((t) => t.id === trackId);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden overflow-y-auto border-l bg-background">
      {selectedClip ? (
        <ClipPanel clip={selectedClip} />
      ) : (
        <InspectorSection title="Clip">
          <p className="text-xs text-muted-foreground">Select a clip on the timeline to edit it.</p>
        </InspectorSection>
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
    <InspectorSection title="Clip" subtitle={source?.title}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 text-xs tabular-nums text-muted-foreground">
          <span>Start {formatDuration(clip.start)}</span>
          <span>Length {formatDuration(length)}</span>
        </div>
        <Range
          label={`Gain — ${clip.gain_db.toFixed(1)} dB`}
          min={-60} max={24} step={0.5} value={clip.gain_db}
          onChange={(v) => patch({ gain_db: v }, "gain")}
        />
        <div className="grid grid-cols-2 gap-3">
          <Range
            label={`Fade in — ${clip.fade_in.toFixed(2)}s`}
            min={0} max={Math.max(0.05, Math.min(10, length))} step={0.05} value={clip.fade_in}
            onChange={(v) => patch({ fade_in: v }, "fade_in")}
          />
          <Range
            label={`Fade out — ${clip.fade_out.toFixed(2)}s`}
            min={0} max={Math.max(0.05, Math.min(10, length))} step={0.05} value={clip.fade_out}
            onChange={(v) => patch({ fade_out: v }, "fade_out")}
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="clip-muted"
            checked={clip.muted}
            onCheckedChange={(next) => patch({ muted: next === true })}
          />
          <Label htmlFor="clip-muted" className="text-[13px] font-normal text-muted-foreground">
            Muted
          </Label>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => editor.apply(ops.duplicateClip(data, clip.id, duration))}
          >
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              editor.apply(ops.splitClip(data, clip.id, editor.state.playhead - bodyOffset))
            }
          >
            Split at playhead
          </Button>
          <Button size="sm" variant="outline" onClick={() => void bounce()} title="Freeze this clip's effects into a reusable asset">
            Bounce to clip
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-coral-red hover:text-coral-red"
            onClick={() => {
              editor.apply(ops.removeClip(data, clip.id));
              editor.selectClip(null);
            }}
          >
            Delete
          </Button>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Effects</p>
          <EffectsChain
            effects={clip.effects}
            onChange={(effects, coalesce) =>
              editor.apply(ops.setClipEffects(data, clip.id, effects), { coalesce })
            }
            onAudition={auditionEffect}
          />
        </div>
      </div>
    </InspectorSection>
  );
}

function TrackPanel({ track }: { track: EditorTrack }) {
  const editor = useEditor();
  const data = editor.state.data;

  function patch(next: Partial<EditorTrack>, field: string) {
    editor.apply(ops.updateTrack(data, track.id, next), { coalesce: `track:${track.id}:${field}` });
  }

  return (
    <InspectorSection title="Track" subtitle={track.name}>
      <div className="space-y-4">
        <Range
          label={`Gain — ${track.gain_db.toFixed(1)} dB`}
          min={-60} max={12} step={0.5} value={track.gain_db}
          onChange={(v) => patch({ gain_db: v }, "gain")}
        />
        <Range
          label={`Pan — ${track.pan.toFixed(2)}`}
          min={-1} max={1} step={0.05} value={track.pan}
          onChange={(v) => patch({ pan: v }, "pan")}
        />
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Effects</p>
          <EffectsChain
            effects={track.effects}
            onChange={(effects, coalesce) =>
              editor.apply(ops.setTrackEffects(data, track.id, effects), { coalesce })
            }
          />
        </div>
      </div>
    </InspectorSection>
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
    <InspectorSection title="Master">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="master-normalize"
            checked={data.master.loudness.enabled}
            onCheckedChange={(next) => patchLoudness({ enabled: next === true })}
          />
          <Label htmlFor="master-normalize" className="text-[13px] font-normal text-muted-foreground">
            Normalize loudness on export
          </Label>
        </div>
        {data.master.loudness.enabled && (
          <Range
            label={`Target — ${data.master.loudness.target_lufs.toFixed(0)} LUFS`}
            min={-40} max={-8} step={1} value={data.master.loudness.target_lufs}
            onChange={(v) => patchLoudness({ target_lufs: v }, "master:lufs")}
          />
        )}
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Master effects</p>
          <EffectsChain
            effects={data.master.effects}
            onChange={(effects, coalesce) => editor.apply(ops.setMasterEffects(data, effects), { coalesce })}
          />
        </div>
      </div>
    </InspectorSection>
  );
}
