import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateFit, getLocaleProfile } from "@/lib/layout";
import { issue } from "@/lib/validate";
import type { FitResult } from "@/lib/types";
import { FitMeter } from "./FitMeter";
import { IssueList } from "./IssueList";
import { RowDetail } from "./RowDetail";
import { buildDemoJob } from "./demo-data";
import { buildRows, type ReviewRow } from "./rows";
import { recomputeRow, type RecomputeContext } from "./recompute";

const profile = getLocaleProfile("de");
const ctx: RecomputeContext = { profile, sourceLocale: "en" };

const job = buildDemoJob({ locales: ["de"] });
const rows = buildRows(job.catalog, job.results);

function rowFor(key: string): ReviewRow {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
}

/** `renderToStaticMarkup` escapes text; compare against the escaped form. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function fitFor(source: string, target: string): FitResult {
  return evaluateFit(source, target, "button", profile);
}

describe("FitMeter", () => {
  it("describes the verdict in text, not only in colour", () => {
    const html = renderToStaticMarkup(<FitMeter fit={fitFor("Save", "Ok")} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain("fits");
    expect(html).toContain("%");
  });

  it("renders a different glyph for each verdict", () => {
    const fits = renderToStaticMarkup(<FitMeter fit={fitFor("Save", "Ok")} />);
    const overflow = renderToStaticMarkup(
      <FitMeter fit={fitFor("Save", "Alle Änderungen dauerhaft speichern")} />,
    );
    expect(fits).toContain("<circle"); // check-in-circle
    expect(overflow).toContain("<rect"); // cross-in-square
    expect(overflow).toContain("overflow");
    expect(overflow).toContain("too long");
    expect(fits).not.toBe(overflow);
  });

  it("hatches the segment past the budget line", () => {
    const html = renderToStaticMarkup(
      <FitMeter fit={fitFor("Save", "Alle Änderungen dauerhaft speichern")} />,
    );
    expect(html).toContain("repeating-linear-gradient");
  });

  it("stays legible when nothing was measured", () => {
    const html = renderToStaticMarkup(<FitMeter fit={null} />);
    expect(html).toContain("Not measured");
    expect(html).toContain("—");
  });

  it("shows the numeric readout in the detail variant", () => {
    const html = renderToStaticMarkup(
      <FitMeter fit={fitFor("Save", "Sichern")} variant="detail" />,
    );
    expect(html).toContain("em");
    expect(html).toContain("/");
  });
});

describe("IssueList", () => {
  it("says so when there is nothing wrong", () => {
    const html = renderToStaticMarkup(<IssueList issues={[]} />);
    expect(html).toContain("passed every check");
  });

  it("labels each severity in words as well as colour", () => {
    const html = renderToStaticMarkup(
      <IssueList
        issues={[
          issue("placeholder-missing", "error", "The placeholder {n} is gone."),
          issue("length-tight", "warning", "No headroom left."),
          issue("placeholder-reordered", "info", "Order changed."),
        ]}
      />,
    );
    expect(html).toContain("Error");
    expect(html).toContain("Warning");
    expect(html).toContain("Info");
    expect(html).toContain("placeholder-missing");
    expect(html).toContain("The placeholder {n} is gone.");
  });

  it("renders the machine-readable detail as readable pairs", () => {
    const html = renderToStaticMarkup(
      <IssueList
        issues={[
          issue("length-overflow", "error", "Too wide.", {
            detail: { targetWidth: 9.4, allowedWidth: 6.1 },
          }),
        ]}
      />,
    );
    expect(html).toContain("target width");
    expect(html).toContain("9.4");
  });
});

describe("RowDetail", () => {
  it("shows the rationale, the budget and the placeholder inventory", () => {
    const html = renderToStaticMarkup(
      <RowDetail row={rowFor("hud.floorLabel")} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("Model rationale");
    expect(html).toContain("Layout budget");
    expect(html).toContain("Placeholders");
    expect(html).toContain("{n}");
    expect(html).toContain("Sibling keys sent as context");
  });

  it("carries the untruncated key, source and translation the row had to clip", () => {
    const row = rowFor("errors.saveFailed.body");
    const html = renderToStaticMarkup(
      <RowDetail row={row} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("errors.saveFailed.body");
    // The row cell truncates this; the panel must not.
    expect(html).toContain("checkpoint at floor {n} is safe");
    expect(html).toContain(escapeHtml(row.target));
  });

  it("says so when a translation came back empty", () => {
    const blanked = recomputeRow(rowFor("menu.play"), "", ctx);
    const html = renderToStaticMarkup(
      <RowDetail row={blanked} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("(empty)");
    expect(html).toContain("empty-translation");
  });

  it("surfaces the developer note the parser picked up", () => {
    const html = renderToStaticMarkup(
      <RowDetail row={rowFor("menu.play")} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("Developer note");
    expect(html).toContain("180px");
  });

  it("marks a dropped placeholder on the source side", () => {
    const broken = recomputeRow(rowFor("hud.floorLabel"), "Ebene", ctx);
    const html = renderToStaticMarkup(
      <RowDetail row={broken} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("dropped");
    expect(html).toContain("placeholder-missing");
  });

  it("marks an invented placeholder on the translation side", () => {
    const broken = recomputeRow(rowFor("menu.play"), "Los {jetzt}", ctx);
    const html = renderToStaticMarkup(
      <RowDetail row={broken} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("invented");
  });

  it("shows the exact repair instruction for an entry that still needs one", () => {
    const broken = recomputeRow(rowFor("hud.floorLabel"), "Ebene", ctx);
    const html = renderToStaticMarkup(
      <RowDetail row={broken} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain("Repair instruction for the next pass");
    expect(html).toContain("Constraints that still apply");
  });

  it("omits the repair block when the entry is clean", () => {
    const fine = recomputeRow(rowFor("hud.floorLabel"), "Ebene {n}", ctx);
    const html = renderToStaticMarkup(
      <RowDetail row={fine} ctx={ctx} direction="ltr" />,
    );
    expect(html).not.toContain("Repair instruction for the next pass");
  });

  it("counts the model calls an entry consumed", () => {
    const repaired = rows.find((row) => row.attempts > 1);
    if (repaired === undefined) throw new Error("expected a repaired row");
    const html = renderToStaticMarkup(
      <RowDetail row={repaired} ctx={ctx} direction="ltr" />,
    );
    expect(html).toContain(`${repaired.attempts} model calls`);
  });
});
