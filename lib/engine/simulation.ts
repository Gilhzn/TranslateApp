/**
 * OFFLINE SIMULATION MODE.
 *
 * This provider is selected when no `ANTHROPIC_API_KEY` is configured (or when
 * a caller asks for it explicitly). It performs no network I/O and consumes no
 * credentials — it synthesises plausible pseudo-localised output so that the
 * entire product (upload → analyse → translate → validate → repair → export)
 * can be demoed, developed against and end-to-end tested without an API key.
 *
 * It is NOT a translator, and nothing it emits is a real translation. It is
 * also not a stub: it honours every contract the real provider honours, which
 * is what makes it useful as a test double for the rest of the pipeline.
 *
 *   - Deterministic. Output is a pure function of (key, locale, source, seed).
 *     No `Math.random`, no clock — two runs produce byte-identical results, so
 *     snapshot tests and demo recordings stay stable.
 *   - Placeholders are reproduced exactly, in source order, never rewritten.
 *   - Glossary terms are applied (forced rendering, or kept verbatim when the
 *     locale has no entry) and are never pseudo-localised.
 *   - Values that are provably not human copy (URLs, hex colours, identifiers,
 *     placeholder-only strings) pass through untouched.
 *   - Generated text uses the target locale's REAL script — German umlauts,
 *     Cyrillic, kana, Hangul, Arabic, Hebrew, Thai, Devanagari — so the width
 *     metrics, the RTL handling and the full-width glyph maths are exercised
 *     for real rather than against Latin filler.
 *   - Generated text is scaled by the locale's REAL expansion factor, rounded
 *     up. Some strings therefore genuinely overflow their budget, which is the
 *     point: the layout engine and the repair loop need something to catch.
 *   - On a repair pass it produces a strictly shorter string than the attempt
 *     that was rejected, so the repair loop provably converges. When the string
 *     is already at its floor it returns the previous attempt unchanged — never
 *     an empty string, and never something wider than what it replaced, because
 *     either of those turns the orchestrator's repair loop into an oscillation.
 */

import { isDoNotTranslate } from "@/lib/core";
import { estimateLongestLineWidth } from "@/lib/layout";
import type {
  Issue,
  LocaleProfile,
  Placeholder,
  ProviderRequest,
  ProviderResponse,
  ProviderTranslation,
  TranslationProvider,
  TranslationUnit,
} from "@/lib/types";
import { resolveGlossary, type GlossaryLine } from "./prompt";

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

interface ScriptSpec {
  id: string;
  /** Whether the script has upper/lower case, so casing can be mirrored. */
  cased: boolean;
  /** Building blocks. Whole units, so a cut never lands inside a cluster. */
  syllables: readonly string[];
  /** CJK punctuation is full-width; using ASCII commas there looks wrong. */
  fullWidthPunctuation: boolean;
}

function script(
  id: string,
  cased: boolean,
  syllables: readonly string[],
  fullWidthPunctuation = false,
): ScriptSpec {
  return Object.freeze({ id, cased, syllables, fullWidthPunctuation });
}

/**
 * Syllable pools are drawn from real UI vocabulary in each language ("speichern",
 * "сохранить", "설정") rather than from random code points: the output has to
 * look like the language to a native speaker glancing at the review table, and
 * it has to have that language's real character-width distribution.
 */
const SCRIPTS: Readonly<Record<string, ScriptSpec>> = Object.freeze({
  latin: script("latin", true, [
    "la", "ré", "mi", "sò", "tu", "né", "va", "ké", "pé", "dâ",
    "fî", "gö", "ru", "sä", "ti", "mü", "cor", "tel", "na", "vis",
  ]),
  latinDe: script("latinDe", true, [
    "ein", "stel", "lun", "gen", "spei", "chern", "ab", "bre", "chen",
    "über", "prü", "fung", "ver", "wal", "tung", "zu", "rück", "nach",
    "richt", "lö", "schen", "är", "ör", "üb",
  ]),
  latinFr: script("latinFr", true, [
    "en", "re", "gis", "trer", "an", "nu", "ler", "pa", "ra", "mè",
    "tres", "choi", "sir", "ré", "es", "sa", "yer", "con", "fi", "gu",
  ]),
  latinEs: script("latinEs", true, [
    "gu", "ar", "dar", "can", "ce", "lar", "a", "jus", "tes", "car",
    "gan", "do", "con", "fir", "mar", "bo", "rrar", "ñe", "ó", "í",
  ]),
  cyrillic: script("cyrillic", true, [
    "на", "стро", "й", "ки", "со", "хра", "нить", "от", "ме", "на",
    "за", "груз", "ка", "про", "вер", "у", "да", "лить", "фа", "йл",
  ]),
  greek: script("greek", true, [
    "ρυθ", "μί", "σεις", "απο", "θή", "κευ", "ση", "ακύ", "ρω",
    "φόρ", "τω", "επι", "βε", "βαί", "δια", "γρα", "φή",
  ]),
  kana: script(
    "kana",
    false,
    [
      "せっ", "てい", "ほ", "ぞん", "キャン", "セル", "よみ", "こみ",
      "かく", "にん", "さく", "じょ", "ファ", "イル", "メ", "ニュー",
      "つう", "ち",
    ],
    true,
  ),
  han: script(
    "han",
    false,
    [
      "设", "置", "保", "存", "取", "消", "加", "载", "确", "认",
      "删", "除", "文", "件", "菜", "单", "通", "知",
    ],
    true,
  ),
  hangul: script("hangul", false, [
    "설", "정", "저", "장", "취", "소", "불", "러", "오", "기",
    "확", "인", "삭", "제", "파", "일", "메", "뉴",
  ]),
  arabic: script("arabic", false, [
    "إع", "دا", "دات", "حف", "ظ", "إل", "غاء", "تح", "ميل",
    "تأ", "كيد", "حذ", "ف", "مل", "قا", "ئمة",
  ]),
  hebrew: script("hebrew", false, [
    "הג", "דר", "ות", "שמ", "יר", "ה", "בי", "טול", "טע",
    "ינה", "אי", "שור", "מח", "יקה", "קו", "בץ",
  ]),
  thai: script("thai", false, [
    "ตั้ง", "ค่า", "บัน", "ทึก", "ยก", "เลิก", "โหลด", "ยืน",
    "ยัน", "ลบ", "ไฟล์", "เมนู",
  ]),
  devanagari: script("devanagari", false, [
    "से", "टिं", "ग्स", "स", "हे", "जें", "र", "द्द", "लो",
    "ड", "पु", "ष्टि", "हटा", "एँ", "फ़ा", "इल",
  ]),
  bengali: script("bengali", false, [
    "সে", "টিং", "স", "সং", "রক্ষ", "ণ", "বা", "তিল", "লো",
    "ড", "নি", "শ্চিত", "মু", "ছুন",
  ]),
  tamil: script("tamil", false, [
    "அ", "மைப்", "புக", "ள்", "சே", "மி", "ரத்", "து", "ஏ",
    "ற்று", "உ", "றுதி",
  ]),
});

const LANGUAGE_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  de: "latinDe",
  fr: "latinFr",
  es: "latinEs",
  ca: "latinEs",
  ru: "cyrillic",
  uk: "cyrillic",
  be: "cyrillic",
  bg: "cyrillic",
  sr: "cyrillic",
  mk: "cyrillic",
  el: "greek",
  ja: "kana",
  zh: "han",
  ko: "hangul",
  ar: "arabic",
  fa: "arabic",
  ur: "arabic",
  ps: "arabic",
  he: "hebrew",
  yi: "hebrew",
  th: "thai",
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
  bn: "bengali",
  ta: "tamil",
});

/** Script used to render `profile`, falling back to accented Latin. */
export function scriptForLocale(profile: LocaleProfile): ScriptSpec {
  const language = profile.code.split("-")[0]?.toLowerCase() ?? "";
  const id = LANGUAGE_SCRIPTS[language];
  const spec = id === undefined ? undefined : SCRIPTS[id];
  return spec ?? SCRIPTS.latin ?? script("latin", true, ["la"]);
}

const FULL_WIDTH_PUNCTUATION: Readonly<Record<string, string>> = Object.freeze({
  ",": "、",
  ".": "。",
  "!": "！",
  "?": "？",
  ":": "：",
  ";": "；",
  "(": "（",
  ")": "）",
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Stable across engines and platforms — no Math.random. */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, in 32-bit arithmetic that survives float precision.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** xorshift32 — decorrelates successive draws from one seed. */
function nextHash(state: number): number {
  let hash = state >>> 0;
  hash ^= hash << 13;
  hash >>>= 0;
  hash ^= hash >>> 17;
  hash ^= hash << 5;
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

type Segment =
  /** Reproduced byte-for-byte: placeholders and glossary renderings. */
  | { kind: "immutable"; text: string }
  | { kind: "text"; text: string };

/**
 * Split a source string on its placeholders.
 *
 * `Placeholder.index` is trusted first and verified against the raw text; if it
 * does not line up (a caller re-derived the string, or indices went stale) the
 * token is located by search instead. A placeholder that cannot be found at all
 * is skipped rather than guessed at — dropping it would break parity, which is
 * the one thing this provider must never do.
 */
export function splitOnPlaceholders(
  source: string,
  placeholders: readonly Placeholder[],
): Segment[] {
  const ordered = [...placeholders]
    .filter((placeholder) => placeholder.raw.length > 0)
    .sort((a, b) => a.index - b.index);

  const segments: Segment[] = [];
  let cursor = 0;

  for (const placeholder of ordered) {
    let at = placeholder.index;
    if (at < cursor || source.slice(at, at + placeholder.raw.length) !== placeholder.raw) {
      at = source.indexOf(placeholder.raw, cursor);
      if (at === -1) continue;
    }
    if (at > cursor) segments.push({ kind: "text", text: source.slice(cursor, at) });
    segments.push({ kind: "immutable", text: placeholder.raw });
    cursor = at + placeholder.raw.length;
  }

  if (cursor < source.length) {
    segments.push({ kind: "text", text: source.slice(cursor) });
  }
  return segments;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/gu;

function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIALS, "\\$&");
}

interface GlossaryMatch {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Carve glossary terms out of a text run as immutable segments.
 *
 * Longest match wins at a given position, so a two-word term is not shadowed by
 * a one-word term that happens to start it. Matching is whole-word: "Build" in
 * the glossary does not fire inside "Rebuilding".
 */
export function applyGlossary(text: string, lines: readonly GlossaryLine[]): Segment[] {
  if (lines.length === 0 || text.length === 0) {
    return text.length === 0 ? [] : [{ kind: "text", text }];
  }

  const matches: GlossaryMatch[] = [];
  for (const line of lines) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(line.term)}(?![\\p{L}\\p{N}])`,
      line.caseSensitive ? "gu" : "giu",
    );
    let found: RegExpExecArray | null;
    while ((found = pattern.exec(text)) !== null) {
      matches.push({
        start: found.index,
        end: found.index + found[0].length,
        // No target for this locale means "keep the English term verbatim",
        // which is exactly the matched text.
        replacement: line.target ?? found[0],
      });
      if (found.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  if (matches.length === 0) return [{ kind: "text", text }];

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // overlapped by a longer earlier match
    if (match.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.start) });
    }
    segments.push({ kind: "immutable", text: match.replacement });
    cursor = match.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Token rendering
// ---------------------------------------------------------------------------

type Token =
  | { kind: "word"; text: string }
  | { kind: "space"; text: string }
  | { kind: "other"; text: string };

const WORD_RE = /^[\p{L}][\p{L}\p{N}'’-]*/u;
const SPACE_RE = /^\s+/u;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let rest = text;
  while (rest.length > 0) {
    const space = SPACE_RE.exec(rest);
    if (space !== null) {
      tokens.push({ kind: "space", text: space[0] });
      rest = rest.slice(space[0].length);
      continue;
    }
    const word = WORD_RE.exec(rest);
    if (word !== null) {
      tokens.push({ kind: "word", text: word[0] });
      rest = rest.slice(word[0].length);
      continue;
    }
    const char = [...rest][0] ?? rest[0] ?? "";
    tokens.push({ kind: "other", text: char });
    rest = rest.slice(char.length);
  }
  return tokens;
}

/** Build one pseudo-word of roughly `targetChars` characters. */
function makeWord(seed: string, targetChars: number, spec: ScriptSpec): string {
  const pool = spec.syllables;
  if (pool.length === 0) return "";

  let state = hash32(seed);
  let out = "";
  // Bounded: even a one-character pool cannot spin here.
  for (let i = 0; i < 40; i += 1) {
    state = nextHash(state);
    const syllable = pool[state % pool.length] ?? "";
    if (syllable.length === 0) continue;
    if (out.length > 0 && out.length + syllable.length > targetChars + 1) break;
    out += syllable;
    if (out.length >= targetChars) break;
  }
  return out.length === 0 ? (pool[0] ?? "") : out;
}

/** Mirror the source word's capitalisation, where the script has capitals. */
function applyCasing(generated: string, source: string, spec: ScriptSpec): string {
  if (!spec.cased || generated.length === 0) return generated;

  const letters = [...source].filter((char) => char.toLowerCase() !== char.toUpperCase());
  if (letters.length > 1 && letters.every((char) => char === char.toUpperCase())) {
    return generated.toUpperCase();
  }
  const first = source[0];
  if (first !== undefined && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return generated.charAt(0).toUpperCase() + generated.slice(1);
  }
  return generated;
}

interface RenderOptions {
  /** Multiplier applied on top of the locale expansion. 1 = first pass. */
  factor: number;
  /** Round up (first pass, pessimistic end of the expansion band) or nearest. */
  roundUp: boolean;
  /** Stop generating words after this many; the rest are dropped. */
  maxWords?: number;
}

interface RenderContext {
  profile: LocaleProfile;
  spec: ScriptSpec;
  seed: string;
  segments: readonly Segment[];
}

function renderSegments(context: RenderContext, options: RenderOptions): string {
  const { profile, spec, seed, segments } = context;
  const expansion = profile.expansion * options.factor;
  const dropSpaces = profile.noWordBreaks;
  const maxWords = options.maxWords ?? Number.POSITIVE_INFINITY;

  let wordIndex = 0;
  let out = "";

  for (const segment of segments) {
    if (segment.kind === "immutable") {
      out += segment.text;
      continue;
    }

    const tokens = tokenize(segment.text);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === undefined) continue;

      if (token.kind === "word") {
        const index = wordIndex;
        wordIndex += 1;
        if (index >= maxWords) continue;
        const raw = [...token.text].length;
        const scaled = raw * expansion;
        // Rounding up models the pessimistic end of the expansion band, which
        // is what makes the layout engine and the repair loop earn their keep.
        // It only applies to locales that actually expand: rounding up a
        // contracting locale (CJK, at 0.55-0.65) would inflate every string by
        // a quarter and make every CJK unit overflow on principle.
        const roundUp = options.roundUp && expansion > 1;
        const target = Math.max(1, roundUp ? Math.ceil(scaled) : Math.round(scaled));
        const generated = makeWord(`${seed}|${index}|${token.text}`, target, spec);
        out += applyCasing(generated, token.text, spec);
        continue;
      }

      if (token.kind === "space") {
        // Scripts without inter-word spaces must not inherit English spacing
        // between two generated words — but spacing that abuts a placeholder or
        // a glossary term is structural and stays.
        if (dropSpaces && tokens[i - 1]?.kind === "word" && tokens[i + 1]?.kind === "word") {
          continue;
        }
        out += token.text;
        continue;
      }

      out += spec.fullWidthPunctuation
        ? (FULL_WIDTH_PUNCTUATION[token.text] ?? token.text)
        : token.text;
    }
  }

  return out;
}

function countWords(segments: readonly Segment[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.kind !== "text") continue;
    for (const token of tokenize(segment.text)) {
      if (token.kind === "word") count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Translation of one unit
// ---------------------------------------------------------------------------

export interface SimulationContext {
  profile: LocaleProfile;
  glossary: readonly GlossaryLine[];
  /** Extra salt; changing it changes every output deterministically. */
  seed: string;
}

/** How aggressively each repair step shrinks relative to the previous one. */
const SHRINK_STEP = 0.8;
const MIN_FACTOR = 0.12;
const MAX_SHRINK_STEPS = 14;

export function simulateTranslation(
  unit: TranslationUnit,
  context: SimulationContext,
): ProviderTranslation {
  const { profile, glossary, seed } = context;

  // Machine data is emitted verbatim, exactly as the real provider is told to.
  if (isDoNotTranslate(unit.source, unit.placeholders)) {
    return {
      key: unit.key,
      target: unit.source,
      rationale: "value is not human copy, passed through verbatim",
    };
  }

  const segments: Segment[] = [];
  for (const segment of splitOnPlaceholders(unit.source, unit.placeholders)) {
    if (segment.kind === "immutable") segments.push(segment);
    else segments.push(...applyGlossary(segment.text, glossary));
  }

  const spec = scriptForLocale(profile);
  const renderContext: RenderContext = {
    profile,
    spec,
    seed: `${seed}|${profile.code}|${unit.key}`,
    segments,
  };

  const previous = unit.previousAttempt ?? "";
  const isRepair =
    previous.length > 0 ||
    (unit.repairFeedback !== undefined && unit.repairFeedback.length > 0);

  const repair = isRepair ? repairRender(renderContext, unit, previous) : null;
  const target =
    repair !== null
      ? repair.target
      : renderSegments(renderContext, { factor: 1, roundUp: true });

  const translation: ProviderTranslation = { key: unit.key, target };
  const rationale = explain(unit, segments, repair);
  if (rationale !== undefined) translation.rationale = rationale;
  return translation;
}

interface RepairResult {
  target: string;
  /**
   * True only when `target` is genuinely narrower than the attempt it replaces.
   * False means the string was already at its floor and `target` IS the previous
   * attempt — the rationale must not claim a shortening that did not happen.
   */
  shortened: boolean;
}

/**
 * Repair pass. Guarantees a result strictly narrower than `previous` whenever
 * the string contains anything that can be shortened, and prefers the widest
 * such result that actually fits the budget — shrinking further than necessary
 * would make the simulation converge on nonsense.
 *
 * Two invariants matter more than the shrinking itself, because the orchestrator
 * feeds each result straight back in as the next `previousAttempt`:
 *
 *   1. The result is never empty for a source that carries copy. Deleting the
 *      string is not a translation, and a zero-width "previous attempt" makes
 *      every subsequent candidate look like an improvement — the loop then
 *      re-inflates to full width and oscillates with period 2 forever.
 *   2. The result is never wider than `previous`. When nothing can be shrunk
 *      further the honest answer is `previous` itself: a stall the caller ends
 *      via `maxRepairAttempts`, not a bigger string dressed up as a repair.
 *
 * Single-word buttons and badges ("OK", "Free", "min") reach the floor on the
 * FIRST repair — one syllable is the narrowest thing `makeWord` can render — so
 * this is the common path for exactly the roles the layout engine squeezes most.
 */
function repairRender(
  context: RenderContext,
  unit: TranslationUnit,
  previous: string,
): RepairResult {
  const { profile } = context;
  const previousWidth = estimateLongestLineWidth(previous, profile);
  const allowed = unit.allowedWidth;

  /** A source with real copy must come back with real copy. */
  const mustStayNonEmpty = unit.source.trim().length > 0;
  /** A blank previous attempt is not a width to undercut — it is no attempt. */
  const hasPrevious = previousWidth > 0;

  /**
   * The single gate every returned candidate passes through. Rejecting rather
   * than clamping keeps the two invariants above local to one place.
   */
  const accept = (candidate: string, width: number): RepairResult | null => {
    if (mustStayNonEmpty && candidate.trim().length === 0) return null;
    if (hasPrevious && width >= previousWidth) return null;
    return { target: candidate, shortened: true };
  };

  const start = hasPrevious
    ? clamp((allowed / previousWidth) * 0.9, MIN_FACTOR, 0.85)
    : 0.7;

  let best: RepairResult | null = null;
  let factor = start;
  for (let step = 0; step < MAX_SHRINK_STEPS && factor >= MIN_FACTOR; step += 1) {
    const candidate = renderSegments(context, { factor, roundUp: false });
    const width = estimateLongestLineWidth(candidate, profile);
    const accepted = accept(candidate, width);
    if (accepted !== null) {
      best = accepted;
      // Prefer the WIDEST candidate that still fits: over-shrinking would make
      // the simulation converge on a stub rather than on a plausible string.
      if (width <= allowed) return accepted;
    }
    factor *= SHRINK_STEP;
  }
  if (best !== null) return best;

  // Nothing got narrower by shrinking words — the string is mostly immutable
  // content. Drop generated words from the end, one at a time, but never the
  // last one: a translation with zero words is a deletion. For a single-word
  // source this loop therefore does not run at all, which is correct — there is
  // no word to spare.
  const totalWords = countWords(context.segments);
  for (let limit = totalWords - 1; limit >= 1; limit -= 1) {
    const candidate = collapseSpaces(
      renderSegments(context, { factor: MIN_FACTOR, roundUp: false, maxWords: limit }),
    );
    const accepted = accept(candidate, estimateLongestLineWidth(candidate, profile));
    if (accepted !== null) return accepted;
  }

  // Terminal state: the string is at its floor, or everything left is
  // placeholders and glossary terms that this provider may not remove.
  // Handing back the rejected attempt unchanged is honest. The one case where
  // it is not is a blank previous attempt on a unit that does have copy — then
  // the narrowest legal render is returned instead of propagating the blank.
  if (mustStayNonEmpty && previous.trim().length === 0) {
    return {
      target: collapseSpaces(renderSegments(context, { factor: MIN_FACTOR, roundUp: false })),
      shortened: true,
    };
  }
  return { target: previous, shortened: false };
}

function collapseSpaces(text: string): string {
  return text.replace(/[^\S\r\n]{2,}/gu, " ").trim();
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * One short clause for the review table. `repair` is null on a first pass; on a
 * repair pass its `shortened` flag decides the wording, because claiming the
 * string was "shortened to fit" when `repairRender` stalled and handed back the
 * previous attempt would be a false rationale attached to unchanged output.
 */
function explain(
  unit: TranslationUnit,
  segments: readonly Segment[],
  repair: RepairResult | null,
): string | undefined {
  if (repair !== null) {
    return repair.shortened
      ? `shortened to fit the ${unit.role} budget`
      : `already at its shortest form in this locale; could not be shortened further for the ${unit.role} budget`;
  }
  const immutables = segments.filter((segment) => segment.kind === "immutable").length;
  if (unit.placeholders.length > 0) {
    return `${unit.placeholders.length} placeholder${unit.placeholders.length === 1 ? "" : "s"} reproduced in source order`;
  }
  if (immutables > 0) return "glossary term applied without inflection";
  if (unit.ambiguities.length > 0) {
    const first = unit.ambiguities[0];
    return first === undefined ? undefined : `resolved as ${first.kind} for a ${unit.role}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface DeterministicProviderOptions {
  /**
   * Salt mixed into every hash. Two providers with different seeds produce
   * different — but each internally stable — output.
   */
  seed?: string;
  /**
   * Artificial delay per batch, in ms. Zero by default; a demo can raise it to
   * exercise the UI's loading and progress states.
   */
  latencyMs?: number;
  /** Injectable for tests; defaults to a `setTimeout` that honours the signal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DETERMINISTIC_PROVIDER_ID = "deterministic";

export class DeterministicProvider implements TranslationProvider {
  readonly id = DETERMINISTIC_PROVIDER_ID;
  readonly label = "Offline simulation (no API key)";

  private readonly seed: string;
  private readonly latencyMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: DeterministicProviderOptions = {}) {
    this.seed = options.seed ?? "lingoloop";
    this.latencyMs = Math.max(0, options.latencyMs ?? 0);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Needs no credentials, so it is always ready. */
  isConfigured(): boolean {
    return true;
  }

  async translate(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    if (this.latencyMs > 0) await this.sleep(this.latencyMs, signal);

    const issues: Issue[] = [];
    if (isAborted(signal)) {
      return { translations: [], issues: [abortIssue()] };
    }

    const context: SimulationContext = {
      profile: request.locale,
      glossary: resolveGlossary(request.glossary, request.locale),
      seed: this.seed,
    };

    const translations: ProviderTranslation[] = [];
    for (const unit of request.units) {
      if (isAborted(signal)) {
        issues.push(abortIssue());
        break;
      }
      translations.push(simulateTranslation(unit, context));
    }

    // No tokens were spent, so `usage` is deliberately omitted rather than
    // reported as zero — a zero would read as "free real translation".
    return { translations, issues };
  }
}

/**
 * Wrapped in a function on purpose: an inline `signal?.aborted === true` is
 * narrowed to `false` by the compiler after the first check.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function abortIssue(): Issue {
  return {
    code: "provider-error",
    severity: "warning",
    message: "Translation was cancelled before the batch completed.",
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted(signal)) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
