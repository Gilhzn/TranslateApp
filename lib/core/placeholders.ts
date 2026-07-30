import type { Placeholder, PlaceholderKind } from "@/lib/types";

/**
 * Placeholder extraction.
 *
 * Locale files in the wild mix every interpolation syntax ever shipped: ICU
 * (`{count}`), Java/Unreal index args (`{0}`), i18next mustaches (`{{user}}`)
 * and nesting (`$t(key)`), JS template literals (`${user}`), C/Obj-C printf
 * (`%s`, `%1$d`), Python named printf (`%(name)s`) and markup/component tags
 * (`<b>`, `<0>`).
 *
 * The extractor is a single left-to-right scan with a *prioritised* matcher at
 * each position, not a union of independent regexes. That is what makes
 * overlapping syntaxes unambiguous: `{{user}}` is consumed whole as ONE
 * double-brace placeholder rather than being reported as an ICU `{user}` plus
 * stray braces, and `${user}` is one dollar-brace rather than a `$` plus an ICU
 * argument. Because the scan only ever moves forward, results are already
 * ordered by `index`.
 *
 * ICU *complex* arguments (`plural`, `selectordinal`, `select`, `choice`) are
 * not atoms: their sub-messages are human copy that must be translated, and may
 * themselves contain placeholders. Such a block therefore yields the whole-span
 * placeholder AND, appended after it, every placeholder found inside its
 * sub-messages carrying absolute indices. Nested spans are consequently
 * *contained* in the parent span rather than disjoint from it — consumers that
 * walk the list with a cursor must skip a placeholder whose `index` is behind
 * the cursor (see {@link stripPlaceholders}).
 *
 * `token` is the normalised identity used for parity checks downstream:
 *   {count}              -> "count"
 *   {count, plural, ...} -> "count"   (whole balanced block is the raw)
 *   {{user}}             -> "user"
 *   ${user}              -> "user"
 *   {0}                  -> "0"
 *   %1$d                 -> "1"       (positional index)
 *   %s                   -> "s"       (conversion letter; order carries meaning)
 *   %(name)s             -> "name"
 *   <b> / </b> / <0>     -> "b" / "b" / "0"
 *   $t(ns:key)           -> "ns:key"
 */

interface Match {
  raw: string;
  kind: PlaceholderKind;
  token: string;
}

/** Sticky regexes: `lastIndex` is assigned before every use. */
const RE_DOUBLE_BRACE = /\{\{\s*([^{}]*?)\s*\}\}/y;
const RE_DOLLAR_BRACE = /\$\{\s*([^{}]*?)\s*\}/y;
const RE_I18NEXT_NESTING = /\$t\(\s*([^()]*?)\s*\)/y;
const RE_PERCENT_NAMED = /%\(([^()]+)\)[-+0#]*(?:\d+)?(?:\.\d+)?[bdiouxXeEfFgGaAcsrn]/y;
// The space and `'` printf flags are deliberately NOT accepted: they would make
// prose like "50% off" parse as the placeholder "% o".
const RE_PRINTF =
  /%(?:(\d+)\$)?[-+0#]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|L|j|z|t|q)?([diouxXeEfFgGaAcspn@])/y;
const RE_ANGLE_TAG = /<\/?([A-Za-z][A-Za-z0-9_.:-]*|\d+)(?:\s[^<>]*?)?\/?>/y;

/** ICU argument head, e.g. `count` in `{count, plural, ...}`. */
const ICU_ARG = /^([A-Za-z_$][A-Za-z0-9_$.-]*)\s*(?:,|$)/;
/** Index-based argument head, e.g. `0` in `{0}` or `{0, number}`. */
const INDEX_ARG = /^(\d+)\s*(?:,|$)/;

function stickyMatch(
  re: RegExp,
  input: string,
  at: number,
): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(input);
}

function matchDoubleBrace(input: string, at: number): Match | null {
  const m = stickyMatch(RE_DOUBLE_BRACE, input, at);
  if (!m) return null;
  const inner = m[1] ?? "";
  if (inner.length === 0) return null;
  return { raw: m[0], kind: "double-brace", token: normaliseArgName(inner) };
}

function matchDollarBrace(input: string, at: number): Match | null {
  const m = stickyMatch(RE_DOLLAR_BRACE, input, at);
  if (!m) return null;
  const inner = m[1] ?? "";
  if (inner.length === 0) return null;
  return { raw: m[0], kind: "dollar-brace", token: normaliseArgName(inner) };
}

function matchI18nextNesting(input: string, at: number): Match | null {
  const m = stickyMatch(RE_I18NEXT_NESTING, input, at);
  if (!m) return null;
  const inner = m[1] ?? "";
  if (inner.length === 0) return null;
  return { raw: m[0], kind: "i18next-nesting", token: normaliseArgName(inner) };
}

function matchAngleTag(input: string, at: number): Match | null {
  const m = stickyMatch(RE_ANGLE_TAG, input, at);
  if (!m) return null;
  const name = m[1];
  if (name === undefined) return null;
  return { raw: m[0], kind: "angle-tag", token: name };
}

/**
 * `%` is either an escaped literal (`%%`, which is NOT a placeholder), a Python
 * named conversion, or a C-style conversion.
 */
function matchPercent(input: string, at: number): Match | "escaped" | null {
  if (input.startsWith("%%", at)) return "escaped";
  const named = stickyMatch(RE_PERCENT_NAMED, input, at);
  if (named) {
    const name = named[1];
    if (name !== undefined) {
      return { raw: named[0], kind: "percent-named", token: name };
    }
  }
  const printf = stickyMatch(RE_PRINTF, input, at);
  if (!printf) return null;
  const positional = printf[1];
  const conversion = printf[2] ?? "";
  return {
    raw: printf[0],
    kind: "printf",
    // Positional specs carry their own identity; plain ones are identified by
    // their conversion letter and their ordering within the string.
    token: positional !== undefined ? positional : conversion,
  };
}

/**
 * Consume a *balanced* `{...}` span. ICU plural/select arguments nest braces
 * (`{n, plural, one {# item} other {# items}}`); taking the whole balanced span
 * as `raw` means the block counts as ONE placeholder for its argument rather
 * than as one per sub-message, while `token` exposes the argument name for
 * parity. The sub-messages themselves are handled by the caller, which recurses
 * into them via {@link parseComplexIcuArgument} — they are copy, not payload.
 */
function matchBraceArgument(input: string, at: number): Match | null {
  let depth = 0;
  let end = -1;
  for (let i = at; i < input.length; i++) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null; // unbalanced: not a placeholder
  const raw = input.slice(at, end + 1);
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return null;

  const indexed = INDEX_ARG.exec(inner);
  if (indexed) {
    const token = indexed[1];
    if (token !== undefined) return { raw, kind: "unreal", token };
  }
  const icu = ICU_ARG.exec(inner);
  if (icu) {
    const token = icu[1];
    if (token !== undefined) return { raw, kind: "icu", token };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ICU complex arguments
// ---------------------------------------------------------------------------

/** Format types whose body is made of translatable sub-messages. */
export type IcuComplexFormat = "plural" | "selectordinal" | "select" | "choice";

/** One branch body of a complex argument, e.g. `# seats` in `other {# seats}`. */
export interface IcuSubMessage {
  /** Absolute index of the first character of the body within the source. */
  index: number;
  /** Body text, excluding the wrapping braces (or the `selector#` for choice). */
  text: string;
}

export interface IcuComplexArgument {
  /** Argument name or index, e.g. `count`. */
  arg: string;
  format: IcuComplexFormat;
  subMessages: IcuSubMessage[];
}

/**
 * `{count, plural, ...` / `{0, select, ...`. The argument head is matched
 * case-insensitively: MessageFormat mandates lowercase keywords, but hand-typed
 * catalogues contain `Plural` and refusing to see them would silently reinstate
 * the "plural block is one opaque placeholder" bug for those files.
 */
const RE_COMPLEX_HEAD =
  /^\s*(?:[A-Za-z_$][A-Za-z0-9_$.-]*|\d+)\s*,\s*(plural|selectordinal|select|choice)\s*,/i;

/**
 * Split the branch list of a plural/select/selectordinal body into its
 * sub-messages. Everything *between* the balanced `{...}` spans is skeleton
 * (`one`, `other`, `=0`, `offset:1`) and is deliberately dropped.
 */
function collectBracedSubMessages(
  body: string,
  bodyOffset: number,
): IcuSubMessage[] {
  const out: IcuSubMessage[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) continue; // stray closer: not our brace to consume
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push({
          index: bodyOffset + start + 1,
          text: body.slice(start + 1, i),
        });
        start = -1;
      }
    }
  }
  return out;
}

/**
 * A choice branch selector: a number followed by `#` (inclusive) or `<`
 * (exclusive). Anchored and numeric so a message that merely opens with a tag
 * (`<b>bold</b>`) is never mistaken for a selector.
 */
const RE_CHOICE_SELECTOR = /^\s*[+-]?(?:\d+(?:\.\d+)?|∞)\s*[#<≤]/;

/**
 * `choice` predates `plural` and does not brace its branches:
 * `{n, choice, 0#no files|1#one file|1<many files}`. Branches are `|`-separated
 * at depth zero and each carries a `<number>#` or `<number><` prefix.
 */
function collectChoiceSubMessages(
  body: string,
  bodyOffset: number,
): IcuSubMessage[] {
  const out: IcuSubMessage[] = [];
  let depth = 0;
  let partStart = 0;

  const push = (from: number, to: number): void => {
    const part = body.slice(from, to);
    const selector = RE_CHOICE_SELECTOR.exec(part);
    // A branch without a selector is malformed; keeping its text is safer than
    // dropping copy, so the whole part is treated as the message.
    const textStart = selector ? selector[0].length : 0;
    out.push({
      index: bodyOffset + from + textStart,
      text: part.slice(textStart),
    });
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "|" && depth === 0) {
      push(partStart, i);
      partStart = i + 1;
    }
  }
  push(partStart, body.length);
  return out;
}

/**
 * Recognise a complex ICU argument inside an already-balanced `{...}` span.
 *
 * `offset` is the absolute index of the opening brace, so the returned
 * sub-message indices are absolute in the original source string.
 * Returns `null` for simple arguments (`{name}`, `{amount, number, ::.00}`),
 * which have no translatable body.
 */
export function parseComplexIcuArgument(
  raw: string,
  offset = 0,
): IcuComplexArgument | null {
  if (raw.length < 2 || !raw.startsWith("{") || !raw.endsWith("}")) return null;
  const inner = raw.slice(1, -1);
  const head = RE_COMPLEX_HEAD.exec(inner);
  if (!head) return null;
  const keyword = head[1];
  if (keyword === undefined) return null;
  const arg = normaliseArgName(inner);
  if (arg.length === 0) return null;

  const body = inner.slice(head[0].length);
  const bodyOffset = offset + 1 + head[0].length;
  const format = keyword.toLowerCase() as IcuComplexFormat;
  const subMessages =
    format === "choice"
      ? collectChoiceSubMessages(body, bodyOffset)
      : collectBracedSubMessages(body, bodyOffset);

  // A `plural` with no branch at all carries no copy; treating it as complex
  // would only add an empty recursion.
  if (subMessages.length === 0) return null;
  return { arg, format, subMessages };
}

/**
 * Strip formatting options from an argument body: i18next's
 * `{{count, number}}` and ICU's `{count, plural, ...}` both identify the same
 * variable, and parity checks care about the variable, not the format.
 */
function normaliseArgName(inner: string): string {
  const comma = inner.indexOf(",");
  const head = comma >= 0 ? inner.slice(0, comma) : inner;
  return head.trim();
}

export function extractPlaceholders(value: string): Placeholder[] {
  const found: Placeholder[] = [];
  let i = 0;

  while (i < value.length) {
    const ch = value[i];
    let match: Match | null = null;

    if (ch === "$") {
      match = matchI18nextNesting(value, i) ?? matchDollarBrace(value, i);
    } else if (ch === "{") {
      match = matchDoubleBrace(value, i) ?? matchBraceArgument(value, i);
    } else if (ch === "%") {
      const result = matchPercent(value, i);
      if (result === "escaped") {
        i += 2;
        continue;
      }
      match = result;
    } else if (ch === "<") {
      match = matchAngleTag(value, i);
    }

    if (match) {
      found.push({
        raw: match.raw,
        kind: match.kind,
        token: match.token,
        index: i,
      });
      // An ICU plural/select block is one placeholder for parity purposes, but
      // its branches are ordinary messages: recurse so `{name}`, `<b>` and `%s`
      // living inside `one {...}` are visible to parity checks instead of being
      // swallowed by the parent span.
      const complex = parseComplexIcuArgument(match.raw, i);
      if (complex) {
        for (const sub of complex.subMessages) {
          for (const nested of extractPlaceholders(sub.text)) {
            found.push({ ...nested, index: nested.index + sub.index });
          }
        }
      }
      i += match.raw.length;
    } else {
      i += 1;
    }
  }

  return found;
}

/**
 * The placeholders whose spans are disjoint: the ones nested inside an ICU
 * complex argument are dropped, keeping their enclosing block.
 *
 * Parity checks want the full list (a dropped `{name}` inside `one {...}` is a
 * real defect). Anything that *rewrites* the string by walking spans with a
 * cursor — segmenters, escapers, highlighters — wants this list instead, since
 * a contained span would otherwise be emitted twice.
 */
export function topLevelPlaceholders(
  placeholders: readonly Placeholder[],
): Placeholder[] {
  const ordered = [...placeholders].sort(
    (a, b) => a.index - b.index || b.raw.length - a.raw.length,
  );
  const out: Placeholder[] = [];
  let cursor = 0;
  for (const p of ordered) {
    if (p.index < cursor) continue;
    out.push(p);
    cursor = p.index + p.raw.length;
  }
  return out;
}

/**
 * The prose of an ICU complex argument: its sub-messages with their own
 * placeholders and the `#` number sign removed, and the skeleton (`{count,
 * plural, one {`, category keywords, `offset:`, closing braces) dropped.
 *
 * Returns `null` when `raw` is not a complex argument, i.e. when the span
 * really is an opaque placeholder.
 */
function icuBranchProse(raw: string): string | null {
  const complex = parseComplexIcuArgument(raw);
  if (complex === null) return null;
  const parts: string[] = [];
  for (const sub of complex.subMessages) {
    // `#` stands for the formatted number, so it is skeleton, not copy.
    parts.push(
      stripPlaceholders(sub.text, extractPlaceholders(sub.text)).replace(
        /#/g,
        " ",
      ),
    );
  }
  return parts.join(" ");
}

/**
 * Everything that is not a placeholder. Used to decide whether a string is
 * "100% placeholder" and therefore untranslatable, and to spot stray braces.
 *
 * Two subtleties:
 *  - Placeholders nested inside an ICU complex argument are contained in their
 *    parent's span. They are skipped here (the parent consumes them) so no
 *    region is subtracted twice.
 *  - Only the ICU *skeleton* of a complex argument is subtracted; the branch
 *    prose survives. `{count, plural, one {# seat} other {# seats}}` is real
 *    copy — treating it as pure placeholder is how English leaks into every
 *    target locale.
 */
export function stripPlaceholders(
  value: string,
  placeholders: readonly Placeholder[],
): string {
  if (placeholders.length === 0) return value;
  const ordered = [...placeholders].sort(
    (a, b) => a.index - b.index || b.raw.length - a.raw.length,
  );
  let out = "";
  let cursor = 0;
  for (const p of ordered) {
    if (p.index < cursor) continue; // contained in a span already consumed
    out += value.slice(cursor, p.index);
    out += icuBranchProse(p.raw) ?? "";
    cursor = p.index + p.raw.length;
  }
  out += value.slice(cursor);
  return out;
}
