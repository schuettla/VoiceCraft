import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { EffectSpec } from "../lib/types";

/* The effects catalog rarely changes within a session (it's fixed by the
 * local ffmpeg build), so fetch it once and share it — same pattern as
 * lib/preferences.ts. */

let cache: EffectSpec[] | null = null;
let inFlight: Promise<EffectSpec[]> | null = null;

function load(): Promise<EffectSpec[]> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= api
    .listEffects()
    .then((specs) => {
      cache = specs;
      return specs;
    })
    .catch(() => [])
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useEffectsRegistry(): EffectSpec[] {
  const [specs, setSpecs] = useState<EffectSpec[]>(cache ?? []);
  useEffect(() => {
    void load().then(setSpecs);
  }, []);
  return specs;
}
