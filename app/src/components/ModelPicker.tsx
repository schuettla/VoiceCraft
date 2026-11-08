import type { ReactNode } from "react";
import { MODEL_STATE_TEXT, type ModelState } from "../lib/engines";
import type { LicenseTier } from "../lib/types";
import { Badge, Field, StatusDot } from "./common";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One entry of the list: a checkpoint, and whether it can run right now. */
export interface ModelOption {
  /** The catalog id. */
  id: string;
  title: string;
  /** The engine it belongs to; options are grouped by it when there are several. */
  group: string;
  state: ModelState;
  /** Overrides the standard note for the state ("not downloaded · 10.1 GB"). */
  note?: string;
}

const DOT: Record<ModelState, "good" | "warn" | "bad"> = {
  ready: "good",
  download: "warn",
  install: "warn",
  unsupported: "bad",
};

/**
 * The model chooser every Generate mode shares. All models of the mode are
 * listed, ready ones first, with what each still needs: picking one that isn't
 * ready is allowed, and the form below then says what to install or download
 * (and the Models page is one click away).
 */
export function ModelPicker({
  options,
  value,
  onChange,
  onOpenModels,
  label = "Model",
  detail,
  disabled,
}: {
  options: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  onOpenModels: () => void;
  label?: string;
  /** What the chosen model is and can do: a line of facts under the list. */
  detail?: ReactNode;
  disabled?: boolean;
}) {
  const selected = options.find((option) => option.id === value);
  const groups = [...new Set(options.map((option) => option.group))];
  const grouped = groups.length > 1;

  const item = (option: ModelOption) => (
    <SelectItem key={option.id} value={option.id} className="pr-8">
      <span className="flex w-full min-w-0 items-center gap-2">
        <StatusDot tone={DOT[option.state]} />
        <span className="truncate">{option.title}</span>
        {(option.note ?? MODEL_STATE_TEXT[option.state]) && (
          <span className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
            {option.note ?? MODEL_STATE_TEXT[option.state]}
          </span>
        )}
      </span>
    </SelectItem>
  );

  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-full min-w-0">
            {/* The items carry a status note; the closed list shows just the name. */}
            <SelectValue placeholder="No model available">
              {selected && (
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot tone={DOT[selected.state]} />
                  <span className="truncate">{selected.title}</span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {grouped
              ? groups.map((group) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {options.filter((option) => option.group === group).map(item)}
                  </SelectGroup>
                ))
              : options.map(item)}
          </SelectContent>
        </Select>
        <Button type="button" variant="ghost" size="sm" onClick={onOpenModels} className="shrink-0">
          Manage models
        </Button>
      </div>
      {detail && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {detail}
        </div>
      )}
    </Field>
  );
}

const TIER_TEXT: Record<LicenseTier, string | null> = {
  open: null,
  conditional: "License terms apply",
  noncommercial: "Non-commercial",
};

/** The license, as a chip: a name for open models, a warning tone for the rest. */
export function LicenseChip({ tier, name }: { tier: LicenseTier; name: string | null }) {
  const text = TIER_TEXT[tier];
  if (!text && !name) return null;
  return (
    <Badge tone={tier === "open" ? "neutral" : tier === "conditional" ? "warn" : "bad"}>
      {tier === "open" ? name : `${name ?? "License"} · ${text}`}
    </Badge>
  );
}
