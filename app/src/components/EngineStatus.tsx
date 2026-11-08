import type { Health } from "@/lib/types";
import { StatusDot } from "@/components/common";

type Line = { tone: "good" | "warn" | "bad" | "busy"; text: string };

/** FR13: say what the backend is doing rather than showing a blind spinner. */
function statusLines(health: Health | null, reachable: boolean | null): Line[] {
  if (reachable === null) return [{ tone: "busy", text: "Connecting to backend…" }];
  if (!reachable) return [{ tone: "bad", text: "Backend offline — retrying" }];
  if (!health) return [];

  const lines: Line[] = [];
  if (!health.ffmpeg) lines.push({ tone: "bad", text: "ffmpeg not found" });
  for (const engine of health.engines) {
    // Engines the user installs on demand (music, SFX) aren't a fault when absent.
    if (engine.optional && !engine.available) continue;
    if (!engine.available) {
      lines.push({ tone: "warn", text: `${engine.name} not installed` });
    } else if (!engine.model_downloaded) {
      // Installed but no weights on disk: the first generation would stall on
      // a multi-gigabyte download. Say so here rather than letting it surprise them.
      lines.push({ tone: "warn", text: `${engine.name} model not downloaded` });
    }
  }
  for (const engine of health.engines.filter((e) => e.loaded)) {
    lines.push({
      tone: "good",
      text: `${engine.name} loaded${engine.device ? ` · ${engine.device}` : ""}`,
    });
  }
  if (lines.length === 0) lines.push({ tone: "good", text: "Ready" });
  return lines;
}

/** Engine / backend state, shown at the right of the top bar. */
export function EngineStatus({
  health,
  reachable,
}: {
  health: Health | null;
  reachable: boolean | null;
}) {
  const lines = statusLines(health, reachable);
  return (
    <div className="ml-auto flex min-w-0 items-center justify-end gap-x-4 overflow-hidden">
      {lines.map((line) => (
        <div
          key={line.text}
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <StatusDot tone={line.tone} />
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
