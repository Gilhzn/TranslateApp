import * as React from "react";
import { Badge, cn } from "@/components/ui";
import type { ActiveProviderDescription } from "@/lib/engine";

/**
 * Honest provider reporting.
 *
 * `describeActiveProvider()` is never optimistic, and neither is this: when the
 * simulator is answering, the banner says so in full sentences rather than
 * hiding it behind a grey dot. Presentational only — no hooks — so it renders
 * inside the server component that reads the environment.
 */

export interface ProviderIndicatorProps {
  provider: ActiveProviderDescription;
  className?: string;
}

type Tone = "ok" | "warn" | "danger";

function toneFor(provider: ActiveProviderDescription): Tone {
  if (provider.mode === "simulation") return "warn";
  return provider.ready ? "ok" : "danger";
}

export function ProviderIndicator({ provider, className }: ProviderIndicatorProps) {
  const tone = toneFor(provider);

  return (
    <Badge
      tone={tone}
      dot
      className={cn("h-7 px-2.5 text-[12px]", className)}
      title={provider.detail}
    >
      <span className="sr-only">Translation provider: </span>
      <span className="font-[family-name:var(--font-mono)] tracking-tight">
        {provider.headline}
      </span>
    </Badge>
  );
}

export interface ProviderNoticeProps {
  provider: ActiveProviderDescription;
  /**
   * Overrides the notice's first line. The header pill already states the mode
   * in `provider.headline`; where both are on screen the notice should say what
   * the mode *means for this run* instead of repeating the pill word for word.
   */
  title?: string;
  className?: string;
}

const NOTICE_TONES: Record<Tone, string> = {
  ok: "border-[color-mix(in_oklch,var(--color-ok-500)_28%,transparent)] bg-[color-mix(in_oklch,var(--color-ok-500)_9%,transparent)]",
  warn: "border-[color-mix(in_oklch,var(--color-warn-500)_28%,transparent)] bg-[color-mix(in_oklch,var(--color-warn-500)_9%,transparent)]",
  danger:
    "border-[color-mix(in_oklch,var(--color-danger-500)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-danger-500)_10%,transparent)]",
};

const NOTICE_TITLE_TONES: Record<Tone, string> = {
  ok: "text-[var(--color-ok-400)]",
  warn: "text-[var(--color-warn-400)]",
  danger: "text-[var(--color-danger-400)]",
};

/**
 * The banner is only rendered when the developer would otherwise be misled —
 * a live, configured model needs no explanation, and a permanent green box is
 * how banners stop being read.
 */
export function ProviderNotice({ provider, title, className }: ProviderNoticeProps) {
  if (provider.mode === "live" && provider.ready) return null;
  const tone = toneFor(provider);

  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius-lg)] border px-4 py-3",
        NOTICE_TONES[tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full",
          tone === "warn" ? "bg-[var(--color-warn-400)]" : "bg-[var(--color-danger-400)]",
        )}
      />
      <div className="min-w-0 space-y-1">
        <p className={cn("text-[13px] font-medium", NOTICE_TITLE_TONES[tone])}>
          {title ?? provider.headline}
        </p>
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {provider.detail}
        </p>
      </div>
    </div>
  );
}
