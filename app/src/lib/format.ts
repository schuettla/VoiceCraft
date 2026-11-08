import type { AudioFormat } from "./types";

/** Everything ffmpeg is wired up to write (backend utils/audio.py `_ENCODERS`). */
export const AUDIO_FORMATS: AudioFormat[] = ["wav", "mp3", "ogg", "flac"];

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** "45 seconds", "2.5 minutes", "12 minutes" — for time estimates. */
export function formatMinutes(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = seconds / 60;
  return `${minutes >= 10 ? Math.round(minutes) : minutes.toFixed(1)} minutes`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "2h 5m" / "45s" — a total length of audio, where m:ss would read 125:03. */
export function formatTotal(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}m ${total % 60}s`;
  return `${hours}h ${minutes}m`;
}

/** The backend stores naive UTC; mark it as such so local time is right. */
export function parseWhen(iso: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

export function formatWhen(iso: string): string {
  const date = parseWhen(iso);
  const elapsed = (Date.now() - date.getTime()) / 1000;
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return date.toLocaleDateString();
}

export function truncate(text: string, length = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1)}…` : clean;
}
