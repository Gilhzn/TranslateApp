/**
 * Prompt construction.
 *
 * This module is the product. Everything else in `lib/engine` moves bytes
 * around; the text built here is what decides whether the output is a real
 * localisation or a dictionary lookup with the shape of one.
 *
 * Four disciplines are stated explicitly, in this order, because they are the
 * four ways machine translation breaks a shipped UI:
 *
 *   1. LENGTH       - the string is correct and the button is destroyed.
 *   2. PLACEHOLDERS - the string is correct and the app throws at runtime.
 *   3. AMBIGUITY    - the string is a correct translation of a different word.
 *   4. REGISTER     - the string is correct and the product sounds like a bank.
 *
 * The prompt is assembled deterministically: same request in, same bytes out.
 * That matters for prompt caching (a stable prefix is a cheap prefix) and for
 * being able to diff two prompts when a translation comes back wrong.
 */

import { describeBudgetForPrompt } from "@/lib/layout";
import type {
  GlossaryTerm,
  LocaleProfile,
  Placeholder,
  PlaceholderKind,
  ProviderRequest,
  ToneProfile,
  TranslationUnit,
  UiRole,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

export interface ToneSpec {
  /** Human label, also used by the UI. */
  label: string;
  /** One-line summary of the voice. */
  summary: string;
  /** Concrete, imperative register rules injected into the system prompt. */
  rules: readonly string[];
}

/**
 * Register guidance per tone.
 *
 * "gaming" and "technical-developer" carry the most text because they are the
 * two registers a general-purpose model reliably destroys: it flattens slang
 * into customer-service English, and it calques loanwords that the target
 * locale's own professionals never translate. Both failures look like careful
 * translation and read like a machine.
 */
export const TONE_SPECS: Readonly<Record<ToneProfile, ToneSpec>> = Object.freeze(
  {
    "neutral-product": {
      label: "Neutral product",
      summary: "The plain, confident voice of a well-run SaaS product.",
      rules: [
        "Clear over clever, short over complete. Say the thing and stop.",
        "Address the user in the second person, at whatever politeness level consumer software actually uses in this locale.",
        "Do not add courtesy formulas, hedges, or explanations the source does not have. If the source says \"Deleted\", the translation says \"Deleted\" — not \"The item has been successfully deleted\".",
      ],
    },
    "casual-indie": {
      label: "Casual indie",
      summary: "A small team talking to its users like people.",
      rules: [
        "Contractions are expected. First person plural (\"we\") where the source uses it.",
        "Use the informal second person in locales that distinguish it (du / tu / tú / ты / 너).",
        "Keep the shrug. \"Oops, that didn't work\" is a shrug, not an incident report — do not upgrade it to \"An unexpected error has occurred\".",
        "Light humour in the source stays humour in the target. If a joke does not survive the language, replace it with a joke that does, at the same length.",
      ],
    },
    gaming: {
      label: "Gaming",
      summary: "The voice of a game the player already likes.",
      rules: [
        "Slang, contractions, interjections and community vocabulary are LICENSED here. Write the words the target-language player community actually types in Discord and reads in shipped games — not the words a dictionary offers.",
        "Keep the community's own borrowed terms. Player communities in most languages keep English gaming vocabulary (loot, buff, nerf, boss, quest, co-op, DPS, HP, spawn, grind) even where a native word exists. If the community says the English word, use the English word.",
        "FORBIDDEN: corporate-neutral flattening. \"You died!\" does not become \"The player character has been eliminated.\" \"Nice!\" does not become \"Operation completed successfully.\" Raising the register \"to be safe\" is a WRONG translation here, not a conservative one.",
        "Use the informal second person unless this locale's own game convention is genuinely formal.",
        "Keep exclamation marks, ellipses, capitals and onomatopoeia when the source has them — they are carrying the tone, not decorating it.",
      ],
    },
    "technical-developer": {
      label: "Technical / developer",
      summary: "Documentation and tooling written for working developers.",
      rules: [
        "Register: precise, dense, unceremonious. The reader is a professional and is in a hurry.",
        "LOANWORD RETENTION — the single most common failure in developer localisation. Established English terms of art that developers in this locale use in daily speech STAY IN ENGLISH, inflected by the target language's grammar rather than replaced by a native calque. German developers say \"Branch\", \"Commit\", \"Merge\", \"Repository\", \"Pull Request\", \"Deployment\", \"Cache\" — never \"Zweig\", \"Übergabe\", \"Zusammenführung\", \"Ablage\", \"Zwischenspeicher\". The same holds everywhere: French developers say \"commit\" and \"build\"; Spanish developers say \"commit\" and \"deploy\"; Japanese developers write コミット and ブランチ.",
        "The test is usage, not availability. A native equivalent existing in the dictionary is not a reason to use it. If a working developer in this locale would not say the word out loud in a stand-up, it does not go in the UI.",
        "Translate everything around the term of art — the verbs, the connectives, the general vocabulary. Retention applies to the term, not to the sentence.",
        "Code identifiers, CLI flags, file names, HTTP verbs, status codes, config keys, environment variables and API nouns are not prose. Reproduce them exactly.",
        "Be direct. Do not add politeness the source does not have.",
      ],
    },
    "formal-enterprise": {
      label: "Formal enterprise",
      summary: "Formal business software, procured by a committee.",
      rules: [
        "Complete phrasing. No slang, and no contractions in locales where they read as informal.",
        "Use the formal second person consistently across the entire file (Sie / vous / usted / вы / 귀하). Mixing registers between two strings in the same screen is a defect.",
        "Prefer the established enterprise term over the colloquial one, and keep terminology identical between strings — the same source noun gets the same target noun everywhere.",
      ],
    },
  },
);

export function toneSpec(tone: ToneProfile): ToneSpec {
  return TONE_SPECS[tone];
}

// ---------------------------------------------------------------------------
// UI roles
// ---------------------------------------------------------------------------

/**
 * What each role *means*, as opposed to how wide it is (that lives in
 * `lib/layout`). This is the lever for quality bar #5: "Run" is an action on a
 * button and a verb in body copy, and the only signal that separates them is
 * the role.
 */
const ROLE_GUIDANCE: Readonly<Record<UiRole, string>> = Object.freeze({
  button:
    "a clickable control. Translate the label as the ACTION the user performs, in whatever form this locale's platform uses for buttons (German and French infinitive, Italian imperative, and so on). Never an abstract noun, never a status.",
  menu: "an item in a menu, tab bar or nav list. Follow this locale's platform menu conventions and keep it grammatically parallel with its siblings.",
  label:
    "a field label sitting beside an input. It names the value being entered — a noun phrase, not an action.",
  placeholder:
    "ghost text inside an empty input. It is a hint or an example of the value, not a command.",
  tooltip:
    "hover help. A short explanatory phrase; a full sentence is acceptable here.",
  title: "a screen, window or dialog title. Noun phrase, in this locale's title convention.",
  heading:
    "a section heading. Noun phrase, grammatically parallel with the other headings around it.",
  body: "running prose. Translate for readability, not word-by-word.",
  error:
    "an error message the user sees when something failed. State plainly what went wrong; do not blame the user; use this locale's standard error phrasing rather than a literal rendering of the English.",
  toast:
    "a transient notification. Usually a completed-action statement (\"Saved\", \"Copied\", \"Link sent\").",
  badge:
    "a tiny status pill. One or two words at the absolute maximum — use the shortest idiomatic form that exists, including an accepted abbreviation.",
  unknown:
    "role could not be determined. Infer it from the key path and the neighbouring keys; if it reads like a control, treat it as an action.",
});

export function roleGuidance(role: UiRole): string {
  return ROLE_GUIDANCE[role];
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

interface PlaceholderRule {
  label: string;
  example: string;
  /**
   * True when the token carries its own identity (a name or an explicit index)
   * and can therefore be moved to suit target grammar. Bare positional tokens
   * cannot: reordering `%s %s` silently swaps two runtime values.
   */
  reorderable: boolean;
  rule: string;
}

const PLACEHOLDER_RULES: Readonly<Record<PlaceholderKind, PlaceholderRule>> =
  Object.freeze({
    icu: {
      label: "ICU / named brace",
      example: "{count}",
      reorderable: true,
      rule: "The name inside the braces is an argument name from the source code. Never translate it, never re-space it, never change its case. If the token carries ICU plural or select syntax, keep the syntax and translate only the human-readable branches.",
    },
    printf: {
      label: "printf",
      example: "%s, %1$d",
      reorderable: false,
      rule: "A bare printf token (%s, %d, %.2f) has NO identity — its meaning is its position in the argument list. Reproduce bare printf tokens in exactly the source order. Only tokens with an explicit index (%1$s) may be reordered, and then the index must travel with the token unchanged. Never invent an index the source does not have.",
    },
    "dollar-brace": {
      label: "template literal",
      example: "${user}",
      reorderable: true,
      rule: "JavaScript template interpolation. Reproduce the `${` and `}` exactly, with no space inside.",
    },
    "double-brace": {
      label: "mustache / i18next",
      example: "{{user}}",
      reorderable: true,
      rule: "Both braces on both sides, no inner spaces. `{{ user }}` is a different token from `{{user}}` and will not resolve.",
    },
    "percent-named": {
      label: "named printf",
      example: "%(name)s",
      reorderable: true,
      rule: "Python-style named interpolation. The name and the trailing conversion letter are both part of the token.",
    },
    "angle-tag": {
      label: "markup tag",
      example: "<b>…</b>, <0>",
      reorderable: true,
      rule: "Markup, not text. Translate what is between the tags; never the tag name or a numeric tag index. Keep every opening tag paired with its closing tag and keep the nesting order intact.",
    },
    unreal: {
      label: "indexed brace",
      example: "{0}",
      reorderable: true,
      rule: "The number is an explicit argument index, so the token may move to suit target grammar — but the digits must not change.",
    },
    "i18next-nesting": {
      label: "string reference",
      example: "$t(key)",
      reorderable: true,
      rule: "A reference to another string in this catalog. The key inside the parentheses is machine data — reproduce it exactly and never translate it.",
    },
  });

export function placeholderRule(kind: PlaceholderKind): PlaceholderRule {
  return PLACEHOLDER_RULES[kind];
}

/** Placeholder kinds actually present in this batch, in a stable order. */
function kindsInRequest(units: readonly TranslationUnit[]): PlaceholderKind[] {
  const seen = new Set<PlaceholderKind>();
  for (const unit of units) {
    for (const placeholder of unit.placeholders) seen.add(placeholder.kind);
  }
  // Stable output order regardless of unit order, so the prompt prefix is
  // cacheable across batches that happen to sort differently.
  return (Object.keys(PLACEHOLDER_RULES) as PlaceholderKind[]).filter((kind) =>
    seen.has(kind),
  );
}

// ---------------------------------------------------------------------------
// Locale typography
// ---------------------------------------------------------------------------

/**
 * Per-language conventions that a model will otherwise carry over from English.
 * Keyed by primary language subtag; absent languages simply contribute nothing.
 */
const TYPOGRAPHY: Readonly<Record<string, string>> = Object.freeze({
  de: 'Quotation marks are „…“. Compound nouns are the main source of overflow — pick the shortest established compound, never invent a longer one.',
  fr: "Quotation marks are « … » with a no-break space inside, and a no-break space precedes ; : ! ? and %.",
  es: "Questions and exclamations open with ¿ and ¡ as well as closing with ? and !.",
  it: "Italian UI controls conventionally use the second-person imperative (\"Salva\", \"Annulla\").",
  nl: "Dutch UI controls conventionally use the infinitive (\"Opslaan\", \"Annuleren\").",
  ru: "Quotation marks are « ». Verbs on controls are infinitives (\"Сохранить\").",
  pl: "Case endings shift with the value a placeholder carries — prefer phrasings that stay grammatical for any inserted value.",
  cs: "Case endings shift with the value a placeholder carries — prefer phrasings that stay grammatical for any inserted value.",
  fi: "Finnish agglutinates: one long word often replaces an English phrase. Never hyphenate or clip it to fit — choose a different word.",
  hu: "Hungarian agglutinates: suffixes stack onto the stem. Never split a word to fit.",
  tr: "Turkish agglutinates: suffixes stack onto the stem. Mind the dotted/dotless i when case changes.",
  ja: "Use full-width punctuation (、。) and no inter-word spaces. Controls are usually a bare noun or noun+する (\"保存\"). Katakana loanwords are normal and expected for developer and gaming vocabulary.",
  zh: "Use full-width punctuation (，。) and no inter-word spaces. UI labels are conventionally two to four characters.",
  ko: "Korean spaces between eojeol, not between every word. Hangul transliterations of English technical terms are normal and expected.",
  th: "Thai has no inter-word spaces; a space is a phrase break, not a word break.",
  ar: "Arabic-Indic vs Western digits: keep whatever the source uses unless the placeholder supplies the number.",
  he: "Hebrew takes no capitalisation — do not try to reproduce English title case.",
  el: "Greek final sigma (ς) only at the end of a word; accents are not optional.",
  vi: "Vietnamese diacritics are letters, not decoration — a missing tone mark is a different word.",
});

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export interface GlossaryLine {
  term: string;
  /** Forced rendering for this locale, or `null` for "keep verbatim". */
  target: string | null;
  caseSensitive: boolean;
  note?: string;
}

/** Resolve the glossary against one locale. `target === null` means "keep verbatim". */
export function resolveGlossary(
  glossary: readonly GlossaryTerm[],
  locale: LocaleProfile,
): GlossaryLine[] {
  const lines: GlossaryLine[] = [];
  for (const term of glossary) {
    if (term.term.length === 0) continue;
    const target = lookupGlossaryTarget(term, locale.code);
    const line: GlossaryLine = {
      term: term.term,
      target,
      caseSensitive: term.caseSensitive,
    };
    if (term.note !== undefined && term.note.length > 0) line.note = term.note;
    lines.push(line);
  }
  return lines;
}

/**
 * Glossary lookup with the same fallback shape as locale resolution:
 * exact tag, then base language. `de-CH` inherits the `de` rendering unless it
 * overrides it, which is what a developer maintaining one glossary expects.
 */
export function lookupGlossaryTarget(
  term: GlossaryTerm,
  locale: string,
): string | null {
  const direct = term.translations[locale];
  if (direct !== undefined && direct.length > 0) return direct;
  const base = locale.split("-")[0];
  if (base !== undefined && base !== locale) {
    const fallback = term.translations[base];
    if (fallback !== undefined && fallback.length > 0) return fallback;
  }
  return null;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * The full instruction set. Deterministic for a given request: no timestamps,
 * no ids, no set iteration — the prefix is byte-stable so it caches.
 */
export function buildSystemPrompt(request: ProviderRequest): string {
  const { locale, sourceLocale, tone, productContext, glossary, units } =
    request;
  const spec = toneSpec(tone);
  const sections: string[] = [];

  // --- Role -------------------------------------------------------------
  sections.push(
    [
      "# Role",
      "",
      `You are a senior localisation engineer for indie games and developer tools. You have shipped software in ${locale.name}, you have watched your own translations break a layout, and you review other people's work for a living.`,
      "",
      `You are translating from ${sourceLocale} into ${locale.name} (${locale.nativeName}) [${locale.code}].`,
      "",
      "You are not a dictionary. You are localising an interface: every string you return has to fit a real component, keep a real runtime contract, and sound like the product it belongs to.",
    ].join("\n"),
  );

  // --- Product ----------------------------------------------------------
  const context = productContext.trim();
  sections.push(
    [
      "# The product",
      "",
      context.length > 0
        ? context
        : "(The developer did not describe the product. Infer what it is from the key names and the strings themselves, and stay consistent with that reading across the whole batch.)",
      "",
      "Everything below is a string from this product's UI. When a word is ambiguous, the product decides which reading is correct.",
    ].join("\n"),
  );

  // --- Register ---------------------------------------------------------
  sections.push(
    [
      `# Voice and register — ${spec.label}`,
      "",
      spec.summary,
      "",
      ...spec.rules.map((rule) => `- ${rule}`),
      "",
      "Register is a correctness property here, not a preference. A translation that is accurate but in the wrong register is a defect and will be rejected.",
    ].join("\n"),
  );

  // --- Length -----------------------------------------------------------
  sections.push(
    [
      "# Length discipline (hard constraint)",
      "",
      "Every unit below carries a character budget. That budget is not advice: the UI has fixed-width chrome — buttons, badges, menu tracks, table columns, input fields — that does not grow to fit its contents. A translation that exceeds its budget clips, overlaps its neighbour, or reflows the row it lives in. The product is visibly broken and the translation is wrong, however accurate it is.",
      "",
      "So: a SHORTER natural equivalent always beats a longer accurate one.",
      "",
      "- Prefer a different, shorter word. Every language has more than one way to say \"settings\", \"remove\", \"try again\".",
      "- Prefer an abbreviation that is genuinely idiomatic in this locale's UIs over a full phrase that does not fit. Use only abbreviations a native user would recognise instantly.",
      "- Drop redundancy the source only has because English is cheap: articles, \"please\", restating the object, \"successfully\".",
      "- NEVER truncate mid-word.",
      "- NEVER add an ellipsis (…) to force a fit. An ellipsis in a translation means \"more is coming\", and adding one where the source has none is a bug.",
      "- NEVER pad a short translation to look more like the English. Shorter than the budget is always fine.",
      "",
      `${locale.name} averages about ${formatPercent(locale.expansion)} the length of English for short UI strings${describeGlyphWidth(locale)}. Expect to fight for room and plan for it from the first word, rather than translating freely and hoping.`,
    ].join("\n"),
  );

  // --- Placeholders -----------------------------------------------------
  const kinds = kindsInRequest(units);
  const placeholderLines: string[] = [
    "# Placeholder discipline (hard constraint)",
    "",
    "Placeholders are code. At runtime the application substitutes a value into each one by matching the exact token text. A token that is translated, renamed, re-spaced, mis-cased or dropped does not throw a translation error — it renders as literal garbage to a user, or crashes the screen.",
    "",
    "Reproduce every placeholder EXACTLY, character for character, including braces, percent signs, dollar signs, angle brackets, inner spacing and case.",
    "",
    "You MAY move a placeholder to a different position in the sentence when target grammar requires it — that is normal and expected. You may NOT translate it, rename it, re-space it inside its delimiters, duplicate it, or drop it. The set of placeholders you return must be exactly the set you were given.",
  ];
  if (kinds.length > 0) {
    placeholderLines.push("", "Kinds present in this batch:");
    for (const kind of kinds) {
      const rule = PLACEHOLDER_RULES[kind];
      placeholderLines.push(
        `- **${rule.label}** (\`${rule.example}\`)${rule.reorderable ? "" : " — ORDER IS LOAD-BEARING"}: ${rule.rule}`,
      );
    }
  }
  if (locale.direction === "rtl") {
    placeholderLines.push(
      "",
      `- This is a right-to-left locale. Placeholders stay literal left-to-right runs in the string; do not reverse them and do not add or remove bidi control characters (U+200E, U+200F, U+2066–U+2069) unless the source already has them. Sentence-final punctuation goes at the logical end of the string.`,
    );
  }
  sections.push(placeholderLines.join("\n"));

  // --- Ambiguity --------------------------------------------------------
  sections.push(
    [
      "# Ambiguity discipline",
      "",
      "Short UI strings are the most ambiguous text in software: one word, no sentence, no subject. The first dictionary sense is wrong often enough that you must not reach for it.",
      "",
      "Resolve by UI ROLE first, then by neighbouring keys, then by the product description. Each unit states its role and its siblings — use them.",
      "",
      "- \"Run\" on a button is *execute this now*; in body copy it can be *a run* (an execution, a session, a sequence) or the verb *to run*.",
      "- \"Save\" on a button is the action; \"Saving\" in a toast or status is the in-progress state and takes a different grammatical form in most languages.",
      "- \"Load\" on a button is *load a file*; as a label it may be *the load* (CPU, weight, capacity).",
      "- \"Right\" is *direction*, *correct*, or *a legal right* — three unrelated words in most target languages.",
      "- \"min\" is *minute* or *minimum*. A neighbouring \"max\" settles it; so does a duration.",
      "- \"Free\" is *no cost*, *unoccupied*, or *to liberate*. On a pricing badge it is the first; on a seat or slot it is the second.",
      "- \"Match\" is *a game/round* or *to correspond*. In a game product, assume the first unless the key says otherwise.",
      "- \"Sign\" is *sign in / sign a document* or *a symbol/sign*.",
      "- \"Open\", \"Close\", \"Play\", \"Record\", \"Skip\", \"Clear\", \"Mute\": action on a control, state everywhere else.",
      "",
      "Some units carry explicit disambiguation notes. **Those notes are authoritative and override your own default reading of the word, always.** They were produced by static analysis of the source file and by the developer, both of whom can see things you cannot.",
      "",
      "A `developer note` on a unit is a direct instruction from the person who wrote the string. Follow it.",
    ].join("\n"),
  );

  // --- Glossary ---------------------------------------------------------
  sections.push(buildGlossarySection(glossary, locale));

  // --- Locale conventions ----------------------------------------------
  const conventions = buildLocaleSection(locale);
  if (conventions !== null) sections.push(conventions);

  // --- Output -----------------------------------------------------------
  sections.push(
    [
      "# Output format (strict)",
      "",
      "Return ONE JSON object and nothing else:",
      "",
      '{"translations":[{"key":"<the key, copied exactly>","target":"<the translation>","rationale":"<one short clause, optional>"}]}',
      "",
      "- No markdown fences. No prose before or after. No comments. No trailing commas.",
      "- One entry per unit you were given, using the key EXACTLY as written — keys are machine identifiers, never translate or reformat them.",
      "- Keep the entries in the order the units were given.",
      "- `target` is the translation only. Never wrap it in quotes of your own, never add a note inside it.",
      "- `rationale` is ONE short clause, in ENGLISH, explaining a non-obvious choice — an abbreviation you chose to fit, a term you deliberately left in English, a reading you picked between two senses. OMIT the field entirely when the choice is obvious. It is read by a developer scanning a review table, not by a user.",
      "- If a string genuinely must stay identical to the source (a brand, a code identifier), return it unchanged and say why in `rationale`.",
    ].join("\n"),
  );

  return sections.join("\n\n---\n\n");
}

function buildGlossarySection(
  glossary: readonly GlossaryTerm[],
  locale: LocaleProfile,
): string {
  const lines = resolveGlossary(glossary, locale);
  if (lines.length === 0) {
    return [
      "# Glossary",
      "",
      "No glossary was supplied. Keep your own terminology internally consistent: the same source term gets the same target term in every string of this batch.",
    ].join("\n");
  }

  const forced = lines.filter((line) => line.target !== null);
  const verbatim = lines.filter((line) => line.target === null);
  const out: string[] = [
    "# Glossary (binding)",
    "",
    "These renderings are decided. They outrank your judgement, the length budget's preference for shorter words, and the register rules.",
  ];

  if (forced.length > 0) {
    out.push("", "Forced renderings — use exactly this target text:");
    for (const line of forced) {
      const flags = line.caseSensitive ? " [case-sensitive]" : "";
      const note = line.note === undefined ? "" : ` — ${line.note}`;
      out.push(`- ${JSON.stringify(line.term)} → ${JSON.stringify(line.target)}${flags}${note}`);
    }
  }
  if (verbatim.length > 0) {
    out.push(
      "",
      `No target is defined for the following terms in ${locale.code}, which means KEEP THEM VERBATIM IN ENGLISH — do not translate, transliterate, decline or pluralise them:`,
    );
    for (const line of verbatim) {
      const note = line.note === undefined ? "" : ` — ${line.note}`;
      out.push(`- ${JSON.stringify(line.term)}${note}`);
    }
  }
  out.push(
    "",
    "Inflect the surrounding sentence around a glossary term rather than altering the term itself.",
  );
  return out.join("\n");
}

function buildLocaleSection(locale: LocaleProfile): string | null {
  const notes: string[] = [];
  const language = locale.code.split("-")[0]?.toLowerCase() ?? "";
  const typography = TYPOGRAPHY[language];
  if (typography !== undefined) notes.push(typography);

  if (locale.noWordBreaks) {
    notes.push(
      "This script has no inter-word spaces. Do not insert spaces to mimic English word boundaries, and remember the string cannot wrap at an arbitrary point.",
    );
  }
  if (locale.direction === "rtl") {
    notes.push(
      "Right-to-left script: write in logical order and let the renderer handle direction. Do not hand-reverse anything.",
    );
  }
  if (notes.length === 0) return null;
  return [
    `# ${locale.name} conventions`,
    "",
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
}

function formatPercent(expansion: number): string {
  return `${Math.round(expansion * 100)}%`;
}

function describeGlyphWidth(locale: LocaleProfile): string {
  if (locale.glyphWidth >= 1.5) {
    return `, but each character renders about ${locale.glyphWidth}× as wide as a Latin letter — fewer characters does not mean a narrower string`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * The payload: one block per unit, plus a repair banner for units that already
 * failed once. Deliberately verbose per unit — a batch is at most a few dozen
 * strings, and every line here is a line the model would otherwise guess.
 */
export function buildUserPrompt(request: ProviderRequest): string {
  const { locale, units } = request;
  const repairs = units.filter(isRepair).length;

  const header: string[] = [
    `TARGET LOCALE: ${locale.code} — ${locale.name} (${locale.nativeName})`,
    `UNITS: ${units.length}`,
  ];
  if (repairs > 0) {
    header.push(
      `REPAIR PASSES: ${repairs} of the ${units.length} units below were already translated once and REJECTED. They are marked. Do not repeat the rejected text.`,
    );
  }

  const blocks = units.map((unit, index) =>
    buildUnitBlock(unit, index, units.length, locale),
  );

  const footer = [
    "=== END OF UNITS ===",
    "",
    `Return the JSON object now: exactly ${units.length} entr${units.length === 1 ? "y" : "ies"}, one per key above, in the same order, no markdown fences, no prose.`,
  ];

  return [header.join("\n"), ...blocks, footer.join("\n")].join("\n\n");
}

function isRepair(unit: TranslationUnit): boolean {
  return (
    (unit.repairFeedback !== undefined && unit.repairFeedback.length > 0) ||
    (unit.previousAttempt !== undefined && unit.previousAttempt.length > 0)
  );
}

function buildUnitBlock(
  unit: TranslationUnit,
  index: number,
  total: number,
  locale: LocaleProfile,
): string {
  const repair = isRepair(unit);
  const lines: string[] = [];

  lines.push(
    repair
      ? `--- UNIT ${index + 1}/${total} ---  !! REPAIR PASS — YOUR PREVIOUS TRANSLATION OF THIS STRING WAS REJECTED !!`
      : `--- UNIT ${index + 1}/${total} ---`,
  );
  lines.push(`key: ${unit.key}`);
  lines.push(`role: ${unit.role} — ${roleGuidance(unit.role)}`);
  lines.push(`source: ${JSON.stringify(unit.source)}`);
  lines.push(
    `length: ${describeBudgetForPrompt(unit.budget, locale, unit.source, unit.role)}`,
  );
  lines.push(`placeholders: ${describePlaceholders(unit.placeholders)}`);
  lines.push(`ambiguity notes: ${describeAmbiguities(unit)}`);
  if (unit.developerNote !== undefined && unit.developerNote.trim().length > 0) {
    lines.push(`developer note: ${unit.developerNote.trim()}`);
  }
  lines.push(`sibling keys: ${describeNeighbors(unit.neighbors)}`);

  if (repair) {
    lines.push("");
    lines.push(
      `REJECTED PREVIOUS ATTEMPT: ${JSON.stringify(unit.previousAttempt ?? "")}`,
    );
    lines.push(
      `WHY IT WAS REJECTED: ${unit.repairFeedback ?? "It did not satisfy the constraints above."}`,
    );
    lines.push(
      "REQUIRED: return a DIFFERENT string that fixes exactly this problem and nothing else. Do not resubmit the rejected text. Do not truncate it or bolt an ellipsis onto it — choose shorter words, or a shorter idiomatic phrasing, and keep every placeholder intact.",
    );
  }

  return lines.join("\n");
}

function describePlaceholders(placeholders: readonly Placeholder[]): string {
  if (placeholders.length === 0) return "none";
  // Source order is the contract for bare printf tokens, so report it.
  const ordered = [...placeholders].sort((a, b) => a.index - b.index);
  return ordered
    .map(
      (placeholder) =>
        `${placeholder.raw} (${placeholder.kind}, arg ${JSON.stringify(placeholder.token)})`,
    )
    .join("  ");
}

function describeAmbiguities(unit: TranslationUnit): string {
  if (unit.ambiguities.length === 0) return "none";
  return unit.ambiguities
    .map(
      (flag) =>
        `[${flag.kind}, confidence ${flag.confidence.toFixed(2)}] ${flag.note}`,
    )
    .join(" | ");
}

/** Cap sibling context: past a handful it stops being context and starts being noise. */
const MAX_NEIGHBORS = 8;

function describeNeighbors(neighbors: readonly string[]): string {
  if (neighbors.length === 0) return "none";
  const shown = neighbors.slice(0, MAX_NEIGHBORS);
  const extra = neighbors.length - shown.length;
  return extra > 0
    ? `${shown.join(", ")} (+${extra} more)`
    : shown.join(", ");
}
