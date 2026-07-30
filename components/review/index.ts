/**
 * LingoLoop review surface.
 *
 * `ReviewPanel` is the drop-in composition: give it a parsed catalog and the
 * job's locale results and it renders the summary, filters, table and export.
 * The pieces below it are exported so a host page can lay them out itself.
 *
 * The `.ts` modules (`rows`, `recompute`, `filtering`, `windowing`) are pure
 * and React-free — they hold every rule the surface enforces and are covered by
 * unit tests.
 */

export { ReviewPanel } from "./ReviewPanel";
export type { ReviewPanelProps } from "./ReviewPanel";

export { ReviewTable } from "./ReviewTable";
export type { ReviewTableProps } from "./ReviewTable";

export { ReviewToolbar } from "./ReviewToolbar";
export type { LocaleOption, ReviewToolbarProps } from "./ReviewToolbar";

export { FIT_VERDICT_LABEL, FitMeter, fitTone } from "./FitMeter";
export type { FitMeterProps, FitTone } from "./FitMeter";

export { IssueList, severityTone } from "./IssueList";
export type { IssueListProps, SeverityTone } from "./IssueList";

export { PlaceholderInventory, RowDetail } from "./RowDetail";
export type { PlaceholderInventoryProps, RowDetailProps } from "./RowDetail";

export { STATUS_LABEL, StatusBadge, statusTone } from "./StatusBadge";
export type { StatusBadgeProps } from "./StatusBadge";

export {
  REVIEW_STATUSES,
  TERMINAL_STATUSES,
  buildRow,
  buildRows,
  diffPlaceholders,
  indexCatalog,
  resultWithEdits,
  rowToEntry,
} from "./rows";
export type { PlaceholderDiff, ReviewRow } from "./rows";

export {
  budgetRationaleForRow,
  evaluateTarget,
  recomputeRow,
  repairFeedbackForRow,
  revertRow,
  tidyRow,
  trimRowToFit,
  unitForRow,
} from "./recompute";
export type { Evaluation, RecomputeContext } from "./recompute";

export {
  ALL_FILTER,
  countRows,
  filterRows,
  isFilterActive,
  issueCodeOptions,
  queryTerms,
} from "./filtering";
export type { Facet, ReviewCounts, ReviewFilter } from "./filtering";

export {
  DETAIL_HEIGHT,
  ROW_HEIGHT,
  buildOffsets,
  computeWindow,
  indexAtOffset,
  scrollToIndex,
  uniformOffsets,
} from "./windowing";
export type { WindowSlice } from "./windowing";

// `./demo-data` is deliberately NOT re-exported: it carries a 4 kB sample
// catalog that only the `/preview/review` route and the tests need, and this
// barrel is imported by production pages. Import it by path when you want it.
