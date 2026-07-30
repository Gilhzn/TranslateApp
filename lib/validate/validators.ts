import { extractPlaceholders, stripPlaceholders } from "@/lib/core";
import type {
  AmbiguityFlag,
  FitResult,
  GlossaryTerm,
  Issue,
  LocaleCode,
  Placeholder,
  UiRole,
} from "@/lib/types";
import { classify, issue, type IssueDetail } from "./errors";
import {
  ALWAYS_SUSPECT_INVISIBLE,
  JOINERS,
  NBSP_LIKE,
  REPLACEMENT_CHARACTER,
  capitalisedWordCount,
  capitalisesNouns,
  codePoints,
  formatCodePoint,
  hasCasedLetters,
  hasLetters,
  isAllCaps,
  isBidiControl,
  isC0Control,
  isC1Control,
  isAllowedControl,
  isCaselessLanguage,
  isEmojiLike,
  leadingWhitespace,
  localeUsesJoiners,
  sameLanguage,
  startsUppercase,
  trailingWhitespace,
  visualizeWhitespace,
  words,
} from "./text";

/**
 * Per-string validators.
 *
 * Every validator has the same shape — `(source, target, context) => Issue[]` —
 * so the orchestrator can run them as a list, and each one is independently
 * testable. None of them throw: a validator's job is to *describe* a problem
 * precisely enough that `buildRepairFeedback` can tell the model how to fix it,
 * which means the `detail` payload matters as much as the message.
 */

export interface ValidationContext {
  /** Flattened entry key, copied onto every issue produced. */
  key?: string;
  role?: UiRole;
  /** Target locale, e.g. "de" — gates the locale-sensitive heuristics. */
  locale?: LocaleCode;
  sourceLocale?: LocaleCode;
  /** From `StringEntry.doNotTranslate`: identity is the correct output. */
  doNotTranslate?: boolean;
  glossary?: readonly GlossaryTerm[];
  ambiguities?: readonly AmbiguityFlag[];
  /**
   * Pre-extracted source placeholders. The parser already computed these for
   * every entry; passing them through avoids re-scanning each source string
   * once per target locale.
   */
  sourcePlaceholders?: readonly Placeholder[];
}

type Validator = (
  source: string,
  target: string,
  ctx?: ValidationContext,
) => Issue[];

function opts(ctx: ValidationContext | undefined, detail: IssueDetail) {
  return ctx?.key !== undefined ? { key: ctx.key, detail } : { detail };
}

function sourcePlaceholdersOf(
  source: string,
  ctx: ValidationContext | undefined,
): readonly Placeholder[] {
  return ctx?.sourcePlaceholders ?? extractPlaceholders(source);
}

// ---------------------------------------------------------------------------
// Placeholder parity
// ---------------------------------------------------------------------------

/**
 * Parity identity of a placeholder.
 *
 * Kind is part of the identity because a model that rewrites `{{user}}` as
 * `{user}` has broken i18next just as thoroughly as if it had deleted the
 * placeholder. Angle tags additionally distinguish open / close / self-closing,
 * so `<b>` and `</b>` are two different obligations rather than one counted
 * twice.
 */
export function placeholderIdentity(p: Placeholder): string {
  if (p.kind === "angle-tag") {
    if (p.raw.startsWith("</")) return `angle:/${p.token}`;
    if (/\/\s*>$/.test(p.raw)) return `angle:${p.token}/`;
    return `angle:${p.token}`;
  }
  return `${p.kind}:${p.token}`;
}

/** A printf spec with no explicit `n$` argument index — order is the binding. */
function isPositionalPrintf(p: Placeholder): boolean {
  return p.kind === "printf" && !/^\d+$/.test(p.token);
}

function countIdentities(list: readonly Placeholder[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of list) {
    counts.set(placeholderIdentity(p), (counts.get(placeholderIdentity(p)) ?? 0) + 1);
  }
  return counts;
}

function firstByIdentity(
  list: readonly Placeholder[],
): Map<string, Placeholder> {
  const map = new Map<string, Placeholder>();
  for (const p of list) {
    const id = placeholderIdentity(p);
    if (!map.has(id)) map.set(id, p);
  }
  return map;
}

/** Invisible or non-ASCII spacing inside a placeholder body breaks lookup. */
function invisibleInsidePlaceholder(raw: string): number | null {
  for (const { cp } of codePoints(raw)) {
    if (NBSP_LIKE.has(cp)) return cp;
    if (ALWAYS_SUSPECT_INVISIBLE.has(cp)) return cp;
    if (JOINERS.has(cp)) return cp;
  }
  return null;
}

/** Full-width delimiters, the classic CJK-model corruption of `{}` and `%`. */
const FULLWIDTH_PLACEHOLDER =
  /｛[^｛｝]*｝|＄｛[^｛｝]*｝|％\s*[-+0# ]*\d*(?:\.\d+)?[sdifgeoxXuc]/u;

const DELIMITER_NEIGHBOURS = new Set([
  "{", "}", "<", ">", "%", "$", "(", ")", "[", "]",
  "｛", "｝", "＜", "＞", "％", "＄",
]);

/**
 * Does the target contain a *mangled echo* of a source placeholder?
 *
 * `{count` and `count}` and `｛count｝` all extract as "no placeholder at all",
 * which naively reads as "missing". Reporting them as malformed instead is
 * what lets the repair prompt say "you wrote `{count` — write `{count}`"
 * rather than the far less useful "you dropped a placeholder".
 */
function hasCorruptedEcho(target: string, p: Placeholder): boolean {
  if (p.token.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = target.indexOf(p.token, from);
    if (at < 0) return false;
    const before = at > 0 ? target[at - 1] : undefined;
    const afterIndex = at + p.token.length;
    const after =
      afterIndex < target.length ? target[afterIndex] : undefined;
    if (
      (before !== undefined && DELIMITER_NEIGHBOURS.has(before)) ||
      (after !== undefined && DELIMITER_NEIGHBOURS.has(after))
    ) {
      return true;
    }
    from = at + 1;
  }
}

/** Braces that are not part of any recognised placeholder. */
function strayBraceCount(value: string, list: readonly Placeholder[]): number {
  const residue = stripPlaceholders(value, list);
  let count = 0;
  for (const ch of residue) {
    if (ch === "{" || ch === "}") count += 1;
  }
  return count;
}

/**
 * Compare placeholders by normalised token MULTISET, then by order.
 *
 * Counts, not sets: "{name} and {name}" needs `{name}` twice in the target, and
 * a model that emits it once has silently dropped an interpolation site.
 */
export const validatePlaceholderParity: Validator = (source, target, ctx) => {
  const issues: Issue[] = [];
  const sourceList = sourcePlaceholdersOf(source, ctx);
  const targetList = extractPlaceholders(target);

  // Fast path for the common case, but only when the target also has no loose
  // delimiters — "Bereit }" has no *recognised* placeholder and is exactly the
  // corruption the malformed checks below exist to catch.
  if (
    sourceList.length === 0 &&
    targetList.length === 0 &&
    !/[{}｛｝％]/u.test(target)
  ) {
    return issues;
  }

  // --- 1. Placeholders that were recognised but carry invisible junk --------
  for (const p of targetList) {
    const bad = invisibleInsidePlaceholder(p.raw);
    if (bad !== null) {
      issues.push(
        classify(
          "placeholder-malformed",
          `Placeholder ${JSON.stringify(p.raw)} contains an invisible character (${formatCodePoint(bad)}) inside its delimiters; at runtime the interpolation key will not match.`,
          opts(ctx, {
            raw: p.raw,
            token: p.token,
            kind: p.kind,
            codePoint: formatCodePoint(bad),
            fixable: true,
          }),
        ),
      );
    }
  }

  // --- 2. Full-width delimiter corruption ----------------------------------
  const fullWidth = FULLWIDTH_PLACEHOLDER.exec(target);
  if (fullWidth) {
    issues.push(
      classify(
        "placeholder-malformed",
        `Placeholder ${JSON.stringify(fullWidth[0])} uses full-width delimiters. Interpolation only recognises ASCII "{", "}", "$" and "%".`,
        opts(ctx, { raw: fullWidth[0], reason: "full-width-delimiters" }),
      ),
    );
  }

  // --- 3. Stray braces the target invented ---------------------------------
  const sourceStray = strayBraceCount(source, sourceList);
  const targetStray = strayBraceCount(target, targetList);
  if (targetStray > sourceStray) {
    issues.push(
      classify(
        "placeholder-malformed",
        `The translation contains ${targetStray - sourceStray} unbalanced brace(s) that are not part of a valid placeholder.`,
        opts(ctx, {
          sourceStrayBraces: sourceStray,
          targetStrayBraces: targetStray,
          reason: "unbalanced-braces",
        }),
      ),
    );
  }

  // --- 4. Multiset comparison ---------------------------------------------
  const sourceCounts = countIdentities(sourceList);
  const targetCounts = countIdentities(targetList);
  const sourceFirst = firstByIdentity(sourceList);
  const targetFirst = firstByIdentity(targetList);

  // Tokens whose absence is already explained by a corrupted echo. Whatever
  // mangled form the model wrote is *the same placeholder*, so reporting it a
  // second time as "added" would be double-counting one mistake.
  const explainedTokens = new Set<string>();

  for (const [id, want] of sourceCounts) {
    const have = targetCounts.get(id) ?? 0;
    if (have >= want) continue;
    const example = sourceFirst.get(id);
    if (example === undefined) continue;

    // A corrupted echo is a *different* failure with a different repair
    // instruction, so it is reported as malformed instead of missing.
    if (have === 0 && hasCorruptedEcho(target, example)) {
      explainedTokens.add(example.token);
      issues.push(
        classify(
          "placeholder-malformed",
          `Placeholder ${JSON.stringify(example.raw)} appears in the translation in a broken form. Reproduce it exactly as ${JSON.stringify(example.raw)}.`,
          opts(ctx, {
            raw: example.raw,
            token: example.token,
            kind: example.kind,
            expected: want,
            actual: have,
            reason: "corrupted-echo",
          }),
        ),
      );
      continue;
    }

    issues.push(
      classify(
        "placeholder-missing",
        want === 1
          ? `Placeholder ${JSON.stringify(example.raw)} is missing from the translation.`
          : `Placeholder ${JSON.stringify(example.raw)} must appear ${want} times but appears ${have} time(s).`,
        opts(ctx, {
          raw: example.raw,
          token: example.token,
          kind: example.kind,
          expected: want,
          actual: have,
        }),
      ),
    );
  }

  for (const [id, have] of targetCounts) {
    const want = sourceCounts.get(id) ?? 0;
    if (have <= want) continue;
    const example = targetFirst.get(id);
    if (example === undefined) continue;
    if (want === 0 && explainedTokens.has(example.token)) continue;
    issues.push(
      classify(
        "placeholder-added",
        want === 0
          ? `Placeholder ${JSON.stringify(example.raw)} does not exist in the source string and must be removed.`
          : `Placeholder ${JSON.stringify(example.raw)} appears ${have} times but the source uses it ${want} time(s).`,
        opts(ctx, {
          raw: example.raw,
          token: example.token,
          kind: example.kind,
          expected: want,
          actual: have,
        }),
      ),
    );
  }

  // --- 5. Ordering ---------------------------------------------------------
  const orderIssue = checkOrdering(sourceList, targetList, sourceCounts, targetCounts, ctx);
  if (orderIssue) issues.push(orderIssue);

  return issues;
};

function checkOrdering(
  sourceList: readonly Placeholder[],
  targetList: readonly Placeholder[],
  sourceCounts: Map<string, number>,
  targetCounts: Map<string, number>,
  ctx: ValidationContext | undefined,
): Issue | null {
  // Only identities with matched counts can meaningfully be "reordered";
  // anything else is already reported as missing or added.
  const comparable = new Set<string>();
  for (const [id, count] of sourceCounts) {
    if (targetCounts.get(id) === count) comparable.add(id);
  }
  if (comparable.size === 0) return null;

  const sourceSeq = sourceList
    .filter((p) => comparable.has(placeholderIdentity(p)))
    .map(placeholderIdentity);
  const targetSeq = targetList
    .filter((p) => comparable.has(placeholderIdentity(p)))
    .map(placeholderIdentity);

  const sameOrder =
    sourceSeq.length === targetSeq.length &&
    sourceSeq.every((id, i) => targetSeq[i] === id);
  if (sameOrder) return null;

  // Positional printf (`%s`, `%d`) binds arguments by *position*, so swapping
  // two of them silently prints the wrong value with the wrong type. Every
  // other syntax names its argument, so reordering is just grammar.
  const printfSource = sourceList
    .filter((p) => isPositionalPrintf(p) && comparable.has(placeholderIdentity(p)))
    .map((p) => p.raw);
  const printfTarget = targetList
    .filter((p) => isPositionalPrintf(p) && comparable.has(placeholderIdentity(p)))
    .map((p) => p.raw);
  const printfOrderBroken =
    printfSource.length > 1 &&
    (printfSource.length !== printfTarget.length ||
      printfSource.some((raw, i) => printfTarget[i] !== raw));

  const detail: IssueDetail = {
    sourceOrder: sourceSeq.join(" "),
    targetOrder: targetSeq.join(" "),
    positional: printfOrderBroken,
  };

  if (printfOrderBroken) {
    return issue(
      "placeholder-reordered",
      "error",
      `Positional format specifiers were reordered (${printfSource.join(" ")} → ${printfTarget.join(" ")}). Without explicit argument indices they are filled in source order, so swapping them substitutes the wrong values.`,
      opts(ctx, detail),
    );
  }

  return classify(
    "placeholder-reordered",
    "Placeholders appear in a different order than in the source. This is usually correct — target grammar dictates word order — and is reported for review only.",
    opts(ctx, detail),
  );
}

// ---------------------------------------------------------------------------
// Emptiness
// ---------------------------------------------------------------------------

const INVISIBLE_ONLY = new RegExp(
  `[\\s\\u200b\\u200c\\u200d\\u2060\\ufeff\\u180e]`,
  "gu",
);

/** A non-empty source must produce a non-empty target. */
export const validateNotEmpty: Validator = (source, target, ctx) => {
  if (source.trim().length === 0) return [];
  // Invisible characters do not count as content: a target of "​" renders
  // as an empty button just as surely as "".
  const substance = target.replace(INVISIBLE_ONLY, "");
  if (substance.length > 0) return [];
  return [
    classify(
      "empty-translation",
      `The translation is empty but the source is not (${JSON.stringify(truncateForMessage(source))}).`,
      opts(ctx, { sourceLength: source.length, targetLength: target.length }),
    ),
  ];
};

// ---------------------------------------------------------------------------
// Untranslated output
// ---------------------------------------------------------------------------

/**
 * Target identical to source.
 *
 * This fires a WARNING, never an error, because the false-positive class is
 * real: "Email", "Chat" and "Sport" are genuinely identical in several
 * European locales. The gates below remove the cases we can *prove* are
 * legitimate; what survives is worth a human glance, not a hard failure.
 */
export const validateUntranslated: Validator = (source, target, ctx) => {
  if (source !== target && source.trim() !== target.trim()) return [];
  if (source.trim().length === 0) return [];
  if (ctx?.doNotTranslate === true) return [];

  // Same language on both sides: identity is the only correct answer.
  if (sameLanguage(ctx?.locale, ctx?.sourceLocale)) return [];

  const placeholders = sourcePlaceholdersOf(source, ctx);
  if (
    placeholders.length > 0 &&
    stripPlaceholders(source, placeholders).trim().length === 0
  ) {
    return [];
  }

  // Digits, symbols and emoji have nothing to translate.
  if (!hasLetters(source)) return [];

  if (isGlossaryVerbatim(source, target, ctx)) return [];
  if (isBrandTerm(source, ctx)) return [];

  return [
    classify(
      "untranslated",
      `The translation is identical to the source string${
        ctx?.locale ? ` for locale "${ctx.locale}"` : ""
      }. Confirm this is a brand or loan word rather than a skipped translation.`,
      opts(ctx, { value: truncateForMessage(source) }),
    ),
  ];
};

/**
 * True when the glossary explains the identity: either the term is marked
 * "keep verbatim" (no rendering for this locale) or its forced rendering IS
 * the source spelling.
 */
function isGlossaryVerbatim(
  source: string,
  target: string,
  ctx: ValidationContext | undefined,
): boolean {
  const glossary = ctx?.glossary;
  if (!glossary || glossary.length === 0) return false;
  const locale = ctx?.locale;

  let residue = source;
  for (const term of glossary) {
    if (term.term.length === 0) continue;
    const forced = locale ? term.translations[locale] : undefined;
    if (forced !== undefined && forced.length > 0 && forced !== target) {
      // The glossary demands a different rendering — identity is a violation,
      // not an exemption.
      continue;
    }
    residue = removeAll(residue, term.term, term.caseSensitive);
  }
  // If stripping the glossary terms leaves nothing translatable, the whole
  // string was brand vocabulary.
  return !hasLetters(residue);
}

function removeAll(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
): string {
  if (needle.length === 0) return haystack;
  if (caseSensitive) return haystack.split(needle).join(" ");
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, cursor);
    if (at < 0) break;
    out += `${haystack.slice(cursor, at)} `;
    cursor = at + needle.length;
  }
  return out + haystack.slice(cursor);
}

/**
 * The analyser flagged this string as a brand term. Short strings are trusted
 * outright; a long sentence carrying an incidental brand mention still has to
 * be translated.
 */
function isBrandTerm(source: string, ctx: ValidationContext | undefined): boolean {
  const flags = ctx?.ambiguities;
  if (!flags) return false;
  if (words(source).length > 3) return false;
  return flags.some((f) => f.kind === "brand-term" && f.confidence >= 0.6);
}

// ---------------------------------------------------------------------------
// Control and invisible characters
// ---------------------------------------------------------------------------

/**
 * Reject characters that corrupt a shipped catalogue.
 *
 * One issue per distinct offending code point, with an occurrence count: a
 * translation with eleven zero-width spaces should produce one actionable
 * finding, not eleven.
 */
export const validateControlCharacters: Validator = (source, target, ctx) => {
  const sourceHas = new Set<number>();
  for (const { cp } of codePoints(source)) sourceHas.add(cp);

  interface Finding {
    count: number;
    index: number;
    severity: "error" | "warning";
    label: string;
  }
  const findings = new Map<number, Finding>();

  const record = (
    cp: number,
    index: number,
    severity: "error" | "warning",
    label: string,
  ): void => {
    const existing = findings.get(cp);
    if (existing) existing.count += 1;
    else findings.set(cp, { count: 1, index, severity, label });
  };

  const points = codePoints(target);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === undefined) continue;
    const { cp, index } = point;

    if (isAllowedControl(cp)) continue;
    // CR is tolerated only when the source itself uses CRLF, so a faithful
    // copy of a multi-line source is not punished.
    if (cp === 0x0d && sourceHas.has(0x0d)) continue;

    if (isC0Control(cp) || isC1Control(cp)) {
      record(cp, index, "error", "control character");
      continue;
    }
    if (cp === REPLACEMENT_CHARACTER) {
      // U+FFFD is proof that bytes were already lost. Deleting it would hide
      // the corruption, so it is an error that must go back to the model.
      record(cp, index, "error", "replacement character (mojibake)");
      continue;
    }
    if (isBidiControl(cp)) continue; // legitimate in RTL layouts
    if (ALWAYS_SUSPECT_INVISIBLE.has(cp)) {
      record(cp, index, "warning", "zero-width character");
      continue;
    }
    if (JOINERS.has(cp)) {
      if (localeUsesJoiners(ctx?.locale)) continue; // orthographically required
      if (sourceHas.has(cp)) continue;
      const prev = points[i - 1];
      const next = points[i + 1];
      if (
        (prev !== undefined && isEmojiLike(prev.cp)) ||
        (next !== undefined && isEmojiLike(next.cp))
      ) {
        continue; // emoji ZWJ sequence
      }
      record(cp, index, "warning", "zero-width joiner");
    }
  }

  const out: Issue[] = [];
  for (const [cp, finding] of findings) {
    out.push(
      issue(
        "control-characters",
        finding.severity,
        `The translation contains ${finding.count} ${finding.label}${
          finding.count === 1 ? "" : "s"
        } (${formatCodePoint(cp)}) at index ${finding.index}.`,
        opts(ctx, {
          codePoint: formatCodePoint(cp),
          count: finding.count,
          index: finding.index,
          category: finding.label,
          fixable: finding.severity === "warning",
        }),
      ),
    );
  }
  return out;
};

// ---------------------------------------------------------------------------
// Tag balance
// ---------------------------------------------------------------------------

/** HTML elements that never carry a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img", "input", "wbr", "meta", "link"]);

interface TagInfo {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  raw: string;
  index: number;
}

function readTags(list: readonly Placeholder[]): TagInfo[] {
  const out: TagInfo[] = [];
  for (const p of list) {
    if (p.kind !== "angle-tag") continue;
    const closing = p.raw.startsWith("</");
    const selfClosing =
      (!closing && /\/\s*>$/.test(p.raw)) || VOID_TAGS.has(p.token.toLowerCase());
    out.push({
      name: p.token,
      closing,
      selfClosing,
      raw: p.raw,
      index: p.index,
    });
  }
  return out;
}

/**
 * Every tag opened in the target must be closed there, correctly nested.
 *
 * Scoped to tag names that are *paired in the source*. Component-interpolation
 * catalogues legitimately contain half-tags (a string that opens `<0>` and a
 * sibling string that closes it), and demanding balance for those would fire
 * on correct input. Names that the source itself leaves unbalanced are covered
 * by the multiset parity check instead.
 */
export const validateTagBalance: Validator = (source, target, ctx) => {
  const sourceTags = readTags(sourcePlaceholdersOf(source, ctx));
  const targetTags = readTags(extractPlaceholders(target));
  if (sourceTags.length === 0 && targetTags.length === 0) return [];

  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  for (const tag of sourceTags) {
    if (tag.selfClosing) continue;
    const bucket = tag.closing ? closes : opens;
    bucket.set(tag.name, (bucket.get(tag.name) ?? 0) + 1);
  }
  const paired = new Set<string>();
  for (const [name, count] of opens) {
    if (count > 0 && closes.get(name) === count) paired.add(name);
  }
  if (paired.size === 0) return [];

  const issues: Issue[] = [];
  const stack: TagInfo[] = [];

  for (const tag of targetTags) {
    if (tag.selfClosing) continue;
    if (!paired.has(tag.name)) continue;

    if (!tag.closing) {
      stack.push(tag);
      continue;
    }

    const top = stack[stack.length - 1];
    if (top === undefined) {
      issues.push(
        classify(
          "tag-imbalance",
          `Closing tag ${JSON.stringify(tag.raw)} at index ${tag.index} has no matching opening tag.`,
          opts(ctx, { tag: tag.raw, name: tag.name, reason: "unopened" }),
        ),
      );
      continue;
    }
    if (top.name !== tag.name) {
      issues.push(
        classify(
          "tag-imbalance",
          `Tags are crossed: ${JSON.stringify(top.raw)} is still open but ${JSON.stringify(tag.raw)} closes first. Markup must nest, not overlap.`,
          opts(ctx, {
            tag: tag.raw,
            expected: `</${top.name}>`,
            reason: "crossed",
          }),
        ),
      );
      // Recover by discarding the mismatched open so one crossing does not
      // cascade into an "unclosed" report for every remaining tag.
      stack.pop();
      continue;
    }
    stack.pop();
  }

  for (const unclosed of stack) {
    issues.push(
      classify(
        "tag-imbalance",
        `Tag ${JSON.stringify(unclosed.raw)} is never closed; add ${JSON.stringify(`</${unclosed.name}>`)}.`,
        opts(ctx, {
          tag: unclosed.raw,
          expected: `</${unclosed.name}>`,
          reason: "unclosed",
        }),
      ),
    );
  }

  return issues;
};

// ---------------------------------------------------------------------------
// Whitespace drift
// ---------------------------------------------------------------------------

/**
 * Edge whitespace must match the source byte for byte.
 *
 * Developers concatenate: `t("greeting.hello") + userName` relies on the
 * trailing space in `"Hello, "`. Models strip it roughly half the time. This
 * is a warning rather than an error only because it is deterministically
 * repairable — see `applyMechanicalFixes`.
 */
export const validateWhitespaceDrift: Validator = (source, target, ctx) => {
  if (source.trim().length === 0) return [];
  if (target.trim().length === 0) return []; // emptiness has its own validator

  const issues: Issue[] = [];
  const pairs: Array<[side: "leading" | "trailing", expected: string, actual: string]> = [
    ["leading", leadingWhitespace(source), leadingWhitespace(target)],
    ["trailing", trailingWhitespace(source), trailingWhitespace(target)],
  ];

  for (const [side, expected, actual] of pairs) {
    if (expected === actual) continue;
    issues.push(
      classify(
        "whitespace-drift",
        `The source has ${side} whitespace ${visualizeWhitespace(expected)} but the translation has ${visualizeWhitespace(actual)}. Edge whitespace is load-bearing when strings are concatenated in the UI.`,
        opts(ctx, {
          side,
          expected,
          actual,
          fixable: true,
        }),
      ),
    );
  }

  return issues;
};

// ---------------------------------------------------------------------------
// Casing drift
// ---------------------------------------------------------------------------

/** Roles where capitalisation is a deliberate visual style, not grammar. */
const STYLE_SENSITIVE_ROLES: ReadonlySet<UiRole> = new Set<UiRole>([
  "button",
  "badge",
  "menu",
]);

/**
 * The source uses a deliberate capitalisation style that the target dropped.
 *
 * INFO only, and heavily gated:
 *   - restricted to roles where casing is styling (button / badge / menu);
 *   - skipped when the target script has no case at all (CJK, Arabic, Hebrew,
 *     Devanagari …), where "ALL CAPS" is not expressible;
 *   - title-case drift is skipped for German and friends, where capitalised
 *     nouns are orthography rather than styling and the check would fire on
 *     every correct translation.
 */
export const validateCasingDrift: Validator = (source, target, ctx) => {
  const role = ctx?.role;
  if (role === undefined || !STYLE_SENSITIVE_ROLES.has(role)) return [];
  if (isCaselessLanguage(ctx?.locale)) return [];
  if (!hasCasedLetters(target)) return []; // caseless script in practice
  if (!hasCasedLetters(source)) return [];

  if (isAllCaps(source)) {
    if (isAllCaps(target)) return [];
    return [
      classify(
        "casing-drift",
        `The source is styled ALL CAPS for this ${role} but the translation is not. Match the styling unless the target language forbids it.`,
        opts(ctx, { style: "all-caps", source, target }),
      ),
    ];
  }

  if (capitalisesNouns(ctx?.locale)) return [];

  const sourceCaps = capitalisedWordCount(source);
  const targetWords = words(target);
  const targetCaps = capitalisedWordCount(target);

  // Title Case: two or more capitalised words in the source. Drift is only
  // reported when the target capitalises at most one — a target that
  // capitalises "most" words is following the convention closely enough.
  if (sourceCaps >= 2 && targetWords.length >= 2 && targetCaps <= 1) {
    return [
      classify(
        "casing-drift",
        `The source uses Title Case for this ${role} (${sourceCaps} capitalised words) but the translation capitalises ${targetCaps}.`,
        opts(ctx, { style: "title-case", sourceCaps, targetCaps }),
      ),
    ];
  }

  if (startsUppercase(source) && !startsUppercase(target) && targetWords.length > 0) {
    return [
      classify(
        "casing-drift",
        `The source ${role} starts with a capital letter but the translation starts lowercase.`,
        opts(ctx, { style: "sentence-case", source, target }),
      ),
    ];
  }

  return [];
};

// ---------------------------------------------------------------------------
// Fit → issues
// ---------------------------------------------------------------------------

/**
 * Translate a layout verdict into the issue vocabulary.
 *
 * Lives here rather than in the layout engine so that every consumer sees a
 * single, uniformly classified issue stream.
 */
export function issuesFromFit(
  fit: FitResult | null,
  key?: string,
): Issue[] {
  if (fit === null) return [];
  const detail: IssueDetail = {
    verdict: fit.verdict,
    targetWidth: fit.targetWidth,
    allowedWidth: fit.allowedWidth,
    ratio: fit.ratio,
    overBy: fit.overBy,
    maxChars: fit.budget.maxChars,
  };
  const base = key !== undefined ? { key, detail } : { detail };

  if (fit.verdict === "overflow") {
    return [
      classify(
        "length-overflow",
        `The translation renders ${fit.targetWidth}em wide but only ${fit.allowedWidth}em is available (${fit.budget.rationale}). Roughly ${fit.overBy} character(s) must come out.`,
        base,
      ),
    ];
  }
  if (fit.verdict === "tight") {
    return [
      classify(
        "length-tight",
        `The translation is within the grace band at ${fit.targetWidth}em against a ${fit.allowedWidth}em budget. It will render, but there is no headroom.`,
        base,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The full per-string battery, in a fixed order.
 *
 * Order matters for the *headline* issue: parity failures outrank cosmetics,
 * so `summarizeIssues` picks the structurally important failure when several
 * share the top severity.
 */
export const STRING_VALIDATORS: ReadonlyArray<
  readonly [name: string, run: Validator]
> = Object.freeze([
  ["placeholder-parity", validatePlaceholderParity],
  ["not-empty", validateNotEmpty],
  ["tag-balance", validateTagBalance],
  ["control-characters", validateControlCharacters],
  ["untranslated", validateUntranslated],
  ["whitespace-drift", validateWhitespaceDrift],
  ["casing-drift", validateCasingDrift],
] as const);

/** Run every string validator and concatenate the findings. */
export function validateString(
  source: string,
  target: string,
  ctx: ValidationContext = {},
): Issue[] {
  const out: Issue[] = [];
  for (const [, run] of STRING_VALIDATORS) {
    out.push(...run(source, target, ctx));
  }
  return out;
}

/** `validateString` plus the layout verdict, which is what the pipeline wants. */
export function validateTranslation(
  source: string,
  target: string,
  fit: FitResult | null,
  ctx: ValidationContext = {},
): Issue[] {
  return [...validateString(source, target, ctx), ...issuesFromFit(fit, ctx.key)];
}

function truncateForMessage(value: string, max = 60): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  return `${chars.slice(0, max).join("")}…`;
}
