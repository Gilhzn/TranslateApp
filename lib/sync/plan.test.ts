import { describe, expect, it } from "vitest";
import { serializeLocaleResult } from "@/lib/export";
import { estimateLongestLineWidth, getLocaleProfile } from "@/lib/layout";
import type { JsonValue, LocaleResult, SyncTarget } from "@/lib/types";
import { SyncPlanError } from "./errors";
import {
  buildBranchName,
  buildSyncPlan,
  buildSyncPlanDetailed,
  sanitizeRefComponent,
} from "./plan";
import { makeCatalog, makeResult } from "./testing";

const TIMESTAMP = Date.parse("2026-07-30T14:32:10Z");

const TARGET: SyncTarget = {
  provider: "github",
  owner: "indiedev",
  repo: "deck-forge",
  baseBranch: "main",
  localeDir: "public/locales",
  fileNamePattern: "{locale}.json",
};

const catalog = makeCatalog();

/** Read a structural path out of a parsed JSON tree. */
function readPath(tree: unknown, path: ReadonlyArray<string | number>): unknown {
  let node: unknown = tree;
  for (const step of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, JsonValue>)[step];
  }
  return node;
}

function german(): LocaleResult {
  return makeResult(catalog, "de", [
    { key: "app.title", target: "Deck Forge" },
    { key: "app.subtitle", target: "Baue einen Durchlauf, brich das Meta-Spiel auf" },
    { key: "menu.save", target: "Speichern" },
    { key: "menu.load", target: "Spielstand laden und fortsetzen", attempts: 2 },
    { key: "menu.settings", target: "Einstellungen" },
    { key: "hud.cardsLeft", target: "{count} Karten übrig" },
    { key: "hud.damage", target: "%d Schaden verursacht" },
    {
      key: "errors.offline",
      target: "",
      status: "failed",
      issues: [
        {
          code: "provider-error",
          severity: "error",
          message: "Provider returned no translation for this key",
        },
      ],
    },
  ]);
}

function japanese(): LocaleResult {
  return makeResult(catalog, "ja", [
    { key: "menu.save", target: "保存" },
    { key: "hud.damage", target: "%d のダメージを与えた" },
  ]);
}

function plan(overrides: Partial<Parameters<typeof buildSyncPlan>[3]> = {}) {
  return buildSyncPlan(TARGET, [german(), japanese()], catalog, {
    timestamp: TIMESTAMP,
    ...overrides,
  });
}

describe("buildSyncPlan — file mapping", () => {
  it("maps each locale to localeDir + pattern", () => {
    expect(plan().files.map((f) => f.path)).toEqual([
      "public/locales/de.json",
      "public/locales/ja.json",
    ]);
  });

  it("emits bytes identical to what the download button produces", () => {
    const result = german();
    const downloaded = serializeLocaleResult(catalog, result, {
      pattern: "de.json",
      directory: "public/locales",
    });
    const synced = plan().files[0];
    expect(synced?.path).toBe(downloaded.path);
    expect(synced?.contents).toBe(downloaded.contents);
  });

  it("keeps the source structure, key order and non-string leaves", () => {
    const contents = plan().files[0]?.contents ?? "";
    const emitted = JSON.parse(contents) as Record<string, unknown>;
    const source = JSON.parse(
      JSON.stringify(catalog.tree),
    ) as Record<string, unknown>;

    expect(Object.keys(emitted)).toEqual(Object.keys(source));
    expect((emitted["meta"] as { version: number }).version).toBe(3);
    expect((emitted["meta"] as { tags: string[] }).tags).toEqual([
      "roguelike",
      "deckbuilder",
    ]);
    // Source order, not alphabetical: "save" precedes "load".
    expect(contents.indexOf('"save"')).toBeLessThan(contents.indexOf('"load"'));
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("ships no string wider than its layout budget", () => {
    const result = german();
    const emitted = JSON.parse(plan().files[0]?.contents ?? "") as unknown;
    const profile = getLocaleProfile("de");

    let checked = 0;
    for (const entry of result.entries) {
      const shipped = readPath(emitted, entry.path);
      const fit = entry.fit;
      expect(typeof shipped).toBe("string");
      if (typeof shipped !== "string" || fit === null) continue;
      checked += 1;
      expect(estimateLongestLineWidth(shipped, profile)).toBeLessThanOrEqual(
        fit.allowedWidth,
      );
    }
    expect(checked).toBe(result.entries.length);
  });

  it("preserves placeholders in the emitted file", () => {
    const contents = plan().files[0]?.contents ?? "";
    expect(contents).toContain("{count} Karten übrig");
    expect(contents).toContain("%d Schaden verursacht");
  });

  it("keeps the source string when a translation failed, never a blank", () => {
    const contents = plan().files[0]?.contents ?? "";
    expect(contents).toContain("You are offline. Progress is saved locally.");
  });
});

describe("buildSyncPlan — validation", () => {
  it("rejects a traversing file name pattern", () => {
    expect(() =>
      buildSyncPlan(
        { ...TARGET, fileNamePattern: "../../.github/workflows/{locale}.json" },
        [german()],
        catalog,
        { timestamp: TIMESTAMP },
      ),
    ).toThrow(SyncPlanError);
  });

  it("rejects locales that collide on one path", () => {
    expect(() =>
      buildSyncPlan({ ...TARGET, fileNamePattern: "strings.json" }, [german(), japanese()], catalog, {
        timestamp: TIMESTAMP,
      }),
    ).toThrowError(/both map to/);
  });

  it("rejects an empty run", () => {
    expect(() => buildSyncPlan(TARGET, [], catalog, { timestamp: TIMESTAMP })).toThrowError(
      /no locale results/,
    );
  });

  it("rejects a missing timestamp rather than reaching for the clock", () => {
    expect(() =>
      buildSyncPlan(TARGET, [german()], catalog, { timestamp: Number.NaN }),
    ).toThrowError(/explicit timestamp/);
  });

  it("rejects an incomplete target", () => {
    expect(() =>
      buildSyncPlan({ ...TARGET, owner: "  " }, [german()], catalog, {
        timestamp: TIMESTAMP,
      }),
    ).toThrowError(/missing owner/);
  });
});

describe("branch naming", () => {
  it("is deterministic for identical inputs", () => {
    expect(plan().branchName).toBe(plan().branchName);
  });

  it("changes when the timestamp changes", () => {
    expect(plan().branchName).not.toBe(plan({ timestamp: TIMESTAMP + 60_000 }).branchName);
  });

  it("changes when the source content changes", () => {
    const other = makeCatalog("en.json");
    other.tree = { app: { title: "Deck Forge II" } };
    const a = buildSyncPlan(TARGET, [german()], catalog, { timestamp: TIMESTAMP });
    const b = buildSyncPlan(TARGET, [german()], other, { timestamp: TIMESTAMP });
    expect(a.branchName).not.toBe(b.branchName);
  });

  it("changes when the locale set changes", () => {
    const a = buildSyncPlan(TARGET, [german()], catalog, { timestamp: TIMESTAMP });
    const b = buildSyncPlan(TARGET, [german(), japanese()], catalog, {
      timestamp: TIMESTAMP,
    });
    expect(a.branchName).not.toBe(b.branchName);
  });

  it("names the locales, sorted and UTC-stamped", () => {
    expect(plan().branchName).toMatch(/^lingoloop\/20260730-1432-de-ja-[0-9a-f]{10}$/);
  });

  it("collapses long locale lists", () => {
    const name = buildBranchName({
      prefix: "lingoloop",
      locales: ["ja", "de", "fr", "es", "pt-BR"],
      timestamp: TIMESTAMP,
      fingerprint: "0123456789",
    });
    expect(name).toBe("lingoloop/20260730-1432-5-locales-0123456789");
  });

  it("ignores duplicate locales and input order", () => {
    const base = { prefix: "x", timestamp: TIMESTAMP, fingerprint: "abc" };
    expect(buildBranchName({ ...base, locales: ["ja", "de", "de"] })).toBe(
      buildBranchName({ ...base, locales: ["de", "ja"] }),
    );
  });

  it("produces a name git will accept", () => {
    const name = buildBranchName({
      prefix: "Feature Branches/../.lock",
      locales: ["pt-BR"],
      timestamp: TIMESTAMP,
      fingerprint: "0123456789",
    });
    expect(name).not.toMatch(/[ ~^:?*[\\]/);
    expect(name).not.toContain("..");
    expect(name.endsWith(".lock")).toBe(false);
    expect(name.startsWith("/")).toBe(false);
    expect(name.endsWith("/")).toBe(false);
  });

  it("falls back to the default prefix when sanitising empties it", () => {
    expect(
      buildBranchName({
        prefix: "///",
        locales: ["de"],
        timestamp: TIMESTAMP,
        fingerprint: "abcdef0123",
      }),
    ).toMatch(/^lingoloop\//);
  });

  it("sanitises ref components", () => {
    expect(sanitizeRefComponent("My Team/Feature")).toBe("my-team/feature");
    expect(sanitizeRefComponent("a..b")).toBe("a.b");
  });
});

describe("commit message", () => {
  it("summarises the run per locale", () => {
    const message = plan().commitMessage;
    const [subject] = message.split("\n");
    expect(subject).toBe("i18n: translate 20 strings into de, ja");
    expect(message).toContain("Source: en.json");
    expect(message).toContain("public/locales/de.json");
    expect(message).toContain("1 failed");
    expect(message).toContain("shortened for layout");
  });

  it("keeps the subject within git's 72-character convention", () => {
    const many = ["de", "fr", "es", "it", "ja", "ko", "pt-BR", "nl", "pl", "tr"].map(
      (locale) => makeResult(catalog, locale, []),
    );
    const message = buildSyncPlan(TARGET, many, catalog, { timestamp: TIMESTAMP })
      .commitMessage;
    const subject = message.split("\n")[0] ?? "";
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).toContain("10 locales");
  });
});

describe("pull request copy", () => {
  it("titles the PR with locale names", () => {
    expect(plan().prTitle).toBe("i18n: German and Japanese translations for en.json");
  });

  it("collapses the title for many locales", () => {
    const many = ["de", "fr", "es", "it"].map((locale) => makeResult(catalog, locale, []));
    const title = buildSyncPlan(TARGET, many, catalog, { timestamp: TIMESTAMP }).prTitle;
    expect(title).toBe("i18n: 4 locale updates for en.json");
    expect(title.length).toBeLessThanOrEqual(72);
  });

  it("reports real per-locale counts in a table", () => {
    const body = plan().prBody;
    expect(body).toContain("| Locale | File | Strings | Passed | Flagged | Failed | Shortened | Avg. width |");
    expect(body).toContain("| German (de) | `public/locales/de.json` |");
    expect(body).toContain("| Japanese (ja) | `public/locales/ja.json` |");
  });

  it("states how many strings were shortened for overflow", () => {
    const report = buildSyncPlanDetailed(TARGET, [german(), japanese()], catalog, {
      timestamp: TIMESTAMP,
    });
    expect(report.totals.overflowRepaired).toBe(1);
    expect(report.totals.clipped).toBeGreaterThan(0);
    expect(report.plan.prBody).toContain(
      `- Re-translated to fit: **${report.totals.overflowRepaired}**`,
    );
    expect(report.plan.prBody).toContain(
      `- Clipped as a last resort: **${report.totals.clipped}**`,
    );
    expect(report.plan.prBody).toContain("No string in this PR exceeds its budget");
  });

  it("tables the worst remaining fit ratios, worst first, showing shipped text", () => {
    const report = buildSyncPlanDetailed(TARGET, [german(), japanese()], catalog, {
      timestamp: TIMESTAMP,
      maxFitRows: 3,
    });
    expect(report.worstFits.length).toBeGreaterThan(0);
    expect(report.worstFits.length).toBeLessThanOrEqual(3);
    const ratios = report.worstFits.map((row) => row.ratio);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);

    const worst = report.worstFits[0];
    expect(worst?.key).toBe("menu.load");
    expect(worst?.clipped).toBe(true);
    expect(worst?.shipped.length).toBeLessThan(worst?.target.length ?? 0);
    expect(report.plan.prBody).toContain("| Locale | Key | Source | Shipped | Width | Status |");
    expect(report.plan.prBody).toContain("clipped to fit");
  });

  it("says so plainly when nothing is tight", () => {
    const body = buildSyncPlan(TARGET, [makeResult(catalog, "de", [])], catalog, {
      timestamp: TIMESTAMP,
    }).prBody;
    expect(body).toContain("fits its budget");
  });

  it("lists the strings that need a human, with the reason", () => {
    const body = plan().prBody;
    expect(body).toContain("## Needs a human");
    expect(body).toContain("`errors.offline`");
    expect(body).toContain("Provider returned no translation for this key");
  });

  it("counts validation findings by code and severity", () => {
    expect(plan().prBody).toContain("| `provider-error` | error | 1 |");
  });

  it("warns loudly when layout enforcement is off", () => {
    const body = plan({ enforceLayout: false }).prBody;
    expect(body).toContain("Layout enforcement was **disabled**");
    expect(body).not.toContain("No string in this PR exceeds its budget");
  });

  it("threads the run's register, product context and engine through", () => {
    const body = plan({
      tone: "gaming",
      productContext: "roguelike deckbuilder",
      providerLabel: "Claude (claude-sonnet-4-5)",
      reviewUrl: "https://lingoloop.dev/jobs/42",
    }).prBody;
    expect(body).toContain("**Register:** `gaming`");
    expect(body).toContain("roguelike deckbuilder");
    expect(body).toContain("Claude (claude-sonnet-4-5)");
    expect(body).toContain("[Open this run in LingoLoop](https://lingoloop.dev/jobs/42)");
  });

  it("escapes markdown table syntax coming from string content", () => {
    const result = makeResult(catalog, "de", [
      { key: "menu.save", target: "Spei|chern `now`" },
      { key: "app.subtitle", target: "Zeile eins\nZeile zwei ist deutlich zu lang für den Platz" },
    ]);
    const body = buildSyncPlan(TARGET, [result], catalog, { timestamp: TIMESTAMP }).prBody;
    for (const line of body.split("\n")) {
      if (!line.startsWith("|")) continue;
      // Every unescaped pipe is a column separator; the count must stay stable.
      const columns = line.split(/(?<!\\)\|/).length;
      expect(columns).toBeGreaterThan(1);
    }
    expect(body).not.toContain("Spei|chern");
  });

  it("never exceeds the body length a pull request can hold", () => {
    const body = plan({ maxBodyLength: 900 }).prBody;
    expect(body.length).toBeLessThanOrEqual(900);
    expect(body).toContain("Truncated");
    // The cut lands on a line boundary, so no half-written table row ships.
    expect(body.split("\n").at(-1)).not.toMatch(/^\|.*[^|]$/);
  });

  it("gives the reviewer a checklist and the structural guarantees", () => {
    const body = plan().prBody;
    expect(body).toContain("## Review checklist");
    expect(body).toContain("- [ ] ");
    expect(body).toContain("same keys, nesting, array lengths");
    expect(body).toContain("Placeholders");
  });
});

describe("buildSyncPlanDetailed", () => {
  it("reports per-file bytes, stats and fingerprint", () => {
    const report = buildSyncPlanDetailed(TARGET, [german(), japanese()], catalog, {
      timestamp: TIMESTAMP,
    });
    expect(report.files).toHaveLength(2);
    expect(report.files[0]?.localeName).toBe("German");
    expect(report.files[0]?.bytes).toBeGreaterThan(0);
    expect(report.fingerprint).toMatch(/^[0-9a-f]{10}$/);
    expect(report.totals.strings).toBe(20);
    expect(report.totals.failed).toBe(1);
    expect(report.plan.branchName).toContain(report.fingerprint);
  });
});
