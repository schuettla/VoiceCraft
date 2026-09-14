import { useState } from "react";
import type { EditorTrack, TimelineClip } from "../../lib/types";
import { cx } from "../../components/ui";
import { useEditor } from "../store";
import { useMedia } from "../MediaContext";
import * as ops from "../ops";
import { TrackHeader } from "./TrackHeader";
import { ClipView } from "./ClipView";
import { MEDIA_DRAG_MIME } from "./MediaBin";

export function TrackLane({
  track,
  otherTracks,
  clips,
  zoom,
  bodyOffset,
  height,
  pixelToTime,
}: {
  track: EditorTrack;
  otherTracks: EditorTrack[];
  clips: TimelineClip[];
  zoom: number;
  bodyOffset: number;
  height: number;
  pixelToTime: (clientX: number) => number;
}) {
  const editor = useEditor();
  const media = useMedia();
  const [dragOver, setDragOver] = useState(false);
  const selectedClipId = [...editor.state.selection.clipIds][0];
  const selectedClip = editor.state.data.clips.find((c) => c.id === selectedClipId);
  const isActive = selectedClip ? selectedClip.track_id === track.id : editor.state.selection.trackId === track.id;

  function dropAt(clientX: number): number {
    return Math.max(0, pixelToTime(clientX) - bodyOffset);
  }

  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes(MEDIA_DRAG_MIME) || e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const start = dropAt(e.clientX);
    const mediaKey = e.dataTransfer.getData(MEDIA_DRAG_MIME);
    if (mediaKey) {
      const source = media.byKey.get(mediaKey);
      if (source) {
        editor.apply(ops.addClip(editor.state.data, track.id, source.ref, start, source.duration ?? 0));
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    void (async () => {
      for (const file of files) {
        const form = new FormData();
        form.set("name", file.name.replace(/\.[^.]+$/, ""));
        form.set("kind", "clip");
        form.set("file", file);
        try {
          const asset = await media.uploadAsset(form);
          editor.apply(
            ops.addClip(editor.state.data, track.id, { asset_id: asset.id }, start, asset.duration_seconds ?? 0),
          );
        } catch {
          /* the toast from uploadAsset's caller already covers this in MediaBin's own flow */
        }
      }
    })();
  }

  return (
    <div className={cx("relative flex border-b border-ink-800", isActive && "bg-accent/[0.04]")} style={{ height }}>
      <div className="sticky left-0 z-20">
        <TrackHeader track={track} otherTracks={otherTracks} />
      </div>
      <div
        data-track-id={track.id}
        className={cx("relative flex-1", dragOver && "bg-accent-soft/40")}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {clips.map((clip) => {
          const source = media.byKey.get(ops.sourceKey(clip.source));
          const duration = source?.duration ?? 0;
          const left = (bodyOffset + clip.start) * zoom;
          const width = ops.clipLength(clip, duration) * zoom;
          return (
            <ClipView
              key={clip.id}
              clip={clip}
              left={left}
              width={width}
              height={height - 8}
              zoom={zoom}
              bodyOffset={bodyOffset}
              pixelToTime={pixelToTime}
              selected={editor.state.selection.clipIds.has(clip.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
