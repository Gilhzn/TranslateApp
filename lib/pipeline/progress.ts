/**
 * Progress accounting.
 *
 * The counts have to be *true*, not decorative. A progress bar that reaches 90%
 * and sits there is worse than no progress bar, so `completedUnits` is
 * incremented exactly once per entry that reaches a terminal status — including
 * the ones that pass through verbatim and the ones that fail — and never
 * decrements.
 *
 * Locales run concurrently, so `totalUnits` is the whole job (entries × target
 * locales) and `locale` names the locale the *event* is about, not a global
 * cursor.
 */

import type { JobPhase, JobProgress, LocaleCode } from "@/lib/types";

export type ProgressListener = (progress: JobProgress) => void;

export class ProgressTracker {
  private readonly total: number;
  private readonly listener: ProgressListener | undefined;
  private currentPhase: JobPhase = "queued";
  private completed = 0;

  constructor(totalUnits: number, listener?: ProgressListener) {
    this.total = Math.max(0, Math.trunc(totalUnits));
    this.listener = listener;
  }

  get totalUnits(): number {
    return this.total;
  }

  get completedUnits(): number {
    return this.completed;
  }

  get phase(): JobPhase {
    return this.currentPhase;
  }

  /** Record a phase transition and report it. */
  setPhase(phase: JobPhase, locale: LocaleCode | null, message: string): void {
    this.currentPhase = phase;
    this.emit(locale, message);
  }

  /** Record `count` entries reaching a terminal status and report it. */
  advance(count: number, locale: LocaleCode | null, message: string): void {
    if (count > 0) {
      this.completed = Math.min(this.total, this.completed + count);
    }
    this.emit(locale, message);
  }

  /** Report without changing anything — used for informational messages. */
  note(locale: LocaleCode | null, message: string): void {
    this.emit(locale, message);
  }

  snapshot(locale: LocaleCode | null, message: string): JobProgress {
    return {
      phase: this.currentPhase,
      progress: this.ratio(),
      locale,
      completedUnits: this.completed,
      totalUnits: this.total,
      message,
    };
  }

  private ratio(): number {
    if (this.currentPhase === "complete") return 1;
    if (this.total === 0) return this.currentPhase === "error" ? 0 : 0;
    // Four decimals: enough for a pixel-accurate bar, few enough that the SSE
    // frames stay small and identical values de-duplicate cleanly.
    return Math.round((this.completed / this.total) * 10_000) / 10_000;
  }

  private emit(locale: LocaleCode | null, message: string): void {
    this.listener?.(this.snapshot(locale, message));
  }
}
