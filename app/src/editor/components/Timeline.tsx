import { useMemo, useRef } from "react";
import { formatDuration } from "../../lib/format";
import { cx, IconButton } from "../../components/ui";
import { LoopIcon, MagnetIcon, MarkerIcon, ScissorsIcon, ZoomInIcon, ZoomOutIcon } from "../../components/icons";
import { useEditor } from "../store";
import { useMedia } from "../MediaContext";
import { useLayout } from "../useLayout";
import * as ops from "../ops";
import { HEADER_WIDTH, MAX_ZOOM, MIN_ZOOM, RULER_HEIGHT, TRACK_HEIGHT } from "../constants";
import { TrackLane } from "./TrackLane";
import { IntroOutroBlock, IntroOutroPicker } from "./IntroOutroSlot";

export function Timeline() {
  const editor = useEditor();
  const media = useMedia();
  const { layout } = useLayout();
  const data = editor.state.data;
  const zoom = editor.state.zoom;
  const scrollRef = useRef<HTMLDivElement>(null);

  const clipsByTrack = useMemo(() => {
    const map = new Map<string, typeof data.clips>();
    for (const clip of data.clips) map.set(clip.track_id, [...(map.get(clip.track_id) ?? []), clip]);
    return map;
  }, [data.clips]);

  const contentWidth = HEADER_WIDTH + Math.max(400, (layout.totalDuration + 15) * zoom);
  const lanesHeight = data.tracks.length * TRACK_HEIGHT;
  const contentHeight = RULER_HEIGHT + lanesHeight;

  /** Client X → timeline time (0 = start of the intro). */
  function pixelToTime(clientX: number): number {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - HEADER_WIDTH;
    return Math.max(0, x / zoom);
  }

  function seekFromEvent(e: React.MouseEvent) {
    editor.setPlayhead(pixelToTime(e.clientX));
  }

  /** Ctrl/Cmd+wheel zooms around the cursor instead of scrolling — the time
   * under the pointer stays put by adjusting scrollLeft to match. */
  function onWheel(e: React.WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    const timeAtCursor = pixelToTime(e.clientX);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    editor.setZoom(nextZoom);
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, timeAtCursor * nextZoom - (e.clientX - el.getBoundingClientRect().left) + HEADER_WIDTH);
    });
  }

  function trackIdUnder(clientX: number, clientY: number): string | undefined {
    return document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId;
  }

  /** Drag on empty lane space selects a time range across the spanned tracks;
   * a plain click there (no movement) seeks and clears selection instead. */
  function onLanesMouseDown(e: React.MouseEvent) {
    if (editor.state.tool === "razor") return;
    const startTrackId = trackIdUnder(e.clientX, e.clientY);
    if (!startTrackId) return; // clicked a track header or another control
    const startX = e.clientX;
    const startTime = pixelToTime(startX);
    let moved = false;

    function onMove(ev: MouseEvent) {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      const endTime = pixelToTime(ev.clientX);
      const endTrackId = trackIdUnder(ev.clientX, ev.clientY) ?? startTrackId;
      const startIdx = data.tracks.findIndex((t) => t.id === startTrackId);
      const endIdx = data.tracks.findIndex((t) => t.id === endTrackId);
      const lo = Math.max(0, Math.min(startIdx, endIdx));
      const hi = Math.max(startIdx, endIdx);
      const trackIds = data.tracks.slice(lo, hi + 1).map((t) => t.id);
      editor.selectRange({ trackIds, start: Math.min(startTime, endTime), end: Math.max(startTime, endTime) });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!moved) {
        editor.selectRange(null);
        editor.setPlayhead(startTime);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const range = editor.state.range;
  const rangeTop = range
    ? RULER_HEIGHT + Math.min(...range.trackIds.map((id) => data.tracks.findIndex((t) => t.id === id))) * TRACK_HEIGHT
    : 0;
  const rangeHeight = range ? range.trackIds.length * TRACK_HEIGHT : 0;
  const loop = editor.state.loop;

  const ticks = useMemo(() => {
    const step = zoom > 80 ? 1 : zoom > 30 ? 5 : zoom > 10 ? 15 : 60;
    const count = Math.ceil(layout.totalDuration + 15);
    const marks: number[] = [];
    for (let t = 0; t <= count; t += step) marks.push(t);
    return marks;
  }, [zoom, layout.totalDuration]);

  const { intro, outro } = data;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-ink-700 bg-ink-950">
      <div className="flex items-center gap-1 border-b border-ink-700 bg-ink-900 px-2 py-1">
        <IconButton
          label="Razor tool — click a clip to split it"
          className={cx(editor.state.tool === "razor" && "bg-white/10 text-white")}
          onClick={() => editor.setTool(editor.state.tool === "razor" ? "select" : "razor")}
        >
          <ScissorsIcon />
        </IconButton>
        <IconButton
          label={editor.state.snapEnabled ? "Snapping on" : "Snapping off"}
          className={cx(editor.state.snapEnabled && "bg-white/10 text-white")}
          onClick={() => editor.setSnap(!editor.state.snapEnabled)}
        >
          <MagnetIcon />
        </IconButton>
        <IconButton
          label={loop ? "Clear loop" : "Loop the selected range"}
          disabled={!loop && !range}
          className={cx(loop && "bg-white/10 text-accent")}
          onClick={() => editor.setLoop(loop ? null : range ? { start: range.start, end: range.end } : null)}
        >
          <LoopIcon />
        </IconButton>
        <IconButton label="Add marker at playhead" onClick={() => editor.apply(ops.addMarker(data, editor.state.playhead))}>
          <MarkerIcon />
        </IconButton>

        <div className="mx-1 h-5 w-px bg-ink-700" />

        <IconButton label="Zoom out" onClick={() => editor.setZoom((z) => Math.max(MIN_ZOOM, z / 1.4))}>
          <ZoomOutIcon />
        </IconButton>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          value={zoom}
          onChange={(e) => editor.setZoom(Number(e.target.value))}
          className="h-3 w-20 accent-accent"
          aria-label="Zoom"
        />
        <IconButton label="Zoom in" onClick={() => editor.setZoom((z) => Math.min(MAX_ZOOM, z * 1.4))}>
          <ZoomInIcon />
        </IconButton>
        {!intro.asset_id && (
          <IntroOutroPicker
            kind="intro"
            options={media.intros}
            onChange={(patch) => editor.apply(ops.setIntro(data, patch))}
          />
        )}
        {!outro.asset_id && (
          <IntroOutroPicker
            kind="outro"
            options={media.outros}
            onChange={(patch) => editor.apply(ops.setOutro(data, patch))}
          />
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-400">
          {formatDuration(layout.totalDuration)} total
        </span>
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto" onWheel={onWheel}>
        <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
          {/* ruler */}
          <div
            className="sticky top-0 z-30 flex cursor-pointer border-b border-ink-700 bg-ink-900"
            style={{ height: RULER_HEIGHT }}
            onClick={seekFromEvent}
          >
            <div className="sticky left-0 z-10 shrink-0 bg-ink-900" style={{ width: HEADER_WIDTH }} />
            <div className="relative flex-1">
              {ticks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 h-full border-l border-ink-700/70 pl-1 font-mono text-[10px] text-ink-500"
                  style={{ left: t * zoom }}
                >
                  {formatDuration(t)}
                </div>
              ))}
              {data.markers.map((marker) => (
                <div
                  key={marker.id}
                  className="absolute top-0 z-10 cursor-pointer text-lavender"
                  style={{ left: marker.time * zoom - 4 }}
                  title={marker.label || "Marker (right-click to remove)"}
                  onClick={(e) => {
                    e.stopPropagation();
                    editor.setPlayhead(marker.time);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    editor.apply(ops.removeMarker(data, marker.id));
                  }}
                >
                  <svg width="9" height="10" viewBox="0 0 9 10">
                    <path d="M1 0v10M1 0h6l-2 2.2L7 4.4H1" fill="currentColor" />
                  </svg>
                </div>
              ))}
            </div>
          </div>

          {/* range selection */}
          {range && (
            <div
              className="pointer-events-none absolute z-10 bg-accent/10 outline outline-1 outline-accent/40"
              style={{
                left: HEADER_WIDTH + range.start * zoom,
                width: Math.max(1, (range.end - range.start) * zoom),
                top: rangeTop,
                height: rangeHeight,
              }}
            />
          )}
          {/* loop range */}
          {loop && (
            <div
              className="pointer-events-none absolute top-0 z-10 border-x-2 border-lavender/50 bg-lavender/5"
              style={{ left: HEADER_WIDTH + loop.start * zoom, width: Math.max(1, (loop.end - loop.start) * zoom), height: contentHeight }}
            />
          )}

          {/* tracks */}
          <div onMouseDown={onLanesMouseDown}>
            {data.tracks.map((track) => (
              <TrackLane
                key={track.id}
                track={track}
                otherTracks={data.tracks.filter((t) => t.id !== track.id)}
                clips={clipsByTrack.get(track.id) ?? []}
                zoom={zoom}
                bodyOffset={layout.bodyOffset}
                height={TRACK_HEIGHT}
                pixelToTime={pixelToTime}
              />
            ))}
          </div>

          {/* intro / outro overlays */}
          {intro.asset_id && lanesHeight > 0 && (
            <IntroOutroBlock
              kind="intro"
              slot={{ ...intro, asset_id: intro.asset_id }}
              left={HEADER_WIDTH}
              top={RULER_HEIGHT + 4}
              width={layout.introLen * zoom}
              height={lanesHeight - 8}
              duration={layout.introLen}
              onChange={(patch, coalesce) => editor.apply(ops.setIntro(data, patch), { coalesce })}
            />
          )}
          {outro.asset_id && lanesHeight > 0 && (
            <IntroOutroBlock
              kind="outro"
              slot={{ ...outro, asset_id: outro.asset_id }}
              left={HEADER_WIDTH + layout.outroStart * zoom}
              top={RULER_HEIGHT + 4}
              width={layout.outroLen * zoom}
              height={lanesHeight - 8}
              duration={layout.outroLen}
              onChange={(patch, coalesce) => editor.apply(ops.setOutro(data, patch), { coalesce })}
            />
          )}

          {/* playhead */}
          <div
            className="pointer-events-none absolute top-0 z-20 w-px bg-accent"
            style={{ left: HEADER_WIDTH + editor.state.playhead * zoom, height: contentHeight }}
          />
        </div>
      </div>
    </div>
  );
}
