import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Options = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** Style the confirm button as destructive (red). */
  destructive?: boolean;
};

type Confirm = (options: Options) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(() => Promise.resolve(false));

/** Promise-based replacement for `window.confirm`, rendered as a shadcn AlertDialog. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<Options | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((next) => {
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  function settle(value: boolean) {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && (
              <AlertDialogDescription className="whitespace-pre-line">
                {options.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                options?.destructive &&
                  buttonVariants({ variant: "destructive" }),
              )}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}
