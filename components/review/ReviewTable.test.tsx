import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocaleProfile } from "@/lib/layout";
import { ReviewPanel } from "./ReviewPanel";
import { ReviewTable } from "./ReviewTable";
import { buildDemoJob } from "./demo-data";
import { buildRows, type ReviewRow } from "./rows";
import type { RecomputeContext } from "./recompute";

/**
 * Render smoke tests.
 *
 * The suite runs in Node without a DOM, so these assert on the server-rendered
 * markup: that the surface renders at all, that its states are real, that the
 * grid is announced correctly, and — the one that matters for scale — that a
 * 236-row table mounts a windowed slice rather than every row.
 */

const job = buildDemoJob({ locales: ["de", "ar"] });
const rows = buildRows(job.catalog, job.results);

const contexts = new Map<string, RecomputeContext>([
  ["de", { profile: getLocaleProfile("de"), sourceLocale: "en" }],
  ["ar", { profile: getLocaleProfile("ar"), sourceLocale: "en" }],
]);
const contextFor = (locale: string): RecomputeContext => {
  const context = contexts.get(locale);
  if (context === undefined) throw new Error(`no context for ${locale}`);
  return context;
};

const noop = () => {
  /* the smoke tests never dispatch */
};

function renderTable(props: Partial<React.ComponentProps<typeof ReviewTable>> = {}) {
  return renderToStaticMarkup(
    <ReviewTable
      rows={rows}
      contextFor={contextFor}
      onEdit={noop}
      onRevert={noop}
      onTrim={noop}
      {...props}
    />,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("ReviewTable rendering", () => {
  it("renders an ARIA grid with the right row count", () => {
    const html = renderTable();
    expect(html).toContain('role="grid"');
    expect(html).toContain(`aria-rowcount="${rows.length + 1}"`);
    expect(html).toContain('aria-label="Translation review"');
  });

  it("renders every column header", () => {
    const html = renderTable();
    for (const header of ["Key", "Locale", "Source", "Translation", "Fit", "Status"]) {
      expect(html).toContain(`>${header}</span>`);
    }
  });

  it("windows: a few hundred rows mount as a few dozen", () => {
    expect(rows.length).toBeGreaterThan(200);
    const mounted = countOccurrences(renderTable(), 'role="row"');
    // Header + the visible slice + overscan — nowhere near `rows.length`.
    expect(mounted).toBeLessThan(60);
    expect(mounted).toBeGreaterThan(10);
  });

  it("mounts more rows for a taller viewport", () => {
    const short = countOccurrences(renderTable({ height: 240 }), 'role="row"');
    const tall = countOccurrences(renderTable({ height: 900 }), 'role="row"');
    expect(tall).toBeGreaterThan(short);
  });

  it("renders the fit meter with an accessible value for each row", () => {
    const html = renderTable();
    expect(html).toContain('role="meter"');
    expect(html).toContain("of the available width");
  });

  it("marks the RTL locale on the translation cell", () => {
    const arabicOnly = rows.filter((row) => row.locale === "ar");
    const html = renderTable({ rows: arabicOnly });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
  });

  it("hides the locale column when asked", () => {
    const html = renderTable({ showLocale: false });
    expect(html).not.toContain(">Locale</span>");
    expect(html).toContain('aria-colcount="6"');
  });

  it("renders a real empty state", () => {
    const html = renderTable({ rows: [] as ReviewRow[] });
    expect(html).toContain("No strings match these filters");
    expect(html).not.toContain('role="meter"');
  });

  it("renders a real loading state", () => {
    const html = renderTable({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading translations");
  });

  it("renders a real error state", () => {
    const html = renderTable({ error: "The provider returned nothing." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The provider returned nothing.");
    expect(html).not.toContain('role="grid"');
  });
});

describe("ReviewPanel rendering", () => {
  const html = renderToStaticMarkup(
    <ReviewPanel
      catalog={job.catalog}
      results={job.results}
      sourceLocale="en"
      glossary={job.settings.glossary}
    />,
  );

  it("shows the catalog summary", () => {
    expect(html).toContain(job.catalog.fileName);
    expect(html).toContain("strings reviewed");
    expect(html).toContain('role="progressbar"');
  });

  it("offers both export paths", () => {
    expect(html).toContain("Export all");
    expect(html).toContain("Export locale");
  });

  it("renders every locale chip with a count", () => {
    for (const result of job.results) {
      expect(html).toContain(`>${result.locale}</span>`);
    }
    expect(html).toContain("All locales");
  });

  it("renders the status filters and the search box", () => {
    expect(html).toContain("Search keys, source text and translations");
    expect(html).toContain("Any status");
    expect(html).toContain("Any issue");
  });

  it("documents the keyboard model on screen", () => {
    expect(html).toContain("expand");
    expect(html).toContain("edit");
  });
});
