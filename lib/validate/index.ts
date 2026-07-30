/**
 * LingoLoop validation: error taxonomy, per-string validators, structural
 * integrity, deterministic repair, and repair decisioning.
 *
 * The intended call order for one translated entry:
 *
 *   1. `applyMechanicalFixes(source, target)`  free deterministic repairs
 *   2. `validateTranslation(source, fixed, fit, ctx)`  what is still wrong
 *   3. `needsRepair(issues, fit)`  is another model call warranted?
 *   4. `buildRepairFeedback(unit, fixed, issues, fit)`  what to tell the model
 *   5. `resolveFinalStatus(issues, fit)`  terminal status for the review table
 *
 * And once per emitted file:
 *
 *   `assertStructuralParity(sourceTree, rebuiltTree)`
 *   `validateEmittedJson(serialized, sourceTree)`
 *
 * Everything is pure and isomorphic — the same code runs in the API route, in
 * the browser preview and in tests.
 */

export {
  ALL_ISSUE_CODES,
  LingoLoopError,
  PLACEHOLDER_CODES,
  ProviderError,
  SEVERITY_POLICY,
  SEVERITY_RANK,
  SourceParseError,
  StructureError,
  ValidationError,
  classify,
  compareSeverity,
  defaultSeverity,
  isBlocking,
  isLingoLoopError,
  issue,
  maxSeverity,
  summarizeIssues,
  toIssue,
} from "./errors";
export type { IssueDetail, IssueOptions, IssueSummary, LingoLoopErrorOptions } from "./errors";

export {
  STRING_VALIDATORS,
  issuesFromFit,
  placeholderIdentity,
  validateCasingDrift,
  validateControlCharacters,
  validateNotEmpty,
  validatePlaceholderParity,
  validateString,
  validateTagBalance,
  validateTranslation,
  validateUntranslated,
  validateWhitespaceDrift,
} from "./validators";
export type { ValidationContext } from "./validators";

export {
  assertStructuralParity,
  deepEqualJson,
  jsonKind,
  validateEmittedJson,
} from "./structure";
export type { JsonKind, ParityOptions } from "./structure";

export { applyMechanicalFixes, describeMechanicalFixes } from "./mechanical-fix";
export type {
  MechanicalFix,
  MechanicalFixKind,
  MechanicalFixResult,
} from "./mechanical-fix";

export {
  MODEL_REPAIRABLE_CODES,
  assessRepair,
  budgetExhaustedIssue,
  buildRepairFeedback,
  isModelRepairable,
  needsRepair,
  resolveFinalStatus,
} from "./repair";
export type { RepairAssessment } from "./repair";

export {
  baseLanguage,
  capitalisesNouns,
  formatCodePoint,
  isCaselessLanguage,
  sameLanguage,
  visualizeWhitespace,
} from "./text";
