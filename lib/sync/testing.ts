/**
 * Fixtures for the sync tests.
 *
 * Not exported from the barrel: this is test scaffolding, not product surface.
 * The catalog goes through the real parser and the fits through the real layout
 * engine, so a test that passes here would also pass against a genuine run.
 */

import { parseSourceFile, type ParsedCatalog } from "@/lib/core";
import { evaluateFit, getLocaleProfile } from "@/lib/layout";
import { rebuildTree } from "@/lib/core";
import type {
  EntryStatus,
  Issue,
  LocaleCode,
  LocaleResult,
  TranslatedEntry,
  UiRole,
} from "@/lib/types";

export const SOURCE_JSON = `{
  "app": {
    "title": "Deck Forge",
    "subtitle": "Build a run, break the meta"
  },
  "menu": {
    "save": "Save",
    "load": "Load run",
    "settings": "Settings"
  },
  "hud": {
    "cardsLeft": "{count} cards left",
    "damage": "Dealt %d damage"
  },
  "errors": {
    "offline": "You are offline. Progress is saved locally."
  },
  "meta": {
    "version": 3,
    "tags": ["roguelike", "deckbuilder"]
  }
}
`;

export function makeCatalog(fileName = "en.json"): ParsedCatalog {
  return parseSourceFile(fileName, SOURCE_JSON);
}

interface EntrySpec {
  key: string;
  target: string;
  role?: UiRole;
  status?: EntryStatus;
  attempts?: number;
  issues?: Issue[];
}

/**
 * Build a `LocaleResult` for a catalog, with real fits computed by the layout
 * engine. Keys not listed keep their source string and pass.
 */
export function makeResult(
  catalog: ParsedCatalog,
  locale: LocaleCode,
  specs: readonly EntrySpec[],
): LocaleResult {
  const profile = getLocaleProfile(locale);
  const overrides = new Map(specs.map((spec) => [spec.key, spec]));
  const entries: TranslatedEntry[] = [];
  const translations = new Map<string, string>();

  let passed = 0;
  let flagged = 0;
  let failed = 0;
  let overflowRepaired = 0;
  let ratioSum = 0;

  for (const source of catalog.entries) {
    const spec = overrides.get(source.key);
    const target = spec?.target ?? source.value;
    const role: UiRole = spec?.role ?? source.role;
    const fit = evaluateFit(source.value, target, role, profile);
    const status: EntryStatus =
      spec?.status ?? (fit.verdict === "overflow" ? "flagged" : "passed");
    const attempts = spec?.attempts ?? 1;

    if (status === "passed") passed += 1;
    else if (status === "failed") failed += 1;
    else flagged += 1;
    if (attempts > 1) overflowRepaired += 1;
    ratioSum += fit.ratio;

    translations.set(source.key, target);
    entries.push({
      key: source.key,
      path: source.path,
      source: source.value,
      target,
      locale,
      status,
      issues: spec?.issues ?? [],
      fit,
      attempts,
    });
  }

  return {
    locale,
    entries,
    tree: rebuildTree(catalog.tree, translations, catalog.keyOrder),
    issues: [],
    stats: {
      total: entries.length,
      passed,
      flagged,
      failed,
      overflowRepaired,
      averageRatio: entries.length === 0 ? 1 : ratioSum / entries.length,
    },
  };
}

/** A minimal `Response` for adapter tests; no network, no undici. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
