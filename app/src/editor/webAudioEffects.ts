import type { EffectInstance } from "../lib/types";

/* Maps the subset of the ffmpeg effects registry tagged `preview: "webaudio"`
 * (see backend/effects.py) onto native Web Audio nodes, so the timeline
 * preview sounds close to the eventual render instead of only being exact
 * after an export. Effects tagged `preview: "render"` (denoise, tempo,
 * reverb…) have no cheap native equivalent and are skipped here — auditioning
 * those is what `api.previewClip` (a real ffmpeg render) is for. */

function num(params: EffectInstance["params"], key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" ? value : fallback;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** One effect's live node(s) — `input`/`output` let the caller chain several
 * of these in sequence without knowing how many internal nodes each uses. */
export type EffectNode = { input: AudioNode; output: AudioNode };

export function buildEffectNode(ctx: BaseAudioContext, effect: EffectInstance): EffectNode | null {
  const p = effect.params;
  switch (effect.type) {
    case "gain": {
      const node = ctx.createGain();
      node.gain.value = dbToGain(num(p, "db", 0));
      return { input: node, output: node };
    }
    case "highpass": {
      const node = ctx.createBiquadFilter();
      node.type = "highpass";
      node.frequency.value = num(p, "hz", 80);
      return { input: node, output: node };
    }
    case "lowpass": {
      const node = ctx.createBiquadFilter();
      node.type = "lowpass";
      node.frequency.value = num(p, "hz", 12000);
      return { input: node, output: node };
    }
    case "bass": {
      const node = ctx.createBiquadFilter();
      node.type = "lowshelf";
      node.frequency.value = num(p, "hz", 100);
      node.gain.value = num(p, "gain_db", 0);
      return { input: node, output: node };
    }
    case "treble": {
      const node = ctx.createBiquadFilter();
      node.type = "highshelf";
      node.frequency.value = num(p, "hz", 8000);
      node.gain.value = num(p, "gain_db", 0);
      return { input: node, output: node };
    }
    case "eq_band": {
      const node = ctx.createBiquadFilter();
      node.type = "peaking";
      node.frequency.value = num(p, "hz", 1000);
      node.Q.value = num(p, "width_q", 1);
      node.gain.value = num(p, "gain_db", 0);
      return { input: node, output: node };
    }
    case "mono": {
      // Forcing a stereo input through a mono-channel node downmixes it
      // (browser default: equal-power L+R) — a fair stand-in for ffmpeg's
      // explicit 0.5*c0+0.5*c1 pan formula.
      const node = ctx.createGain();
      node.channelCount = 1;
      node.channelCountMode = "explicit";
      node.channelInterpretation = "speakers";
      return { input: node, output: node };
    }
    case "compressor": {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = num(p, "threshold_db", -18);
      comp.ratio.value = num(p, "ratio", 3);
      comp.attack.value = num(p, "attack_ms", 20) / 1000;
      comp.release.value = num(p, "release_ms", 250) / 1000;
      comp.knee.value = 6;
      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(num(p, "makeup_db", 0));
      comp.connect(makeup);
      return { input: comp, output: makeup };
    }
    default:
      return null;
  }
}

/** Chains every enabled, live-previewable effect in order. `input`/`output`
 * are `null` when nothing in the list has a live node (all render-only, or
 * the list is empty) — the caller should skip inserting the chain then. */
export function buildEffectChain(
  ctx: BaseAudioContext,
  effects: EffectInstance[],
): { input: AudioNode | null; output: AudioNode | null } {
  let input: AudioNode | null = null;
  let output: AudioNode | null = null;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    const node = buildEffectNode(ctx, effect);
    if (!node) continue;
    if (output) output.connect(node.input);
    input ??= node.input;
    output = node.output;
  }
  return { input, output };
}
