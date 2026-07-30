export { UploadStage } from "./UploadStage";
export type { StartHandler, UploadStageProps } from "./UploadStage";

export { DropZone } from "./DropZone";
export type { DropZoneProps } from "./DropZone";

export { CatalogSummary } from "./CatalogSummary";
export type { CatalogSummaryProps } from "./CatalogSummary";

export { LocalePicker } from "./LocalePicker";
export type { LocalePickerProps } from "./LocalePicker";

export { JobSettings } from "./JobSettings";
export type { JobSettingsProps } from "./JobSettings";

export { ProviderIndicator, ProviderNotice } from "./ProviderIndicator";
export type { ProviderIndicatorProps, ProviderNoticeProps } from "./ProviderIndicator";

export {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  failureFromParseError,
  failureFromUnknown,
  fileExtension,
  formatBytes,
  looksLikeJsonObject,
  utf8ByteLength,
  validatePastedText,
  validateUploadFile,
} from "./file-validation";
export type {
  UploadCandidate,
  UploadFailure,
  UploadFailureCode,
} from "./file-validation";

export { DRAG_IDLE, carriesFiles, dragTransition } from "./drag-state";
export type { DragSignal, DragState } from "./drag-state";

export {
  POPULAR_LOCALES,
  expansionRisk,
  filterLocaleProfiles,
  formatExpansion,
  localeHaystack,
  localeTags,
  matchesLocaleQuery,
  profilesFor,
  selectableLocales,
  worstExpansion,
} from "./locale-search";
export type { ExpansionRisk } from "./locale-search";

export {
  AMBIGUITY_META,
  AMBIGUITY_ORDER,
  ROLE_LABELS,
  ROLE_ORDER,
  catalogHeadlines,
  describeFormatting,
  formatCount,
  groupAmbiguities,
  pickSamples,
  segmentPlaceholders,
  tallyRoles,
  totalAmbiguities,
} from "./catalog-insights";
export type {
  AmbiguityGroup,
  AmbiguityItem,
  AmbiguityKindMeta,
  CatalogHeadline,
  RoleTally,
  ValueSegment,
} from "./catalog-insights";

export {
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS,
  MIN_REPAIR_ATTEMPTS,
  PRODUCT_CONTEXT_LIMIT,
  TONE_OPTIONS,
  TONE_ORDER,
  buildTranslationSettings,
  clampRepairAttempts,
  compileGlossary,
  estimateUnits,
  initialSettingsDraft,
  newGlossaryDraft,
  startBlockers,
  toggleLocale,
} from "./settings-model";
export type {
  BlockerCode,
  GlossaryDraft,
  ReadinessInput,
  SettingsDraft,
  StartBlocker,
  ToneOption,
} from "./settings-model";
