import * as React from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "accent";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Shows a leading status dot — used for fit verdicts in the review table. */
  dot?: boolean;
  mono?: boolean;
}

const TONES: Record<BadgeTone, string> = {
  neutral: cn(
    "bg-[color-mix(in_oklch,var(--color-ink-700)_45%,transparent)]",
    "text-[var(--text-secondary)] border-[var(--border-subtle)]",
  ),
  ok: cn(
    "bg-[color-mix(in_oklch,var(--color-ok-500)_16%,transparent)]",
    "text-[var(--color-ok-400)]",
    "border-[color-mix(in_oklch,var(--color-ok-500)_34%,transparent)]",
  ),
  warn: cn(
    "bg-[color-mix(in_oklch,var(--color-warn-500)_16%,transparent)]",
    "text-[var(--color-warn-400)]",
    "border-[color-mix(in_oklch,var(--color-warn-500)_34%,transparent)]",
  ),
  danger: cn(
    "bg-[color-mix(in_oklch,var(--color-danger-500)_16%,transparent)]",
    "text-[var(--color-danger-400)]",
    "border-[color-mix(in_oklch,var(--color-danger-500)_34%,transparent)]",
  ),
  accent: cn(
    "bg-[color-mix(in_oklch,var(--color-accent-500)_16%,transparent)]",
    "text-[var(--color-accent-400)]",
    "border-[color-mix(in_oklch,var(--color-accent-500)_34%,transparent)]",
  ),
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--color-ink-400)]",
  ok: "bg-[var(--color-ok-400)]",
  warn: "bg-[var(--color-warn-400)]",
  danger: "bg-[var(--color-danger-400)]",
  accent: "bg-[var(--color-accent-400)]",
};

export function Badge({
  tone = "neutral",
  dot = false,
  mono = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border",
        "px-2 py-0.5 text-[11px] font-medium leading-5",
        mono && "font-[family-name:var(--font-mono)] tracking-tight",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONES[tone])}
        />
      )}
      {children}
    </span>
  );
}
