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
 * as `raw` means the inner sub-messages are not double-counted as separate
 * placeholders, while `token` still exposes the argument name for parity.
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
      i += match.raw.length;
    } else {
      i += 1;
    }
  }

  return found;
}

/**
 * Everything that is not a placeholder, with whitespace collapsed. Used to
 * decide whether a string is "100% placeholder" and therefore untranslatable.
 */
export function stripPlaceholders(
  value: string,
  placeholders: readonly Placeholder[],
): string {
  if (placeholders.length === 0) return value;
  let out = "";
  let cursor = 0;
  for (const p of placeholders) {
    out += value.slice(cursor, p.index);
    cursor = p.index + p.raw.length;
  }
  out += value.slice(cursor);
  return out;
}
