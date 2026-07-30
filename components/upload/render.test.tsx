/**
 * Static-render smoke tests.
 *
 * Vitest runs in the node environment, so there is no DOM to drive — but
 * `react-dom/server` needs none, and rendering each surface against the real
 * fixtures catches the whole class of defects unit tests over helpers miss:
 * a bad index into a label table, a null deref on an empty selection, a role
 * the tally produced that the UI has no name for.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSourceFile } from "@/lib/core";
import { describeActiveProvider } from "@/lib/engine";
import Home from "@/app/page";
import { CatalogSummary } from "./CatalogSummary";
import { JobSettings } from "./JobSettings";
import { LocalePicker } from "./LocalePicker";
import { ProviderIndicator, ProviderNotice } from "./ProviderIndicator";
import { UploadStage } from "./UploadStage";
import {
  initialSettingsDraft,
  newGlossaryDraft,
  type SettingsDraft,
} from "./settings-model";

const FIXTURES = path.resolve(__dirname, "../../fixtures");

function fixture(name: string) {
  return parseSourceFile(name, readFileSync(path.join(FIXTURES, name), "utf8"));
}

const SIMULATION = describeActiveProvider({ env: {} });
const LIVE = describeActiveProvider({ env: { ANTHROPIC_API_KEY: "sk-test-key" } });

describe("CatalogSummary", () => {
  for (const name of ["indie-game-en.json", "micro-saas-en.json"] as const) {
    it(`renders every panel for ${name}`, () => {
      const html = renderToStaticMarkup(<CatalogSummary catalog={fixture(name)} />);
      expect(html).toContain("What we understood");
      expect(html).toContain("Role distribution");
      expect(html).toContain("Detected ambiguities");
      expect(html).toContain("Sample entries");
      expect(html).toContain(name);
    });
  }

  it("shows the empty-ambiguity copy rather than a blank panel", () => {
    const catalog = parseSourceFile("plain.json", '{\n  "x": "zzzq"\n}\n');
    const html = renderToStaticMarkup(<CatalogSummary catalog={catalog} />);
    expect(html).toContain("No ambiguous terms found");
  });
});

describe("LocalePicker", () => {
  it("shows native names and expansion for the selection and the list", () => {
    const html = renderToStaticMarkup(
      <LocalePicker sourceLocale="en" selected={["de", "ja"]} onChange={() => {}} />,
    );
    expect(html).toContain("Deutsch");
    expect(html).toContain("+35% avg");
    expect(html).toContain("2 selected");
    // The source locale is never offered as a target.
    expect(html).not.toContain(">English<");
  });

  it("designs the empty selection instead of leaving a gap", () => {
    const html = renderToStaticMarkup(
      <LocalePicker sourceLocale="en" selected={[]} onChange={() => {}} invalid />,
    );
    expect(html).toContain("No languages selected yet");
  });
});

describe("JobSettings", () => {
  it("renders every tone with its register description", () => {
    const html = renderToStaticMarkup(
      <JobSettings draft={initialSettingsDraft("en")} onChange={() => {}} />,
    );
    expect(html).toContain("Casual indie");
    expect(html).toContain("Technical / developer");
    expect(html).toContain("Repair attempts");
    expect(html).toContain("Enforce layout budgets");
    expect(html).toContain("No glossary terms");
  });

  it("renders per-locale glossary fields once verbatim mode is off", () => {
    const draft: SettingsDraft = {
      ...initialSettingsDraft("en"),
      targetLocales: ["de", "ja"],
      glossary: [{ ...newGlossaryDraft("g1"), term: "Emberfall", keepVerbatim: false }],
    };
    const html = renderToStaticMarkup(<JobSettings draft={draft} onChange={() => {}} />);
    expect(html).toContain("Emberfall");
    expect(html).toContain("Deutsch rendering");
    expect(html).toContain("日本語 rendering");
  });
});

describe("provider chrome", () => {
  it("states plainly that simulation output is not a translation", () => {
    expect(renderToStaticMarkup(<ProviderIndicator provider={SIMULATION} />)).toContain(
      "Offline simulation",
    );
    expect(renderToStaticMarkup(<ProviderNotice provider={SIMULATION} />)).toContain(
      "not translations",
    );
  });

  it("names the live model and suppresses the banner when nothing is wrong", () => {
    expect(renderToStaticMarkup(<ProviderIndicator provider={LIVE} />)).toContain(
      "Anthropic",
    );
    expect(renderToStaticMarkup(<ProviderNotice provider={LIVE} />)).toBe("");
  });
});

describe("UploadStage", () => {
  it("renders a designed idle state", () => {
    const html = renderToStaticMarkup(<UploadStage provider={SIMULATION} />);
    expect(html).toContain("Drop your source catalog");
    expect(html).toContain("Parse and analyse");
    expect(html).toContain("Offline simulation");
    // Nothing downstream of an upload should exist yet.
    expect(html).not.toContain("Target languages");
  });
});

describe("dashboard page", () => {
  it("renders the shell with the honest provider indicator", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("LingoLoop");
    expect(html).toContain("Drop your source catalog");
    // The page reads the real environment, so assert on whichever mode that is
    // rather than pinning the test to one machine's configuration.
    const actual = describeActiveProvider();
    expect(html).toContain(actual.headline);
  });

  it("never renders a hardcoded provider claim", () => {
    const html = renderToStaticMarkup(<Home />);
    const actual = describeActiveProvider();
    if (actual.mode === "simulation") expect(html).not.toContain("Anthropic ·");
  });
});
