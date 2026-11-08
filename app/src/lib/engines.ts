import type { AudioEngine } from "./types";

/**
 * Which engine a Music / Sound FX form uses, when a kind has several.
 *
 * Order of preference, so the form shows something that can work:
 *   1. the engine the user picked last time, if it is ready now;
 *   2. the first ready one (the backend lists a kind's default first);
 *   3. the default, if this machine can run it (the install card then says what
 *      is missing);
 *   4. the first engine this machine *can* run — a CPU-only machine gets Stable
 *      Audio 3 Small here, with `passedOver` set to the default that can't run;
 *   5. the default, so the card can say why nothing works.
 */
export function chooseEngine(
  engines: AudioEngine[],
  remembered: string,
): { engine: AudioEngine | null; passedOver: AudioEngine | null } {
  const standard = engines.find((item) => item.default) ?? engines[0] ?? null;
  const picked =
    engines.find((item) => item.name === remembered && item.ready) ??
    engines.find((item) => item.ready) ??
    (standard?.supported ? standard : null) ??
    engines.find((item) => item.supported) ??
    standard;
  const passedOver =
    picked && standard && picked.name !== standard.name && !standard.supported ? standard : null;
  return { engine: picked, passedOver };
}

/**
 * Engines whose checkpoints ignore the guidance setting (distilled models: the
 * ACE-Step turbo ones and Stable Audio 3's post-trained checkpoints).
 */
export function ignoresGuidance(engine: AudioEngine): boolean {
  return engine.name.startsWith("sa3_") || (engine.model_id?.includes("turbo") ?? false);
}

/** Engines worth offering in a selector: the ones that would run right now. */
export function readyEngines(engines: AudioEngine[]): AudioEngine[] {
  return engines.filter((item) => item.ready);
}
