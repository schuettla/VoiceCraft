import { useState } from "react";
import type { EngineStatus as Engine, Health } from "@/lib/types";
import { isTauri } from "@/lib/tauri";
import { StatusDot } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Display names for the backend's engine ids (the health payload carries ids only). */
const ENGINE_LABEL: Record<string, string> = {
  qwen: "Qwen3-TTS",
  kokoro: "Kokoro",
  kitten: "KittenTTS 2",
  acestep: "ACE-Step",
  moss_sfx: "MOSS-SoundEffect",
  sa3_music: "Stable Audio 3 (music)",
  sa3_sfx: "Stable Audio 3 (effects)",
};

const label = (name: string) => ENGINE_LABEL[name] ?? name;

type Tone = "good" | "warn" | "bad" | "busy";
type Fix = "models" | "setup";

/** Something the user should know about, with what it means and how to fix it. */
type Issue = { tone: Tone; text: string; detail: string; fix?: Fix };

/** FR13: say what the backend is doing rather than showing a blind spinner. */
function issues(health: Health | null, reachable: boolean | null): Issue[] {
  if (reachable === null) {
    return [{ tone: "busy", text: "Connecting to backend…", detail: "Waiting for the local engine service to answer." }];
  }
  if (!reachable) {
    return [
      {
        tone: "bad",
        text: "Backend offline — retrying",
        detail:
          "The local engine service isn't answering. VoiceCraft keeps retrying; if it stays offline, re-run engine setup.",
        fix: "setup",
      },
    ];
  }
  if (!health) return [];

  const list: Issue[] = [];
  if (!health.ffmpeg) {
    list.push({
      tone: "bad",
      text: "ffmpeg not found",
      detail: "Exports to MP3 / OGG / FLAC and the editor's mixdown need ffmpeg. Install it, make sure it is on PATH, then restart VoiceCraft.",
    });
  }
  for (const engine of health.engines) {
    // Engines the user installs on demand (music, SFX) aren't a fault when absent.
    if (engine.optional && !engine.available) continue;
    if (!engine.available) {
      list.push({
        tone: "warn",
        text: `${label(engine.name)} not installed`,
        detail: "Its Python packages are missing, so voices on this engine can't generate. Engine setup reinstalls them.",
        fix: "setup",
      });
    } else if (!engine.model_downloaded) {
      // Installed but no weights on disk: the first generation would stall on
      // a multi-gigabyte download. Say so here rather than letting it surprise them.
      list.push({
        tone: "warn",
        text: `${label(engine.name)} model not downloaded`,
        detail: `${engine.model ?? "Its model"} isn't on disk yet. Download it on the Models page before generating with this engine.`,
        fix: "models",
      });
    }
  }
  return list;
}

/** One engine's state in a few words, for the details panel. */
function engineState(engine: Engine): { tone: Tone | "neutral"; text: string } {
  if (!engine.available) {
    return engine.optional
      ? { tone: "neutral", text: "not installed (optional)" }
      : { tone: "warn", text: "not installed" };
  }
  if (!engine.model_downloaded) return { tone: "warn", text: "model not downloaded" };
  if (engine.loaded) return { tone: "good", text: `loaded${engine.device ? ` · ${engine.device}` : ""}` };
  return { tone: "neutral", text: "ready" };
}

/**
 * Engine / backend state at the left of the status bar. One summary item; a
 * click opens a panel with every issue (and how to fix it) and each engine.
 */
export function EngineStatus({
  health,
  reachable,
  onOpenModels,
  onRunSetup,
}: {
  health: Health | null;
  reachable: boolean | null;
  onOpenModels: () => void;
  onRunSetup: () => void;
}) {
  const [open, setOpen] = useState(false);
  const found = issues(health, reachable);
  const loaded = health && reachable ? health.engines.filter((engine) => engine.loaded) : [];

  const summary: { tone: Tone; text: string } =
    found.length > 1
      ? {
          tone: found.some((issue) => issue.tone === "bad") ? "bad" : "warn",
          text: `${found.length} setup issues`,
        }
      : found[0] ?? { tone: "good", text: "Ready" };

  function fix(kind: Fix) {
    setOpen(false);
    if (kind === "models") onOpenModels();
    else onRunSetup();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-full min-w-0 items-center gap-x-4 overflow-hidden px-2 transition-colors hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.08] data-[state=open]:text-foreground"
        >
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusDot tone={summary.tone} />
            {summary.text}
          </span>
          {loaded.map((engine) => (
            <span key={engine.name} className="flex shrink-0 items-center gap-1.5">
              <StatusDot tone="good" />
              {label(engine.name)} loaded{engine.device ? ` · ${engine.device}` : ""}
            </span>
          ))}
        </button>
      </PopoverTrigger>

      <PopoverContent side="top" align="start" sideOffset={6} className="w-96 p-0 text-[13px]">
        <div className="flex items-baseline justify-between gap-3 border-b px-3 py-2.5">
          <span className="font-medium text-foreground">Engine status</span>
          <span className="text-xs text-muted-foreground">
            {reachable
              ? `Backend connected${health ? ` · v${health.version}` : ""}`
              : reachable === null
                ? "Connecting…"
                : "Backend offline"}
          </span>
        </div>

        {found.length > 0 ? (
          <ul className="divide-y">
            {found.map((issue) => (
              <li key={issue.text} className="space-y-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <StatusDot tone={issue.tone} />
                  {issue.text}
                </div>
                <p className="pl-3.5 text-xs leading-relaxed text-muted-foreground">{issue.detail}</p>
                {issue.fix === "models" && (
                  <div className="pl-3.5">
                    <Button size="xs" variant="outline" onClick={() => fix("models")}>
                      Open Models
                    </Button>
                  </div>
                )}
                {issue.fix === "setup" && isTauri() && (
                  <div className="pl-3.5">
                    <Button size="xs" variant="outline" onClick={() => fix("setup")}>
                      Run engine setup
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2.5 text-xs text-muted-foreground">Nothing needs attention.</p>
        )}

        {health && reachable && health.engines.length > 0 && (
          <div className="border-t px-3 py-2.5">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              Engines
            </div>
            <ul className="space-y-1">
              {health.engines.map((engine) => {
                const state = engineState(engine);
                return (
                  <li key={engine.name} className="flex items-center gap-2 text-xs">
                    <StatusDot tone={state.tone} />
                    <span className="min-w-0 flex-1 truncate text-foreground" title={engine.model ?? undefined}>
                      {label(engine.name)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{state.text}</span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-1.5 truncate text-[11px] text-muted-foreground" title={health.data_dir}>
              Data: <span className="font-mono">{health.data_dir}</span>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
