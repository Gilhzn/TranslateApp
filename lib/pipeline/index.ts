/**
 * LingoLoop pipeline — the autonomous execution loop and its HTTP plumbing.
 *
 * The shape a caller normally uses:
 *
 *   1. `parseTranslateRequest(body)`   validate untrusted input, parse the file
 *   2. `resolveProvider()`             (from `@/lib/engine`) pick the provider
 *   3. `runJob({ catalog, settings, provider, onProgress, onLocaleComplete })`
 *   4. `encodeSseEvent("progress", …)` frame each callback onto the wire
 *
 * `runLocale` is exported separately for callers translating a single locale,
 * and `mapPool` for anything else that needs a bounded pool.
 */

export {
  JobAbortedError,
  PipelineRequestError,
  StructuralIntegrityError,
  isAborted,
  isJobAborted,
  isPipelineRequestError,
  throwIfAborted,
} from "./errors";
export type {
  PipelineRequestErrorOptions,
  RequestErrorBody,
  RequestErrorCode,
} from "./errors";

export { mapPool, withAbort } from "./pool";
export type { PoolOptions } from "./pool";

export { MAX_NEIGHBORS, neighborKeys, prepareUnits, repairUnit } from "./units";
export type { PreparedCatalog, PreparedUnit } from "./units";

export { ProgressTracker } from "./progress";
export type { ProgressListener } from "./progress";

export {
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_LOCALE_CONCURRENCY,
  REPAIR_ATTEMPT_CEILING,
  runJob,
  runLocale,
} from "./run";
export type {
  RebuildFn,
  RunJobOptions,
  RunLocaleOptions,
  RunnableCatalog,
} from "./run";

export {
  SseParser,
  encodeSseComment,
  encodeSseEvent,
  encodeSseFrame,
  readSseStream,
} from "./sse";
export type { SseFrame, SseMessage } from "./sse";

export {
  LOCALE_PATTERN,
  MAX_FILE_NAME_LENGTH,
  MAX_GLOSSARY_TERMS,
  MAX_GLOSSARY_TERM_LENGTH,
  MAX_PRODUCT_CONTEXT,
  MAX_REPAIR_ATTEMPTS,
  MAX_REQUEST_BYTES,
  MAX_SOURCE_TEXT_BYTES,
  MAX_TARGET_LOCALES,
  parseSettings,
  parseTranslateRequest,
  readJsonBody,
} from "./request";
export type { TranslateRequest } from "./request";
