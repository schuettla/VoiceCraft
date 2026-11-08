import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge as ShadBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/* Thin compositions over shadcn primitives — the handful of patterns the app
 * repeats everywhere, so pages stay declarative and consistent. */

export const cx = cn;

/* ------------------------------------------------------------------ layout */

/** Flat page title bar. No box: the page itself is the surface. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-6 pb-6", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled block of a page — separated by whitespace, not a bordered box. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-sm font-medium tracking-tight text-foreground">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** One row of a settings-style list: label + help on the left, control on the right. */
export function SettingRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-8 border-b py-4 last:border-b-0",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label className="text-[13px] font-normal text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Option list in a shadcn Select — replaces the native `<select>`. */
export function OptionSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  size = "default",
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: ReactNode; disabled?: boolean }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size={size} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Single-choice segmented control — a shadcn ToggleGroup that can't be emptied. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  itemClassName,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  itemClassName?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      className={className}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(
            "px-3 text-[13px] data-[state=on]:bg-accent data-[state=on]:text-foreground",
            itemClassName,
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Icon-only button with a tooltip — row-level and toolbar actions. */
export function IconButton({
  label,
  className,
  size = "icon-sm",
  variant = "ghost",
  ...props
}: {
  label: string;
  size?: React.ComponentProps<typeof Button>["size"];
  variant?: React.ComponentProps<typeof Button>["variant"];
} & Omit<React.ComponentProps<"button">, "size">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          aria-label={label}
          className={cn("text-muted-foreground hover:text-foreground", className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/* ---------------------------------------------------------------- feedback */

type Tone = "neutral" | "good" | "warn" | "bad" | "busy";

const TONES: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-pulse-green",
  warn: "text-warning",
  bad: "text-coral-red",
  busy: "text-primary",
};

/** Status chip: tone is carried by text colour, the fill stays quiet. */
export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadBadge
      variant="secondary"
      className={cn("rounded-md bg-white/5 px-1.5 font-normal", TONES[tone], className)}
    >
      {children}
    </ShadBadge>
  );
}

/** Coloured dot used alongside text for connection / engine state. */
export function StatusDot({ tone = "neutral" }: { tone?: Tone }) {
  const fills: Record<Tone, string> = {
    neutral: "bg-muted-foreground",
    good: "bg-pulse-green",
    warn: "bg-warning",
    bad: "bg-coral-red",
    busy: "bg-primary animate-pulse",
  };
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", fills[tone])} />;
}

/** Inline message — advisory (info), caution (warn), or failure (bad). */
export function Notice({
  tone = "info",
  className,
  children,
}: {
  tone?: "info" | "warn" | "bad";
  className?: string;
  children: ReactNode;
}) {
  const tones = {
    info: "bg-white/[0.02] text-muted-foreground",
    warn: "border-warning/30 bg-warning/10 text-warning",
    bad: "border-coral-red/40 bg-coral-red/10 text-coral-red",
  } as const;
  return (
    <Alert className={cn("px-3 py-2", tones[tone], className)}>
      <AlertDescription className="text-[13px] leading-relaxed text-current">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** Empty state — quiet text, no dashed box. */
export function Empty({
  title,
  children,
  className,
}: {
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("py-12 text-center", className)}>
      {title && <p className="text-sm font-medium text-foreground">{title}</p>}
      {children && (
        <p className={cn("text-sm text-muted-foreground", title && "mt-1")}>{children}</p>
      )}
    </div>
  );
}
