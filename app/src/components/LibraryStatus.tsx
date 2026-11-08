import type { ItemStatus, StatusFilter } from "../lib/library";
import { StatusDot } from "./common";
import { TrashIcon } from "./icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How many items are in each state, for whatever the Library is showing. */
export type StatusCounts = Record<ItemStatus, number> & { all: number };

const CHIPS: {
  value: StatusFilter;
  label: string;
  tone: "neutral" | "good" | "busy" | "bad";
}[] = [
  { value: "all", label: "All", tone: "neutral" },
  { value: "ready", label: "Ready", tone: "good" },
  { value: "active", label: "Generating", tone: "busy" },
  { value: "failed", label: "Failed", tone: "bad" },
];

/**
 * Where things stand — secondary to *what* they are, so it is a quiet strip of
 * counted chips under the type tabs rather than a filter of its own weight.
 *
 * It only appears when there is something to say — a job running or failed, or
 * a status filter in effect — so a healthy library shows no strip at all.
 * "Generating" and "Failed" chips likewise only appear while they have items.
 */
export function LibraryStatus({
  counts,
  value,
  onChange,
  onClearFailed,
}: {
  counts: StatusCounts;
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  /** Delete every failed item in view. */
  onClearFailed: () => void;
}) {
  // Everything is simply ready: "All 8 · Ready 8" would say the same thing twice.
  if (value === "all" && counts.active === 0 && counts.failed === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5">
        {CHIPS.filter(
          (chip) =>
            chip.value === "all" ||
            chip.value === "ready" ||
            counts[chip.value] > 0 ||
            chip.value === value,
        ).map((chip) => {
          const on = value === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(chip.value)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                on
                  ? "border-transparent bg-accent text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {chip.value !== "all" && <StatusDot tone={chip.tone} />}
              {chip.label}
              <span className="tabular-nums text-muted-foreground">{counts[chip.value]}</span>
            </button>
          );
        })}
      </div>

      {counts.failed > 0 && (
        <Button
          size="xs"
          variant="ghost"
          className="ml-1 h-7 text-xs text-muted-foreground hover:text-coral-red"
          onClick={onClearFailed}
        >
          <TrashIcon />
          Clear {counts.failed} failed
        </Button>
      )}
    </div>
  );
}
