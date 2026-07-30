/**
 * LingoLoop layout engine — UI context checking.
 *
 * Public surface, in the order a caller normally uses it:
 *
 *   1. `getLocaleProfile("pt-BR")`            resolve the target language
 *   2. `planLength(source, role, profile)`    budget + allowedWidth for a unit
 *   3. `describeBudgetForPrompt(...)`         plain-language limit for the LLM
 *   4. `evaluateFit(source, target, ...)`     verdict on what came back
 *   5. `describeFitForRepair(fit, profile)`   feedback for the repair pass
 *   6. `enforceFit(...)`                      last-resort structural clip
 *
 * Everything here is pure and runs unchanged in Node and the browser.
 */

export {
  DEFAULT_EXPANSION,
  LOCALE_PROFILES,
  NEUTRAL_LOCALE_PROFILE,
  getLocaleProfile,
  isFullWidthScript,
  isKnownLocale,
  listLocaleProfiles,
  normalizeLocaleCode,
} from "./locales";

export {
  FULL_WIDTH_ADVANCE,
  MEAN_LATIN_ADVANCE,
  averageCharWidth,
  charAdvance,
  estimateLongestLineWidth,
  estimateWidth,
  measureText,
  round3,
  typicalCharWidth,
} from "./metrics";
export type { TextMeasurement } from "./metrics";

export {
  absoluteHeadroomFor,
  allowedWidthFor,
  budgetForRole,
  describeBudgetForPrompt,
  effectiveRatioFor,
  planLength,
  roleSpec,
} from "./budget";
export type { LengthPlan } from "./budget";

export {
  budgetFor,
  describeFitForRepair,
  enforceFit,
  evaluateFit,
  truncateToWidth,
  verdictFor,
} from "./fit";
export type { TruncateOptions, TruncationResult } from "./fit";
