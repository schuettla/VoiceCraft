import { useRef } from "react";
import type { TimelineClip } from "../../lib/types";
import { cx } from "../../components/common";
import { useEditor } from "../store";
import { useMedia } from "../MediaContext";
import * as ops from "../ops";
import { Waveform } from "./Waveform";

const EDGE_PX = 8;
const SNAP_PX = 8;

type DragMode = "move" | "trim-start" | "trim-end" | "fade-in" | "fade-out";

export function ClipView({
  clip,
  left,
  width,
  height,
  zoom,
  selected,
  bodyOffset,
  pixelToTime,
}: {
  clip: TimelineClip;
  /** Pixel position — already includes the body offset (space the intro reserves). */
  left: number;
  width: number;
  height: number;
  zoom: number;
  selected: boolean;
  bodyOffset: number;
  /** Client X -> timeline time (0 = start of the intro); used by the razor tool. */
  pixelToTime: (clientX: number) => number;
}) {
  const editor = useEditor();
  const media = useMedia();
  const dragRef = useRef<{
    mode: DragMode;
    startX: number;
    origin: TimelineClip;
    sourceDuration: number;
  } | null>(null);

  const source = media.byKey.get(ops.sourceKey(clip.source));
  const sourceDuration = source?.duration ?? 0;
  const outPoint = clip.out_point ?? sourceDuration;

  /** Other clips' edges + the playhead + markers, in body time, on `trackId` —
   * used to snap a drag/trim to a nearby edge. */
  function snapCandidates(trackId: string): number[] {
    const data = editor.state.data;
    const list = [editor.state.playhead - bodyOffset];
    for (const marker of data.markers) list.push(marker.time - bodyOffset);
    for (const other of data.clips) {
      if (other.id === clip.id || other.track_id !== trackId) continue;
      const duration = media.byKey.get(ops.sourceKey(other.source))?.duration ?? 0;
      list.push(other.start, ops.clipEnd(other, duration));
    }
    return list;
  }

  function snap(time: number, trackId: string): number {
    if (!editor.state.snapEnabled) return time;
    return ops.snapTime(time, snapCandidates(trackId), SNAP_PX / zoom);
  }

  /** The track lane under the pointer right now, for dragging a clip onto a
   * different track — `TrackLane` tags its drop area with `data-track-id`. */
  function trackUnderPointer(e: MouseEvent, fallback: string): string {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-track-id]");
    return el?.dataset.trackId ?? fallback;
  }

  function beginDrag(mode: DragMode, e: React.MouseEvent) {
    e.stopPropagation();
    if (editor.state.tool === "razor") {
      editor.apply(ops.splitClip(editor.state.data, clip.id, pixelToTime(e.clientX) - bodyOffset));
      return;
    }
    editor.selectClip(clip.id);
    editor.beginGesture();
    dragRef.current = { mode, startX: e.clientX, origin: clip, sourceDuration };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  }

  function onDragMove(e: MouseEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaSeconds = (e.clientX - drag.startX) / zoom;
    const data = editor.state.data;
    const origin = drag.origin;
    switch (drag.mode) {
      case "move": {
        const targetTrack = trackUnderPointer(e, origin.track_id);
        const newStart = snap(Math.max(0, origin.start + deltaSeconds), targetTrack);
        editor.live(ops.moveClip(data, clip.id, targetTrack, newStart));
        break;
      }
      case "trim-start": {
        const newStart = snap(Math.max(0, origin.start + deltaSeconds), origin.track_id);
        editor.live(ops.trimClipStart(data, clip.id, newStart, drag.sourceDuration));
        break;
      }
      case "trim-end": {
        const currentOut = origin.out_point ?? drag.sourceDuration;
        const currentLen = currentOut - origin.in_point;
        const newEnd = snap(origin.start + currentLen + deltaSeconds, origin.track_id);
        editor.live(ops.trimClipEnd(data, clip.id, newEnd, drag.sourceDuration));
        break;
      }
      case "fade-in": {
        const maxFade = Math.max(0, (origin.out_point ?? drag.sourceDuration) - origin.in_point);
        const fade = Math.min(maxFade, Math.max(0, origin.fade_in + deltaSeconds));
        editor.live(ops.updateClip(data, clip.id, { fade_in: fade }));
        break;
      }
      case "fade-out": {
        const maxFade = Math.max(0, (origin.out_point ?? drag.sourceDuration) - origin.in_point);
        const fade = Math.min(maxFade, Math.max(0, origin.fade_out - deltaSeconds));
        editor.live(ops.updateClip(data, clip.id, { fade_out: fade }));
        break;
      }
    }
  }

  function onDragEnd() {
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
  }

  const fadeInPx = Math.min(width / 2, clip.fade_in * zoom);
  const fadeOutPx = Math.min(width / 2, clip.fade_out * zoom);
  const preview = editor.state.previewRegions?.clipId === clip.id ? editor.state.previewRegions : null;

  return (
    <div
      className={cx(
        "group absolute top-1 overflow-hidden rounded-md border select-none",
        selected ? "z-10 border-primary ring-1 ring-primary" : "border-ink-600 hover:border-ink-500",
        clip.muted ? "opacity-40" : "bg-ink-800",
        editor.state.tool === "razor" && "cursor-[crosshair]",
      )}
      style={{ left, width: Math.max(4, width), height }}
      onMouseDown={(e) => beginDrag("move", e)}
      title={source?.title ?? "missing source"}
    >
      <Waveform source={clip.source} inPoint={clip.in_point} outPoint={outPoint} />

      {/* silence-removal preview, before the cut is applied */}
      {preview?.ranges.map(([start, end], i) => (
        <div
          key={i}
          className="pointer-events-none absolute inset-y-0 bg-coral-red/25"
          style={{ left: Math.max(0, start * zoom), width: Math.max(1, (end - start) * zoom) }}
        />
      ))}

      {/* fade shading */}
      {fadeInPx > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-ink-950/60"
          style={{ width: fadeInPx, clipPath: "polygon(0 0, 100% 100%, 0 100%)" }}
        />
      )}
      {fadeOutPx > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-ink-950/60"
          style={{ width: fadeOutPx, clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
        />
      )}

      <div className="pointer-events-none absolute inset-x-1.5 top-0.5 truncate text-[10px] text-ink-100/90">
        {source?.title ?? "missing source"}
      </div>

      {/* trim handles */}
      <div
        className="absolute inset-y-0 left-0 z-10 cursor-ew-resize"
        style={{ width: EDGE_PX }}
        onMouseDown={(e) => beginDrag("trim-start", e)}
      />
      <div
        className="absolute inset-y-0 right-0 z-10 cursor-ew-resize"
        style={{ width: EDGE_PX }}
        onMouseDown={(e) => beginDrag("trim-end", e)}
      />
      {/* fade handles */}
      <div
        className="absolute left-0 top-0 z-10 size-2.5 cursor-crosshair rounded-full bg-ink-100/0 opacity-0 group-hover:opacity-100 group-hover:bg-primary"
        onMouseDown={(e) => beginDrag("fade-in", e)}
      />
      <div
        className="absolute right-0 top-0 z-10 size-2.5 cursor-crosshair rounded-full bg-ink-100/0 opacity-0 group-hover:opacity-100 group-hover:bg-primary"
        onMouseDown={(e) => beginDrag("fade-out", e)}
      />
    </div>
  );
}
