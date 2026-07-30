/**
 * Static-render smoke tests for the flow's own surfaces.
 *
 * `react-dom/server` needs no DOM, and rendering the run monitor and the error
 * panel against real machine states catches what the pure reducer tests cannot:
 * a locale the rail has no glyph for, a stat block that null-derefs on a run
 * that has not emitted a frame yet, a failure kind with no tone entry.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSourceFile } from "@/lib/core";
import type { LocaleResult, TranslationSettings } from "@/lib/types";
import { FlowErrorPanel } from "./FlowErrorPanel";
import { RunMonitor } from "./RunMonitor";
import {
  cancelledFailure,
  failureFromJobEvent,
  failureFromResponse,
  failureFromTransport,
  truncatedFailure,
  type RunState,
} from "./machine";

const SOURCE = '{\n  "app": {\n    "save": "Save"\n  }\n}\n';

const SETTINGS: TranslationSettings = {
  sourceLocale: "en",
  targetLocales: ["de", "ja", "ar"],
  tone: "casual-indie",
  productContext: "",
  glossary: [],
  enforceLayout: true,
  maxRepairAttempts: 2,
};

function result(locale: string): LocaleResult {
  return {
    locale,
    entries: [],
    tree: {},
    issues: [],
    stats: {
      total: 40,
      passed: 36,
      flagged: 2,
      failed: 2,
      overflowRepaired: 5,
      averageRatio: 1.2,
    },
  };
}

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    request: {
      catalog: parseSourceFile("en.json", SOURCE),
      settings: SETTINGS,
      sourceText: SOURCE,
    },
    startedAt: Date.now(),
    start: null,
    progress: null,
    results: [],
    touched: [],
    ...overrides,
  };
}

describe("RunMonitor", () => {
  it("shows an indeterminate bar before the first frame rather than a fake percentage", () => {
    const html = renderToStaticMarkup(<RunMonitor run={run()} onCancel={() => {}} />);
    expect(html).toContain("Opening the stream…");
    // No `aria-valuenow` at all: the bar is honestly indeterminate rather than
    // parked at a percentage nothing reported.
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("shimmer");
    expect(html).toContain("Cancel");
    // Every target is listed from the start, so the developer sees the whole run.
    for (const code of SETTINGS.targetLocales) expect(html).toContain(`>${code}<`);
  });

  it("reports real counts and the layout repairs once frames arrive", () => {
    const html = renderToStaticMarkup(
      <RunMonitor
        onCancel={() => {}}
        run={run({
          progress: {
            phase: "repairing",
            progress: 0.42,
            locale: "ja",
            completedUnits: 50,
            totalUnits: 120,
            message: "ja: repairing 3 overflowing strings",
          },
          results: [result("de")],
          touched: ["de", "ja"],
        })}
      />,
    );
    expect(html).toContain("Repairing overflow");
    expect(html).toContain("42%");
    expect(html).toContain("50 / 120 units");
    expect(html).toContain("1/3 locales");
    expect(html).toContain("5 refit");
    expect(html).toContain("in flight");
    expect(html).toContain("queued");
  });
});

describe("FlowErrorPanel", () => {
  const cases = [
    ["refused request", failureFromResponse(413, { error: { code: "payload-too-large", message: "too big" } })],
    ["job failure", failureFromJobEvent({ code: "structure-mismatch", message: "diverged", paths: ["a.b"] })],
    ["dropped connection", failureFromTransport(new Error("terminated"))],
    ["truncated stream", truncatedFailure()],
    ["cancel", cancelledFailure()],
  ] as const;

  for (const [name, failure] of cases) {
    it(`renders a specific, recoverable state for a ${name}`, () => {
      const html = renderToStaticMarkup(
        <FlowErrorPanel
          failure={failure}
          run={run({ results: [result("de")] })}
          onRetry={() => {}}
          onBackToSetup={() => {}}
          onReviewPartial={() => {}}
        />,
      );
      expect(html).toContain(failure.title);
      expect(html).toContain(failure.hint);
      expect(html).toContain("Back to setup");
      // One locale finished, so the partial-review escape hatch is offered.
      expect(html).toContain("Review the 1 finished language");
      expect(html).toContain(failure.retryable ? "Run again" : "Back to setup");
    });
  }

  it("offers no retry for a refusal that would be refused identically", () => {
    const html = renderToStaticMarkup(
      <FlowErrorPanel
        failure={failureFromResponse(400, { error: { code: "invalid-body", message: "bad" } })}
        run={run()}
        onRetry={() => {}}
        onBackToSetup={() => {}}
        onReviewPartial={() => {}}
      />,
    );
    expect(html).not.toContain("Run again");
    expect(html).not.toContain("Review the");
  });
});
