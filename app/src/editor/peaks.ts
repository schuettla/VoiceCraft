import { api } from "../lib/api";
import type { SourceRef } from "../lib/types";
import { sourceKey } from "./ops";

/* Waveform peaks, fetched from the backend and cached per (source, resolution).
 * A canvas draws directly from the Int8Array — see components/Waveform.tsx. */

export type PeakData = { peaks: Int8Array; duration: number; resolution: number };

const cache = new Map<string, Promise<PeakData>>();

/** Zoom level (pixels per second) → the peaks resolution worth fetching. */
export function resolutionForZoom(pxPerSecond: number): number {
  if (pxPerSecond > 60) return 200;
  if (pxPerSecond > 15) return 100;
  if (pxPerSecond > 4) return 25;
  return 8;
}

export function getPeaks(source: SourceRef, resolution: number): Promise<PeakData> {
  const key = `${sourceKey(source)}@${resolution}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = api
      .peaks(source, resolution)
      .then(({ data, duration }) => ({ peaks: data, duration, resolution }));
    cache.set(key, entry);
    entry.catch(() => cache.delete(key));
  }
  return entry;
}

export function clearPeaksCache(): void {
  cache.clear();
}
