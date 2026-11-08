import type { Asset, Generation, GenerationStatus } from "./types";
import { parseWhen } from "./format";

/* The Library's data model and the pure logic around it: one normalised item
 * for both generations and exported files, and the filter / sort / group steps
 * the page chains together. No React in here, so it is easy to reason about. */

/** What an item *is* — the primary way the library is divided. */
export type ItemType = "speech" | "music" | "sfx" | "export";
export type TypeTab = "all" | ItemType;

/** Where an item is in its life. Exports are files, so they are always `ready`. */
export type ItemStatus = "ready" | "active" | "failed";
export type StatusFilter = "all" | ItemStatus;

export type GroupBy = "none" | "date" | "type" | "voice" | "engine" | "length" | "format";
export type SortBy = "newest" | "oldest" | "longest" | "shortest" | "name";

export const TYPE_LABEL: Record<ItemType, string> = {
  speech: "Voice",
  music: "Music",
  sfx: "Sound FX",
  export: "Exports",
};

export const GROUP_LABEL: Record<GroupBy, string> = {
  none: "No grouping",
  date: "Date",
  type: "Type",
  voice: "Voice",
  engine: "Engine",
  length: "Length",
  format: "File format",
};

export const SORT_LABEL: Record<SortBy, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  longest: "Longest first",
  shortest: "Shortest first",
  name: "Name A–Z",
};

/** How each engine is named in the UI; an engine not listed shows its raw id. */
const ENGINE_LABEL: Record<string, string> = {
  qwen: "Qwen3-TTS",
  kokoro: "Kokoro",
  kitten: "KittenTTS 2",
  acestep: "ACE-Step",
  moss_sfx: "MOSS-SoundEffect",
  sa3_music: "Stable Audio 3",
  sa3_sfx: "Stable Audio 3",
};

export function engineLabel(engine: string | null): string | null {
  if (!engine) return null;
  return ENGINE_LABEL[engine] ?? engine;
}

export interface LibraryItem {
  /** Generation or asset id (unique across both — they are uuid4 hex). */
  id: string;
  type: ItemType;
  /** The script / prompt, or an export's file name. */
  title: string;
  created: number;
  seconds: number | null;
  format: string | null;
  /** The voice's name — speech only. */
  voice: string | null;
  engine: string | null;
  status: ItemStatus;
  favorite: boolean;
  generation: Generation | null;
  asset: Asset | null;
}

const ACTIVE: GenerationStatus[] = ["queued", "processing"];

export function statusOf(status: GenerationStatus): ItemStatus {
  if (status === "failed") return "failed";
  return ACTIVE.includes(status) ? "active" : "ready";
}

export function toItems(
  generations: Generation[],
  exports: Asset[],
  voiceNames: Map<string, string>,
): LibraryItem[] {
  const fromGenerations = generations.map<LibraryItem>((g) => ({
    id: g.id,
    type: g.kind ?? "speech",
    title: g.text,
    created: parseWhen(g.created_at).getTime(),
    seconds: g.duration_seconds,
    format: g.format,
    // Only speech has a voice; a profile that was deleted reads as such.
    voice:
      (g.kind ?? "speech") === "speech" && g.profile_id
        ? (voiceNames.get(g.profile_id) ?? "Deleted voice")
        : null,
    engine: engineLabel(g.engine),
    status: statusOf(g.status),
    favorite: g.favorite === true,
    generation: g,
    asset: null,
  }));
  const fromExports = exports.map<LibraryItem>((a) => ({
    id: a.id,
    type: "export",
    title: a.name,
    created: parseWhen(a.created_at).getTime(),
    seconds: a.duration_seconds,
    format: a.format,
    voice: null,
    engine: null,
    status: "ready",
    favorite: false,
    generation: null,
    asset: a,
  }));
  return [...fromGenerations, ...fromExports];
}

/* ---------------------------------------------------------------- filtering */

export interface Filters {
  tab: TypeTab;
  status: StatusFilter;
  voiceId: string;
  query: string;
  favoritesOnly: boolean;
}

/**
 * `skip` leaves dimensions out, so a tab or a status chip can show how many
 * items it *would* yield. "All" means everything generated: exported files are
 * copies of generations, so they live on their own tab instead of doubling up.
 */
export function matches(
  item: LibraryItem,
  filters: Filters,
  skip: readonly ("tab" | "status")[] = [],
): boolean {
  if (!skip.includes("tab")) {
    if (filters.tab === "all" ? item.type === "export" : item.type !== filters.tab) {
      return false;
    }
  }
  if (!skip.includes("status") && filters.status !== "all" && item.status !== filters.status) {
    return false;
  }
  if (filters.voiceId && filters.tab === "speech") {
    if (item.generation?.profile_id !== filters.voiceId) return false;
  }
  if (filters.favoritesOnly && !item.favorite) return false;
  const needle = filters.query.trim().toLowerCase();
  if (needle) {
    const lyrics = item.generation?.params?.lyrics;
    const haystack = [
      item.title,
      item.voice,
      item.engine,
      typeof lyrics === "string" ? lyrics : "",
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ sorting */

export function sortItems(items: LibraryItem[], by: SortBy): LibraryItem[] {
  const copy = [...items];
  // Unknown lengths (failed / running jobs) always sink to the bottom.
  const byLength = (dir: 1 | -1) => (a: LibraryItem, b: LibraryItem) => {
    if (a.seconds == null && b.seconds == null) return b.created - a.created;
    if (a.seconds == null) return 1;
    if (b.seconds == null) return -1;
    return (a.seconds - b.seconds) * dir || b.created - a.created;
  };
  switch (by) {
    case "oldest":
      return copy.sort((a, b) => a.created - b.created);
    case "longest":
      return copy.sort(byLength(-1));
    case "shortest":
      return copy.sort(byLength(1));
    case "name":
      return copy.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) ||
          b.created - a.created,
      );
    default:
      return copy.sort((a, b) => b.created - a.created);
  }
}

/* ----------------------------------------------------------------- grouping */

export interface Group {
  key: string;
  label: string;
  items: LibraryItem[];
  seconds: number;
}

interface Bucket {
  key: string;
  label: string;
  /** Lower sorts first. */
  rank: number;
}

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dateBucket(created: number, now: Date): Bucket {
  const day = 86_400_000;
  const age = Math.round((startOfDay(now) - startOfDay(new Date(created))) / day);
  if (age <= 0) return { key: "today", label: "Today", rank: 0 };
  if (age === 1) return { key: "yesterday", label: "Yesterday", rank: 1 };
  if (age <= 7) return { key: "week", label: "Previous 7 days", rank: 2 };
  if (age <= 30) return { key: "month", label: "Previous 30 days", rank: 3 };
  const then = new Date(created);
  const months =
    (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  return {
    key: `m${then.getFullYear()}-${then.getMonth()}`,
    label: MONTH_FORMAT.format(then),
    rank: 4 + Math.max(months, 0),
  };
}

function lengthBucket(seconds: number | null): Bucket {
  if (seconds == null) return { key: "unknown", label: "No length yet", rank: 4 };
  if (seconds < 10) return { key: "short", label: "Under 10 seconds", rank: 0 };
  if (seconds < 30) return { key: "medium", label: "10 – 30 seconds", rank: 1 };
  if (seconds < 120) return { key: "long", label: "30 seconds – 2 minutes", rank: 2 };
  return { key: "xlong", label: "Over 2 minutes", rank: 3 };
}

const TYPE_RANK: Record<ItemType, number> = { speech: 0, music: 1, sfx: 2, export: 3 };

function bucketOf(item: LibraryItem, by: GroupBy, now: Date): Bucket {
  switch (by) {
    case "date":
      return dateBucket(item.created, now);
    case "length":
      return lengthBucket(item.seconds);
    case "type":
      return { key: item.type, label: TYPE_LABEL[item.type], rank: TYPE_RANK[item.type] };
    case "voice":
      // Everything that isn't speech has no voice; keep it together, at the end.
      return item.voice
        ? { key: `v:${item.voice}`, label: item.voice, rank: 0 }
        : { key: "no-voice", label: "No voice", rank: 1 };
    case "engine":
      return item.engine
        ? { key: `e:${item.engine}`, label: item.engine, rank: 0 }
        : { key: "no-engine", label: "Unknown engine", rank: 1 };
    case "format": {
      const format = item.format ? item.format.toUpperCase() : "";
      return format
        ? { key: `f:${format}`, label: format, rank: 0 }
        : { key: "no-format", label: "No file yet", rank: 1 };
    }
    default:
      return { key: "all", label: "", rank: 0 };
  }
}

/** Split already-sorted items into groups, keeping the sort inside each one. */
export function groupItems(
  items: LibraryItem[],
  by: GroupBy,
  sort: SortBy,
  now: Date = new Date(),
): Group[] {
  if (by === "none") {
    return [
      {
        key: "all",
        label: "",
        items,
        seconds: items.reduce((sum, item) => sum + (item.seconds ?? 0), 0),
      },
    ];
  }
  const groups = new Map<string, Group & { rank: number }>();
  for (const item of items) {
    const bucket = bucketOf(item, by, now);
    let group = groups.get(bucket.key);
    if (!group) {
      group = { ...bucket, items: [], seconds: 0 };
      groups.set(bucket.key, group);
    }
    group.items.push(item);
    group.seconds += item.seconds ?? 0;
  }
  // Time and length read in the direction the sort asks for; named groups
  // (voice, engine, format, type) are simply alphabetical.
  const compareRank = (a: { rank: number }, b: { rank: number }) => {
    if (by === "date" && sort === "oldest") return b.rank - a.rank;
    // "No length yet" (rank 4) stays last however the lengths are ordered.
    if (by === "length" && sort === "longest" && a.rank < 4 && b.rank < 4) {
      return b.rank - a.rank;
    }
    return a.rank - b.rank;
  };
  return [...groups.values()]
    .sort(
      (a, b) =>
        compareRank(a, b) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    )
    .map(({ rank: _rank, ...group }) => group);
}

/** Which groupings make sense on a tab (a voice only exists for speech, etc.). */
export function groupOptions(tab: TypeTab): GroupBy[] {
  switch (tab) {
    case "all":
      return ["none", "date", "type", "length", "engine"];
    case "speech":
      return ["none", "date", "voice", "length", "engine"];
    case "export":
      return ["none", "date", "format", "length"];
    default:
      return ["none", "date", "length", "engine"];
  }
}
