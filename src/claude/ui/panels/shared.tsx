import { ChevronRight, LoaderCircle } from "lucide-react";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

/*
 * Small building blocks shared by the Claude Code side panels. Styles live in
 * src/styles/claude-panels.css (`cp-` classes).
 */

export type Tone = "accent" | "ok" | "warn" | "err" | "info" | "dim";

/** A message from anything thrown. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <LoaderCircle size={size} className="cp-spin" aria-hidden="true" />;
}

export function IconButton({
  label,
  busy,
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & { label: string; busy?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} {...props} className={`cp-icon-button ${className}`} disabled={props.disabled || busy}>
      {busy ? <Spinner /> : children}
    </button>
  );
}

export function Button({
  variant = "default",
  busy,
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & { variant?: "default" | "primary" | "danger" | "ghost"; busy?: boolean }) {
  return (
    <button type="button" {...props} className={`cp-button cp-button-${variant} ${className}`} disabled={props.disabled || busy}>
      {busy && <Spinner size={11} />}
      {children}
    </button>
  );
}

/** A status dot: filled, pulsing (running) or hollow (pending). */
export function Dot({ tone, pulse, hollow, label }: { tone: Tone; pulse?: boolean; hollow?: boolean; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      title={label}
      className={`cp-dot cp-tone-${tone}${pulse ? " cp-pulse" : ""}${hollow ? " cp-dot-hollow" : ""}`}
    />
  );
}

export function Badge({ children, tone, mono, title }: { children: ReactNode; tone?: Tone; mono?: boolean; title?: string }) {
  return (
    <span title={title} className={`cp-badge${tone ? ` cp-badge-${tone}` : ""}${mono ? " cp-mono" : ""}`}>
      {children}
    </span>
  );
}

/** A collapsible section with a count or total on the right. */
export function Section({
  title,
  meta,
  defaultOpen = false,
  children,
  empty,
}: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  /** Shown (and the section not expandable) when there is nothing in it. */
  empty?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="cp-section" data-open={open && !empty ? "" : undefined}>
      <button type="button" className="cp-section-head" aria-expanded={open && !empty} disabled={empty} onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className="cp-chevron" aria-hidden="true" />
        <span className="cp-section-title">{title}</span>
        {meta !== undefined && <span className="cp-section-meta">{meta}</span>}
      </button>
      {open && !empty && <div className="cp-section-body">{children}</div>}
    </section>
  );
}

/** A plain (not collapsible) heading over a group. */
export function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="cp-heading">
      <span>{children}</span>
      {aside && <span className="cp-heading-aside">{aside}</span>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="cp-empty">
      {icon && <div className="cp-empty-icon">{icon}</div>}
      <div className="cp-empty-title">{title}</div>
      {children && <div className="cp-empty-text">{children}</div>}
    </div>
  );
}

export function ErrorLine({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="cp-error" role="alert">
      <span className="cp-error-text">{children}</span>
      {onRetry && (
        <button type="button" className="cp-link" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** A segmented control (a radio group that looks like joined buttons). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`cp-segmented ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          className="cp-segment"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            const index = options.findIndex((candidate) => candidate.value === value);
            const next = options[(index + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
            onChange(next.value);
            const group = event.currentTarget.parentElement;
            requestAnimationFrame(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
          }}
          tabIndex={option.value === value ? 0 : -1}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A horizontal meter, 0-100. */
export function Meter({ percent, tone, label }: { percent: number; tone: Tone; label: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="cp-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}>
      <div className={`cp-meter-fill cp-tone-${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** The panel's toolbar, under the tab row. */
export function Toolbar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`cp-toolbar ${className}`}>{children}</div>;
}

/** The current time, updated every `interval` ms while `active`. */
export function useNow(interval: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval, active]);
  return now;
}

/**
 * Per-row command state: which rows have a command running and the last
 * error of each. `run(id, fn)` marks the row busy, clears its error, and
 * records a failure.
 */
export function useRowCommands() {
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (id: string, what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy((current) => ({ ...current, [id]: what }));
    setErrors(({ [id]: _, ...rest }) => rest);
    try {
      await fn();
      return true;
    } catch (error) {
      if (mounted.current) setErrors((current) => ({ ...current, [id]: errorText(error) }));
      return false;
    } finally {
      if (mounted.current) setBusy(({ [id]: _, ...rest }) => rest);
    }
  }, []);
  const clearError = useCallback((id: string) => setErrors(({ [id]: _, ...rest }) => rest), []);
  return { busy, errors, run, clearError };
}
