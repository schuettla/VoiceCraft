import type { EffectInstance } from "../../lib/types";
import { IconButton, OptionSelect } from "../../components/common";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const byType = new Map(registry.map((s) => [s.type, s]));
  const categories = [...new Set(registry.map((s) => s.category))];

  return (
    <div>
      {effects.length === 0 && (
        <p className="pb-2 text-xs text-muted-foreground">No effects — add one below.</p>
      )}
      <div className="divide-y">
        {effects.map((effect) => {
          const spec = byType.get(effect.type);
          return (
            <div key={effect.id} className="py-2.5 first:pt-0">
              <div className="flex items-center gap-1">
                <Switch
                  size="sm"
                  checked={effect.enabled}
                  onCheckedChange={(next) =>
                    onChange(ops.updateEffect(effects, effect.id, { enabled: next }))
                  }
                  aria-label="Enabled"
                  className="mr-1.5"
                />
                <span className="flex-1 truncate text-[13px] text-foreground">
                  {spec?.label ?? effect.type}
                </span>
                {spec?.preview === "render" && onAudition && (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="text-muted-foreground"
                    onClick={() => onAudition(effect.id)}
                  >
                    render preview
                  </Button>
                )}
                <IconButton
                  size="icon-xs"
                  label="Move up"
                  onClick={() => onChange(ops.moveEffect(effects, effect.id, -1))}
                >
                  <ArrowUpIcon />
                </IconButton>
                <IconButton
                  size="icon-xs"
                  label="Move down"
                  onClick={() => onChange(ops.moveEffect(effects, effect.id, 1))}
                >
                  <ArrowDownIcon />
                </IconButton>
                <IconButton
                  size="icon-xs"
                  label="Remove effect"
                  className="hover:text-coral-red"
                  onClick={() => onChange(ops.removeEffect(effects, effect.id))}
                >
                  <TrashIcon />
                </IconButton>
              </div>
              {spec && spec.params.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2.5 pl-1">
                  {spec.params.map((param) => {
                    const value = effect.params[param.key] ?? param.default;
                    const setParam = (next: string | number | boolean, coalesce?: string) =>
                      onChange(
                        ops.updateEffect(effects, effect.id, {
                          params: { ...effect.params, [param.key]: next },
                        }),
                        coalesce,
                      );
                    return (
                      <div key={param.key} className="col-span-1 block text-[11px] text-muted-foreground">
                        <span className="mb-1 flex justify-between">
                          <span>{param.label}</span>
                          {param.kind !== "bool" && param.kind !== "choice" && (
                            <span className="font-mono text-foreground/70">
                              {typeof value === "number" ? value : ""}
                              {param.unit ?? ""}
                            </span>
                          )}
                        </span>
                        {param.kind === "bool" ? (
                          <Switch
                            size="sm"
                            checked={Boolean(value)}
                            onCheckedChange={(next) => setParam(next)}
                            aria-label={param.label}
                          />
                        ) : param.kind === "choice" ? (
                          <OptionSelect
                            size="sm"
                            value={String(value)}
                            onChange={(next) => setParam(next)}
                            options={(param.choices ?? []).map((c) => ({ value: c, label: c }))}
                          />
                        ) : (
                          <Slider
                            min={param.min ?? 0}
                            max={param.max ?? 100}
                            step={param.step ?? 1}
                            value={[Number(value)]}
                            onValueChange={([next]) => setParam(next, `fx:${effect.id}:${param.key}`)}
                            aria-label={param.label}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="mt-2 w-full border-dashed text-muted-foreground">
            <PlusIcon /> Add effect
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
          {categories.map((category, index) => (
            <div key={category}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs capitalize text-muted-foreground">
                  {category}
                </DropdownMenuLabel>
                {registry
                  .filter((s) => s.category === category)
                  .map((s) => (
                    <DropdownMenuItem
                      key={s.type}
                      onSelect={() => {
                        const defaults = Object.fromEntries(s.params.map((p) => [p.key, p.default]));
                        onChange(ops.addEffect(effects, s.type, defaults));
                      }}
                    >
                      {s.label}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
