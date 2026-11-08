import type { ReactNode } from "react";
import { openExternal } from "../lib/tauri";
import { useToast } from "./Toaster";
import { cn } from "@/lib/utils";

/**
 * A link that leaves the app. The desktop webview would navigate itself away
 * from VoiceCraft on a plain anchor, so the click is handed to the shell (the
 * default browser). The `href` stays real, so the address can still be selected,
 * copied, or opened from the context menu in a plain browser.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children?: ReactNode;
  className?: string;
}) {
  const toast = useToast();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        openExternal(href).catch((error: Error) => toast(error.message, "error"));
      }}
      className={cn(
        "text-foreground underline underline-offset-2 hover:text-primary",
        className,
      )}
    >
      {children ?? href}
    </a>
  );
}
