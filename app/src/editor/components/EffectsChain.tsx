import { useState } from "react";
import type { EffectInstance } from "../../lib/types";
import { Badge, IconButton, Select } from "../../components/ui";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "../../components/icons";
import { useEffectsRegistry } from "../effectsRegistry";
import * as ops from "../ops";

/** A generic effects chain editor — used for a clip, a track, and the master
 * bus alike. Every control is generated from `GET /api/edit/effects`' param
 * schema, so adding an effect anywhere is a backend-only change. */
export function EffectsChain({
  effects,
  onChange,
  onAudition,
}: {
  effects: EffectInstance[];
  /** `coalesce` is set for continuous controls, so a slider drag is one undo step. */
  onChange: (next: EffectInstance[], coalesce?: string) => void;
  /** Render-only effects (noise reduction, compressor, tempo…) can't be
   * approximated live — offer a real ffmpeg render instead. */
  onAudition?: (effectId: string) => void;
}) {
  const registry = useEffectsRegistry();
  const [adding, setAdding] = useState(false);
  const byType = new Map(registry.map((s) => [s.type, s]));
  const categories = [...new Set(registry.map((s) => s.category))];

  return (
    <div className="space-y-1.5">
      {effects.length === 0 && (
        <p className="text-[11px] text-ink-500">No effects — add one below.</p>
      )}
      {effects.map((effect) => {
        const spec = byType.get(effect.type);
        return (
          <div key={effect.id} className="rounded-md border border-ink-700 bg-white/[0.02] p-2">
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={effect.enabled}
                onChange={(e) => onChange(ops.updateEffect(effects, effect.id, { enabled: e.target.checked }))}
                className="size-3.5 accent-accent"
                title="Enabled"
              />
              <span className="flex-1 truncate text-[12px] text-ink-200">{spec?.label ?? effect.type}</span>
              {spec?.preview === "render" && onAudition && (
                <Badge tone="neutral">
                  <button type="button" onClick={() => onAudition(effect.id)} className="hover:text-accent">
                    render preview
                  </button>
                </Badge>
              )}
              <IconButton label="Move up" onClick={() => onChange(ops.moveEffect(effects, effect.id, -1))}>
                <ArrowUpIcon />
              </IconButton>
              <IconButton label="Move down" onClick={() => onChange(ops.moveEffect(effects, effect.id, 1))}>
                <ArrowDownIcon />
              </IconButton>
              <IconButton
                label="Remove effect"
                className="hover:text-coral-red"
                onClick={() => onChange(ops.removeEffect(effects, effect.id))}
              >
                <TrashIcon />
              </IconButton>
            </div>
            {spec && spec.params.length > 0 && (
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 pl-5">
                {spec.params.map((param) => {
                  const value = effect.params[param.key] ?? param.default;
                  return (
                    <label key={param.key} className="col-span-1 block text-[10px] text-ink-400">
                      <span className="mb-0.5 flex justify-between">
                        <span>{param.label}</span>
                        {param.kind !== "bool" && param.kind !== "choice" && (
                          <span className="font-mono text-ink-300">
                            {typeof value === "number" ? value : ""}
                            {param.unit ?? ""}
                          </span>
                        )}
                      </span>
                      {param.kind === "bool" ? (
                        <input
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(e) =>
                            onChange(
                              ops.updateEffect(effects, effect.id, {
                                params: { ...effect.params, [param.key]: e.target.checked },
                              }),
                            )
                          }
                          className="size-3.5 accent-accent"
                        />
                      ) : param.kind === "choice" ? (
                        <select
                          value={String(value)}
                          onChange={(e) =>
                            onChange(
                              ops.updateEffect(effects, effect.id, {
                                params: { ...effect.params, [param.key]: e.target.value },
                              }),
                            )
                          }
                          className="w-full rounded border border-white/10 bg-ink-900 px-1 py-0.5 text-[11px] text-ink-200"
                        >
                          {param.choices?.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="range"
                          min={param.min ?? 0}
                          max={param.max ?? 100}
                          step={param.step ?? 1}
                          value={Number(value)}
                          onChange={(e) =>
                            onChange(
                              ops.updateEffect(effects, effect.id, {
                                params: { ...effect.params, [param.key]: Number(e.target.value) },
                              }),
                              `fx:${effect.id}:${param.key}`,
                            )
                          }
                          className="w-full accent-accent"
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {adding ? (
        <Select
          autoFocus
          value=""
          onChange={(e) => {
            const spec = byType.get(e.target.value);
            if (spec) {
              const defaults = Object.fromEntries(spec.params.map((p) => [p.key, p.default]));
              onChange(ops.addEffect(effects, spec.type, defaults));
            }
            setAdding(false);
          }}
          onBlur={() => setAdding(false)}
        >
          <option value="">Choose an effect…</option>
          {categories.map((category) => (
            <optgroup key={category} label={category}>
              {registry
                .filter((s) => s.category === category)
                .map((s) => (
                  <option key={s.type} value={s.type}>
                    {s.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-ink-700 py-1.5 text-[12px] text-ink-400 hover:border-ink-500 hover:text-ink-200"
        >
          <PlusIcon /> Add effect
        </button>
      )}
    </div>
  );
}
