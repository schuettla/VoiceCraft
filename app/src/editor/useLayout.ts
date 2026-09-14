import { useMemo } from "react";
import { useEditor } from "./store";
import { useMedia } from "./MediaContext";
import { computeLayout, type TimelineLayout } from "./ops";

/** Source durations by key plus the intro/body/outro layout derived from them.
 *
 * Two time bases exist: clip `start`s are *body* time (0 = where the body
 * begins), while the playhead, ruler, and playback are *timeline* time
 * (0 = start of the intro). `layout.bodyOffset` converts between them. */
export function useLayout(): { durations: Map<string, number>; layout: TimelineLayout } {
  const editor = useEditor();
  const media = useMedia();
  const durations = useMemo(
    () => new Map(Array.from(media.byKey.entries()).map(([key, clip]) => [key, clip.duration ?? 0])),
    [media.byKey],
  );
  const data = editor.state.data;
  const layout = useMemo(() => computeLayout(data, durations), [data, durations]);
  return { durations, layout };
}
