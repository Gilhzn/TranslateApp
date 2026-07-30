"use client";

import * as React from "react";
import { Badge, cn, type BadgeTone } from "@/components/ui";
import type { EntryStatus } from "@/lib/types";

const TONES: Record<EntryStatus, BadgeTone> = {
  passed: "ok",
  flagged: "warn",
  failed: "danger",
  pending: "neutral",
  translating: "accent",
  repairing: "accent",
};

export const STATUS_LABEL: Record<EntryStatus, string> = {
  passed: "Passed",
  flagged: "Flagged",
  failed: "Failed",
  pending: "Pending",
  translating: "Translating",
  repairing: "Repairing",
};

export function statusTone(status: EntryStatus): BadgeTone {
  return TONES[status];
}

export interface StatusBadgeProps {
  status: EntryStatus;
  /** Adds the "edited" marker used in the review table. */
  edited?: boolean;
  className?: string;
}

export function StatusBadge({ status, edited = false, className }: StatusBadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Badge tone={statusTone(status)} dot>
        {STATUS_LABEL[status]}
      </Badge>
      {edited && (
        <span
          title="Overridden by you"
          aria-label="Overridden by you"
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center rounded-full",
            "border border-[color-mix(in_oklch,var(--color-accent-500)_45%,transparent)]",
            "bg-[color-mix(in_oklch,var(--color-accent-500)_18%,transparent)]",
            "text-[9px] font-bold leading-none text-[var(--color-accent-400)]",
          )}
        >
          E
        </span>
      )}
    </span>
  );
}
