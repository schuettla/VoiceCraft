import { useMemo } from "react";
import type { ModelView } from "../lib/engines";
import { modelState } from "../lib/engines";
import { formatBytes, formatDuration } from "../lib/format";
import { engineLabel } from "../lib/library";
import { LicenseChip, ModelPicker, type ModelOption } from "./ModelPicker";
import { Badge } from "./common";

/**
 * The Music / Sound FX model list: every model of every engine of the kind, with
 * what the chosen one can do (vocals, editing a clip, length, steps, license).
 */
export function AudioModelPicker({
  models,
  chosen,
  onPick,
  onOpenModels,
}: {
  /** Every model of the kind (ready or not). */
  models: ModelView[];
  /** The one the form is showing. */
  chosen: ModelView | null;
  onPick: (modelId: string) => void;
  onOpenModels: () => void;
}) {
  const options = useMemo<ModelOption[]>(() => {
    const rows = models.map((view): ModelOption => {
      const state = modelState(view);
      return {
        id: view.model_id ?? view.name,
        title: view.model_title ?? view.label,
        group: engineLabel(view.name) ?? view.name,
        state,
        note:
          state === "download" && view.download_estimate_bytes
            ? `not downloaded · ${formatBytes(view.download_estimate_bytes)}`
            : undefined,
      };
    });
    // Models that can run now come first; the order is otherwise the backend's.
    return [...rows.filter((r) => r.state === "ready"), ...rows.filter((r) => r.state !== "ready")];
  }, [models]);

  if (models.length === 0) return null;

  return (
    <ModelPicker
      options={options}
      value={chosen?.model_id ?? ""}
      onChange={onPick}
      onOpenModels={onOpenModels}
      detail={chosen && <Detail view={chosen} />}
    />
  );
}

function Detail({ view }: { view: ModelView }) {
  const summary = view.models.find((model) => model.id === view.model_id)?.summary;
  return (
    <>
      <LicenseChip tier={view.license_tier} name={view.license_name} />
      {view.kind === "music" && (
        <Badge>{view.lyrics ? "Instrumental or vocals" : "Instrumental only"}</Badge>
      )}
      {view.editing && <Badge>Edits clips</Badge>}
      {view.max_duration_seconds != null && (
        <Badge>up to {formatDuration(view.max_duration_seconds)}</Badge>
      )}
      {view.default_steps != null && <Badge>{view.default_steps} steps</Badge>}
      {summary && <span className="basis-full pt-0.5 leading-relaxed">{summary}</span>}
    </>
  );
}
