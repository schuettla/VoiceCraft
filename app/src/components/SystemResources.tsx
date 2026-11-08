import { useEffect, useState } from "react";
import { ChevronUp } from "lucide-react";
import { api } from "@/lib/api";
import type { Resources } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const POLL_MS = 3000;

/** Live machine load, pinned to the bottom of the sidebar. Collapsible, and
 * hidden entirely while the sidebar is an icon rail. */
export function SystemResources() {
  const [data, setData] = useState<Resources | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .resources()
        .then((next) => alive && setData(next))
        .catch(() => alive && setData(null));
    void tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!data) return null;

  const ramPct = pct(data.ram_used_bytes, data.ram_total_bytes);
  const gpuPct = pct(data.gpu_mem_used_bytes, data.gpu_mem_total_bytes);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t group-data-[collapsible=icon]:hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-foreground">
        System Resources
        <ChevronUp
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            !open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 px-4 pb-4">
          {data.ram_total_bytes != null && (
            <Meter
              label="RAM"
              value={ramPct}
              left={`Used ${formatBytes(data.ram_used_bytes)}`}
              right={`Total ${formatBytes(data.ram_total_bytes)}`}
            />
          )}
          {data.cpu_percent != null && (
            <Meter
              label="CPU"
              value={data.cpu_percent}
              left={data.cpu_cores ? `${data.cpu_cores} cores` : ""}
              right={data.cpu_vendor ?? ""}
            />
          )}
          {data.gpu_backend ? (
            <Meter
              label="GPU"
              value={data.gpu_mem_total_bytes ? gpuPct : null}
              valueLabel={data.gpu_mem_total_bytes ? undefined : "—"}
              left={
                data.gpu_mem_total_bytes
                  ? `VRAM ${formatBytes(data.gpu_mem_used_bytes)} / ${formatBytes(data.gpu_mem_total_bytes)}`
                  : "Compute engine"
              }
              right={data.gpu_backend}
            />
          ) : (
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">GPU</span>
              <span>No GPU detected</span>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  return used != null && total ? Math.min(100, (used / total) * 100) : null;
}

function Meter({
  label,
  value,
  valueLabel,
  left,
  right,
}: {
  label: string;
  value: number | null;
  valueLabel?: string;
  left: string;
  right: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="font-medium tabular-nums text-foreground">
          {valueLabel ?? (value != null ? `${Math.round(value)}%` : "—")}
        </span>
      </div>
      <Progress value={value ?? 0} className="h-1 bg-white/10" />
      <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{left}</span>
        <span className="shrink-0">{right}</span>
      </div>
    </div>
  );
}
