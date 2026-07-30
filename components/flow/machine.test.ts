/**
 * The flow machine, tested where the product's failure modes actually live.
 *
 * The browser test proves the happy path renders; these prove the seven paths
 * a browser test cannot reach cheaply — a refused request, a mid-stream error,
 * a dropped connection, a cancel with partial results, a truncated stream, a
 * job that returns nothing, and a malformed frame from a skewed deploy.
 */

import { describe, expect, it } from "vitest";
import { parseSourceFile, type ParsedCatalog } from "@/lib/core";
import type { LocaleResult, TranslationSettings } from "@/lib/types";
import {
  INITIAL_FLOW_STATE,
  cancelledFailure,
  decodeJobDone,
  decodeJobError,
  decodeJobStart,
  decodeLocaleResult,
  decodeProgress,
  failureFromJobEvent,
  failureFromResponse,
  failureFromTransport,
  flowReducer,
  formatDuration,
  localeTracks,
  runOf,
  runTotals,
  truncatedFailure,
  type FlowState,
  type RunRequest,
} from "./machine";

const SOURCE = '{\n  "app": {\n    "save": "Save",\n    "cancel": "Cancel"\n  }\n}\n';

function catalog(): ParsedCatalog {
  return parseSourceFile("en.json", SOURCE);
}

function settings(targets: string[] = ["de", "ja"]): TranslationSettings {
  return {
    sourceLocale: "en",
    targetLocales: targets,
    tone: "neutral-product",
    productContext: "",
    glossary: [],
    enforceLayout: true,
    maxRepairAttempts: 2,
  };
}

function request(targets?: string[]): RunRequest {
  return { catalog: catalog(), settings: settings(targets), sourceText: SOURCE };
}

function result(locale: string, overrides: Partial<LocaleResult["stats"]> = {}): LocaleResult {
  return {
    locale,
    entries: [],
    tree: {},
    issues: [],
    stats: {
      total: 2,
      passed: 2,
      flagged: 0,
      failed: 0,
      overflowRepaired: 0,
      averageRatio: 1,
      ...overrides,
    },
  };
}

function running(targets?: string[]): FlowState {
  return flowReducer(INITIAL_FLOW_STATE, {
    type: "run-requested",
    request: request(targets),
    at: 1_000,
  });
}

// ---------------------------------------------------------------------------

describe("phase transitions", () => {
  it("starts idle and moves to configuring only when a catalog lands", () => {
    expect(INITIAL_FLOW_STATE.phase).toBe("idle");
    const next = flowReducer(INITIAL_FLOW_STATE, {
      type: "catalog-loaded",
      catalog: catalog(),
    });
    expect(next.phase).toBe("configuring");
    expect(
      flowReducer(next, { type: "catalog-loaded", catalog: null }).phase,
    ).toBe("idle");
  });

  it("runs, collects locales and completes", () => {
    let state = running();
    state = flowReducer(state, {
      type: "progress",
      progress: {
        phase: "translating",
        progress: 0.5,
        locale: "de",
        completedUnits: 2,
        totalUnits: 4,
        message: "de: batch 1/1",
      },
    });
    state = flowReducer(state, { type: "locale-complete", result: result("de") });
    state = flowReducer(state, { type: "locale-complete", result: result("ja") });
    state = flowReducer(state, {
      type: "job-done",
      event: { jobId: "job_1", durationMs: 900, issues: [] },
      at: 2_500,
    });

    expect(state.phase).toBe("complete");
    if (state.phase !== "complete") return;
    expect(state.run.results.map((entry) => entry.locale)).toEqual(["de", "ja"]);
    expect(state.finishedAt - state.run.startedAt).toBe(1_500);
    expect(state.done?.jobId).toBe("job_1");
  });

  it("never lets a late frame resurrect a finished run", () => {
    let state = running();
    state = flowReducer(state, { type: "locale-complete", result: result("de") });
    state = flowReducer(state, {
      type: "job-done",
      event: decodeJobDone(null),
      at: 2_000,
    });
    const after = flowReducer(state, { type: "locale-complete", result: result("ja") });
    expect(after).toBe(state);
  });

  it("ignores a duplicate locale rather than doubling a review column", () => {
    let state = running();
    state = flowReducer(state, { type: "locale-complete", result: result("de") });
    const again = flowReducer(state, { type: "locale-complete", result: result("de") });
    expect(again).toBe(state);
  });

  it("does not let a late parse yank a running job off the screen", () => {
    const state = running();
    expect(
      flowReducer(state, { type: "catalog-loaded", catalog: catalog() }),
    ).toBe(state);
  });

  it("treats a job that produced no locale as a failure, not an empty table", () => {
    const state = flowReducer(running(), {
      type: "job-done",
      event: decodeJobDone(null),
      at: 2_000,
    });
    expect(state.phase).toBe("error");
    if (state.phase !== "error") return;
    expect(state.failure.code).toBe("no-results");
  });

  it("keeps the catalog when going back to setup, and drops it on reset", () => {
    const state = flowReducer(running(), {
      type: "job-failed",
      failure: cancelledFailure(),
    });
    const back = flowReducer(state, { type: "back-to-setup" });
    expect(back.phase).toBe("configuring");
    if (back.phase === "configuring") expect(back.catalog.fileName).toBe("en.json");
    expect(flowReducer(back, { type: "reset" }).phase).toBe("idle");
  });
});

describe("partial results", () => {
  it("lets a cancelled run with finished locales be reviewed", () => {
    let state = running();
    state = flowReducer(state, { type: "locale-complete", result: result("de") });
    state = flowReducer(state, { type: "job-failed", failure: cancelledFailure() });
    expect(state.phase).toBe("error");

    const reviewed = flowReducer(state, { type: "review-partial", at: 3_000 });
    expect(reviewed.phase).toBe("complete");
    if (reviewed.phase !== "complete") return;
    // `done: null` is what marks the review as partial in the UI.
    expect(reviewed.done).toBeNull();
    expect(reviewed.run.results).toHaveLength(1);
  });

  it("refuses to offer a review when nothing finished", () => {
    const state = flowReducer(running(), {
      type: "job-failed",
      failure: cancelledFailure(),
    });
    expect(flowReducer(state, { type: "review-partial", at: 3_000 })).toBe(state);
  });
});

describe("failure taxonomy", () => {
  it("does not offer a retry for a 4xx that will be refused identically", () => {
    const failure = failureFromResponse(400, {
      error: {
        code: "invalid-body",
        message: "Select at least one target locale.",
        field: "settings.targetLocales",
      },
    });
    expect(failure.kind).toBe("request");
    expect(failure.retryable).toBe(false);
    expect(failure.detail).toContain("Field: settings.targetLocales");
  });

  it("does offer a retry for a 5xx", () => {
    const failure = failureFromResponse(503, null);
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("503");
  });

  it("surfaces the byte counts a payload-too-large refusal carries", () => {
    const failure = failureFromResponse(413, {
      error: {
        code: "payload-too-large",
        message: "too big",
        detail: { bytes: 3_000_000, maxBytes: 2_000_000 },
      },
    });
    expect(failure.detail).toEqual(["bytes: 3000000", "maxBytes: 2000000"]);
    expect(failure.hint).toContain("Split the catalogue");
  });

  it("names the diverging paths of a structure mismatch", () => {
    const failure = failureFromJobEvent(
      decodeJobError({
        code: "structure-mismatch",
        message: "de diverged",
        paths: ["app.save", "app.cancel"],
      }),
    );
    expect(failure.kind).toBe("job");
    expect(failure.detail).toEqual([
      "Diverging key: app.save",
      "Diverging key: app.cancel",
    ]);
  });

  it("routes the server's own cancellation to the cancel state, not an error", () => {
    const failure = failureFromJobEvent(
      decodeJobError({ code: "cancelled", message: "aborted" }),
    );
    expect(failure.kind).toBe("cancelled");
  });

  it("distinguishes a dropped connection from a truncated stream", () => {
    expect(failureFromTransport(new Error("terminated")).code).toBe("network");
    expect(truncatedFailure().code).toBe("stream-truncated");
    expect(truncatedFailure().retryable).toBe(true);
  });
});

describe("wire decoders", () => {
  it("rejects a progress frame with an unknown phase", () => {
    expect(decodeProgress({ phase: "vibing", progress: 0.5 })).toBeNull();
    expect(decodeProgress(null)).toBeNull();
    expect(decodeProgress("nope")).toBeNull();
  });

  it("clamps a progress ratio and defaults the message", () => {
    const progress = decodeProgress({ phase: "translating", progress: 4 });
    expect(progress?.progress).toBe(1);
    expect(progress?.message).toBe("");
    expect(progress?.locale).toBeNull();
  });

  it("drops a locale-complete frame that could not build a review row", () => {
    expect(decodeLocaleResult({ locale: "de" })).toBeNull();
    expect(decodeLocaleResult({ locale: "de", entries: [], tree: {} })).toBeNull();
    expect(
      decodeLocaleResult({ locale: "de", entries: [], tree: {}, stats: {} }),
    ).not.toBeNull();
  });

  it("keeps a start frame usable when the provider block is unreadable", () => {
    const event = decodeJobStart({
      fileName: "en.json",
      sourceLocale: "en",
      targetLocales: ["de", 7, "ja"],
      totalUnits: 12,
      provider: "anthropic",
    });
    expect(event?.targetLocales).toEqual(["de", "ja"]);
    expect(event?.provider).toBeNull();
    expect(event?.translatableKeys).toBe(0);
  });

  it("never throws on a garbage done or error payload", () => {
    expect(decodeJobDone(42)).toEqual({ jobId: "", durationMs: 0, issues: [] });
    expect(decodeJobError([]).code).toBe("job-failed");
  });
});

describe("derived views", () => {
  it("reports every target as queued, active or done — concurrently", () => {
    let state = running(["de", "ja", "fr"]);
    state = flowReducer(state, {
      type: "progress",
      progress: {
        phase: "translating",
        progress: 0.1,
        locale: "de",
        completedUnits: 1,
        totalUnits: 6,
        message: "",
      },
    });
    state = flowReducer(state, {
      type: "progress",
      progress: {
        phase: "translating",
        progress: 0.2,
        locale: "ja",
        completedUnits: 2,
        totalUnits: 6,
        message: "",
      },
    });
    state = flowReducer(state, { type: "locale-complete", result: result("de") });

    const run = runOf(state);
    expect(run).not.toBeNull();
    if (run === null) return;
    expect(localeTracks(run)).toEqual([
      { locale: "de", state: "done", result: expect.objectContaining({ locale: "de" }) },
      { locale: "ja", state: "active", result: null },
      { locale: "fr", state: "queued", result: null },
    ]);
  });

  it("sums the stats the completion bar reports", () => {
    expect(
      runTotals([
        result("de", { overflowRepaired: 3, flagged: 1 }),
        result("ja", { failed: 2 }),
      ]),
    ).toEqual({ strings: 4, passed: 4, flagged: 1, failed: 2, overflowRepaired: 3 });
  });

  it("formats durations without ever saying 'a few seconds'", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(12_400)).toBe("12.4s");
    expect(formatDuration(64_000)).toBe("1m 04s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
