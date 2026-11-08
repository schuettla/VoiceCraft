import { useCallback, useState } from "react";

/**
 * A string choice that survives a reload (the Generate page's last mode).
 *
 * Browser storage is a convenience here, never the source of truth: it can be
 * blocked, cleared or throw, and the page must work without it. So every access
 * is wrapped, and a stored value that is no longer one of `allowed` (an option
 * removed in a later version) falls back to `fallback`.
 */
export function useRemembered<T extends string>(
  key: string,
  fallback: T,
  /** Omit to accept any stored string (the caller validates it against live data). */
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) return fallback;
      return !allowed || allowed.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* private window or blocked storage: the choice just won't persist */
      }
    },
    [key],
  );

  return [value, set];
}
