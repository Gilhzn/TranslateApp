import {
  extractPlaceholders,
  parseComplexIcuArgument,
  type IcuComplexFormat,
  type IcuSubMessage,
} from "@/lib/core";
import type { Placeholder } from "@/lib/types";

/**
 * ICU complex-argument structure, as validation needs to see it.
 *
 * The extractor reports a `{count, plural, one {…} other {…}}` span as ONE
 * placeholder and then appends every placeholder found inside its branches,
 * with absolute indices, *contained* in the parent span. Validation cannot treat
 * that flattened list as a multiset: the number of branches is a property of the
 * TARGET language, not of the string. English and German have two CLDR plural
 * categories, Japanese has one, Russian and Polish four, Arabic six. A correct
 * Russian translation of a two-branch English plural therefore repeats every
 * branch-internal placeholder four times, and any check that compares
 * occurrence counts across the block boundary rejects it.
 *
 * So the block is compared *structurally* — same argument, same format — and its
 * branches are compared with a set invariant that is stable across locales:
 *   - a branch may only use placeholders that some source branch uses;
 *   - a branch must use every placeholder that EVERY source branch uses.
 * Anything the source uses in only some of its branches (an `=0` branch that
 * omits the number, say) is optional in the target.
 */

export interface IcuBranch {
  /** Selector keyword as written: `one`, `few`, `=0`, `0#`, `male`. */
  label: string;
  /** Absolute index of the first character of the branch body. */
  index: number;
  text: string;
  /** Placeholders inside this branch, carrying absolute indices. */
  placeholders: Placeholder[];
}

export interface IcuBlock {
  /** The whole-span placeholder this block was read from. */
  placeholder: Placeholder;
  /** Argument name or index, e.g. `count`. */
  arg: string;
  format: IcuComplexFormat;
  branches: IcuBranch[];
}

/**
 * Recover the selector that introduces a branch.
 *
 * `parseComplexIcuArgument` deliberately drops the skeleton, but a repair prompt
 * that says "the `few` branch is missing {name}" is worth far more than one that
 * says "a branch is missing {name}", so the keyword is read back out of the raw
 * span: walk left from the branch's opening brace, over any whitespace, and take
 * the run of characters up to the previous delimiter. That yields `one`, `=0`,
 * `few` and — for `offset:1 one {…}` — `one` rather than the offset clause.
 */
function branchLabel(
  raw: string,
  blockIndex: number,
  sub: IcuSubMessage,
  format: IcuComplexFormat,
): string {
  const relative = sub.index - blockIndex;
  // `choice` branches are not braced: the selector (`0#`, `1<`) sits directly
  // before the body, so there is no brace to step over.
  let end = format === "choice" ? relative : relative - 1;
  if (end < 0 || end > raw.length) return "";
  while (end > 0 && /\s/.test(raw[end - 1] ?? "")) end -= 1;
  let start = end;
  while (start > 0) {
    const ch = raw[start - 1];
    if (ch === undefined || /[\s,{}|]/.test(ch)) break;
    start -= 1;
  }
  return raw.slice(start, end);
}

/**
 * Read a placeholder as a complex ICU argument, or `null` when it is a simple
 * one (`{name}`, `{amount, number, ::.00}`) with no translatable body.
 *
 * Branch placeholders are re-extracted from the branch text rather than filtered
 * out of a caller-supplied list, so the result is correct whether the caller
 * holds the full contained list or only the top-level one.
 */
export function readIcuBlock(p: Placeholder): IcuBlock | null {
  const complex = parseComplexIcuArgument(p.raw, p.index);
  if (complex === null) return null;
  const branches: IcuBranch[] = complex.subMessages.map((sub, i) => ({
    label: branchLabel(p.raw, p.index, sub, complex.format) || `#${i + 1}`,
    index: sub.index,
    text: sub.text,
    placeholders: extractPlaceholders(sub.text).map((q) => ({
      ...q,
      index: q.index + sub.index,
    })),
  }));
  return {
    placeholder: p,
    arg: complex.arg,
    format: complex.format,
    branches,
  };
}

/** Every complex block among a list of *top-level* placeholders. */
export function readIcuBlocks(list: readonly Placeholder[]): IcuBlock[] {
  const out: IcuBlock[] = [];
  for (const p of list) {
    const block = readIcuBlock(p);
    if (block !== null) out.push(block);
  }
  return out;
}

export function isComplexIcu(p: Placeholder): boolean {
  return parseComplexIcuArgument(p.raw) !== null;
}

/** `{count}` — the argument alone, never the branch prose. */
export function icuArgumentReference(arg: string): string {
  return `{${arg}}`;
}

/**
 * How a placeholder may be named in a message that reaches the model.
 *
 * For a complex argument this MUST NOT be the raw span: the span contains
 * English prose, and a prompt that quotes it is a prompt that tells the model to
 * paste untranslated English into the output.
 */
export function describePlaceholder(p: Placeholder): string {
  const complex = parseComplexIcuArgument(p.raw);
  if (complex === null) return JSON.stringify(p.raw);
  return `the ICU ${complex.format} block for ${icuArgumentReference(complex.arg)}`;
}

/**
 * What the target must supply in place of the source's branch set.
 *
 * Takes a plain `string` because callers also reach it from an `Issue.detail`
 * payload, which is untyped by the contract.
 */
export function branchExpectation(format: string): string {
  return format === "plural" || format === "selectordinal"
    ? "use the plural categories your language actually requires — add or drop branches as CLDR demands"
    : "keep the same selector keys as the source";
}

/** Join a nested branch path for `detail.branch`, e.g. `few › one`. */
export function joinBranchPath(parent: string | null, label: string): string {
  return parent === null || parent.length === 0 ? label : `${parent} › ${label}`;
}
