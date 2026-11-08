import { useCallback, type ReactNode } from "react";
import { toast as sonnerToast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

type Tone = "info" | "success" | "error";

/** Mounts the sonner viewport. Errors are never swallowed silently. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" richColors={false} />
    </>
  );
}

/** `toast(message, tone)` — same call shape the pages have always used. */
export function useToast() {
  return useCallback((message: string, tone: Tone = "info") => {
    if (tone === "error") sonnerToast.error(message, { duration: 8000 });
    else if (tone === "success") sonnerToast.success(message, { duration: 4000 });
    else sonnerToast(message, { duration: 4000 });
  }, []);
}
