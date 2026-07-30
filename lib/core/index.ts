/**
 * LingoLoop core: source parsing, flattening, and per-string analysis.
 *
 * Pure, isomorphic logic — no React, no DOM, no Node built-ins — so the same
 * code runs in the upload dropzone, in the API route and in tests.
 */

export {
  parseSourceFile,
  serializeWithCatalogFormatting,
  detectIndent,
  detectEol,
  inferLocaleFromFileName,
  JsonParseError,
  type ParseOptions,
  type ParsedCatalog,
  type CatalogFormatting,
} from "./parse";

export {
  readJsonDocument,
  JsonReadError,
  MAX_NESTING_DEPTH,
  type JsonDocument,
} from "./json-reader";

export {
  orderKeys,
  registerKeyOrder,
  recordedKeyOrder,
  resolveKeyOrder,
  toSerializableKeyOrder,
  keyOrderFromEntries,
  type KeyOrderMap,
  type SerializedKeyOrder,
} from "./key-order";

export {
  flattenJson,
  rebuildTree,
  collectTreeStats,
  type TreeStats,
} from "./flatten";

export { encodeKey, decodeKey, KeyDecodeError } from "./keys";

export {
  extractPlaceholders,
  stripPlaceholders,
  topLevelPlaceholders,
  parseComplexIcuArgument,
  type IcuComplexArgument,
  type IcuComplexFormat,
  type IcuSubMessage,
} from "./placeholders";

export { inferRole, tokenizeSegment } from "./roles";

export {
  detectAmbiguities,
  findWholeWord,
  ambiguityTermCount,
} from "./ambiguity";

export {
  classifyNonTranslatable,
  isDoNotTranslate,
  type NonTranslatableReason,
} from "./translatable";
