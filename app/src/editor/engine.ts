import type { EffectInstance, ProjectData, SourceRef } from "../lib/types";
import type { TimelineLayout } from "./ops";
import { buildEffectChain } from "./webAudioEffects";

/* A multitrack playback engine on top of Web Audio.
 *
 * Gain, pan, mute/solo, fades, and the intro/outro (with their crossfades)
 * are reproduced exactly — they're just gain nodes and automation, placed
 * with the same `computeLayout()` math the renderer uses. Clip- and
 * track-level effects tagged `preview: "webaudio"` in the backend registry
 * (gain, EQ/filter shapes, mono, compressor) get real native nodes via
 * `webAudioEffects.ts`, chained into each voice's signal path and each
 * track's bus. Auto-ducking is *approximated* live — an envelope follower on
 * the key track's post-effects level drives the ducked track's gain — since
 * Web Audio has no sidechain-compressor node; the real `sidechaincompress`
 * only runs at export. Effects with no live node (`preview: "render"` —
 * noise reduction, tempo, reverb…) aren't reproduced at all; auditioning
 * those exactly is what `api.previewClip` (a real ffmpeg render of one clip)
 * is for. The whole mix is only exact after a render.
 *
 * Sources longer than STREAM_THRESHOLD_S stream through an <audio> element
 * instead of a fully-decoded buffer, so a multi-hour recording placed on the
 * timeline doesn't force a multi-hundred-MB decodeAudioData() call; the
 * trade-off is best-effort (not sample-accurate) scheduling for those voices.
 *
 * All positions here are timeline time (0 = start of the intro).
 */

const STREAM_THRESHOLD_S = 20 * 60;
/** Envelope-follower rate for the live ducking approximation. */
const DUCK_TICK_MS = 40;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** One sound to schedule, already resolved to timeline time. */
type Voice = {
  url: string;
  at: number; // timeline start
  inPoint: number;
  outPoint: number | null; // null = to the end of the buffer
  gain: number;
  fadeIn: number;
  fadeOut: number;
  pan: number;
  trackId?: string; // undefined for intro/outro, which have no track/effects
  effects: EffectInstance[];
};

type ScheduledBuffer = { kind: "buffer"; source: AudioBufferSourceNode; nodes: AudioNode[] };
type ScheduledStream = {
  kind: "stream";
  el: HTMLAudioElement;
  nodes: AudioNode[];
  startTimer: number;
  stopTimer: number;
};
type Scheduled = ScheduledBuffer | ScheduledStream;

/** A track's live bus: everything a voice on that track routes through
 * before reaching the master — its effect chain, then a duck gain the
 * envelope follower drives. */
type TrackBus = { input: AudioNode; duckGain: GainNode; duckTargetTrackIds: string[]; duckAmount: number };

export class PlaybackEngine {
  private ctx: AudioContext;
  private master: GainNode;
  readonly analyser: AnalyserNode;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  /** One real MediaElementAudioSourceNode per URL — the browser only allows
   * creating it once per <audio> element, so streamed sources are cached. */
  private streamSources = new Map<string, { el: HTMLAudioElement; node: MediaElementAudioSourceNode }>();
  private scheduled: Scheduled[] = [];
  private trackBuses = new Map<string, TrackBus>();
  private trackLevelTaps = new Map<string, AnalyserNode>();
  private duckLevels = new Map<string, number>(); // smoothed 0..1, per ducked track
  private duckLoop: number | undefined;
  private playing = false;
  /** Bumped by every play/stop so a play still decoding can tell it was superseded. */
  private generation = 0;
  private startedAtContextTime = 0;
  private startedAtTimelineTime = 0;
  private endTimer: number | undefined;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTime(): number {
    if (!this.playing) return this.startedAtTimelineTime;
    return this.startedAtTimelineTime + (this.ctx.currentTime - this.startedAtContextTime);
  }

  private loadBuffer(url: string): Promise<AudioBuffer> {
    let entry = this.buffers.get(url);
    if (!entry) {
      entry = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => this.ctx.decodeAudioData(buf));
      this.buffers.set(url, entry);
      entry.catch(() => this.buffers.delete(url));
    }
    return entry;
  }

  private getStreamSource(url: string): { el: HTMLAudioElement; node: MediaElementAudioSourceNode } {
    let entry = this.streamSources.get(url);
    if (!entry) {
      const el = new Audio(url);
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      const node = this.ctx.createMediaElementSource(el);
      entry = { el, node };
      this.streamSources.set(url, entry);
    }
    return entry;
  }

  /** Build (or rebuild) this play cycle's per-track buses: effect chain then
   * a duck gain, both feeding the master. Ducking itself is wired separately
   * once every voice's track is known to be in use. */
  private buildTrackBuses(data: ProjectData): void {
    this.trackBuses.clear();
    for (const track of data.tracks) {
      const chain = buildEffectChain(this.ctx, track.effects);
      const duckGain = this.ctx.createGain();
      duckGain.gain.value = 1;
      const input = chain.input ?? duckGain;
      if (chain.output) chain.output.connect(duckGain);
      duckGain.connect(this.master);
      const keyIds = track.duck.enabled ? track.duck.against_track_ids.filter((id) => id !== track.id) : [];
      this.trackBuses.set(track.id, { input, duckGain, duckTargetTrackIds: keyIds, duckAmount: track.duck.amount_db });
    }
  }

  /** Envelope-follower tap on a track's post-effects, pre-duck level — reused
   * across every ducked track that keys off the same track. */
  private tapFor(trackId: string): AnalyserNode | undefined {
    let analyser = this.trackLevelTaps.get(trackId);
    if (!analyser) {
      const bus = this.trackBuses.get(trackId);
      if (!bus) return undefined;
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      bus.duckGain.connect(analyser);
      this.trackLevelTaps.set(trackId, analyser);
    }
    return analyser;
  }

  private startDuckLoop(): void {
    const buffer = new Uint8Array(512);
    const tick = () => {
      if (!this.playing) return;
      for (const [trackId, bus] of this.trackBuses) {
        if (bus.duckTargetTrackIds.length === 0) continue;
        let peak = 0;
        for (const keyId of bus.duckTargetTrackIds) {
          const tap = this.tapFor(keyId);
          if (!tap) continue;
          tap.getByteTimeDomainData(buffer);
          let sum = 0;
          for (const v of buffer) {
            const centered = (v - 128) / 128;
            sum += centered * centered;
          }
          peak = Math.max(peak, Math.sqrt(sum / buffer.length));
        }
        const active = peak > 0.02;
        const target = active ? dbToGain(-Math.abs(bus.duckAmount)) : 1;
        const current = this.duckLevels.get(trackId) ?? 1;
        // Simple one-pole smoothing toward the target — an approximation of
        // attack/release, not the exact ffmpeg envelope.
        const next = current + (target - current) * 0.35;
        this.duckLevels.set(trackId, next);
        bus.duckGain.gain.setTargetAtTime(next, this.ctx.currentTime, 0.02);
      }
      this.duckLoop = window.setTimeout(tick, DUCK_TICK_MS);
    };
    tick();
  }

  /** Play the project from timeline position `at` until everything has ended.
   * Resolves `false` if a later play/stop superseded this one while it was
   * still decoding sources. */
  async play(
    data: ProjectData,
    layout: TimelineLayout,
    urlFor: (source: SourceRef) => string | null,
    at: number,
    onEnded?: () => void,
  ): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.buildTrackBuses(data);
    const voices = collectVoices(data, layout, urlFor);
    const streamed = voices.map((v) => (v.outPoint ?? 0) - v.inPoint > STREAM_THRESHOLD_S);

    // Decode every buffered (non-streamed) source BEFORE reading the clock:
    // scheduling against a timestamp taken before a multi-second decode would
    // start every clip late and out of step with the playhead.
    const loaded = await Promise.all(
      voices.map((voice, i) => (streamed[i] ? Promise.resolve(null) : this.loadBuffer(voice.url).then((b) => b, () => null))),
    );
    if (generation !== this.generation) return false;

    const now = this.ctx.currentTime;
    let maxEnd = at;

    voices.forEach((voice, i) => {
      const bus = voice.trackId ? this.trackBuses.get(voice.trackId) : undefined;
      const destination = bus?.input ?? this.master;

      if (streamed[i]) {
        const duration = (voice.outPoint ?? 0) - voice.inPoint;
        const end = voice.at + duration;
        if (duration <= 0 || end <= at) return;
        maxEnd = Math.max(maxEnd, end);
        const offsetIntoClip = Math.max(0, at - voice.at);
        const playDuration = duration - offsetIntoClip;
        const delayMs = Math.max(0, voice.at - at) * 1000;
        const when = now + delayMs / 1000;

        const { el, node } = this.getStreamSource(voice.url);
        node.disconnect();
        const gain = this.ctx.createGain();
        scheduleGain(gain.gain, when, duration, offsetIntoClip, voice);
        node.connect(gain);
        const nodes: AudioNode[] = [gain];
        let tail: AudioNode = gain;
        tail = connectEffects(this.ctx, tail, voice.effects, nodes);
        tail = connectPan(this.ctx, tail, voice.pan, nodes);
        tail.connect(destination);

        const startTimer = window.setTimeout(() => {
          el.currentTime = voice.inPoint + offsetIntoClip;
          void el.play().catch(() => undefined);
        }, delayMs);
        const stopTimer = window.setTimeout(() => el.pause(), delayMs + playDuration * 1000);
        this.scheduled.push({ kind: "stream", el, nodes, startTimer, stopTimer });
        return;
      }

      const buffer = loaded[i];
      if (!buffer) return;
      const outPoint = Math.min(voice.outPoint ?? buffer.duration, buffer.duration);
      const length = outPoint - voice.inPoint;
      const end = voice.at + length;
      if (length <= 0 || end <= at) return;
      maxEnd = Math.max(maxEnd, end);

      const offsetIntoClip = Math.max(0, at - voice.at);
      const playDuration = length - offsetIntoClip;
      const when = now + Math.max(0, voice.at - at);

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const gain = this.ctx.createGain();
      scheduleGain(gain.gain, when, length, offsetIntoClip, voice);
      source.connect(gain);
      const nodes: AudioNode[] = [gain];
      let tail: AudioNode = gain;
      tail = connectEffects(this.ctx, tail, voice.effects, nodes);
      tail = connectPan(this.ctx, tail, voice.pan, nodes);
      tail.connect(destination);
      source.start(when, voice.inPoint + offsetIntoClip, playDuration);
      this.scheduled.push({ kind: "buffer", source, nodes });
    });

    this.startedAtContextTime = now;
    this.startedAtTimelineTime = at;
    this.playing = true;
    this.startDuckLoop();
    this.endTimer = window.setTimeout(() => {
      this.playing = false;
      this.startedAtTimelineTime = maxEnd;
      onEnded?.();
    }, Math.max(0.05, maxEnd - at) * 1000 + 80);
    return true;
  }

  stop(): void {
    this.generation += 1;
    for (const entry of this.scheduled) {
      if (entry.kind === "buffer") {
        try {
          entry.source.stop();
        } catch {
          /* never started */
        }
        entry.source.disconnect();
      } else {
        window.clearTimeout(entry.startTimer);
        window.clearTimeout(entry.stopTimer);
        entry.el.pause();
      }
      entry.nodes.forEach((n) => n.disconnect());
    }
    this.scheduled = [];
    for (const bus of this.trackBuses.values()) bus.duckGain.disconnect();
    for (const tap of this.trackLevelTaps.values()) tap.disconnect();
    this.trackBuses.clear();
    this.trackLevelTaps.clear();
    this.duckLevels.clear();
    window.clearTimeout(this.endTimer);
    window.clearTimeout(this.duckLoop);
    this.playing = false;
  }

  /** Stop and park `currentTime` at `time`. */
  pauseAt(time: number): void {
    this.stop();
    this.startedAtTimelineTime = time;
  }

  dispose(): void {
    this.stop();
    for (const { el, node } of this.streamSources.values()) {
      node.disconnect();
      el.pause();
      el.src = "";
    }
    this.streamSources.clear();
    void this.ctx.close().catch(() => undefined);
  }
}

/** Inserts `effects`' live-previewable nodes after `tail`, returning the new
 * tail — a no-op (returns `tail` unchanged) if none of them have a live node. */
function connectEffects(ctx: BaseAudioContext, tail: AudioNode, effects: EffectInstance[], nodes: AudioNode[]): AudioNode {
  const chain = buildEffectChain(ctx, effects);
  if (!chain.input || !chain.output) return tail;
  tail.connect(chain.input);
  nodes.push(chain.input, chain.output);
  return chain.output;
}

function connectPan(ctx: BaseAudioContext, tail: AudioNode, pan: number, nodes: AudioNode[]): AudioNode {
  if (Math.abs(pan) <= 1e-6) return tail;
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  tail.connect(panner);
  nodes.push(panner);
  return panner;
}

/** Flatten intro, body clips (muted/solo applied), and outro into timeline-time voices. */
function collectVoices(
  data: ProjectData,
  layout: TimelineLayout,
  urlFor: (source: SourceRef) => string | null,
): Voice[] {
  const voices: Voice[] = [];
  const push = (source: SourceRef, voice: Omit<Voice, "url">) => {
    const url = urlFor(source);
    if (url) voices.push({ url, ...voice });
  };

  if (data.intro.asset_id) {
    push({ asset_id: data.intro.asset_id }, {
      at: 0, inPoint: 0, outPoint: layout.introLen || null, gain: dbToGain(data.intro.gain_db),
      fadeIn: 0, fadeOut: layout.introXfade, pan: 0, effects: [],
    });
  }

  const soloed = data.tracks.some((t) => t.solo);
  const tracks = new Map(data.tracks.filter((t) => !t.mute && (!soloed || t.solo)).map((t) => [t.id, t]));
  for (const clip of data.clips) {
    const track = tracks.get(clip.track_id);
    if (clip.muted || !track) continue;
    push(clip.source, {
      at: layout.bodyOffset + clip.start,
      inPoint: clip.in_point,
      outPoint: clip.out_point,
      // Track gain is applied here (matching the old behavior); track
      // effects/ducking are applied via the track's live bus in `play()`.
      gain: dbToGain(clip.gain_db + track.gain_db),
      fadeIn: clip.fade_in,
      fadeOut: clip.fade_out,
      pan: track.pan,
      trackId: track.id,
      effects: clip.effects,
    });
  }

  if (data.outro.asset_id) {
    push({ asset_id: data.outro.asset_id }, {
      at: layout.outroStart, inPoint: 0, outPoint: layout.outroLen || null, gain: dbToGain(data.outro.gain_db),
      fadeIn: layout.outroXfade, fadeOut: 0, pan: 0, effects: [],
    });
  }
  return voices;
}

/** Gain envelope for one voice, evaluated from `offsetIntoClip` onward so
 * starting playback mid-fade lands at the right level instead of full gain. */
function scheduleGain(
  param: AudioParam,
  when: number,
  length: number,
  offsetIntoClip: number,
  voice: Voice,
): void {
  const fadeIn = Math.min(voice.fadeIn, length);
  const fadeOut = Math.min(voice.fadeOut, length);
  const fadeOutStart = length - fadeOut;
  const levelAt = (t: number) => {
    let level = voice.gain;
    if (fadeIn > 0 && t < fadeIn) level *= t / fadeIn;
    if (fadeOut > 0 && t > fadeOutStart) level *= Math.max(0, (length - t) / fadeOut);
    return level;
  };
  const toCtx = (t: number) => when + (t - offsetIntoClip);

  param.setValueAtTime(levelAt(offsetIntoClip), when);
  if (fadeIn > 0 && offsetIntoClip < fadeIn) {
    param.linearRampToValueAtTime(levelAt(fadeIn), toCtx(fadeIn));
  }
  if (fadeOut > 0) {
    if (offsetIntoClip < fadeOutStart) param.setValueAtTime(levelAt(fadeOutStart), toCtx(fadeOutStart));
    param.linearRampToValueAtTime(0, toCtx(length));
  }
}
