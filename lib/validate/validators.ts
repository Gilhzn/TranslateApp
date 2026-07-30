import {
  extractPlaceholders,
  stripPlaceholders,
  topLevelPlaceholders,
} from "@/lib/core";
import {
  branchExpectation,
  describePlaceholder,
  icuArgumentReference,
  joinBranchPath,
  readIcuBlock,
  readIcuBlocks,
  type IcuBlock,
  type IcuBranch,
} from "./icu";
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

// ---------------------------------------------------------------------------
// Angle-tag shape (name + attributes)
// ---------------------------------------------------------------------------

/**
 * The parsed form of an angle-tag placeholder.
 *
 * Attributes matter for parity because `<a href="/terms">` and
 * `<a href="/bedingungen">` are *not* the same tag: the second one is a 404 in
 * production. The extractor keeps the full tag in `Placeholder.raw` but
 * normalises `token` to the element name alone, so anything that compares tags
 * has to re-parse `raw` — which is what this does.
 */
export interface AngleTagShape {
  /** Element name exactly as written, e.g. "a", "Link", "0". */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /**
   * Attribute name → value. Names are lowercased (HTML attribute names are
   * case-insensitive); values are kept verbatim, minus the quotes.
   *
   * A valueless boolean attribute (`<input disabled>`) normalises to `""`
   * because HTML defines `disabled` and `disabled=""` as the same thing —
   * treating them as different would fire on correct markup.
   *
   * Insertion order is the source order, but callers must treat attribute
   * ORDER as insignificant: `<a href="/t" id="x">` and `<a id="x" href="/t">`
   * are the same element.
   */
  attributes: Map<string, string>;
}

function isSpaceChar(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * Parse the attribute list of a tag body (everything after the element name and
 * before the closing `>`/`/>`).
 *
 * Hand-written rather than regex-driven because all four real-world spellings
 * have to survive: `href="/a"`, `href='/a'`, `href=/a` (unquoted) and a bare
 * `disabled`. Duplicate names keep the FIRST occurrence, matching how browsers
 * resolve them.
 */
function parseTagAttributes(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;

  while (i < body.length) {
    const ch = body[i];
    if (ch === undefined) break;
    if (isSpaceChar(ch) || ch === "/") {
      i += 1;
      continue;
    }

    const nameStart = i;
    while (i < body.length) {
      const c = body[i];
      if (c === undefined || isSpaceChar(c) || c === "=" || c === "/") break;
      i += 1;
    }
    const name = body.slice(nameStart, i).toLowerCase();
    if (name.length === 0) {
      i += 1;
      continue;
    }

    let cursor = i;
    while (cursor < body.length && isSpaceChar(body[cursor])) cursor += 1;

    if (body[cursor] !== "=") {
      // Valueless boolean attribute. Do not consume the whitespace run — the
      // outer loop skips it — but do resume from where the lookahead stopped.
      if (!out.has(name)) out.set(name, "");
      i = cursor;
      continue;
    }

    cursor += 1; // past "="
    while (cursor < body.length && isSpaceChar(body[cursor])) cursor += 1;

    const quote = body[cursor];
    if (quote === '"' || quote === "'") {
      const close = body.indexOf(quote, cursor + 1);
      const end = close < 0 ? body.length : close;
      if (!out.has(name)) out.set(name, body.slice(cursor + 1, end));
      i = close < 0 ? body.length : close + 1;
      continue;
    }

    let end = cursor;
    while (end < body.length && !isSpaceChar(body[end])) end += 1;
    if (!out.has(name)) out.set(name, body.slice(cursor, end));
    i = end;
  }

  return out;
}

/** `<`, an optional `/`, then the element name. */
const RE_TAG_HEAD = /^<(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]*|\d+)/;

/**
 * Parse an angle-tag placeholder's `raw` into name + attributes.
 *
 * Returns `null` for anything that is not a tag, so callers can fall back to
 * name-only behaviour rather than inventing a shape for garbage input.
 */
export function parseAngleTag(raw: string): AngleTagShape | null {
  const head = RE_TAG_HEAD.exec(raw);
  if (head === null) return null;
  const name = head[2];
  if (name === undefined) return null;

  // The extractor's tag pattern forbids `<`/`>` inside the attribute run, so
  // the last `>` is always the tag terminator.
  const close = raw.lastIndexOf(">");
  const bodyEnd = close >= head[0].length ? close : raw.length;
  let body = raw.slice(head[0].length, bodyEnd);

  let selfClosing = false;
  const trimmed = body.trimEnd();
  if (trimmed.endsWith("/")) {
    selfClosing = true;
    body = trimmed.slice(0, -1);
  }

  return {
    name,
    closing: head[1] === "/",
    selfClosing,
    attributes: parseTagAttributes(body),
  };
}

/**
 * Canonical attribute rendering for identity purposes: sorted by name so
 * ordering is insignificant, and JSON-quoted so quote style and embedded
 * quotes cannot collide (`title='He said "hi"'` vs `title="He said &quot;hi"`).
 */
function serialiseAttributes(attributes: ReadonlyMap<string, string>): string {
  if (attributes.size === 0) return "";
  const parts = [...attributes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return `[${parts.join(" ")}]`;
}

/**
 * Parity identity of a placeholder.
 *
 * Kind is part of the identity because a model that rewrites `{{user}}` as
 * `{user}` has broken i18next just as thoroughly as if it had deleted the
 * placeholder. Angle tags additionally distinguish open / close / self-closing,
 * so `<b>` and `</b>` are two different obligations rather than one counted
 * twice.
 *
 * An OPENING tag's attributes are part of its identity: `<a href="/terms">` and
 * `<a href="/bedingungen">` point at different pages, and a translation that
 * "helpfully" localises the URL ships a dead link. Closing tags carry no
 * attributes, and attribute-free tags (`<b>`, `<0>`) serialise to exactly the
 * string they always did — so react-i18next `<Trans>` catalogues are unaffected.
 */
export function placeholderIdentity(p: Placeholder): string {
  if (p.kind === "angle-tag") {
    const shape = parseAngleTag(p.raw);
    if (shape === null) {
      // Unparseable: fall back to the name-only identity rather than treating
      // every malformed tag as its own unique obligation.
      if (p.raw.startsWith("</")) return `angle:/${p.token}`;
      if (/\/\s*>$/.test(p.raw)) return `angle:${p.token}/`;
      return `angle:${p.token}`;
    }
    if (shape.closing) return `angle:/${p.token}`;
    const attrs = serialiseAttributes(shape.attributes);
    return shape.selfClosing
      ? `angle:${p.token}${attrs}/`
      : `angle:${p.token}${attrs}`;
  }
  return `${p.kind}:${p.token}`;
}

/** A printf spec with no explicit `n$` argument index — order is the binding. */
function isPositionalPrintf(p: Placeholder): boolean {
  return p.kind === "printf" && !/^\d+$/.test(p.token);
}

/**
 * Occurrence count per identity.
 *
 * Callers MUST pass a list of *disjoint* placeholders (see
 * {@link topLevelPlaceholders}). Feeding it the raw extraction result would
 * count an ICU plural block once for the whole span and once more for every
 * placeholder inside every branch — and since the branch count is a property of
 * the target language, that inflated total can never match across locales.
 */
function countIdentities(list: readonly Placeholder[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of list) {
    const id = placeholderIdentity(p);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Distinct identities of a list of disjoint placeholders. */
function identitySet(list: readonly Placeholder[]): Set<string> {
  const out = new Set<string>();
  for (const p of list) out.add(placeholderIdentity(p));
  return out;
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

/**
 * The parts of a placeholder that are machine-read rather than human copy.
 *
 * For a simple placeholder that is the whole raw span. For a complex ICU
 * argument it is the skeleton only — `{count, plural, one {` and friends — with
 * the branch bodies blanked out, because those bodies are prose whose own
 * placeholders are separately present in the extraction result. Scanning the
 * whole span instead would report one defect twice: once against the nested
 * placeholder and once against the block that contains it.
 */
function placeholderSkeleton(p: Placeholder): string {
  const block = readIcuBlock(p);
  if (block === null) return p.raw;
  let out = "";
  let cursor = 0;
  for (const branch of block.branches) {
    const start = branch.index - p.index;
    if (start < cursor) continue;
    out += p.raw.slice(cursor, start);
    cursor = start + branch.text.length;
  }
  return out + p.raw.slice(cursor);
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

// ---------------------------------------------------------------------------
// Angle-tag attribute parity
// ---------------------------------------------------------------------------

interface OpeningTag {
  placeholder: Placeholder;
  shape: AngleTagShape;
}

/**
 * Non-closing angle tags, bucketed by element name and self-closing form.
 *
 * The bucket key deliberately excludes attributes — pairing has to happen
 * BEFORE attributes are compared. Self-closing form is part of the key because
 * `<img/>` and `<img>` already differ in identity, so pairing them would report
 * an attribute diff on top of a shape diff for the same mistake.
 */
function groupOpeningTags(
  list: readonly Placeholder[],
): Map<string, OpeningTag[]> {
  const groups = new Map<string, OpeningTag[]>();
  for (const p of list) {
    if (p.kind !== "angle-tag") continue;
    const shape = parseAngleTag(p.raw);
    if (shape === null || shape.closing) continue;
    const key = `${shape.name.toLowerCase()}${shape.selfClosing ? "/" : ""}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [{ placeholder: p, shape }]);
    else bucket.push({ placeholder: p, shape });
  }
  return groups;
}

type AttributeReason =
  | "attribute-drift"
  | "attribute-missing"
  | "attribute-added";

interface AttributeDiff {
  attribute: string;
  /** Source value; `null` when the source has no such attribute. */
  expected: string | null;
  /** Target value; `null` when the target dropped it. */
  actual: string | null;
  reason: AttributeReason;
}

/** Ordered, deterministic diff: source attributes first, then target-only ones. */
function diffAttributes(
  source: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): AttributeDiff[] {
  const out: AttributeDiff[] = [];
  const names = [...source.keys()].sort();
  for (const attribute of names) {
    const expected = source.get(attribute);
    if (expected === undefined) continue;
    const actual = target.get(attribute);
    if (actual === undefined) {
      out.push({ attribute, expected, actual: null, reason: "attribute-missing" });
    } else if (actual !== expected) {
      out.push({ attribute, expected, actual, reason: "attribute-drift" });
    }
  }
  for (const attribute of [...target.keys()].sort()) {
    if (source.has(attribute)) continue;
    const actual = target.get(attribute);
    if (actual === undefined) continue;
    out.push({ attribute, expected: null, actual, reason: "attribute-added" });
  }
  return out;
}

function attributeIssue(
  source: OpeningTag,
  diff: AttributeDiff,
  ctx: ValidationContext | undefined,
): Issue {
  const tag = `<${source.shape.name}>`;
  const exactly = `reproduce the tag exactly as ${source.placeholder.raw}.`;
  const notContent = "Attribute values are not translatable content";

  let message: string;
  if (diff.reason === "attribute-drift") {
    message =
      `The ${tag} tag's ${diff.attribute} attribute changed from ` +
      `${JSON.stringify(diff.expected ?? "")} to ${JSON.stringify(diff.actual ?? "")}. ` +
      `${notContent} — ${exactly}`;
  } else if (diff.reason === "attribute-missing") {
    message =
      `The ${tag} tag lost its ${diff.attribute} attribute ` +
      `(${diff.attribute}=${JSON.stringify(diff.expected ?? "")}). ` +
      `${notContent} — ${exactly}`;
  } else {
    message =
      `The ${tag} tag gained a ${diff.attribute} attribute ` +
      `(${diff.attribute}=${JSON.stringify(diff.actual ?? "")}) that the source does not have. ` +
      `${notContent} — ${exactly}`;
  }

  return classify(
    "placeholder-malformed",
    message,
    opts(ctx, {
      raw: source.placeholder.raw,
      token: source.placeholder.token,
      kind: source.placeholder.kind,
      attribute: diff.attribute,
      expected: diff.expected,
      actual: diff.actual,
      reason: diff.reason,
    }),
  );
}

/**
 * Compare the attributes of tags that the target *did* reproduce.
 *
 * Runs BEFORE the multiset comparison and records the identities it explains,
 * because an attribute edit changes a tag's identity and would otherwise
 * surface as the baffling pair "`<a href="/terms">` is missing" +
 * "`<a href="/bedingungen">` was added" for what is one mistake with one fix.
 *
 * Tags are paired by element name and position-in-sequence, NOT by attributes:
 * that is what makes two sibling links with their hrefs swapped report as two
 * attribute changes. Pairing by attribute value would match them up and see
 * nothing wrong, which is the exact bug this check exists to close. Surplus
 * tags on either side are left to the missing/added checks, where "the tag
 * itself is absent" is the accurate description.
 */
function checkTagAttributes(
  sourceList: readonly Placeholder[],
  targetList: readonly Placeholder[],
  ctx: ValidationContext | undefined,
  explainedIdentities: Set<string>,
): Issue[] {
  const issues: Issue[] = [];
  const sourceGroups = groupOpeningTags(sourceList);
  if (sourceGroups.size === 0) return issues;
  const targetGroups = groupOpeningTags(targetList);

  for (const [key, sourceTags] of sourceGroups) {
    const targetTags = targetGroups.get(key);
    if (targetTags === undefined) continue;
    const pairs = Math.min(sourceTags.length, targetTags.length);
    for (let i = 0; i < pairs; i++) {
      const sourceTag = sourceTags[i];
      const targetTag = targetTags[i];
      if (sourceTag === undefined || targetTag === undefined) continue;
      const diffs = diffAttributes(
        sourceTag.shape.attributes,
        targetTag.shape.attributes,
      );
      if (diffs.length === 0) continue;
      explainedIdentities.add(placeholderIdentity(sourceTag.placeholder));
      explainedIdentities.add(placeholderIdentity(targetTag.placeholder));
      for (const diff of diffs) {
        issues.push(attributeIssue(sourceTag, diff, ctx));
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// ICU complex-argument parity
// ---------------------------------------------------------------------------

/**
 * Result of the structural pass over `plural` / `select` / `selectordinal` /
 * `choice` arguments.
 *
 * `explained` lists the identities this pass owns. The multiset comparison must
 * skip them: it can only see "the block is there / not there", and its message
 * would quote the block's raw span — English prose the model would then be told
 * to reproduce character for character.
 */
interface ComplexParityResult {
  issues: Issue[];
  explained: Set<string>;
}

function icuDetail(
  arg: string,
  format: string,
  branch: string | null,
  extra: IssueDetail = {},
): IssueDetail {
  const detail: IssueDetail = { icu: true, icuArg: arg, icuFormat: format, ...extra };
  if (branch !== null) detail["branch"] = branch;
  return detail;
}

function groupBlocksByArg(blocks: readonly IcuBlock[]): Map<string, IcuBlock[]> {
  const out = new Map<string, IcuBlock[]>();
  for (const block of blocks) {
    const bucket = out.get(block.arg);
    if (bucket === undefined) out.set(block.arg, [block]);
    else bucket.push(block);
  }
  return out;
}

/**
 * The source branch a target branch is compared against for *attribute* parity.
 *
 * Branch sets do not line up across locales, so there is no positional pairing
 * to be had. The same selector is the best match; `other` is the canonical
 * fallback because CLDR guarantees every language has it; failing both, the last
 * branch (which for `select` is the default). This only ever decides which tag's
 * attributes are compared with which — the missing/added invariants below use
 * the union/intersection over ALL source branches and never this one branch.
 */
function representativeSourceBranch(
  source: IcuBlock,
  label: string,
): IcuBranch | undefined {
  return (
    source.branches.find((b) => b.label === label) ??
    source.branches.find((b) => b.label === "other") ??
    source.branches[source.branches.length - 1]
  );
}

function firstOccurrenceByIdentity(
  branches: readonly IcuBranch[],
): Map<string, Placeholder> {
  const out = new Map<string, Placeholder>();
  for (const branch of branches) {
    for (const p of topLevelPlaceholders(branch.placeholders)) {
      const id = placeholderIdentity(p);
      if (!out.has(id)) out.set(id, p);
    }
  }
  return out;
}

/**
 * Compare the branches of two paired complex arguments.
 *
 * The invariant is deliberately a SET invariant, never a count one:
 *   - `union` — every placeholder any source branch uses. A target branch that
 *     uses something outside this set invented an interpolation.
 *   - `required` — the intersection: placeholders every source branch uses.
 *     Those are structural (`{name}` in "{name} added a file"), so every target
 *     branch must carry them. Anything the source uses in only some branches is
 *     optional, because the branch that omits it proves it is omissible.
 *
 * Branch COUNT is never compared. `en` has `one`/`other`, `ja` has `other`,
 * `ru`/`pl` have `one`/`few`/`many`/`other`, `ar` has six: matching English's
 * branch count is a bug in the translation, not a requirement.
 */
function compareIcuBlocks(
  source: IcuBlock,
  target: IcuBlock,
  ctx: ValidationContext | undefined,
  parentPath: string | null,
  issues: Issue[],
): void {
  if (source.format !== target.format) {
    issues.push(
      classify(
        "placeholder-malformed",
        `The ICU argument ${icuArgumentReference(source.arg)} is a "${source.format}" in the source but a "${target.format}" in the translation. Keep the same format type.`,
        opts(
          ctx,
          icuDetail(source.arg, source.format, parentPath, {
            actualFormat: target.format,
            reason: "icu-format-changed",
            token: source.arg,
          }),
        ),
      ),
    );
    // Branch semantics differ entirely between formats; comparing them now
    // would bury the one actionable finding under derived noise.
    return;
  }

  const branchIdentities = source.branches.map((b) =>
    identitySet(topLevelPlaceholders(b.placeholders)),
  );
  const union = new Set<string>();
  for (const set of branchIdentities) for (const id of set) union.add(id);

  let required: Set<string> | null = null;
  for (const set of branchIdentities) {
    if (required === null) {
      required = new Set(set);
      continue;
    }
    for (const id of [...required]) if (!set.has(id)) required.delete(id);
  }
  const requiredIds = required ?? new Set<string>();
  const examples = firstOccurrenceByIdentity(source.branches);

  for (const targetBranch of target.branches) {
    const path = joinBranchPath(parentPath, targetBranch.label);
    const targetTop = topLevelPlaceholders(targetBranch.placeholders);
    const targetIds = identitySet(targetTop);

    // Attribute drift inside a branch is a distinct, more precise finding than
    // "identity X missing, identity Y added"; run it first and let it claim the
    // identities it explains.
    const explained = new Set<string>();
    const representative = representativeSourceBranch(source, targetBranch.label);
    if (representative !== undefined) {
      issues.push(
        ...checkTagAttributes(
          topLevelPlaceholders(representative.placeholders),
          targetTop,
          ctx,
          explained,
        ),
      );
    }

    for (const id of requiredIds) {
      if (targetIds.has(id) || explained.has(id)) continue;
      const example = examples.get(id);
      if (example === undefined) continue;
      issues.push(
        classify(
          "placeholder-missing",
          `The "${path}" branch of the ICU ${source.format} for ${icuArgumentReference(source.arg)} is missing ${describePlaceholder(example)}. Every branch of the source carries it, so every branch of the translation must too.`,
          opts(
            ctx,
            icuDetail(source.arg, source.format, path, {
              raw: example.raw,
              token: example.token,
              kind: example.kind,
            }),
          ),
        ),
      );
    }

    for (const p of targetTop) {
      const id = placeholderIdentity(p);
      if (union.has(id) || explained.has(id)) continue;
      issues.push(
        classify(
          "placeholder-added",
          `The "${path}" branch of the ICU ${source.format} for ${icuArgumentReference(source.arg)} uses ${describePlaceholder(p)}, which no branch of the source uses. Remove it.`,
          opts(
            ctx,
            icuDetail(source.arg, source.format, path, {
              raw: p.raw,
              token: p.token,
              kind: p.kind,
            }),
          ),
        ),
      );
    }

    // Nested complex arguments (a `select` inside a `plural` branch) get the
    // same treatment, one level down, so their branch counts are just as free.
    for (const p of targetTop) {
      const nestedTarget = readIcuBlock(p);
      if (nestedTarget === null) continue;
      const sourceExample = examples.get(placeholderIdentity(p));
      if (sourceExample === undefined) continue;
      const nestedSource = readIcuBlock(sourceExample);
      if (nestedSource === null) continue;
      compareIcuBlocks(nestedSource, nestedTarget, ctx, path, issues);
    }
  }
}

/**
 * Pair complex ICU arguments by argument name and compare them structurally.
 *
 * Pairing by NAME rather than by position or count is what makes this survive
 * reordering and locale-driven branch differences. The two failure modes worth
 * reporting are "the block for {count} is gone" (usually the model flattened the
 * plural into one form, which breaks every count but one) and "the translation
 * invented a block for an argument the string does not have".
 *
 * The reverse — the source has a plain `{count}` and the translation wraps it in
 * a plural — is NOT reported. Languages with richer plural systems than English
 * legitimately need a plural block where English needed none, and rejecting that
 * would punish the best translations.
 */
function checkComplexArguments(
  sourceTop: readonly Placeholder[],
  targetTop: readonly Placeholder[],
  ctx: ValidationContext | undefined,
): ComplexParityResult {
  const issues: Issue[] = [];
  const explained = new Set<string>();

  const sourceBlocks = readIcuBlocks(sourceTop);
  const targetBlocks = readIcuBlocks(targetTop);
  if (sourceBlocks.length === 0 && targetBlocks.length === 0) {
    return { issues, explained };
  }

  for (const block of sourceBlocks) {
    explained.add(placeholderIdentity(block.placeholder));
  }
  for (const block of targetBlocks) {
    explained.add(placeholderIdentity(block.placeholder));
  }

  const sourceIds = identitySet(sourceTop);
  const byArgSource = groupBlocksByArg(sourceBlocks);
  const byArgTarget = groupBlocksByArg(targetBlocks);

  for (const [arg, sourceList] of byArgSource) {
    const targetList = byArgTarget.get(arg) ?? [];
    const pairs = Math.min(sourceList.length, targetList.length);
    for (let i = 0; i < pairs; i++) {
      const s = sourceList[i];
      const t = targetList[i];
      if (s === undefined || t === undefined) continue;
      compareIcuBlocks(s, t, ctx, null, issues);
    }
    for (let i = pairs; i < sourceList.length; i++) {
      const s = sourceList[i];
      if (s === undefined) continue;
      issues.push(
        classify(
          "placeholder-missing",
          `The translation is missing the ICU ${s.format} for ${icuArgumentReference(s.arg)}. Keep the block — write ${icuArgumentReference(s.arg)} as a ${s.format} argument, translate the text inside each branch, and ${branchExpectation(s.format)}. Do not flatten it to a single form.`,
          opts(
            ctx,
            icuDetail(s.arg, s.format, null, {
              token: s.placeholder.token,
              kind: s.placeholder.kind,
              reason: "icu-block-missing",
            }),
          ),
        ),
      );
    }
  }

  for (const [arg, targetList] of byArgTarget) {
    const sourceList = byArgSource.get(arg) ?? [];
    for (let i = sourceList.length; i < targetList.length; i++) {
      const t = targetList[i];
      if (t === undefined) continue;
      const identity = placeholderIdentity(t.placeholder);
      if (sourceIds.has(identity)) {
        // The source has a plain `{count}` here and the translation promoted it
        // to a plural. That is correct localisation, not a defect — but the
        // branches it invented still may not reference unknown arguments.
        for (const branch of t.branches) {
          for (const p of topLevelPlaceholders(branch.placeholders)) {
            if (sourceIds.has(placeholderIdentity(p))) continue;
            issues.push(
              classify(
                "placeholder-added",
                `The "${branch.label}" branch of the ICU ${t.format} for ${icuArgumentReference(t.arg)} uses ${describePlaceholder(p)}, which the source string does not contain. Remove it.`,
                opts(
                  ctx,
                  icuDetail(t.arg, t.format, branch.label, {
                    raw: p.raw,
                    token: p.token,
                    kind: p.kind,
                  }),
                ),
              ),
            );
          }
        }
        continue;
      }
      issues.push(
        classify(
          "placeholder-added",
          `The translation adds an ICU ${t.format} for ${icuArgumentReference(t.arg)}, but ${icuArgumentReference(t.arg)} is not an argument of the source string. Remove it — the runtime has no value to pass in.`,
          opts(
            ctx,
            icuDetail(t.arg, t.format, null, {
              token: t.placeholder.token,
              kind: t.placeholder.kind,
              reason: "icu-block-added",
            }),
          ),
        ),
      );
    }
  }

  return { issues, explained };
}

/**
 * Compare placeholders by normalised token MULTISET, then by order — but only
 * across placeholders whose spans are DISJOINT.
 *
 * Counts, not sets: "{name} and {name}" needs `{name}` twice in the target, and
 * a model that emits it once has silently dropped an interpolation site.
 *
 * The multiset is built from {@link topLevelPlaceholders}, so an ICU
 * plural/select block counts once and the placeholders inside its branches are
 * NOT folded into the same buckets. Those branches are compared separately by
 * {@link checkComplexArguments} with a locale-stable set invariant, because the
 * number of branches — and therefore the number of times anything inside them
 * occurs — is decided by the target language's CLDR plural rules, not by the
 * source.
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

  // Disjoint views. Everything that compares COUNTS has to use these: a
  // placeholder inside a plural branch is contained in the block's span, and the
  // number of branches is a property of the target language.
  const sourceTop = topLevelPlaceholders(sourceList);
  const targetTop = topLevelPlaceholders(targetList);

  // --- 1. Placeholders that were recognised but carry invisible junk --------
  for (const p of targetList) {
    const bad = invisibleInsidePlaceholder(placeholderSkeleton(p));
    if (bad !== null) {
      issues.push(
        classify(
          "placeholder-malformed",
          `Placeholder ${describePlaceholder(p)} contains an invisible character (${formatCodePoint(bad)}) inside its delimiters; at runtime the interpolation key will not match.`,
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
  const sourceStray = strayBraceCount(source, sourceTop);
  const targetStray = strayBraceCount(target, targetTop);
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
  const sourceCounts = countIdentities(sourceTop);
  const targetCounts = countIdentities(targetTop);
  const sourceFirst = firstByIdentity(sourceTop);
  const targetFirst = firstByIdentity(targetTop);

  // Tokens whose absence is already explained by a corrupted echo. Whatever
  // mangled form the model wrote is *the same placeholder*, so reporting it a
  // second time as "added" would be double-counting one mistake.
  const explainedTokens = new Set<string>();
  /** Identities already accounted for by a more precise attribute report. */
  const explainedIdentities = new Set<string>();

  // Attribute drift first: it explains identities that would otherwise read as
  // a missing/added pair.
  issues.push(
    ...checkTagAttributes(sourceTop, targetTop, ctx, explainedIdentities),
  );

  // --- 4b. ICU complex arguments, compared structurally --------------------
  // Runs before the multiset loops and claims the block identities, whose
  // whole-span raw must never reach a message.
  const complex = checkComplexArguments(sourceTop, targetTop, ctx);
  issues.push(...complex.issues);

  for (const [id, want] of sourceCounts) {
    const have = targetCounts.get(id) ?? 0;
    if (have >= want) continue;
    if (explainedIdentities.has(id)) continue;
    if (complex.explained.has(id)) continue;
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
    if (explainedIdentities.has(id)) continue;
    if (complex.explained.has(id)) continue;
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
  // Top-level only: word order *inside* a plural branch is grammar, and the
  // branches of two locales are not even in correspondence.
  const orderIssue = checkOrdering(
    sourceTop,
    targetTop,
    sourceCounts,
    targetCounts,
    ctx,
    explainedIdentities,
  );
  if (orderIssue) issues.push(orderIssue);

  return issues;
};

function checkOrdering(
  sourceList: readonly Placeholder[],
  targetList: readonly Placeholder[],
  sourceCounts: Map<string, number>,
  targetCounts: Map<string, number>,
  ctx: ValidationContext | undefined,
  explainedIdentities: ReadonlySet<string>,
): Issue | null {
  // Only identities with matched counts can meaningfully be "reordered";
  // anything else is already reported as missing or added. Identities whose
  // attributes already drifted are excluded too: two links with swapped hrefs
  // are a corruption, not a word-order choice, and reporting "reordered" on top
  // of the attribute errors would only muddy the repair prompt.
  const comparable = new Set<string>();
  for (const [id, count] of sourceCounts) {
    if (explainedIdentities.has(id)) continue;
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

/** " in the \"few\" branch" — appended to a message when inside an ICU branch. */
function branchSuffix(branch: string | null): string {
  return branch === null ? "" : ` in the "${branch}" branch`;
}

function branchDetail(branch: string | null, detail: IssueDetail): IssueDetail {
  return branch === null ? detail : { ...detail, branch };
}

/**
 * Run the nesting check over ONE region of the string.
 *
 * A region is either the top level or the body of a single ICU branch. Regions
 * are checked independently because ICU branches are alternatives, not
 * concatenation: `one {<b>x</b>} other {<b>y</b>}` renders exactly one of them,
 * so balance holds per branch. Checking the flattened string instead would let
 * `one {<b>x} other {y</b>}` — which renders unbalanced markup for every count —
 * pass, while a locale that needs four branches would see its tags interleaved
 * into one long, meaningless stack.
 */
function checkTagRegion(
  list: readonly Placeholder[],
  paired: ReadonlySet<string>,
  ctx: ValidationContext | undefined,
  branch: string | null,
  issues: Issue[],
): void {
  const top = topLevelPlaceholders(list);
  const stack: TagInfo[] = [];

  for (const tag of readTags(top)) {
    if (tag.selfClosing) continue;
    if (!paired.has(tag.name)) continue;

    if (!tag.closing) {
      stack.push(tag);
      continue;
    }

    const open = stack[stack.length - 1];
    if (open === undefined) {
      issues.push(
        classify(
          "tag-imbalance",
          `Closing tag ${JSON.stringify(tag.raw)} at index ${tag.index}${branchSuffix(branch)} has no matching opening tag.`,
          opts(
            ctx,
            branchDetail(branch, {
              tag: tag.raw,
              name: tag.name,
              reason: "unopened",
            }),
          ),
        ),
      );
      continue;
    }
    if (open.name !== tag.name) {
      issues.push(
        classify(
          "tag-imbalance",
          `Tags are crossed${branchSuffix(branch)}: ${JSON.stringify(open.raw)} is still open but ${JSON.stringify(tag.raw)} closes first. Markup must nest, not overlap.`,
          opts(
            ctx,
            branchDetail(branch, {
              tag: tag.raw,
              expected: `</${open.name}>`,
              reason: "crossed",
            }),
          ),
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
        `Tag ${JSON.stringify(unclosed.raw)}${branchSuffix(branch)} is never closed; add ${JSON.stringify(`</${unclosed.name}>`)}.`,
        opts(
          ctx,
          branchDetail(branch, {
            tag: unclosed.raw,
            expected: `</${unclosed.name}>`,
            reason: "unclosed",
          }),
        ),
      ),
    );
  }

  for (const p of top) {
    const block = readIcuBlock(p);
    if (block === null) continue;
    for (const sub of block.branches) {
      checkTagRegion(
        sub.placeholders,
        paired,
        ctx,
        joinBranchPath(branch, sub.label),
        issues,
      );
    }
  }
}

/**
 * Every tag opened in the target must be closed there, correctly nested.
 *
 * Scoped to tag names that are *paired in the source*. Component-interpolation
 * catalogues legitimately contain half-tags (a string that opens `<0>` and a
 * sibling string that closes it), and demanding balance for those would fire
 * on correct input. Names that the source itself leaves unbalanced are covered
 * by the multiset parity check instead.
 *
 * "Paired in the source" is decided over the whole flattened source — a name the
 * source pairs anywhere is a name the target is expected to pair — but the
 * balance itself is checked per region, see {@link checkTagRegion}.
 */
export const validateTagBalance: Validator = (source, target, ctx) => {
  const sourceList = sourcePlaceholdersOf(source, ctx);
  const targetList = extractPlaceholders(target);
  const sourceTags = readTags(sourceList);
  if (sourceTags.length === 0 && readTags(targetList).length === 0) return [];

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
  checkTagRegion(targetList, paired, ctx, null, issues);
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
