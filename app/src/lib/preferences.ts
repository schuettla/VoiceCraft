import { useEffect, useState } from "react";
import { api } from "./api";
import type { Preferences } from "./types";

/**
 * The defaults the Settings page owns, shared by every page that starts a form.
 *
 * They are fetched once and kept in a module-level cache: the pages that read
 * them mount and unmount constantly as the user switches tabs, and re-fetching
 * on each one would put a request behind every click for a value that changes
 * about twice a year.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  default_engine: "qwen",
  default_language: "en",
  default_output_format: "mp3",
  default_crossfade_ms: 0,
  default_music_seconds: 30,
  default_music_vocals: "instrumental",
  default_sfx_seconds: 3,
  default_sfx_takes: 1,
  default_kitten_style: "stable",
  idle_unload_minutes: 10,
};

let cache: Preferences | null = null;
let inFlight: Promise<Preferences> | null = null;
const listeners = new Set<(preferences: Preferences) => void>();

function publish(preferences: Preferences) {
  cache = preferences;
  listeners.forEach((listener) => listener(preferences));
}

/** Called by the Settings page so open forms pick up a change immediately. */
export function setCachedPreferences(preferences: Preferences) {
  publish(preferences);
}

function load(): Promise<Preferences> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= api
    .settings()
    .then((settings) => {
      publish(settings.preferences);
      return settings.preferences;
    })
    .catch(() => DEFAULT_PREFERENCES) // offline backend: the defaults still work
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function usePreferences(): Preferences {
  const [preferences, setPreferences] = useState<Preferences>(
    cache ?? DEFAULT_PREFERENCES,
  );

  useEffect(() => {
    listeners.add(setPreferences);
    void load().then(setPreferences);
    return () => {
      listeners.delete(setPreferences);
    };
  }, []);

  return preferences;
}
