import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Resources } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const POLL_MS = 3000;

/** Live machine load as compact readouts for the status bar: RAM, CPU, GPU. */
export function SystemResources() {
  const [data, setData] = useState<Resources | null>(null);

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
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-full items-center gap-4 px-2 transition-colors hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.08] data-[state=open]:text-foreground"
        >
          {data.ram_total_bytes != null && (
            <Readout
              label="RAM"
              value={ramPct}
              text={`${formatBytes(data.ram_used_bytes)} / ${formatBytes(data.ram_total_bytes)}`}
            />
          )}
          {data.cpu_percent != null && (
            <Readout
              label="CPU"
              value={data.cpu_percent}
              text={`${Math.round(data.cpu_percent)}%`}
            />
          )}
          {data.gpu_backend ? (
            <Readout
              label="GPU"
              value={data.gpu_mem_total_bytes ? gpuPct : null}
              text={
                data.gpu_mem_total_bytes
                  ? `${formatBytes(data.gpu_mem_used_bytes)} / ${formatBytes(data.gpu_mem_total_bytes)}`
                  : data.gpu_backend
              }
            />
          ) : (
            <span className="text-muted-foreground">
              GPU —
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-80 p-0 text-[13px]">
        <div className="border-b px-3 py-2.5 font-medium text-foreground">System resources</div>
        <dl className="divide-y">
          <Detail
            label="Memory"
            value={ramPct}
            lines={[
              data.ram_total_bytes != null
                ? `${formatBytes(data.ram_used_bytes)} used of ${formatBytes(data.ram_total_bytes)}`
                : "Unknown",
            ]}
          />
          <Detail
            label="CPU"
            value={data.cpu_percent}
            lines={[
              data.cpu_vendor ?? "Processor",
              data.cpu_cores ? `${data.cpu_cores} cores` : null,
            ]}
          />
          <Detail
            label="GPU"
            value={data.gpu_mem_total_bytes ? gpuPct : null}
            lines={
              data.gpu_backend
                ? [
                    data.gpu_name ?? "Graphics card",
                    data.gpu_mem_total_bytes
                      ? `${formatBytes(data.gpu_mem_used_bytes)} of ${formatBytes(data.gpu_mem_total_bytes)} video memory used`
                      : null,
                    `Compute: ${data.gpu_backend}`,
                  ]
                : ["No GPU detected — models run on the CPU."]
            }
          />
        </dl>
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Updated every {POLL_MS / 1000} s.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  return used != null && total ? Math.min(100, (used / total) * 100) : null;
}

/** `LABEL  ▬▬▬▭▭  text` — a tiny meter with its number, one status-bar cell. */
function Readout({
  label,
  value,
  text,
}: {
  label: string;
  value: number | null;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-medium text-foreground/80">{label}</span>
      {value != null && (
        <span className="h-1 w-10 overflow-hidden rounded-full bg-white/10">
          <span
            className={cn(
              "block h-full rounded-full bg-muted-foreground transition-[width]",
              value > 90 && "bg-coral-red",
              value > 75 && value <= 90 && "bg-warning",
            )}
            style={{ width: `${value}%` }}
          />
        </span>
      )}
      <span className="tabular-nums">{text}</span>
    </div>
  );
}

/** One resource in the details panel: name, percentage with a bar, then facts. */
function Detail({
  label,
  value,
  lines,
}: {
  label: string;
  value: number | null;
  lines: (string | null)[];
}) {
  return (
    <div className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <dt className="font-medium text-foreground">{label}</dt>
        <span className="tabular-nums text-foreground">
          {value != null ? `${Math.round(value)}%` : "—"}
        </span>
      </div>
      {value != null && (
        <div className="h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={cn(
              "h-full rounded-full bg-muted-foreground",
              value > 90 && "bg-coral-red",
              value > 75 && value <= 90 && "bg-warning",
            )}
            style={{ width: `${value}%` }}
          />
        </div>
      )}
      {lines.filter(Boolean).map((line) => (
        <dd key={line} className="text-xs text-muted-foreground">
          {line}
        </dd>
      ))}
    </div>
  );
}
