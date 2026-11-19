import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { customTitleBar } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/* Segoe Fluent Icons (Windows 11) / Segoe MDL2 Assets (Windows 10) caption
 * glyphs — the same ones the system draws, so the buttons look native. */
const GLYPH = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
};

/** Minimise / maximise / close for the undecorated Windows window. Renders
 * nothing where the OS draws the title bar. */
export function WindowControls({ className }: { className?: string }) {
  const enabled = customTitleBar();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;
    const sync = () => void win.isMaximized().then((next) => alive && setMaximized(next));
    sync();
    void win.onResized(sync).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [enabled]);

  if (!enabled) return null;
  const win = getCurrentWindow();

  return (
    <div className={cn("flex h-full shrink-0 self-stretch", className)}>
      <CaptionButton label="Minimise" glyph={GLYPH.minimize} onClick={() => void win.minimize()} />
      <CaptionButton
        label={maximized ? "Restore" : "Maximise"}
        glyph={maximized ? GLYPH.restore : GLYPH.maximize}
        onClick={() => void win.toggleMaximize()}
      />
      <CaptionButton
        label="Close"
        glyph={GLYPH.close}
        onClick={() => void win.close()}
        className="hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/80"
      />
    </div>
  );
}

function CaptionButton({
  label,
  glyph,
  onClick,
  className,
}: {
  label: string;
  glyph: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        "flex h-full w-[46px] items-center justify-center text-[10px] text-foreground/80 transition-colors hover:bg-white/[0.08] hover:text-foreground active:bg-white/[0.05]",
        className,
      )}
      style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' }}
    >
      {glyph}
    </button>
  );
}

/** A bare title bar for screens without the app shell (start-up, engine setup),
 * so the window can still be moved and closed. */
export function BareTitleBar() {
  if (!customTitleBar()) return null;
  return (
    <header data-tauri-drag-region className="flex h-9 shrink-0 items-center border-b">
      <span className="pointer-events-none px-4 text-xs font-medium text-muted-foreground">
        VoiceCraft
      </span>
      <div data-tauri-drag-region className="h-full flex-1" />
      <WindowControls />
    </header>
  );
}
