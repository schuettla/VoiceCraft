import type { ReactNode } from "react";
import type { Generation } from "../lib/types";
import { engineLabel } from "../lib/library";
import { formatDuration, parseWhen } from "../lib/format";
import { Notice } from "./common";

const TEXT_LABEL: Record<Generation["kind"], string> = {
  speech: "Script",
  music: "Style prompt",
  sfx: "Description",
};

/** "output_format" → "Output format". */
function humanize(key: string): string {
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <p className="max-h-44 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
        {children}
      </p>
    </div>
  );
}

/**
 * Everything a library row leaves out: the full prompt, lyrics, the engine's
 * options (seed, steps, preset, …), timing, and any warning or error.
 */
export function GenerationDetails({
  generation: g,
  voice,
}: {
  generation: Generation;
  voice: string | null;
}) {
  const lyrics = typeof g.params?.lyrics === "string" ? g.params.lyrics.trim() : "";
  const options = Object.entries(g.params ?? {}).filter(
    ([key, value]) =>
      key !== "lyrics" &&
      (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value !== "")),
  );

  const facts: [string, ReactNode][] = [
    ["Engine", engineLabel(g.engine)],
    ["Voice", voice],
    ["Length", g.duration_seconds != null ? formatDuration(g.duration_seconds) : null],
    ["Format", g.format ? g.format.toUpperCase() : null],
    ["Device", g.device],
    ["Created", parseWhen(g.created_at).toLocaleString()],
    ...options.map(([key, value]): [string, ReactNode] => [humanize(key), String(value)]),
  ].filter((fact): fact is [string, ReactNode] => fact[1] != null && fact[1] !== "");

  return (
    <div className="space-y-3 rounded-md bg-white/[0.03] p-3">
      <Block label={TEXT_LABEL[g.kind] ?? "Text"}>{g.text}</Block>
      {lyrics && <Block label="Lyrics">{lyrics}</Block>}
      {g.error && <Notice tone="bad">{g.error}</Notice>}
      {g.warning && <Notice tone="warn">{g.warning}</Notice>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
