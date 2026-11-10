import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "./tauri";

/**
 * "Is there a newer release?" — notify-only. Nothing is downloaded or installed
 * here: the user is sent to the release page and installs it themselves, which
 * works the same for every package (installer, portable exe, AppImage, dmg, deb).
 *
 * GitHub's `releases/latest` ignores drafts and pre-releases, so a new version is
 * only announced once its draft has been published.
 */
const REPO = "schuettla/VoiceCraft";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEY_ENABLED = "voicecraft.updates.auto";
const KEY_LAST_CHECK = "voicecraft.updates.lastCheck";
const KEY_NOTIFIED = "voicecraft.updates.notified";

export interface UpdateInfo {
  current: string;
  /** Latest published version; equals `current` when nothing has been published. */
  latest: string;
  newer: boolean;
  /** The release page to send the user to. */
  url: string;
}

/** `v1.2.3-beta.1` → numbers `[1,2,3]` and whether it is a pre-release. */
function parseVersion(text: string): { parts: number[]; pre: boolean } {
  const clean = text.trim().replace(/^v/i, "");
  const [core, pre] = clean.split(/[-+]/, 2);
  const parts = core.split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  return { parts, pre: clean.includes("-") && Boolean(pre) };
}

/** Positive when `a` is newer than `b`. A final release outranks its own pre-release. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
}

/** Ask GitHub for the latest published release. Throws a readable error on failure. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) throw new Error("Update checks only run in the desktop app.");
  const current = await getVersion();

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
  } catch {
    throw new Error("Couldn't reach GitHub. Check your internet connection.");
  } finally {
    window.clearTimeout(timer);
  }

  if (response.status === 404) {
    // No release has been published yet: nothing newer can exist.
    return { current, latest: current, newer: false, url: RELEASES_URL };
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);

  const release = (await response.json()) as { tag_name?: string; html_url?: string };
  if (!release.tag_name) throw new Error("GitHub's answer had no version in it.");
  const latest = release.tag_name.replace(/^v/i, "");
  // Only ever link into this project, whatever the response says.
  const url = release.html_url?.startsWith(`https://github.com/${REPO}/`)
    ? release.html_url
    : RELEASES_URL;
  return { current, latest, newer: compareVersions(latest, current) > 0, url };
}

/* ------------------------------------------------- per-viewer conveniences */
// Browser storage can be blocked or throw; everything here degrades to "default".

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* blocked storage: the choice just won't persist */
  }
}

export function autoCheckEnabled(): boolean {
  return read(KEY_ENABLED) !== "off";
}

export function setAutoCheckEnabled(enabled: boolean) {
  write(KEY_ENABLED, enabled ? "on" : "off");
}

/** True at most once a day, so reopening the app doesn't hit GitHub every time. */
export function autoCheckDue(): boolean {
  if (!autoCheckEnabled()) return false;
  const last = Number(read(KEY_LAST_CHECK));
  return !Number.isFinite(last) || Date.now() - last > AUTO_CHECK_INTERVAL_MS;
}

export function markChecked() {
  write(KEY_LAST_CHECK, String(Date.now()));
}

/** A version the user has already been told about is not announced again. */
export function alreadyNotified(version: string): boolean {
  return read(KEY_NOTIFIED) === version;
}

export function markNotified(version: string) {
  write(KEY_NOTIFIED, version);
}
