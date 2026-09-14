import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cx } from "./ui";

type Tone = "info" | "success" | "error";
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

/** Small, self-dismissing notices — errors here are never swallowed silently. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((t) => t.id !== id)),
      tone === "error" ? 8000 : 4000,
    );
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              "pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-xl backdrop-blur",
              toast.tone === "error"
                ? "border-red-900 bg-red-950/90 text-red-200"
                : toast.tone === "success"
                  ? "border-emerald-900 bg-emerald-950/90 text-emerald-200"
                  : "border-ink-600 bg-ink-800/95 text-ink-200",
            )}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
