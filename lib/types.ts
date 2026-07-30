/**
 * LingoLoop shared domain contract.
 *
 * This file is the single interlock between independently built modules
 * (parser, layout engine, prompt engine, validator, UI, API). It contains
 * types and pure constants only — never runtime logic, never imports.
 */

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

/** BCP-47-ish locale code, e.g. "de", "pt-BR", "ja". */
export type LocaleCode = string;

export interface LocaleProfile {
  code: LocaleCode;
  /** English endonym, e.g. "German". */
  name: string;
  /** Native name, e.g. "Deutsch". */
  nativeName: string;
  /**
   * Typical text-expansion multiplier versus English for short UI strings.
   * 1.0 means same length; 1.35 means ~35% longer on average.
   */
  expansion: number;
  /** Writing direction. */
  direction: "ltr" | "rtl";
  /**
   * Average advance width of one character relative to an English character
   * at the same font size. CJK glyphs are wide but you need far fewer of them.
   */
  glyphWidth: number;
  /** True for scripts without inter-word spaces (ja, zh, th). */
  noWordBreaks: boolean;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/** Placeholder syntaxes recognised in source strings. */
export type PlaceholderKind =
  | "icu" // {count}, {name}
  | "printf" // %s, %1$d
  | "dollar-brace" // ${user}
  | "double-brace" // {{user}}
  | "percent-named" // %(name)s
  | "angle-tag" // <b>, </b>, <0>
  | "unreal" // {0}
  | "i18next-nesting"; // $t(key)

export interface Placeholder {
  /** Exact substring as it appears in the source, e.g. "{count}". */
  raw: string;
  kind: PlaceholderKind;
  /** Normalised identity used for parity checks, e.g. "count". */
  token: string;
  /** Zero-based index into the source string. */
  index: number;
}

/**
 * Where a string surfaces in the product. Drives both the length budget and
 * the translation register.
 */
export type UiRole =
  | "button"
  | "menu"
  | "label"
  | "placeholder"
  | "tooltip"
  | "title"
  | "heading"
  | "body"
  | "error"
  | "toast"
  | "badge"
  | "unknown";

/** Ambiguity classes that materially change a translation. */
export type AmbiguityKind =
  | "verb-or-noun" // "Save", "Run", "Load"
  | "action-or-state" // "Save" (button) vs "Saving" (status)
  | "homonym" // "Right" = correct / direction
  | "unit-or-word" // "min" = minute / minimum
  | "brand-term" // do not translate
  | "gaming-slang" // "GG", "Loot", "Buff"
  | "tech-term"; // "Commit", "Branch", "Cache"

export interface AmbiguityFlag {
  kind: AmbiguityKind;
  /** Human-readable reason surfaced in the UI and sent to the model. */
  note: string;
  /** 0..1 — how strongly the heuristic fired. */
  confidence: number;
}

/** One translatable string, flattened out of the source JSON tree. */
export interface StringEntry {
  /** Dot/bracket path, e.g. "menu.file.save" or "errors[0].title". */
  key: string;
  /** Structural path segments; numbers denote array indices. */
  path: ReadonlyArray<string | number>;
  value: string;
  placeholders: Placeholder[];
  role: UiRole;
  ambiguities: AmbiguityFlag[];
  /** Developer-authored hint, from sibling `_comment`/`_context` keys. */
  developerNote?: string;
  /** True when the value should be emitted verbatim (URLs, tokens, empty). */
  doNotTranslate: boolean;
}

/**
 * The parsed source file. `tree` retains the original structure (including
 * non-string leaves) so output can be rebuilt byte-shape-identical.
 */
export interface SourceCatalog {
  /** File name as uploaded, e.g. "en.json". */
  fileName: string;
  sourceLocale: LocaleCode;
  entries: StringEntry[];
  /** Original parsed JSON, used as the template for reconstruction. */
  tree: JsonValue;
  /** Indentation detected in the uploaded file, for faithful re-emission. */
  indent: string;
  /** Whether the original file ended with a newline. */
  trailingNewline: boolean;
  stats: {
    totalKeys: number;
    translatableKeys: number;
    skippedKeys: number;
    totalCharacters: number;
    maxDepth: number;
  };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

// ---------------------------------------------------------------------------
// Layout / UI context checking
// ---------------------------------------------------------------------------

/** The width ceiling a translation must respect. */
export interface LengthBudget {
  /** Multiplier over the source's rendered width, e.g. 1.3 for buttons. */
  maxRatio: number;
  /** Absolute character ceiling, when the role implies a hard cap. */
  maxChars: number | null;
  /** Below this ratio no warning is raised even if longer. */
  graceRatio: number;
  /** Why this budget was chosen — surfaced in the UI. */
  rationale: string;
}

export type FitVerdict = "fits" | "tight" | "overflow";

export interface FitResult {
  verdict: FitVerdict;
  /** Estimated rendered width of the source, in em units. */
  sourceWidth: number;
  /** Estimated rendered width of the translation, in em units. */
  targetWidth: number;
  /** targetWidth / sourceWidth. */
  ratio: number;
  /** Budget that was applied. */
  budget: LengthBudget;
  /** Width the translation must come down to in order to pass, in em. */
  allowedWidth: number;
  /** Rough count of characters to cut; 0 when it fits. */
  overBy: number;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warning" | "info";

export type IssueCode =
  | "placeholder-missing"
  | "placeholder-added"
  | "placeholder-malformed"
  | "placeholder-reordered"
  | "length-overflow"
  | "length-tight"
  | "empty-translation"
  | "untranslated" // output identical to input where it shouldn't be
  | "structure-mismatch"
  | "invalid-json"
  | "control-characters"
  | "tag-imbalance"
  | "whitespace-drift"
  | "casing-drift"
  | "provider-error"
  | "budget-exhausted";

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** Entry key this issue belongs to; absent for file-level issues. */
  key?: string;
  /** Optional machine-readable detail for the UI. */
  detail?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** Product register, chosen by the developer, threaded into every prompt. */
export type ToneProfile =
  | "neutral-product"
  | "casual-indie"
  | "gaming"
  | "technical-developer"
  | "formal-enterprise";

export interface GlossaryTerm {
  term: string;
  /** Per-locale forced rendering; empty object means "keep verbatim". */
  translations: Record<LocaleCode, string>;
  caseSensitive: boolean;
  note?: string;
}

export interface TranslationSettings {
  sourceLocale: LocaleCode;
  targetLocales: LocaleCode[];
  tone: ToneProfile;
  /** Free-text description of the product, e.g. "roguelike deckbuilder". */
  productContext: string;
  glossary: GlossaryTerm[];
  /** Enforce length budgets and retry on overflow. */
  enforceLayout: boolean;
  /** Max repair attempts per string after the first pass. */
  maxRepairAttempts: number;
}

export type EntryStatus =
  | "pending"
  | "translating"
  | "repairing"
  | "passed"
  | "flagged" // delivered but with warnings
  | "failed"; // could not be produced

export interface TranslatedEntry {
  key: string;
  path: ReadonlyArray<string | number>;
  source: string;
  target: string;
  locale: LocaleCode;
  status: EntryStatus;
  issues: Issue[];
  fit: FitResult | null;
  /** How many model calls this entry consumed (1 = first pass only). */
  attempts: number;
  /** Model's own one-line justification, shown on hover in the review table. */
  rationale?: string;
}

export interface LocaleResult {
  locale: LocaleCode;
  entries: TranslatedEntry[];
  /** Rebuilt JSON tree, structurally identical to the source. */
  tree: JsonValue;
  issues: Issue[];
  stats: {
    total: number;
    passed: number;
    flagged: number;
    failed: number;
    overflowRepaired: number;
    averageRatio: number;
  };
}

export type JobPhase =
  | "queued"
  | "parsing"
  | "analyzing"
  | "translating"
  | "validating"
  | "repairing"
  | "complete"
  | "error";

export interface JobProgress {
  phase: JobPhase;
  /** 0..1 overall completion. */
  progress: number;
  locale: LocaleCode | null;
  completedUnits: number;
  totalUnits: number;
  message: string;
}

export interface TranslationJob {
  id: string;
  catalog: SourceCatalog;
  settings: TranslationSettings;
  results: LocaleResult[];
  progress: JobProgress;
  issues: Issue[];
  startedAt: number;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------------------

export interface TranslationUnit {
  key: string;
  source: string;
  role: UiRole;
  placeholders: Placeholder[];
  ambiguities: AmbiguityFlag[];
  developerNote?: string;
  budget: LengthBudget;
  /** Max rendered width in em the output must respect. */
  allowedWidth: number;
  /** Sibling keys, giving the model surrounding UI context. */
  neighbors: string[];
  /** Set on repair passes: what the previous attempt got wrong. */
  repairFeedback?: string;
  /** Set on repair passes: the rejected previous attempt. */
  previousAttempt?: string;
}

export interface ProviderTranslation {
  key: string;
  target: string;
  rationale?: string;
}

export interface ProviderRequest {
  locale: LocaleProfile;
  sourceLocale: LocaleCode;
  tone: ToneProfile;
  productContext: string;
  glossary: GlossaryTerm[];
  units: TranslationUnit[];
}

export interface ProviderResponse {
  translations: ProviderTranslation[];
  /** Provider-level failures that apply to the whole batch. */
  issues: Issue[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TranslationProvider {
  readonly id: string;
  readonly label: string;
  /** False when the provider needs credentials that are not configured. */
  isConfigured(): boolean;
  translate(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Export / sync
// ---------------------------------------------------------------------------

export interface ExportFile {
  /** Relative path, e.g. "locales/de.json". */
  path: string;
  contents: string;
}

export interface SyncTarget {
  provider: "github";
  owner: string;
  repo: string;
  baseBranch: string;
  /** Directory the locale files live in, e.g. "public/locales". */
  localeDir: string;
  /** Pattern for file names; `{locale}` is substituted. */
  fileNamePattern: string;
}

export interface SyncPlan {
  target: SyncTarget;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  files: ExportFile[];
}
