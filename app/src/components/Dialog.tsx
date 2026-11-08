import type { ReactNode } from "react";
import {
  Dialog as ShadDialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** The shell every editor dialog (Export, Silence, Loudness, the project
 * picker) is built from — now a shadcn Dialog, kept behind the old API. */
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
  return (
    <ShadDialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn("gap-4 sm:max-w-sm", className)}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div>{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </ShadDialog>
  );
}
