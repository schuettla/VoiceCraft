import { useEffect, useRef } from "react";
import type { SourceRef } from "../../lib/types";
import { getPeaks, resolutionForZoom } from "../peaks";
import { decodeKey } from "../MediaContext";
import { sourceKey } from "../ops";

/* Draws the portion of a source's waveform covered by [inPoint, outPoint]
 * into a canvas sized to the clip's on-screen box. Peaks are min/max signed
 * bytes at a fixed resolution (buckets/second); each canvas column takes the
 * min/max over the buckets it spans, so zoomed-out views don't alias.
 *
 * Browsers refuse canvases wider than ~32k px (a 15-minute clip at the
 * default zoom is already 36k), so the backing store is capped and the
 * canvas stretched horizontally — slightly soft past the cap, never blank. */

const MAX_BACKING_WIDTH = 16384;

export function Waveform({
  source,
  inPoint,
  outPoint,
  color = "rgba(255,255,255,0.55)",
}: {
  source: SourceRef;
  inPoint: number;
  outPoint: number;
  color?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Depend on the key, not the object: callers may build `source` inline.
  const key = sourceKey(source);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ref = decodeKey(key);

    const draw = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const resolution = resolutionForZoom(width / Math.max(0.01, outPoint - inPoint));

      getPeaks(ref, resolution)
        .then(({ peaks }) => {
          if (cancelled) return;
          const columns = Math.max(1, Math.min(MAX_BACKING_WIDTH, Math.round(width * dpr)));
          const rows = Math.max(1, Math.round(height * dpr));
          canvas.width = columns;
          canvas.height = rows;
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, columns, rows);
          ctx.fillStyle = color;

          const mid = rows / 2;
          const startBucket = Math.floor(inPoint * resolution);
          const bucketsPerColumn = Math.max(0, outPoint - inPoint) * resolution / columns;
          const lastBucket = peaks.length / 2 - 1;
          for (let x = 0; x < columns; x++) {
            const from = startBucket + Math.floor(x * bucketsPerColumn);
            const to = Math.min(lastBucket, Math.max(from, startBucket + Math.ceil((x + 1) * bucketsPerColumn) - 1));
            if (from < 0 || from > lastBucket) continue;
            let lo = 127;
            let hi = -128;
            for (let b = from; b <= to; b++) {
              lo = Math.min(lo, peaks[b * 2]);
              hi = Math.max(hi, peaks[b * 2 + 1]);
            }
            const y1 = mid - (hi / 128) * mid;
            const y2 = mid - (lo / 128) * mid;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
          }
        })
        .catch(() => undefined);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [key, inPoint, outPoint, color]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
