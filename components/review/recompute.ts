/**
 * Live re-evaluation of an edited translation.
 *
 * This is the file that makes the product's central claim true. When a
 * developer overrides a string in the review table, the same layout engine and
 * the same validators that judged the model's output judge theirs — immediately,
 * on every keystroke — so an edit that overflows is flagged the instant it
 * does, not at export time and not in production.
 *
 * Nothing here re-implements a rule: fit comes from `evaluateFit`, issues from
 * `validateTranslation`, the terminal status from `resolveFinalStatus`.
 */

import { extractPlaceholders } from "@/lib/core";
import {
  budgetForRole,
  evaluateFit,
  planLength,
  truncateToWidth,
} from "@/lib/layout";
import {
  applyMechanicalFixes,
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
  LocaleProfile,
  TranslationUnit,
} from "@/lib/types";
import type { ReviewRow } from "./rows";

export interface RecomputeContext {
  profile: LocaleProfile;
  sourceLocale: LocaleCode;
  glossary?: readonly GlossaryTerm[];
}

function validationContextFor(
  row: ReviewRow,
  ctx: RecomputeContext,
): ValidationContext {
  const context: ValidationContext = {
    key: row.key,
    role: row.role,
    locale: row.locale,
    sourceLocale: ctx.sourceLocale,
    doNotTranslate: row.doNotTranslate,
    ambiguities: row.ambiguities,
    sourcePlaceholders: row.sourcePlaceholders,
  };
  if (ctx.glossary !== undefined) context.glossary = ctx.glossary;
  return context;
}

/** Fit + issues + status for a candidate translation, without building a row. */
export interface Evaluation {
  fit: ReturnType<typeof evaluateFit>;
  issues: Issue[];
  status: ReturnType<typeof resolveFinalStatus>;
}

export function evaluateTarget(
  row: ReviewRow,
  target: string,
  ctx: RecomputeContext,
): Evaluation {
  const fit = evaluateFit(row.source, target, row.role, ctx.profile);
  const issues = validateTranslation(
    row.source,
    target,
    fit,
    validationContextFor(row, ctx),
  );
  return { fit, issues, status: resolveFinalStatus(issues, fit) };
}

/**
 * Apply an override to a row.
 *
 * Reverting to the model's exact output clears the `edited` flag — an edit that
 * has been undone is not an edit, and the export summary must not claim
 * otherwise.
 */
export function recomputeRow(
  row: ReviewRow,
  nextTarget: string,
  ctx: RecomputeContext,
): ReviewRow {
  const { fit, issues, status } = evaluateTarget(row, nextTarget, ctx);

  return {
    ...row,
    target: nextTarget,
    edited: nextTarget !== row.modelTarget,
    status,
    issues,
    fit,
    targetPlaceholders: extractPlaceholders(nextTarget),
  };
}

/** Restore the model's own output and the analysis that came with it. */
export function revertRow(row: ReviewRow, ctx: RecomputeContext): ReviewRow {
  return recomputeRow(row, row.modelTarget, ctx);
}

/**
 * Deterministic clean-up the pipeline would have applied — stray whitespace,
 * smart-quote drift, a missing trailing space. Offered as a one-click fix
 * because a human editor introduces exactly these.
 */
export function tidyRow(row: ReviewRow, ctx: RecomputeContext): ReviewRow {
  const fixed = applyMechanicalFixes(row.source, row.target);
  return fixed.changed ? recomputeRow(row, fixed.text, ctx) : row;
}

/**
 * Clip an overflowing edit down to its budget, keeping placeholders whole.
 *
 * The same `truncateToWidth` the exporter uses, so what the developer previews
 * here is exactly what would be written to disk.
 */
export function trimRowToFit(row: ReviewRow, ctx: RecomputeContext): ReviewRow {
  const allowedWidth =
    row.fit?.allowedWidth ??
    planLength(row.source, row.role, ctx.profile).allowedWidth;

  const preserve = extractPlaceholders(row.target).map((p) => p.raw);
  const truncation = truncateToWidth(row.target, allowedWidth, ctx.profile, {
    preserve,
  });
  return truncation.truncated ? recomputeRow(row, truncation.text, ctx) : row;
}

/** The prompt unit this row would produce — the shape the engine speaks. */
export function unitForRow(
  row: ReviewRow,
  ctx: RecomputeContext,
): TranslationUnit {
  const plan = planLength(row.source, row.role, ctx.profile);
  const unit: TranslationUnit = {
    key: row.key,
    source: row.source,
    role: row.role,
    placeholders: row.sourcePlaceholders,
    ambiguities: row.ambiguities,
    budget: plan.budget,
    allowedWidth: plan.allowedWidth,
    neighbors: row.neighbors,
  };
  if (row.developerNote !== undefined) unit.developerNote = row.developerNote;
  return unit;
}

/**
 * The exact instruction a repair pass would send for this row, or `null` when
 * the row does not warrant one.
 *
 * Shown in the expanded row so the developer can see precisely what the agent
 * would tell the model — the repair loop stops being a black box.
 */
export function repairFeedbackForRow(
  row: ReviewRow,
  ctx: RecomputeContext,
): string | null {
  if (!needsRepair(row.issues, row.fit)) return null;
  return buildRepairFeedback(
    unitForRow(row, ctx),
    row.target,
    row.issues,
    row.fit,
  );
}

/** Plain-language budget line for the row, for the expanded panel. */
export function budgetRationaleForRow(
  row: ReviewRow,
  ctx: RecomputeContext,
): string {
  return (
    row.fit?.budget.rationale ??
    budgetForRole(row.role, row.source, ctx.profile).rationale
  );
}
