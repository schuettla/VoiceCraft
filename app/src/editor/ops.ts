import type {
  DuckSettings,
  EditorTrack,
  EffectInstance,
  IntroOutroSlot,
  Marker,
  ProjectData,
  SourceRef,
  TimelineClip,
  TrackKind,
} from "../lib/types";

/* Pure operations on a `ProjectData` timeline. Every function takes the
 * current project (and whatever else it needs) and returns a new one —
 * nothing here mutates its input, which is what makes `store.ts`'s undo
 * stack a simple array of snapshots. */

export function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}_${rand.replace(/-/g, "").slice(0, 12)}`;
}

export function emptyProject(): ProjectData {
  return {
    schema_version: 1,
    tracks: [
      { ...defaultTrack("voice"), name: "Voice" },
      { ...defaultTrack("music"), name: "Music" },
    ],
    clips: [],
    intro: { asset_id: null, crossfade_ms: 0, gain_db: 0 },
    outro: { asset_id: null, crossfade_ms: 0, gain_db: 0 },
    master: { effects: [], loudness: { enabled: false, target_lufs: -16, true_peak: -1.5 } },
    export: { output_format: "mp3", sample_rate: 44100, channels: 2 },
    markers: [],
  };
}

function defaultDuck(): DuckSettings {
  return { enabled: false, against_track_ids: [], amount_db: -12, attack_ms: 20, release_ms: 250 };
}

export function defaultTrack(kind: TrackKind): EditorTrack {
  return {
    id: uid("t"),
    name: kind === "voice" ? "Voice" : kind === "music" ? "Music" : kind === "sfx" ? "SFX" : "Track",
    kind,
    gain_db: 0,
    pan: 0,
    mute: false,
    solo: false,
    effects: [],
    duck: defaultDuck(),
  };
}

export function defaultClip(trackId: string, source: SourceRef, start: number, duration: number): TimelineClip {
  return {
    id: uid("c"),
    track_id: trackId,
    source,
    start: Math.max(0, start),
    in_point: 0,
    out_point: duration > 0 ? duration : null,
    gain_db: 0,
    fade_in: 0,
    fade_out: 0,
    effects: [],
    muted: false,
  };
}

export function clipLength(clip: TimelineClip, sourceDuration: number): number {
  const out = clip.out_point ?? sourceDuration;
  return Math.max(0, out - clip.in_point);
}

export function clipEnd(clip: TimelineClip, sourceDuration: number): number {
  return clip.start + clipLength(clip, sourceDuration);
}

export function projectDuration(data: ProjectData, durations: Map<string, number>): number {
  let end = 0;
  for (const clip of data.clips) {
    const key = sourceKey(clip.source);
    end = Math.max(end, clipEnd(clip, durations.get(key) ?? 0));
  }
  return end;
}

export function sourceKey(source: SourceRef): string {
  return source.generation_id ? `g:${source.generation_id}` : `a:${source.asset_id}`;
}

export type TimelineLayout = {
  introLen: number;
  introXfade: number;
  bodyOffset: number;
  bodyEnd: number;
  outroLen: number;
  outroXfade: number;
  outroStart: number;
  totalDuration: number;
};

/** Mirrors `utils/timeline.compile_timeline`'s placement math exactly, so the
 * timeline draws clips at the same position ffmpeg will actually render them. */
export function computeLayout(data: ProjectData, durations: Map<string, number>): TimelineLayout {
  const introLen = data.intro.asset_id ? durations.get(`a:${data.intro.asset_id}`) ?? 0 : 0;
  const introXfade = data.intro.asset_id ? Math.min(data.intro.crossfade_ms / 1000, introLen) : 0;
  const bodyOffset = Math.max(0, introLen - introXfade);

  let bodyEnd = bodyOffset;
  for (const clip of data.clips) {
    if (clip.muted) continue;
    const duration = durations.get(sourceKey(clip.source)) ?? 0;
    bodyEnd = Math.max(bodyEnd, bodyOffset + clipEnd(clip, duration));
  }

  const outroLen = data.outro.asset_id ? durations.get(`a:${data.outro.asset_id}`) ?? 0 : 0;
  const outroXfade = data.outro.asset_id ? Math.min(data.outro.crossfade_ms / 1000, outroLen) : 0;
  const outroStart = data.outro.asset_id ? Math.max(bodyOffset, bodyEnd - outroXfade) : bodyEnd;

  return {
    introLen, introXfade, bodyOffset, bodyEnd, outroLen, outroXfade, outroStart,
    totalDuration: Math.max(introLen, bodyEnd, outroStart + outroLen),
  };
}

// --------------------------------------------------------------------------
// Tracks
// --------------------------------------------------------------------------

export function addTrack(data: ProjectData, kind: TrackKind): ProjectData {
  return { ...data, tracks: [...data.tracks, defaultTrack(kind)] };
}

export function removeTrack(data: ProjectData, trackId: string): ProjectData {
  return {
    ...data,
    tracks: data.tracks.filter((t) => t.id !== trackId),
    clips: data.clips.filter((c) => c.track_id !== trackId),
  };
}

export function updateTrack(data: ProjectData, trackId: string, patch: Partial<EditorTrack>): ProjectData {
  return {
    ...data,
    tracks: data.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
  };
}

export function updateDuck(data: ProjectData, trackId: string, patch: Partial<DuckSettings>): ProjectData {
  return {
    ...data,
    tracks: data.tracks.map((t) => (t.id === trackId ? { ...t, duck: { ...t.duck, ...patch } } : t)),
  };
}

// --------------------------------------------------------------------------
// Clips
// --------------------------------------------------------------------------

export function addClip(
  data: ProjectData,
  trackId: string,
  source: SourceRef,
  start: number,
  duration: number,
): ProjectData {
  return { ...data, clips: [...data.clips, defaultClip(trackId, source, start, duration)] };
}

export function updateClip(data: ProjectData, clipId: string, patch: Partial<TimelineClip>): ProjectData {
  return { ...data, clips: data.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) };
}

export function removeClip(data: ProjectData, clipId: string): ProjectData {
  return { ...data, clips: data.clips.filter((c) => c.id !== clipId) };
}

export function removeClips(data: ProjectData, clipIds: Set<string>): ProjectData {
  return { ...data, clips: data.clips.filter((c) => !clipIds.has(c.id)) };
}

export function moveClip(data: ProjectData, clipId: string, trackId: string, start: number): ProjectData {
  return updateClip(data, clipId, { track_id: trackId, start: Math.max(0, start) });
}

export function nudgeClip(data: ProjectData, clipId: string, deltaSeconds: number): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  return updateClip(data, clipId, { start: Math.max(0, clip.start + deltaSeconds) });
}

/** Drag the clip's left edge: trims `in_point` and shifts `start` together.
 * Clamped — past the source start, the timeline start, or the out point the
 * edge stops there rather than rejecting the move. */
export function trimClipStart(
  data: ProjectData,
  clipId: string,
  newStart: number,
  sourceDuration: number,
): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  const out = clip.out_point ?? (sourceDuration > 0 ? sourceDuration : Infinity);
  const minDelta = Math.max(-clip.in_point, -clip.start);
  const maxDelta = out - 0.05 - clip.in_point;
  const delta = Math.min(maxDelta, Math.max(minDelta, newStart - clip.start));
  return updateClip(data, clipId, { start: clip.start + delta, in_point: clip.in_point + delta });
}

/** Drag the clip's right edge: trims `out_point`, clamped to the source length. */
export function trimClipEnd(data: ProjectData, clipId: string, newEnd: number, sourceDuration: number): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  const newOut = clip.in_point + Math.max(0.05, newEnd - clip.start);
  const capped = sourceDuration > 0 ? Math.min(newOut, sourceDuration) : newOut;
  return updateClip(data, clipId, { out_point: capped });
}

export function splitClip(data: ProjectData, clipId: string, atTime: number): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  const cut = atTime - clip.start;
  if (cut <= 0.02) return data;
  const outPoint = clip.out_point;
  if (outPoint != null && cut >= outPoint - clip.in_point - 0.02) return data;

  const left: TimelineClip = { ...clip, out_point: clip.in_point + cut, fade_out: 0 };
  const right: TimelineClip = {
    ...clip,
    id: uid("c"),
    start: atTime,
    in_point: clip.in_point + cut,
    out_point: outPoint,
    fade_in: 0,
  };
  return {
    ...data,
    clips: data.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c])),
  };
}

export function duplicateClip(data: ProjectData, clipId: string, sourceDuration: number): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  const copy: TimelineClip = { ...clip, id: uid("c"), start: clipEnd(clip, sourceDuration) };
  return { ...data, clips: [...data.clips, copy] };
}

export function setClipEffects(data: ProjectData, clipId: string, effects: EffectInstance[]): ProjectData {
  return updateClip(data, clipId, { effects });
}

export function setTrackEffects(data: ProjectData, trackId: string, effects: EffectInstance[]): ProjectData {
  return updateTrack(data, trackId, { effects });
}

export function setMasterEffects(data: ProjectData, effects: EffectInstance[]): ProjectData {
  return { ...data, master: { ...data.master, effects } };
}

export function addEffect(effects: EffectInstance[], type: string, defaults: Record<string, number | string | boolean>): EffectInstance[] {
  return [...effects, { id: uid("fx"), type, params: { ...defaults }, enabled: true }];
}

export function removeEffect(effects: EffectInstance[], id: string): EffectInstance[] {
  return effects.filter((e) => e.id !== id);
}

export function updateEffect(effects: EffectInstance[], id: string, patch: Partial<EffectInstance>): EffectInstance[] {
  return effects.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

export function moveEffect(effects: EffectInstance[], id: string, delta: number): EffectInstance[] {
  const index = effects.findIndex((e) => e.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= effects.length) return effects;
  const next = [...effects];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// --------------------------------------------------------------------------
// Intro / outro
// --------------------------------------------------------------------------

export function setIntro(data: ProjectData, patch: Partial<IntroOutroSlot>): ProjectData {
  return { ...data, intro: { ...data.intro, ...patch } };
}

export function setOutro(data: ProjectData, patch: Partial<IntroOutroSlot>): ProjectData {
  return { ...data, outro: { ...data.outro, ...patch } };
}

// --------------------------------------------------------------------------
// Silence removal
// --------------------------------------------------------------------------

/** Ripple-delete a set of [start,end) regions out of one clip's visible span,
 * shortening it in place (multiple cuts become multiple shorter clips). */
export function cutRegionsFromClip(
  data: ProjectData,
  clipId: string,
  regions: { start: number; end: number }[],
  sourceDuration: number,
): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip || regions.length === 0) return data;
  const sorted = [...regions].sort((a, b) => a.start - b.start);

  const pieces: TimelineClip[] = [];
  let cursor = clip.in_point;
  let timelineCursor = clip.start;
  for (const region of sorted) {
    const regionStart = clip.in_point + Math.max(0, region.start - clip.start);
    const regionEnd = clip.in_point + Math.max(0, region.end - clip.start);
    if (regionStart > cursor) {
      const length = regionStart - cursor;
      pieces.push({
        ...clip, id: uid("c"), start: timelineCursor, in_point: cursor, out_point: regionStart,
        fade_in: pieces.length === 0 ? clip.fade_in : 0, fade_out: 0,
      });
      timelineCursor += length;
    }
    cursor = Math.max(cursor, regionEnd);
  }
  const tail = clip.out_point ?? sourceDuration;
  if (tail > cursor) {
    pieces.push({
      ...clip, id: uid("c"), start: timelineCursor, in_point: cursor, out_point: tail,
      fade_in: pieces.length === 0 ? clip.fade_in : 0, fade_out: clip.fade_out,
    });
  }
  return { ...data, clips: data.clips.flatMap((c) => (c.id === clipId ? pieces : [c])) };
}

// --------------------------------------------------------------------------
// Snapping
// --------------------------------------------------------------------------

/** Nearest of `candidates` to `time`, if one is within `tolerance` seconds —
 * otherwise `time` unchanged. Pure: the caller converts its pixel snap
 * distance to seconds via the current zoom before calling this. */
export function snapTime(time: number, candidates: number[], tolerance: number): number {
  let best = time;
  let bestDelta = tolerance;
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - time);
    if (delta <= bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

// --------------------------------------------------------------------------
// Razor / ripple / range tools
// --------------------------------------------------------------------------

/** Razor "cut all tracks": split every clip crossing `time`. */
export function splitAllAt(data: ProjectData, time: number): ProjectData {
  let next = data;
  for (const clip of data.clips) {
    const cut = time - clip.start;
    const outPoint = clip.out_point;
    const crosses = cut > 0.02 && (outPoint == null || cut < outPoint - clip.in_point - 0.02);
    if (crosses) next = splitClip(next, clip.id, time);
  }
  return next;
}

/** Remove one clip and shift every later clip on its own track left to close
 * the gap. `sourceDuration` resolves the removed clip's own length when it's
 * open-ended (no `out_point`). */
export function rippleDeleteClip(data: ProjectData, clipId: string, sourceDuration: number): ProjectData {
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) return data;
  const length = clipLength(clip, sourceDuration);
  const trackId = clip.track_id;
  const cutStart = clip.start;
  return {
    ...data,
    clips: data.clips
      .filter((c) => c.id !== clipId)
      .map((c) =>
        c.track_id === trackId && c.start >= cutStart + length - 1e-3
          ? { ...c, start: Math.max(0, c.start - length) }
          : c,
      ),
  };
}

/** Cut the `[start, end)` time range out of every clip on `trackIds` (default:
 * all tracks), splitting/trimming clips that only partly overlap and dropping
 * ones fully inside — leaves a gap, doesn't ripple what comes after. */
export function deleteRange(
  data: ProjectData,
  start: number,
  end: number,
  durations: Map<string, number>,
  trackIds?: string[],
): ProjectData {
  if (end <= start) return data;
  const targets = trackIds ? new Set(trackIds) : null;
  const nextClips: TimelineClip[] = [];
  for (const clip of data.clips) {
    if (targets && !targets.has(clip.track_id)) {
      nextClips.push(clip);
      continue;
    }
    const duration = durations.get(sourceKey(clip.source)) ?? 0;
    const endTime = clipEnd(clip, duration);
    if (clip.start >= end || endTime <= start) {
      nextClips.push(clip);
      continue;
    }
    const overlapsLeft = clip.start < start;
    const overlapsRight = endTime > end;
    if (overlapsLeft && overlapsRight) {
      nextClips.push({ ...clip, out_point: clip.in_point + (start - clip.start), fade_out: 0 });
      nextClips.push({
        ...clip, id: uid("c"), start: end,
        in_point: clip.in_point + (end - clip.start),
        out_point: clip.out_point, fade_in: 0,
      });
    } else if (overlapsLeft) {
      nextClips.push({ ...clip, out_point: clip.in_point + (start - clip.start), fade_out: 0 });
    } else if (overlapsRight) {
      nextClips.push({
        ...clip, start: end,
        in_point: clip.in_point + (end - clip.start),
        out_point: clip.out_point, fade_in: 0,
      });
    }
    // else: fully inside [start, end) — dropped.
  }
  return { ...data, clips: nextClips };
}

/** Like `deleteRange`, but everything starting at/after `end` on the same
 * tracks then shifts left to close the gap. */
export function rippleDeleteRange(
  data: ProjectData,
  start: number,
  end: number,
  durations: Map<string, number>,
  trackIds?: string[],
): ProjectData {
  const cut = deleteRange(data, start, end, durations, trackIds);
  const targets = trackIds ? new Set(trackIds) : null;
  const shift = end - start;
  return {
    ...cut,
    clips: cut.clips.map((c) =>
      (!targets || targets.has(c.track_id)) && c.start >= end - 1e-6
        ? { ...c, start: Math.max(0, c.start - shift) }
        : c,
    ),
  };
}

/** Opens a `duration`-second gap at `time` on `trackIds` (default: all),
 * splitting any clip that crosses it first, then shifting everything at/after
 * `time` on those tracks to the right. */
export function insertSilence(
  data: ProjectData,
  time: number,
  duration: number,
  trackIds?: string[],
): ProjectData {
  if (duration <= 0) return data;
  const targets = trackIds ? new Set(trackIds) : null;
  let next = data;
  for (const clip of data.clips) {
    if (targets && !targets.has(clip.track_id)) continue;
    const cut = time - clip.start;
    const outPoint = clip.out_point;
    const crosses = cut > 0.02 && (outPoint == null || cut < outPoint - clip.in_point - 0.02);
    if (crosses) next = splitClip(next, clip.id, time);
  }
  return {
    ...next,
    clips: next.clips.map((c) =>
      (!targets || targets.has(c.track_id)) && c.start >= time - 1e-6
        ? { ...c, start: c.start + duration }
        : c,
    ),
  };
}

/** Clone `clips` onto `trackId`, re-anchored so the earliest of them starts
 * at `atTime` — used by paste and by copy-duplicate-at-playhead. */
export function pasteClips(
  data: ProjectData,
  clips: TimelineClip[],
  atTime: number,
  trackId: string,
): ProjectData {
  if (clips.length === 0) return data;
  const earliest = Math.min(...clips.map((c) => c.start));
  const pasted = clips.map((c) => ({
    ...c,
    id: uid("c"),
    track_id: trackId,
    start: Math.max(0, atTime + (c.start - earliest)),
  }));
  return { ...data, clips: [...data.clips, ...pasted] };
}

// --------------------------------------------------------------------------
// Markers
// --------------------------------------------------------------------------

export function addMarker(data: ProjectData, time: number, label = ""): ProjectData {
  const marker: Marker = { id: uid("m"), time: Math.max(0, time), label };
  return { ...data, markers: [...data.markers, marker].sort((a, b) => a.time - b.time) };
}

export function removeMarker(data: ProjectData, markerId: string): ProjectData {
  return { ...data, markers: data.markers.filter((m) => m.id !== markerId) };
}

export function renameMarker(data: ProjectData, markerId: string, label: string): ProjectData {
  return { ...data, markers: data.markers.map((m) => (m.id === markerId ? { ...m, label } : m)) };
}

export function moveMarker(data: ProjectData, markerId: string, time: number): ProjectData {
  return {
    ...data,
    markers: data.markers
      .map((m) => (m.id === markerId ? { ...m, time: Math.max(0, time) } : m))
      .sort((a, b) => a.time - b.time),
  };
}
