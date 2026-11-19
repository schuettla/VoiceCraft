import type { Health } from "@/lib/types";
import { EngineStatus } from "@/components/EngineStatus";
import { SystemResources } from "@/components/SystemResources";

/** The window's status bar: backend / engine state on the left, machine load on
 * the right. Each side opens a details panel on click. Fixed-height and always visible, like a desktop app's. */
export function StatusBar({
  health,
  reachable,
  onOpenModels,
  onRunSetup,
}: {
  health: Health | null;
  reachable: boolean | null;
  onOpenModels: () => void;
  onRunSetup: () => void;
}) {
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-6 border-t bg-card px-1 text-[11px] text-muted-foreground">
      <EngineStatus
        health={health}
        reachable={reachable}
        onOpenModels={onOpenModels}
        onRunSetup={onRunSetup}
      />
      <SystemResources />
    </footer>
  );
}
