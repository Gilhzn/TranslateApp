import type {
  EntryStatus,
  FitResult,
  Issue,
  IssueCode,
  Placeholder,
  TranslationUnit,
} from "@/lib/types";
import { classify, summarizeIssues } from "./errors";
import { placeholderIdentity } from "./validators";

/**
 * Repair decisioning and feedback authoring.
 *
 * `buildRepairFeedback` is the highest-leverage function in this module: its
 * output is injected verbatim into the next prompt, and the difference between
 * "the translation was too long" and "your attempt was 24 characters, the
 * button budget is 18, cut at least 6, do not use an ellipsis" is the
 * difference between a repair pass that works and one that burns a model call
 * to produce the same failure.
 *
 * Three rules govern everything here:
 *   1. Name the exact token. Never "a placeholder" — always `{count}`.
 *   2. Give a number whenever one exists. "Too long" is not actionable.
 *   3. Say what to do, not only what went wrong, and pre-empt the obvious wrong
 *      fix (truncating with "…" instead of choosing a shorter word).
 */

/** Codes a second model pass can plausibly fix. */
export const MODEL_REPAIRABLE_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "placeholder-missing",
  "placeholder-added",
  "placeholder-malformed",
  "placeholder-reordered",
  "length-overflow",
  "empty-translation",
  "untranslated",
  "control-characters",
  "tag-imbalance",
  "whitespace-drift",
  "casing-drift",
]);

export function isModelRepairable(code: IssueCode): boolean {
  return MODEL_REPAIRABLE_CODES.has(code);
}

export interface RepairAssessment {
  needed: boolean;
  /** The issues that forced the decision — empty when `needed` is false. */
  blocking: Issue[];
  /** One line for the job log / progress message. */
  reason: string;
}

/**
 * Should another model call be spent on this entry?
 *
 * Errors and overflow verdicts yes; warnings and info alone no. Re-prompting
 * for a `whitespace-drift` warning would be pure latency — the mechanical
 * fixer already repaired it, and if it did not, the drift is cosmetic enough
 * to ship flagged.
 */
export function assessRepair(
  issues: readonly Issue[],
  fit: FitResult | null,
): RepairAssessment {
  const blocking = issues.filter(
    (i) => i.severity === "error" && isModelRepairable(i.code),
  );
  const overflow = fit !== null && fit.verdict === "overflow";

  if (blocking.length === 0 && !overflow) {
    const summary = summarizeIssues(issues);
    return {
      needed: false,
      blocking: [],
      reason:
        summary.total === 0
          ? "Clean on the first pass."
          : `${summary.warnings} warning(s) and ${summary.infos} info issue(s) — not worth another model call.`,
    };
  }

  const reasons: string[] = [];
  if (overflow) reasons.push("layout overflow");
  if (blocking.length > 0) {
    reasons.push(`${blocking.length} blocking issue(s): ${[...new Set(blocking.map((i) => i.code))].join(", ")}`);
  }
  return { needed: true, blocking, reason: `Repair required — ${reasons.join("; ")}.` };
}

/** Boolean form of {@link assessRepair}. */
export function needsRepair(
  issues: readonly Issue[],
  fit: FitResult | null,
): boolean {
  return assessRepair(issues, fit).needed;
}

// ---------------------------------------------------------------------------
// Feedback authoring
// ---------------------------------------------------------------------------

function detailString(issue: Issue, field: string): string | null {
  const value = issue.detail?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function detailNumber(issue: Issue, field: string): number | null {
  const value = issue.detail?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Code-point length — what a person means by "characters". */
function charLength(value: string): number {
  return [...value].length;
}

/**
 * Convert the em-based overflow verdict into a character budget.
 *
 * The model cannot reason about em widths, but it can count characters. The
 * conversion uses the *observed* width-per-character of the rejected attempt,
 * which is exact for the string that actually failed and is the honest way to
 * express a proportional budget in units the model understands.
 */
function characterCeiling(previousTarget: string, fit: FitResult): number {
  const chars = charLength(previousTarget);
  if (fit.budget.maxChars !== null) return fit.budget.maxChars;
  if (chars === 0 || fit.targetWidth <= 0) return Math.max(1, chars);
  const perChar = fit.targetWidth / chars;
  return Math.max(1, Math.floor(fit.allowedWidth / perChar));
}

function overflowDirective(
  unit: TranslationUnit,
  previousTarget: string,
  fit: FitResult,
): string {
  const chars = charLength(previousTarget);
  const ceiling = characterCeiling(previousTarget, fit);
  const cut = Math.max(1, chars - ceiling, Math.ceil(fit.overBy));
  return (
    `Your previous attempt was ${chars} characters but the ${unit.role} budget is ${ceiling}. ` +
    `Cut at least ${cut} character${cut === 1 ? "" : "s"}. ` +
    `Do not truncate or add an ellipsis — choose a shorter word, drop a filler word, ` +
    `or use the conventional abbreviation for this control.`
  );
}

function placeholderDirective(issue: Issue): string {
  const raw = detailString(issue, "raw");
  const expected = detailNumber(issue, "expected");
  const actual = detailNumber(issue, "actual");
  const token = raw ?? detailString(issue, "token") ?? "the placeholder";

  switch (issue.code) {
    case "placeholder-missing": {
      const times =
        expected !== null && expected > 1
          ? `exactly ${expected} times`
          : "exactly once";
      return (
        `The placeholder ${token} is missing from your output. It must appear ${times}, ` +
        `spelled character for character as ${token}. Do not translate the text inside it.`
      );
    }
    case "placeholder-added": {
      if (expected !== null && expected > 0 && actual !== null) {
        return `You used ${token} ${actual} times but the source uses it ${expected} time${expected === 1 ? "" : "s"}. Remove the extra occurrence${actual - expected === 1 ? "" : "s"}.`;
      }
      return `You introduced ${token}, which does not exist in the source string. Remove it — inventing an interpolation breaks the caller.`;
    }
    case "placeholder-malformed": {
      const reason = detailString(issue, "reason");
      if (reason === "full-width-delimiters") {
        return `${token} uses full-width delimiters. Rewrite it with ASCII braces and percent signs exactly as the source has it.`;
      }
      if (reason === "unbalanced-braces") {
        return `Your output has unbalanced braces that are not part of a valid placeholder. Every "{" must have its matching "}".`;
      }
      return `${token} is malformed in your output. Reproduce it exactly as ${token} — same characters, no added spaces, no substituted look-alike glyphs.`;
    }
    case "placeholder-reordered": {
      const sourceOrder = detailString(issue, "sourceOrder");
      return (
        `The format specifiers must stay in the source order${sourceOrder ? ` (${sourceOrder})` : ""}. ` +
        `They have no argument indices, so they are filled by position — swapping them prints the wrong value in the wrong place. ` +
        `If the target grammar demands a different word order, keep the specifiers in their original sequence and rearrange the words around them.`
      );
    }
    default:
      return issue.message;
  }
}

function directiveFor(
  issue: Issue,
  unit: TranslationUnit,
  previousTarget: string,
  fit: FitResult | null,
): string {
  switch (issue.code) {
    case "placeholder-missing":
    case "placeholder-added":
    case "placeholder-malformed":
    case "placeholder-reordered":
      return placeholderDirective(issue);

    case "length-overflow":
      return fit !== null
        ? overflowDirective(unit, previousTarget, fit)
        : issue.message;

    case "length-tight":
      return `Your previous attempt only just fits. Shorten it if you can do so without losing meaning.`;

    case "empty-translation":
      return (
        `You returned an empty string. Every entry must carry a real translation of ` +
        `${JSON.stringify(unit.source)} — if the string is a brand name, repeat it verbatim rather than returning nothing.`
      );

    case "untranslated":
      return (
        `Your output was character-for-character identical to the source. Translate it. ` +
        `Only repeat the source verbatim when it is a proper noun, a product name, or a term the glossary marks as untranslatable.`
      );

    case "control-characters": {
      const cp = detailString(issue, "codePoint") ?? "an invalid character";
      return `Your output contains ${cp}. Emit plain text only — no control characters, no zero-width characters, no replacement glyphs.`;
    }

    case "tag-imbalance": {
      const tag = detailString(issue, "tag");
      const expected = detailString(issue, "expected");
      if (tag !== null && expected !== null) {
        return `The markup is unbalanced around ${tag}: it needs a matching ${expected}, correctly nested. Tags may move within the sentence but must stay paired.`;
      }
      return `The markup tags in your output are unbalanced. Every opening tag needs its matching closing tag, correctly nested.`;
    }

    case "whitespace-drift": {
      const side = detailString(issue, "side") ?? "edge";
      return (
        `The source has ${side} whitespace that your output dropped or changed. Reproduce it exactly — ` +
        `these strings are concatenated with adjacent UI text and the space is part of the layout.`
      );
    }

    case "casing-drift": {
      const style = detailString(issue, "style") ?? "casing";
      return `The source uses ${style} styling for this ${unit.role}. Match it, unless the target language's orthography forbids it.`;
    }

    case "structure-mismatch":
    case "invalid-json":
      return `Return only the translated string itself — no JSON, no object wrapper, no key.`;

    case "provider-error":
    case "budget-exhausted":
      return issue.message;
  }

  // Exhaustive over `IssueCode`: adding a code to the contract without a
  // directive here is a compile error rather than a silently vague prompt.
  const unhandled: never = issue.code;
  return String(unhandled);
}

function requiredPlaceholderLine(placeholders: readonly Placeholder[]): string | null {
  if (placeholders.length === 0) return null;
  const counts = new Map<string, { raw: string; count: number }>();
  for (const p of placeholders) {
    const id = placeholderIdentity(p);
    const existing = counts.get(id);
    if (existing) existing.count += 1;
    else counts.set(id, { raw: p.raw, count: 1 });
  }
  const rendered = [...counts.values()].map(({ raw, count }) =>
    count === 1 ? raw : `${raw} ×${count}`,
  );
  return `Placeholders that must appear exactly as written: ${rendered.join(", ")}.`;
}

/**
 * Author the `repairFeedback` string that goes into the next prompt.
 *
 * Structure is fixed on purpose — models follow numbered, imperative lists far
 * more reliably than prose — and the closing "constraints" block restates the
 * invariants so a repair that fixes the length does not quietly drop a
 * placeholder in the process.
 */
export function buildRepairFeedback(
  unit: TranslationUnit,
  previousTarget: string,
  issues: readonly Issue[],
  fit: FitResult | null,
): string {
  const relevant = issues.filter(
    (i) => i.severity === "error" || i.code === "length-overflow",
  );
  const pool = relevant.length > 0 ? relevant : issues;

  const directives: string[] = [];
  const seen = new Set<string>();

  // Overflow leads: it is the constraint that shapes the whole rewrite, and if
  // the fit result says overflow the model must hear it even when no
  // `length-overflow` issue was recorded alongside it.
  if (fit !== null && fit.verdict === "overflow") {
    const line = overflowDirective(unit, previousTarget, fit);
    directives.push(line);
    seen.add(line);
  }

  for (const issue of pool) {
    // `seen` handles the overlap with the leading overflow directive: for a
    // `length-overflow` issue with a fit result, `directiveFor` produces the
    // identical string and is deduplicated.
    const line = directiveFor(issue, unit, previousTarget, fit);
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    directives.push(line);
  }

  if (directives.length === 0) {
    directives.push(
      "Your previous attempt was rejected. Produce a different translation that keeps the meaning, the register, and every placeholder.",
    );
  }

  const lines: string[] = [];
  lines.push(
    `Your previous attempt for "${unit.key}" was rejected: ${JSON.stringify(previousTarget)}`,
  );
  lines.push("");
  lines.push("Fix all of the following:");
  directives.forEach((directive, i) => {
    lines.push(`${i + 1}. ${directive}`);
  });

  const constraints: string[] = [];
  const placeholderLine = requiredPlaceholderLine(unit.placeholders);
  if (placeholderLine !== null) constraints.push(placeholderLine);
  if (unit.budget.maxChars !== null) {
    constraints.push(`Hard limit: ${unit.budget.maxChars} characters (${unit.budget.rationale}).`);
  } else if (fit !== null && fit.verdict === "overflow") {
    constraints.push(
      `Target length: at most ${characterCeiling(previousTarget, fit)} characters (${unit.budget.rationale}).`,
    );
  }
  constraints.push(
    "Return the translated string only — no quotes around it, no code fence, no explanation.",
  );

  lines.push("");
  lines.push("Constraints that still apply:");
  for (const constraint of constraints) lines.push(`- ${constraint}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Final status
// ---------------------------------------------------------------------------

/**
 * Reduce the surviving issues to the entry's terminal status.
 *
 * A surviving error means the entry could not be produced correctly, so it is
 * `failed` and the UI must surface it rather than shipping it silently. An
 * overflow verdict is treated the same way even without an accompanying issue:
 * quality bar #1 says a translation never overflows its bounds, so "still
 * overflowing at resolution time" cannot be reported as a pass.
 */
export function resolveFinalStatus(
  issues: readonly Issue[],
  fit: FitResult | null,
): EntryStatus {
  const summary = summarizeIssues(issues);
  if (summary.errors > 0) return "failed";
  if (fit !== null && fit.verdict === "overflow") return "failed";
  if (summary.total > 0) return "flagged";
  if (fit !== null && fit.verdict === "tight") return "flagged";
  return "passed";
}

/**
 * The issue recorded when the repair budget runs out with problems still open.
 * Distinct from the underlying failure so the UI can explain *why* a broken
 * entry was delivered rather than retried again.
 */
export function budgetExhaustedIssue(
  key: string,
  attempts: number,
  maxRepairAttempts: number,
): Issue {
  return classify(
    "budget-exhausted",
    `Gave up after ${attempts} attempt(s); the repair budget for this entry is ${maxRepairAttempts}.`,
    { key, detail: { attempts, maxRepairAttempts } },
  );
}
