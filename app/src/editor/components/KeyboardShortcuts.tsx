import { useEffect } from "react";
import { useEditor } from "../store";
import { useEngine } from "../EngineContext";
import { useMedia } from "../MediaContext";
import { useLayout } from "../useLayout";
import { MIN_ZOOM, MAX_ZOOM } from "../constants";
import * as ops from "../ops";

/** Global editor shortcuts. Skips everything while the focus is in a text
 * field so renaming a track or typing a project name isn't hijacked. */
export function KeyboardShortcuts() {
  const editor = useEditor();
  const engine = useEngine();
  const media = useMedia();
  const { bodyOffset, totalDuration } = useLayout().layout;

  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTyping(e.target)) return;
      const data = editor.state.data;
      const selectedId = [...editor.state.selection.clipIds][0];
      const selectedClip = data.clips.find((c) => c.id === selectedId);
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === "Space") {
        e.preventDefault();
        void engine.toggle();
      } else if (e.key === "Delete" && e.shiftKey && selectedClip) {
        e.preventDefault();
        const duration = media.byKey.get(ops.sourceKey(selectedClip.source))?.duration ?? 0;
        editor.apply(ops.rippleDeleteClip(data, selectedClip.id, duration));
        editor.selectClip(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        editor.apply(ops.removeClip(data, selectedId));
        editor.selectClip(null);
      } else if (e.key.toLowerCase() === "s" && !mod && selectedId) {
        e.preventDefault();
        // The playhead is timeline time; clip positions are body time.
        editor.apply(ops.splitClip(data, selectedId, editor.state.playhead - bodyOffset));
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        editor.redo();
      } else if (mod && e.key.toLowerCase() === "c" && selectedClip) {
        e.preventDefault();
        editor.setClipboard([selectedClip]);
      } else if (mod && e.key.toLowerCase() === "v" && editor.state.clipboard) {
        e.preventDefault();
        const trackId = selectedClip?.track_id ?? editor.state.selection.trackId ?? data.tracks[0]?.id;
        if (trackId) {
          editor.apply(ops.pasteClips(data, editor.state.clipboard, editor.state.playhead - bodyOffset, trackId));
        }
      } else if (mod && e.key.toLowerCase() === "d" && selectedClip) {
        e.preventDefault();
        const duration = media.byKey.get(ops.sourceKey(selectedClip.source))?.duration ?? 0;
        editor.apply(ops.duplicateClip(data, selectedClip.id, duration));
      } else if (e.key === "ArrowLeft" && selectedId) {
        e.preventDefault();
        editor.apply(ops.nudgeClip(data, selectedId, e.shiftKey ? -1 : -0.1));
      } else if (e.key === "ArrowRight" && selectedId) {
        e.preventDefault();
        editor.apply(ops.nudgeClip(data, selectedId, e.shiftKey ? 1 : 0.1));
      } else if (e.key === "Home") {
        e.preventDefault();
        editor.setPlayhead(0);
      } else if (e.key === "End") {
        e.preventDefault();
        editor.setPlayhead(totalDuration);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        editor.setZoom((z) => Math.min(MAX_ZOOM, z * 1.4));
      } else if (e.key === "-") {
        e.preventDefault();
        editor.setZoom((z) => Math.max(MIN_ZOOM, z / 1.4));
      } else if (e.key.toLowerCase() === "l" && !mod) {
        e.preventDefault();
        const range = editor.state.range;
        editor.setLoop(editor.state.loop ? null : range ? { start: range.start, end: range.end } : null);
      } else if (e.key.toLowerCase() === "m" && !mod) {
        e.preventDefault();
        editor.apply(ops.addMarker(data, editor.state.playhead));
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, engine, media, bodyOffset, totalDuration]);

  return null;
}
