import * as React from "react";
import { cn } from "./cn";

export interface ProgressProps {
  /** 0..1. Values outside the range are clamped. */
  value: number;
  /** Renders a moving sheen for work whose completion cannot be estimated. */
  indeterminate?: boolean;
  label?: string;
  className?: string;
}

export function Progress({
  value,
  indeterminate = false,
  label,
  className,
}: ProgressProps) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const pct = Math.round(clamped * 1000) / 10;

  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-label={label}
    >
      <div
        className={cn(
          "h-full rounded-full",
          "bg-gradient-to-r from-[var(--color-accent-600)] to-[var(--color-accent-400)]",
          indeterminate
            ? "w-1/3 bg-[length:200%_100%] shimmer"
            : "transition-[width] duration-500 ease-[var(--ease-out-expo)]",
        )}
        style={indeterminate ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}
