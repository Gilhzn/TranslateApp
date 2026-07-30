import { describe, expect, it } from "vitest";
import { serializeLocaleResult } from "@/lib/export";
import { buildDemoJob, summarizeJob } from "./demo-data";

const job = buildDemoJob();

describe("demo job", () => {
  it("parses the demo catalog with its real formatting", () => {
    expect(job.catalog.indent).toBe("    ");
    expect(job.catalog.trailingNewline).toBe(true);
    expect(job.catalog.entries.length).toBeGreaterThan(80);
  });

  it("produces several hundred reviewable rows", () => {
    const total = summarizeJob(job.results).total;
    expect(job.results).toHaveLength(6);
    expect(total).toBeGreaterThan(400);
  });

  it("yields a genuine mix of outcomes, not one bucket", () => {
    const summary = summarizeJob(job.results);
    expect(summary.passed).toBeGreaterThan(0);
    expect(summary.flagged).toBeGreaterThan(0);
    expect(summary.failed).toBeGreaterThan(0);
    expect(summary.passed + summary.flagged + summary.failed).toBe(summary.total);
  });

  it("contains real overflow cases", () => {
    const overflowing = job.results
      .flatMap((r) => r.entries)
      .filter((e) => e.fit?.verdict === "overflow");
    expect(overflowing.length).toBeGreaterThan(0);
  });

  it("contains placeholder failures for the issue panel to render", () => {
    const codes = new Set(
      job.results.flatMap((r) => r.entries).flatMap((e) => e.issues.map((i) => i.code)),
    );
    expect(codes.has("placeholder-missing")).toBe(true);
    expect(codes.has("placeholder-added")).toBe(true);
  });

  it("marks every injected slip so nothing masquerades as a pipeline result", () => {
    expect(job.slipKeys.size).toBeGreaterThan(0);
    for (const id of job.slipKeys) {
      const [locale, key] = id.split("::");
      const result = job.results.find((r) => r.locale === locale);
      expect(result?.entries.some((e) => e.key === key)).toBe(true);
    }
  });

  it("records repair attempts rather than pretending every entry passed first time", () => {
    const repaired = job.results
      .flatMap((r) => r.entries)
      .filter((e) => e.attempts > 1);
    expect(repaired.length).toBeGreaterThan(0);
  });

  it("is deterministic for a fixed seed", () => {
    const again = buildDemoJob();
    expect(again.results[0]?.entries[0]?.target).toBe(
      job.results[0]?.entries[0]?.target,
    );
  });

  it("exports every locale back to a byte-shape-identical file", () => {
    for (const result of job.results) {
      const file = serializeLocaleResult(job.catalog, result);
      expect(file.contents.endsWith("\n")).toBe(true);
      expect(file.contents).toContain('\n    "meta": {');

      const parsed = JSON.parse(file.contents) as {
        meta: { build: number; betaChannel: boolean; supportUrl: string };
        cards: Array<{ cost: number }>;
      };
      expect(parsed.meta.build).toBe(42117);
      expect(parsed.meta.betaChannel).toBe(true);
      // A URL is machine data: the engine must hand it back verbatim.
      expect(parsed.meta.supportUrl).toBe("https://emberfall.gg/support");
      expect(parsed.cards).toHaveLength(4);
      expect(parsed.cards[0]?.cost).toBe(1);
    }
  });
});
