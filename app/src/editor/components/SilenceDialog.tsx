import { useEffect, useState } from "react";
import type { SilenceRegion } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { Field } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Dialog } from "../../components/Dialog";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toaster";
import { useMedia } from "../MediaContext";
import { useEditor } from "../store";
import * as ops from "../ops";

/** Detects long quiet stretches in the selected clip's source and, on
 * confirmation, ripple-cuts them out of the clip in one undo step. Found
 * regions are pushed to the store as `previewRegions` so `ClipView` can
 * highlight them on the waveform before the cut is applied. */
export function SilenceDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const media = useMedia();
  const toast = useToast();
  const data = editor.state.data;
  const clipId = [...editor.state.selection.clipIds][0];
  const clip = data.clips.find((c) => c.id === clipId);
  const source = clip ? media.byKey.get(ops.sourceKey(clip.source)) : undefined;

  const [noiseDb, setNoiseDb] = useState(-30);
  const [minDuration, setMinDuration] = useState(0.5);
  const [regions, setRegions] = useState<SilenceRegion[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => editor.setPreviewRegions(null), [editor]);

  async function detect() {
    if (!clip) return;
    setBusy(true);
    try {
      const outPoint = clip.out_point ?? source?.duration ?? Infinity;
      const { regions: found } = await api.analyzeSilence({
        ...clip.source,
        noise_db: noiseDb,
        min_duration: minDuration,
      });
      // Keep only silence inside the clip's visible [in_point, out_point) span.
      const clipped = found
        .map((r) => ({ start: Math.max(r.start, clip.in_point), end: Math.min(r.end, outPoint) }))
        .filter((r) => r.end - r.start > 0.05);
      setRegions(clipped);
      editor.setPreviewRegions({
        clipId: clip.id,
        ranges: clipped.map((r) => [r.start - clip.in_point, r.end - clip.in_point]),
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!clip || !regions || regions.length === 0) return;
    // Convert from source-file time to timeline time before cutting.
    const timelineRegions = regions.map((r) => ({
      start: clip.start + (r.start - clip.in_point),
      end: clip.start + (r.end - clip.in_point),
    }));
    editor.apply(ops.cutRegionsFromClip(data, clip.id, timelineRegions, source?.duration ?? 0));
    editor.setPreviewRegions(null);
    onClose();
  }

  return (
    <Dialog
      onClose={onClose}
      title="Remove silence"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!regions || regions.length === 0} onClick={apply}>
            Cut silence
          </Button>
        </>
      }
    >
      {!clip ? (
        <p className="text-[13px] text-muted-foreground">Select a clip on the timeline first.</p>
      ) : (
        <div className="space-y-3">
          <p className="truncate text-[13px] text-muted-foreground">{source?.title}</p>
          <Field label={`Threshold — ${noiseDb} dB`}>
            <Slider
              min={-60} max={-10} step={1} value={[noiseDb]}
              onValueChange={([next]) => setNoiseDb(next)}
              className="py-1.5"
            />
          </Field>
          <Field label={`Minimum length — ${minDuration.toFixed(2)}s`}>
            <Slider
              min={0.1} max={3} step={0.1} value={[minDuration]}
              onValueChange={([next]) => setMinDuration(next)}
              className="py-1.5"
            />
          </Field>
          <Button size="sm" variant="outline" onClick={detect} disabled={busy}>
            {busy ? "Scanning…" : "Scan for silence"}
          </Button>
          {regions && (
            <p className="text-[13px] text-muted-foreground">
              {regions.length === 0
                ? "No silence found at this threshold."
                : `${regions.length} region${regions.length === 1 ? "" : "s"}, ` +
                  `${formatDuration(regions.reduce((s, r) => s + (r.end - r.start), 0))} total — highlighted on the clip`}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
