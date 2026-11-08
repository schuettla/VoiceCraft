import { Mic, Music, Zap } from "lucide-react";
import type { GenerationKind } from "../lib/types";
import { cn } from "@/lib/utils";

const KINDS: Record<GenerationKind, { icon: typeof Mic; label: string }> = {
  speech: { icon: Mic, label: "Voice" },
  music: { icon: Music, label: "Music" },
  sfx: { icon: Zap, label: "Sound effect" },
};

/** The kind of a generation as a small icon, with the name as its tooltip text. */
export function KindIcon({ kind, className }: { kind: GenerationKind; className?: string }) {
  const { icon: Icon, label } = KINDS[kind] ?? KINDS.speech;
  return (
    <Icon
      aria-label={label}
      role="img"
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
    >
      <title>{label}</title>
    </Icon>
  );
}
