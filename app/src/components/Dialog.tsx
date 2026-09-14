import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx, IconButton } from "./ui";
import { XIcon } from "./icons";

/** A centered modal over a click-to-dismiss backdrop, with Escape support and
 * proper dialog semantics — the shell every editor dialog (Export, Silence,
 * Loudness, the project picker) is built from. */
export function Dialog({
  onClose,
  title,
  children,
  footer,
  className,
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-5" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx("w-full max-w-sm border border-ink-700 bg-ink-900 p-5", className)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[14px] font-medium text-white">{title}</h2>
          <IconButton label="Close" className="-mr-1.5 -mt-1.5" onClick={onClose}>
            <XIcon />
          </IconButton>
        </div>
        <div className="mt-3">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
