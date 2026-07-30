"use client";

import * as React from "react";
import { cn } from "@/components/ui";
import type { FitResult, FitVerdict } from "@/lib/types";

/**
 * The fit meter — one row's translation width against the width it is allowed.
 *
 * Reading rules the design has to satisfy:
 *
 *   - The budget line sits at a FIXED position in the track (68%), never at a
 *     position derived from the data. Every row's line therefore lines up
 *     vertically, and "past the line" is a shape you can scan down a column for
 *     rather than a number you have to read.
 *   - Colour is never the only signal: a glyph (check / triangle / cross), a
 *     percentage, and a diagonal hatch on the over-budget segment all carry the
 *     same meaning, so the column survives deuteranopia and greyscale printing.
 *   - Widths come from the `FitResult` the layout engine already produced. The
 *     UI never estimates width from `string.length`; on edit the row is
 *     re-evaluated through `evaluateFit` and a fresh `FitResult` arrives here.
 */

const BUDGET_FRACTION = 0.68;
/** Ratio at which the bar fills the whole track; beyond it the bar clamps. */
const MAX_DRAWN_RATIO = 1 / BUDGET_FRACTION;

export type FitTone = "ok" | "warn" | "danger" | "neutral";

export function fitTone(verdict: FitVerdict | null): FitTone {
  if (verdict === "fits") return "ok";
  if (verdict === "tight") return "warn";
  if (verdict === "overflow") return "danger";
  return "neutral";
}

const BAR_COLOR: Record<FitTone, string> = {
  ok: "var(--color-ok-500)",
  warn: "var(--color-warn-500)",
  danger: "var(--color-danger-500)",
  neutral: "var(--color-ink-600)",
};

const TEXT_COLOR: Record<FitTone, string> = {
  ok: "var(--color-ok-400)",
  warn: "var(--color-warn-400)",
  danger: "var(--color-danger-400)",
  neutral: "var(--text-tertiary)",
};

export const FIT_VERDICT_LABEL: Record<FitVerdict, string> = {
  fits: "Fits",
  tight: "Tight",
  overflow: "Overflow",
};

export interface FitMeterProps {
  fit: FitResult | null;
  /** `row` is the dense table variant; `detail` adds the numeric readout. */
  variant?: "row" | "detail";
  className?: string;
}

export function FitMeter({ fit, variant = "row", className }: FitMeterProps) {
  const tone = fitTone(fit?.verdict ?? null);
  const usage = usageRatio(fit);
  const percent = Math.round(usage * 100);
  const fill = Math.min(usage, MAX_DRAWN_RATIO) * BUDGET_FRACTION * 100;
  const overflowing = fit?.verdict === "overflow";
  const clamped = usage > MAX_DRAWN_RATIO;

  const valueText =
    fit === null
      ? "Not measured"
      : `${percent}% of the available width — ${FIT_VERDICT_LABEL[fit.verdict].toLowerCase()}` +
        (overflowing ? `, about ${fit.overBy} character(s) too long` : "");

  return (
    <div
      className={cn(
        "flex items-center gap-2",
        variant === "detail" && "gap-3",
        className,
      )}
    >
      <VerdictGlyph verdict={fit?.verdict ?? null} />

      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={Math.round(MAX_DRAWN_RATIO * 100)}
        aria-valuenow={Math.min(percent, Math.round(MAX_DRAWN_RATIO * 100))}
        aria-valuetext={valueText}
        aria-label="Translation width against its budget"
        className={cn(
          "relative min-w-0 flex-1 overflow-hidden rounded-full",
          "bg-[color-mix(in_oklch,var(--color-ink-700)_45%,transparent)]",
          variant === "row" ? "h-[6px]" : "h-2.5",
        )}
      >
        {/* Under-budget segment. */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ease-[var(--ease-out-expo)] motion-reduce:transition-none"
          style={{
            width: `${Math.min(fill, BUDGET_FRACTION * 100)}%`,
            backgroundColor: BAR_COLOR[tone],
          }}
        />

        {/* Over-budget segment, hatched so the excess reads without colour. */}
        {fill > BUDGET_FRACTION * 100 && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 rounded-r-full transition-[width] duration-200 ease-[var(--ease-out-expo)] motion-reduce:transition-none"
            style={{
              left: `${BUDGET_FRACTION * 100}%`,
              width: `${fill - BUDGET_FRACTION * 100}%`,
              backgroundImage:
                "repeating-linear-gradient(115deg, var(--color-danger-500) 0 3px, color-mix(in oklch, var(--color-danger-500) 45%, black) 3px 6px)",
            }}
          />
        )}

        {/* The budget line itself. */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-[var(--color-ink-300)] opacity-70"
          style={{ left: `${BUDGET_FRACTION * 100}%` }}
        />

        {/* Clamp marker: the bar ran off the end of the track. */}
        {clamped && (
          <span
            aria-hidden="true"
            className="absolute inset-y-0 right-0 w-1.5 bg-[var(--color-danger-400)]"
          />
        )}
      </div>

      <span
        className={cn(
          "tabular shrink-0 text-right text-[11px] font-medium leading-none",
          variant === "row" ? "w-9" : "w-12 text-xs",
        )}
        style={{ color: TEXT_COLOR[tone] }}
      >
        {fit === null ? "—" : `${percent}%`}
      </span>

      {variant === "detail" && fit !== null && (
        <span className="tabular shrink-0 text-[11px] text-[var(--text-tertiary)]">
          {fit.targetWidth.toFixed(1)} / {fit.allowedWidth.toFixed(1)} em
          {overflowing ? ` · cut ~${fit.overBy}` : ""}
        </span>
      )}
    </div>
  );
}

function usageRatio(fit: FitResult | null): number {
  if (fit === null) return 0;
  if (fit.allowedWidth <= 0) return fit.targetWidth > 0 ? MAX_DRAWN_RATIO : 0;
  return fit.targetWidth / fit.allowedWidth;
}

/**
 * The redundant, non-colour signal. Three genuinely different silhouettes —
 * circle, triangle, square — so they are told apart at 12px in greyscale.
 */
function VerdictGlyph({ verdict }: { verdict: FitVerdict | null }) {
  const tone = fitTone(verdict);
  const color = TEXT_COLOR[tone];

  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden="true"
      className="shrink-0"
      focusable="false"
    >
      {verdict === "fits" && (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke={color} strokeWidth="1.25" />
          <path
            d="M3.6 6.2 5.2 7.8 8.4 4.4"
            fill="none"
            stroke={color}
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {verdict === "tight" && (
        <>
          <path
            d="M6 1.1 11.2 10.6H0.8Z"
            fill="none"
            stroke={color}
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
          <path d="M6 4.6v2.6" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="6" cy="8.9" r="0.7" fill={color} />
        </>
      )}
      {verdict === "overflow" && (
        <>
          <rect
            x="1"
            y="1"
            width="10"
            height="10"
            rx="2"
            fill="none"
            stroke={color}
            strokeWidth="1.25"
          />
          <path
            d="M4.2 4.2 7.8 7.8M7.8 4.2 4.2 7.8"
            stroke={color}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      )}
      {verdict === null && (
        <path d="M2 6h8" stroke={color} strokeWidth="1.25" strokeLinecap="round" />
      )}
    </svg>
  );
}
