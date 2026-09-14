import type { ReactNode, SelectHTMLAttributes } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Override the body's default `p-6` — e.g. a denser `p-3` for a sidebar panel. */
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx(
        "rounded-xl border border-ink-700 bg-ink-900",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-700 px-6 py-4">
          <div>
            {title && (
              <h2 className="text-[13px] font-medium tracking-tight text-white">{title}</h2>
            )}
            {subtitle && <p className="mt-1 text-[13px] text-ink-400">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={bodyClassName ?? "p-6"}>{children}</div>
    </section>
  );
}

type ButtonProps = {
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button({
  variant = "ghost",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-[-0.011em] transition " +
    "disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-accent/70";
  const variants = {
    primary: "bg-accent text-ink-950 hover:bg-accent-strong",
    ghost: "border border-ink-700 bg-transparent text-ink-200 hover:border-ink-600 hover:text-white",
    danger: "border border-coral-red/40 text-coral-red hover:bg-coral-red/10",
  } as const;
  const sizes = { sm: "px-3 py-1 text-[13px]", md: "px-4 py-2 text-sm" } as const;
  return <button className={cx(base, variants[variant], sizes[size], className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-normal text-ink-400">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[13px] text-ink-400">{hint}</span>}
    </label>
  );
}

const controlStyles =
  "w-full rounded-md border border-white/10 bg-white/[0.02] px-3.5 py-3 text-sm text-ink-200 " +
  "placeholder:text-ink-400 focus:border-ink-200 focus:outline-none focus:ring-0";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(controlStyles, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(controlStyles, "resize-y", props.className)} />;
}

// Native chevron off; ours is a Fog-coloured caret painted as a background SVG.
const selectStyles =
  "appearance-none bg-no-repeat bg-[position:right_0.75rem_center] pr-9 " +
  "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%238a8f98%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22m2.5%204.5%203.5%203.5%203.5-3.5%22%2F%3E%3C%2Fsvg%3E')]";

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(controlStyles, selectStyles, props.className)}
    />
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "busy";
  children: ReactNode;
}) {
  const tones = {
    neutral: "text-ink-400",
    good: "text-pulse-green",
    warn: "text-[#e2b93b]",
    bad: "text-coral-red",
    busy: "text-accent",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5 text-[12px] font-normal",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** A compact square button for row-level actions — icon in, no label. */
export function IconButton({
  label,
  className,
  ...props
}: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "grid size-7 shrink-0 place-items-center rounded-md text-ink-400 transition",
        "hover:bg-white/5 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-30",
        className,
      )}
      {...props}
    />
  );
}

/** Single-choice segmented control — replaces a <select> when options are few. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "inline-flex gap-0.5 rounded-md border border-ink-700 bg-white/[0.02] p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded px-2.5 py-1 text-[13px] transition",
            option.value === value
              ? "bg-ink-700 text-white"
              : "text-ink-400 hover:text-ink-200",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-400">
      {children}
    </p>
  );
}

/** Inline message block — advisory (info), caution (warn), or failure (bad). */
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
    info: "border-ink-700 bg-white/[0.02] text-ink-400",
    warn: "border-[#e2b93b]/30 bg-[#e2b93b]/10 text-[#e2b93b]",
    bad: "border-coral-red/40 bg-coral-red/10 text-coral-red",
  } as const;
  return (
    <div
      className={cx(
        "rounded-md border px-3 py-2 text-[13px] leading-relaxed",
        tones[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
