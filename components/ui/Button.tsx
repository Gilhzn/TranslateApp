"use client";

import * as React from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner and blocks interaction without changing layout width. */
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  // Light-on-dark primary, the Vercel signature. Subtle inner highlight keeps
  // it from reading flat against the near-black canvas.
  primary: cn(
    "bg-[var(--color-ink-50)] text-[var(--color-ink-950)]",
    "hover:bg-white active:bg-[var(--color-ink-200)]",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]",
  ),
  secondary: cn(
    "bg-[var(--surface-3)] text-[var(--text-primary)]",
    "border border-[var(--border-subtle)]",
    "hover:bg-[var(--color-ink-700)] hover:border-[var(--border-strong)]",
    "active:bg-[var(--color-ink-800)]",
  ),
  ghost: cn(
    "bg-transparent text-[var(--text-secondary)]",
    "hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
    "active:bg-[var(--color-ink-800)]",
  ),
  danger: cn(
    "bg-[var(--color-danger-500)] text-white",
    "hover:brightness-110 active:brightness-95",
  ),
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius-sm)]",
  md: "h-9 px-4 text-sm gap-2 rounded-[var(--radius-md)]",
  lg: "h-11 px-5 text-[15px] gap-2 rounded-[var(--radius-lg)]",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      iconLeft,
      iconRight,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cn(
          "relative inline-flex select-none items-center justify-center font-medium",
          "transition-[background-color,border-color,color,transform,filter] duration-150",
          "active:translate-y-px",
          "disabled:pointer-events-none disabled:opacity-45",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...rest}
      >
        {/* Content is hidden rather than removed so the button keeps its width. */}
        <span
          className={cn(
            "inline-flex items-center",
            SIZES[size].includes("gap-1.5") ? "gap-1.5" : "gap-2",
            loading && "invisible",
          )}
        >
          {iconLeft}
          {children}
          {iconRight}
        </span>

        {loading && (
          <span className="absolute inset-0 grid place-items-center">
            <ButtonSpinner />
          </span>
        )}
      </button>
    );
  },
);

function ButtonSpinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
