import { useEffect } from "react";

/** True when the event started in something you type into (or select text from). */
function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest("input, textarea, select, [contenteditable='true']")
  );
}

/**
 * Window-level behaviour that makes the webview act like a desktop window rather
 * than a browser tab. Everything that would reveal the browser (its context menu,
 * reload, page zoom, view-source) is switched off in the packaged app only, so
 * `tauri dev` keeps DevTools and hot-reload keys.
 *
 * Also wires the app's own global shortcuts: `Ctrl/⌘ + 1…n` jumps between the
 * given views, and `Ctrl/⌘ + ,` opens the one named `settings`.
 */
export function useDesktopBehavior<V extends string>(
  views: readonly V[],
  navigate: (view: V) => void,
) {
  useEffect(() => {
    const packaged = import.meta.env.PROD;

    const onContextMenu = (event: MouseEvent) => {
      if (packaged && !inTextField(event.target)) event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (mod && !event.altKey) {
        // Jump to a view: Ctrl+1 is the first nav item, and so on.
        if (/^[1-9]$/.test(event.key)) {
          const next = views[Number(event.key) - 1];
          if (next) {
            event.preventDefault();
            navigate(next);
          }
          return;
        }
        if (event.key === "," && views.includes("settings" as V)) {
          event.preventDefault();
          navigate("settings" as V);
          return;
        }
      }

      if (!packaged) return;
      const reload = key === "f5" || (mod && key === "r");
      const zoom = mod && ["+", "=", "-", "_", "0"].includes(event.key);
      const browserOnly = mod && ["u", "p", "f", "g", "j"].includes(key) && !inTextField(event.target);
      if (reload || zoom || browserOnly) event.preventDefault();
    };

    // Images and links in a desktop UI aren't draggable out of the window.
    const onDragStart = (event: DragEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("img, a")) {
        event.preventDefault();
      }
    };

    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("dragstart", onDragStart);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dragstart", onDragStart);
    };
  }, [views, navigate]);
}
