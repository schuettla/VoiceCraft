import type { AudioEngine } from "./types";

/**
 * One (engine, model) pair, shaped like an engine so the forms and the install
 * card can treat "ACE-Step 1.5 (quality)" and "ACE-Step 1.5 (turbo)" alike: the
 * per-model facts (weights, limits, defaults, license) replace the engine's own,
 * which describe whichever checkpoint is active. `name` stays the engine's;
 * `model_id` tells the views apart.
 */
export type ModelView = AudioEngine & { active: boolean };

/** Every model of every engine, engines in the order given, each engine's default first. */
export function modelViews(engines: AudioEngine[]): ModelView[] {
  return engines.flatMap((engine) => {
    if (!engine.models?.length) return [{ ...engine, active: true }];
    return engine.models.map((model): ModelView => ({
      ...engine,
      active: model.active,
      default: engine.default && model.default,
      label: model.title,
      model_id: model.id,
      model_title: model.title,
      model_downloaded: model.downloaded,
      download_estimate_bytes: model.download_estimate_bytes,
      license_tier: model.license_tier,
      license_name: model.license_name,
      license_url: model.license_url,
      gated: model.gated,
      supported: engine.supported && model.unavailable_reason === null,
      unsupported_reason: model.unavailable_reason ?? engine.unsupported_reason,
      max_duration_seconds: engine.supported ? model.max_duration_seconds : null,
      default_steps: model.default_steps,
      default_guidance: model.default_guidance,
      ready: model.ready,
    }));
  });
}

/**
 * Which model a Music / Sound FX form uses, when a kind has several.
 *
 * Order of preference, so the form shows something that can work:
 *   0. the one the user picked in the list, even if it still needs installing or
 *      downloading (the card then says what is missing);
 *   1. the one picked last time, if it is ready now;
 *   2. the model its engine has active, if ready (the Models page's choice);
 *   3. the first ready one (the backend lists a kind's default first);
 *   4. the default, if this machine can run it (the install card says what is missing);
 *   5. the first one this machine *can* run — a CPU-only machine gets Stable Audio 3
 *      Small here, with `passedOver` set to the default that can't run;
 *   6. the default, so the card can say why nothing works.
 */
export function chooseEngine(
  engines: ModelView[],
  remembered: string,
  picked = "",
): { engine: ModelView | null; passedOver: ModelView | null } {
  const standard = engines.find((item) => item.default) ?? engines[0] ?? null;
  const explicit = picked ? engines.find((item) => item.model_id === picked) : undefined;
  const chosen =
    explicit ??
    engines.find((item) => item.model_id === remembered && item.ready) ??
    engines.find((item) => item.active && item.ready) ??
    engines.find((item) => item.ready) ??
    (standard?.supported ? standard : null) ??
    engines.find((item) => item.supported) ??
    standard;
  const passedOver =
    !explicit && chosen && standard && chosen.model_id !== standard.model_id && !standard.supported
      ? standard
      : null;
  return { engine: chosen, passedOver };
}

/**
 * Engines whose checkpoints ignore the guidance setting (distilled models: the
 * ACE-Step turbo ones and Stable Audio 3's post-trained checkpoints).
 */
export function ignoresGuidance(engine: AudioEngine): boolean {
  return engine.name.startsWith("sa3_") || (engine.model_id?.includes("turbo") ?? false);
}

/** What a model needs before it can run, in the order a person does it. */
export type ModelState = "ready" | "install" | "download" | "unsupported";

export function modelState(view: ModelView): ModelState {
  if (view.ready) return "ready";
  if (!view.supported) return "unsupported";
  if (!view.installed) return "install";
  return "download";
}

export const MODEL_STATE_TEXT: Record<ModelState, string> = {
  ready: "",
  install: "engine not installed",
  download: "not downloaded",
  unsupported: "can't run here",
};
