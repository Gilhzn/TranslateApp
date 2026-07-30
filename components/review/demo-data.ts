/**
 * Realistic demo data for the standalone review preview (`/preview/review`)
 * and for the tests that exercise the review surface.
 *
 * This is NOT a mock of the pipeline: it runs the real one. The catalog is
 * parsed with `parseSourceFile`, budgets come from `planLength`, translations
 * from the engine's deterministic offline provider, and every entry goes
 * through `applyMechanicalFixes` → `evaluateFit` → `validateTranslation` →
 * repair → `resolveFinalStatus`, exactly as the API route does. The mix of
 * passed, flagged and failed rows the table shows is therefore emergent —
 * German really does overflow those buttons — rather than hand-written.
 *
 * The single exception is `INJECTED_SLIPS`: a small, deterministic set of
 * simulated model mistakes (a dropped placeholder, an invented one, a control
 * character). The offline provider is too well-behaved to produce them, and a
 * review surface that has never rendered a placeholder failure has not been
 * reviewed. Every injection is marked in `slipKeys` so nothing pretends to be
 * an honest pipeline result.
 */

import { parseSourceFile, type ParsedCatalog } from "@/lib/core";
import {
  hash32,
  resolveGlossary,
  simulateTranslation,
  type GlossaryLine,
} from "@/lib/engine";
import { evaluateFit, getLocaleProfile, planLength } from "@/lib/layout";
import {
  applyMechanicalFixes,
  budgetExhaustedIssue,
  buildRepairFeedback,
  needsRepair,
  resolveFinalStatus,
  validateTranslation,
  type ValidationContext,
} from "@/lib/validate";
import type {
  GlossaryTerm,
  Issue,
  LocaleCode,
  LocaleResult,
  StringEntry,
  TranslatedEntry,
  TranslationSettings,
  TranslationUnit,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * `en.json` for "Emberfall", a roguelike deckbuilder with a companion web
 * dashboard — chosen because it exercises everything the review table has to
 * survive: single-word buttons with almost no headroom, ICU and printf
 * placeholders, markup tags, ambiguous verbs ("Save", "Run", "Right", "min"),
 * developer notes, arrays of card objects, non-string leaves, do-not-translate
 * values, and body copy that wraps.
 *
 * Kept as raw text rather than an object literal so the parser sees real
 * formatting: four-space indentation and a trailing newline, both of which the
 * export must give back byte-for-byte.
 */
export const DEMO_SOURCE = `{
    "meta": {
        "_comment": "Emberfall — roguelike deckbuilder. Casual, punchy, community voice. Never translate card codenames.",
        "gameTitle": "Emberfall",
        "version": "1.4.2",
        "build": 42117,
        "betaChannel": true,
        "supportUrl": "https://emberfall.gg/support",
        "discord": "https://discord.gg/emberfall"
    },
    "menu": {
        "_context": "Main menu. Fixed 180px button column — keep these short.",
        "play": "Play",
        "continueRun": "Continue Run",
        "newRun": "New Run",
        "dailyChallenge": "Daily Challenge",
        "collection": "Collection",
        "achievements": "Achievements",
        "settings": "Settings",
        "credits": "Credits",
        "quitToDesktop": "Quit to Desktop"
    },
    "hud": {
        "_context": "In-run HUD. Extremely tight — 64px per stat.",
        "hp": "HP",
        "mp": "MP",
        "xp": "XP",
        "floorLabel": "Floor {n}",
        "goldLabel": "{amount} Gold",
        "deckCount": "{count} cards left",
        "comboMeter": "Combo x{multiplier}",
        "turnCounter": "Turn {turn}/{total}",
        "run": "Run",
        "save": "Save",
        "saving": "Saving…",
        "saved": "Saved",
        "autosaveOn": "Autosave on"
    },
    "actions": {
        "endTurn": "End Turn",
        "discard": "Discard",
        "draw": "Draw",
        "flee": "Flee",
        "use": "Use",
        "equip": "Equip",
        "sell": "Sell",
        "upgrade": "Upgrade",
        "right": "Right",
        "left": "Left"
    },
    "cards": [
        {
            "id": "strike",
            "name": "Strike",
            "rarity": "Common",
            "description": "Deal {damage} damage to a single enemy.",
            "flavor": "Simple. Reliable. Boring.",
            "cost": 1
        },
        {
            "id": "emberburst",
            "name": "Emberburst",
            "rarity": "Rare",
            "description": "Deal {damage} damage to all enemies and apply <b>Burn</b> for {turns} turns.",
            "flavor": "The floor remembers what you did last winter.",
            "cost": 2
        },
        {
            "id": "second_wind",
            "name": "Second Wind",
            "rarity": "Epic",
            "description": "Heal {amount} HP. If your deck is empty, draw {count} cards instead.",
            "flavor": "Breathe. Again. Harder.",
            "cost": 3
        },
        {
            "id": "ash_ward",
            "name": "Ash Ward",
            "rarity": "Legendary",
            "description": "Gain {block} Block. Whenever you take damage this turn, deal {thorns} back.",
            "flavor": "Cinders make a fine wall if you stack them angrily enough.",
            "cost": 4
        }
    ],
    "toast": {
        "runSaved": "Run saved",
        "cardAdded": "{card} added to your deck",
        "levelUp": "Level {level} reached!",
        "achievementUnlocked": "Achievement unlocked: {name}",
        "connectionLost": "Connection lost — playing offline"
    },
    "errors": {
        "saveFailed": {
            "title": "Couldn't save your run",
            "body": "We hit a snag writing your save file. Your last checkpoint at floor {n} is safe. Try again, and if it keeps happening, grab the log from Settings → Support and send it our way.",
            "retry": "Retry",
            "dismiss": "Not now"
        },
        "networkTimeout": {
            "title": "Server didn't answer",
            "body": "The daily challenge needs a connection. You can keep playing offline — your run syncs the moment we can reach the server again.",
            "retry": "Try again",
            "dismiss": "Play offline"
        }
    },
    "settings": {
        "_context": "Settings panel. Labels sit in a 140px left column.",
        "audio": "Audio",
        "masterVolume": "Master Volume",
        "musicVolume": "Music",
        "sfxVolume": "Effects",
        "graphics": "Graphics",
        "fullscreen": "Fullscreen",
        "vsync": "V-Sync",
        "resolution": "Resolution",
        "gameplay": "Gameplay",
        "difficulty": "Difficulty",
        "screenShake": "Screen Shake",
        "language": "Language",
        "resetDefaults": "Reset to Defaults",
        "minLabel": "min",
        "maxLabel": "max",
        "autosaveEvery": "Autosave every {minutes} min",
        "confirmReset": "This resets every setting to its default. Your saves and unlocks are untouched."
    },
    "dashboard": {
        "_context": "Companion web dashboard. Developer-facing, technical register.",
        "overview": "Overview",
        "runs": "Runs",
        "branches": "Branches",
        "commit": "Commit",
        "cache": "Cache",
        "deploy": "Deploy",
        "rollback": "Rollback",
        "buildLog": "Build Log",
        "apiKeys": "API Keys",
        "webhookUrl": "Webhook URL",
        "lastRun": "Last run %s ago",
        "runsThisWeek": "%d runs this week",
        "seatsUsed": "{used} of {total} seats used",
        "emptyRuns": "No runs yet. Push a build and it'll show up here within a few seconds.",
        "deleteWarning": "Deleting <b>{project}</b> removes every run, log and artifact. This cannot be undone."
    },
    "onboarding": {
        "welcomeTitle": "Welcome to Emberfall",
        "welcomeBody": "You get one deck, one run, and as many mistakes as you can survive. Cards you pick up stay with you until the floor takes them back.",
        "stepOne": "Pick a starting relic",
        "stepTwo": "Clear the first floor",
        "stepThree": "Beat the Ember Warden",
        "skip": "Skip",
        "next": "Next",
        "back": "Back",
        "done": "Let's go"
    },
    "store": {
        "title": "Supporter Pack",
        "price": "$9.99",
        "cta": "Get the pack",
        "perkOne": "Two extra starting relics",
        "perkTwo": "Alternate card art for {count} cards",
        "perkThree": "Name in the credits, forever",
        "restore": "Restore purchase",
        "legal": "Prices shown in USD and may vary by region. Payment is handled by the platform store."
    }
}
`;

export const DEMO_GLOSSARY: GlossaryTerm[] = [
  {
    term: "Emberfall",
    translations: {},
    caseSensitive: true,
    note: "Product name — never translate.",
  },
  {
    term: "Ember Warden",
    translations: {},
    caseSensitive: true,
    note: "Boss name — never translate.",
  },
  {
    term: "Block",
    translations: { de: "Block", fr: "Blocage", "pt-BR": "Bloqueio" },
    caseSensitive: true,
    note: "Game mechanic, not a verb.",
  },
];

export const DEMO_LOCALES: readonly LocaleCode[] = Object.freeze([
  "de",
  "fr",
  "pt-BR",
  "ja",
  "ar",
  "ru",
]);

export const DEMO_SETTINGS: TranslationSettings = {
  sourceLocale: "en",
  targetLocales: [...DEMO_LOCALES],
  tone: "gaming",
  productContext:
    "Emberfall — a roguelike deckbuilder with a companion web dashboard for build analytics. Punchy, warm, second person.",
  glossary: DEMO_GLOSSARY,
  enforceLayout: true,
  maxRepairAttempts: 1,
};

// ---------------------------------------------------------------------------
// Simulated model slips
// ---------------------------------------------------------------------------

type SlipKind =
  | "drop-placeholder"
  | "invent-placeholder"
  | "control-character"
  | "verbose";

/**
 * Deterministic mistakes injected into the offline provider's output so the
 * review surface renders the failure modes it exists to catch. Keyed by locale
 * so each one shows up exactly once in the table.
 */
const INJECTED_SLIPS: ReadonlyArray<{
  locale: LocaleCode;
  key: string;
  kind: SlipKind;
}> = Object.freeze([
  { locale: "de", key: "hud.deckCount", kind: "drop-placeholder" },
  { locale: "fr", key: "toast.cardAdded", kind: "drop-placeholder" },
  { locale: "ja", key: "dashboard.seatsUsed", kind: "invent-placeholder" },
  { locale: "ar", key: "hud.turnCounter", kind: "drop-placeholder" },
  { locale: "ru", key: "dashboard.lastRun", kind: "invent-placeholder" },
  { locale: "pt-BR", key: "toast.levelUp", kind: "drop-placeholder" },
  // The mechanical fixer strips this one for free before validation ever runs —
  // which is the point: the free repairs happen without spending a model call.
  { locale: "ja", key: "toast.runSaved", kind: "control-character" },

  // Verbose renderings that survive the repair budget. Expansion-heavy locales
  // on the tightest roles is exactly where a real model runs out of room, and
  // the review table has to render a red, still-overflowing row.
  { locale: "de", key: "menu.dailyChallenge", kind: "verbose" },
  { locale: "de", key: "menu.quitToDesktop", kind: "verbose" },
  { locale: "de", key: "actions.endTurn", kind: "verbose" },
  { locale: "de", key: "settings.resetDefaults", kind: "verbose" },
  { locale: "ru", key: "hud.autosaveOn", kind: "verbose" },
  { locale: "ru", key: "menu.achievements", kind: "verbose" },
  { locale: "fr", key: "dashboard.rollback", kind: "verbose" },
  { locale: "pt-BR", key: "onboarding.stepThree", kind: "verbose" },
  { locale: "ar", key: "store.cta", kind: "verbose" },
]);

/**
 * Padding used by the `verbose` slip, per locale, so the over-long string is
 * still plausible copy in that script rather than Latin filler.
 */
const VERBOSE_PADDING: Readonly<Record<string, string>> = Object.freeze({
  de: " und alle zugehörigen Einstellungen",
  fr: " et toutes les options associées",
  "pt-BR": " e todas as configurações relacionadas",
  ru: " и все связанные настройки",
  ja: "とすべての関連設定",
  ar: " وجميع الإعدادات المرتبطة",
});

function applySlip(
  kind: SlipKind,
  target: string,
  entry: StringEntry,
  locale: LocaleCode,
): string {
  switch (kind) {
    case "drop-placeholder": {
      const first = entry.placeholders[0];
      return first === undefined
        ? target
        : target.replace(first.raw, "").replace(/\s{2,}/g, " ").trim();
    }
    case "invent-placeholder":
      return `${target} {extra}`;
    case "control-character":
      // A stray vertical tab — exactly what a copy-paste out of a spreadsheet
      // leaves behind, and invisible until it breaks a renderer.
      return `${target}\u000B`;
    case "verbose":
      return `${target}${VERBOSE_PADDING[locale] ?? " and everything attached to it"}`;
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface DemoJob {
  catalog: ParsedCatalog;
  settings: TranslationSettings;
  results: LocaleResult[];
  /** `locale::key` of every deliberately corrupted entry. */
  slipKeys: ReadonlySet<string>;
}

export interface DemoOptions {
  locales?: readonly LocaleCode[];
  /** Changes every simulated translation deterministically. */
  seed?: string;
  source?: string;
  /** Skip the injected model slips — used by tests that want a clean run. */
  injectSlips?: boolean;
}

function unitFor(
  entry: StringEntry,
  locale: ReturnType<typeof getLocaleProfile>,
  neighbors: string[],
): TranslationUnit {
  const plan = planLength(entry.value, entry.role, locale);
  const unit: TranslationUnit = {
    key: entry.key,
    source: entry.value,
    role: entry.role,
    placeholders: entry.placeholders,
    ambiguities: entry.ambiguities,
    budget: plan.budget,
    allowedWidth: plan.allowedWidth,
    neighbors,
  };
  if (entry.developerNote !== undefined) unit.developerNote = entry.developerNote;
  return unit;
}

function neighborIndex(entries: readonly StringEntry[]): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const entry of entries) {
    const cut = Math.max(entry.key.lastIndexOf("."), entry.key.lastIndexOf("["));
    const parent = cut === -1 ? "" : entry.key.slice(0, cut);
    const bucket = byParent.get(parent);
    if (bucket === undefined) byParent.set(parent, [entry.key]);
    else bucket.push(entry.key);
  }

  const out = new Map<string, string[]>();
  for (const entry of entries) {
    const cut = Math.max(entry.key.lastIndexOf("."), entry.key.lastIndexOf("["));
    const parent = cut === -1 ? "" : entry.key.slice(0, cut);
    const siblings = byParent.get(parent) ?? [];
    out.set(
      entry.key,
      siblings.filter((k) => k !== entry.key).slice(0, 6),
    );
  }
  return out;
}

/**
 * Run the real translate → validate → repair loop for one locale.
 */
function translateLocale(
  catalog: ParsedCatalog,
  locale: LocaleCode,
  glossary: readonly GlossaryLine[],
  neighbors: Map<string, string[]>,
  seed: string,
  maxRepairAttempts: number,
  slips: Map<string, SlipKind>,
): LocaleResult {
  const profile = getLocaleProfile(locale);
  const entries: TranslatedEntry[] = [];
  let overflowRepaired = 0;
  let ratioSum = 0;
  let ratioCount = 0;

  for (const entry of catalog.entries) {
    const unit = unitFor(entry, profile, neighbors.get(entry.key) ?? []);
    const context: ValidationContext = {
      key: entry.key,
      role: entry.role,
      locale,
      sourceLocale: catalog.sourceLocale,
      doNotTranslate: entry.doNotTranslate,
      ambiguities: entry.ambiguities,
      sourcePlaceholders: entry.placeholders,
    };

    const slip = slips.get(`${locale}::${entry.key}`);
    // A slipping model slips consistently: the same mistake comes back on the
    // repair pass, which is what makes the entry end up genuinely failed
    // instead of quietly fixed before anyone sees it.
    const withSlip = (candidate: string): string =>
      slip === undefined ? candidate : applySlip(slip, candidate, entry, locale);

    const first = simulateTranslation(unit, { profile, glossary, seed });

    let target = applyMechanicalFixes(entry.value, withSlip(first.target)).text;
    let fit = evaluateFit(entry.value, target, entry.role, profile);
    let issues = validateTranslation(entry.value, target, fit, context);
    let attempts = 1;
    let rationale = first.rationale;
    const startedOverflowing = fit.verdict === "overflow";

    while (needsRepair(issues, fit) && attempts <= maxRepairAttempts) {
      const repairUnit: TranslationUnit = {
        ...unit,
        previousAttempt: target,
        repairFeedback: buildRepairFeedback(unit, target, issues, fit),
      };
      const repaired = simulateTranslation(repairUnit, {
        profile,
        glossary,
        seed,
      });
      target = applyMechanicalFixes(entry.value, withSlip(repaired.target)).text;
      fit = evaluateFit(entry.value, target, entry.role, profile);
      issues = validateTranslation(entry.value, target, fit, context);
      attempts += 1;
      rationale = repaired.rationale ?? rationale;
    }

    if (needsRepair(issues, fit)) {
      issues = [
        ...issues,
        budgetExhaustedIssue(entry.key, attempts, maxRepairAttempts),
      ];
    } else if (startedOverflowing && attempts > 1) {
      overflowRepaired += 1;
    }

    const translated: TranslatedEntry = {
      key: entry.key,
      path: entry.path,
      source: entry.value,
      target,
      locale,
      status: resolveFinalStatus(issues, fit),
      issues,
      fit,
      attempts,
    };
    if (rationale !== undefined) translated.rationale = rationale;
    entries.push(translated);

    ratioSum += fit.ratio;
    ratioCount += 1;
  }

  let passed = 0;
  let flagged = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.status === "passed") passed += 1;
    else if (entry.status === "flagged") flagged += 1;
    else if (entry.status === "failed") failed += 1;
  }

  return {
    locale,
    // The review surface rebuilds the tree from the (possibly edited) rows at
    // export time, so this is the as-translated snapshot only.
    tree: catalog.tree,
    entries,
    issues: [],
    stats: {
      total: entries.length,
      passed,
      flagged,
      failed,
      overflowRepaired,
      averageRatio:
        ratioCount === 0 ? 0 : Math.round((ratioSum / ratioCount) * 1000) / 1000,
    },
  };
}

/**
 * Build the whole demo job. Deterministic for a given seed — the preview route
 * renders the same table on every reload, which is what makes it reviewable.
 */
export function buildDemoJob(options: DemoOptions = {}): DemoJob {
  const locales = options.locales ?? DEMO_LOCALES;
  const seed = options.seed ?? "lingoloop-preview";
  const catalog = parseSourceFile("en.json", options.source ?? DEMO_SOURCE, {
    sourceLocale: "en",
  });
  const neighbors = neighborIndex(catalog.entries);

  const injectSlips = options.injectSlips ?? true;
  const slips = new Map<string, SlipKind>();
  if (injectSlips) {
    for (const slip of INJECTED_SLIPS) {
      if (locales.includes(slip.locale)) {
        slips.set(`${slip.locale}::${slip.key}`, slip.kind);
      }
    }
  }

  const results = locales.map((locale) =>
    translateLocale(
      catalog,
      locale,
      resolveGlossary(DEMO_GLOSSARY, getLocaleProfile(locale)),
      neighbors,
      // Salting per locale keeps `hash32` from producing the same word shapes
      // in every language, which would look obviously synthetic.
      `${seed}:${hash32(locale)}`,
      DEMO_SETTINGS.maxRepairAttempts,
      slips,
    ),
  );

  return {
    catalog,
    settings: { ...DEMO_SETTINGS, targetLocales: [...locales] },
    results,
    slipKeys: new Set(slips.keys()),
  };
}

/** Roll-up used by the preview header. */
export function summarizeJob(results: readonly LocaleResult[]): {
  total: number;
  passed: number;
  flagged: number;
  failed: number;
} {
  let total = 0;
  let passed = 0;
  let flagged = 0;
  let failed = 0;
  for (const result of results) {
    total += result.stats.total;
    passed += result.stats.passed;
    flagged += result.stats.flagged;
    failed += result.stats.failed;
  }
  return { total, passed, flagged, failed };
}

/** Aggregate issue collected across every locale — used by the preview banner. */
export function jobIssues(results: readonly LocaleResult[]): Issue[] {
  return results.flatMap((r) => r.issues);
}
