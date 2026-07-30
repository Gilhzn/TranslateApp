import type { Placeholder } from "@/lib/types";
import { stripPlaceholders } from "./placeholders";

/**
 * "Do not translate" detection.
 *
 * Locale files carry a surprising amount of machine data: asset paths, colour
 * tokens, analytics identifiers, version strings. Sending those to a model is
 * how you end up with `#FF0000` translated to `#RO0000` — so anything that is
 * provably not human copy is emitted verbatim.
 *
 * Every rule below is deliberately *anchored to the whole value*. A URL inside
 * a sentence does not make the sentence untranslatable; a value that IS a URL
 * does.
 */

export type NonTranslatableReason =
  | "empty"
  | "url"
  | "email"
  | "number"
  | "iso-date"
  | "hex-color"
  | "semver"
  | "file-path"
  | "identifier"
  | "placeholder-only";

const RE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|data:|\/\/)\S*$/i;
const RE_BARE_DOMAIN = /^www\.[^\s/]+\.[a-z]{2,}(?:\/\S*)?$/i;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RE_NUMBER = /^[+-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?$/;
const RE_ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const RE_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RE_SEMVER =
  /^v?\d+\.\d+\.\d+(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i;
/** Rooted or dot-relative paths, plus Windows drive paths. */
const RE_ROOTED_PATH = /^(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/])[^\s]*$/;
/** Multi-segment relative paths that end in an extension, e.g. `assets/ui/x.png`. */
const RE_RELATIVE_PATH = /^[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8}$/;
/** Bare file names: `sprite.png`, `README.md` — but not the product "Node.js". */
const RE_BARE_FILE = /^([a-z0-9_-]+|[A-Z0-9_]+)\.([A-Za-z0-9]{1,8})$/;
const FILE_EXTENSIONS = new Set([
  "json", "js", "jsx", "ts", "tsx", "mjs", "cjs", "map", "css", "scss", "sass",
  "less", "html", "htm", "xml", "svg", "png", "jpg", "jpeg", "gif", "webp",
  "avif", "ico", "bmp", "tiff", "mp3", "wav", "ogg", "flac", "mp4", "webm",
  "mov", "avi", "md", "mdx", "txt", "csv", "tsv", "pdf", "zip", "tar", "gz",
  "rar", "7z", "yml", "yaml", "toml", "ini", "env", "lock", "log", "sh", "bat",
  "ps1", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h",
  "hpp", "cs", "php", "sql", "db", "sqlite", "exe", "dll", "dmg", "apk", "ipa",
  "ttf", "otf", "woff", "woff2", "glb", "gltf", "fbx", "obj", "unity", "uasset",
]);
/** SCREAMING_SNAKE or snake_case identifiers. */
const RE_SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$|^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/**
 * kebab-case identifiers. Two-segment kebab is deliberately excluded: "sign-up",
 * "opt-in", "e-mail" and "co-op" are ordinary UI copy, and silently refusing to
 * translate them is worse than sending an occasional CSS token to the model.
 */
const RE_KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}$/;
/** Dotted machine identifiers, e.g. `com.example.app` or `user.profile.title`. */
const RE_DOTTED_ID = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+){2,}$/;

/**
 * Returns the reason a value must be emitted verbatim, or `null` when the value
 * is human-facing copy.
 */
export function classifyNonTranslatable(
  value: string,
  placeholders: readonly Placeholder[],
): NonTranslatableReason | null {
  if (value.trim().length === 0) return "empty";

  // A string made entirely of interpolations (e.g. "{{first}} {{last}}") has no
  // words to translate and any edit risks breaking parity.
  if (placeholders.length > 0) {
    const residue = stripPlaceholders(value, placeholders);
    if (residue.trim().length === 0) return "placeholder-only";
  }

  const text = value.trim();
  // Multi-word human copy is never a machine token; bail out early so the
  // narrow regexes below cannot misfire on sentences.
  const hasSpace = /\s/.test(text);

  if (!hasSpace) {
    if (RE_URL.test(text) || RE_BARE_DOMAIN.test(text)) return "url";
    if (RE_EMAIL.test(text)) return "email";
    if (RE_HEX_COLOR.test(text)) return "hex-color";
    if (RE_ISO_DATE.test(text)) return "iso-date";
    if (RE_SEMVER.test(text)) return "semver";
    if (RE_NUMBER.test(text)) return "number";
    if (RE_ROOTED_PATH.test(text) || RE_RELATIVE_PATH.test(text)) {
      return "file-path";
    }
    const bareFile = RE_BARE_FILE.exec(text);
    if (bareFile) {
      const ext = bareFile[2];
      if (ext !== undefined && FILE_EXTENSIONS.has(ext.toLowerCase())) {
        return "file-path";
      }
    }
    if (RE_SNAKE.test(text) || RE_KEBAB.test(text) || RE_DOTTED_ID.test(text)) {
      return "identifier";
    }
  } else if (RE_ISO_DATE.test(text)) {
    // "2024-01-01 10:00" is the one machine format that legitimately contains a
    // space.
    return "iso-date";
  }

  return null;
}

export function isDoNotTranslate(
  value: string,
  placeholders: readonly Placeholder[],
): boolean {
  return classifyNonTranslatable(value, placeholders) !== null;
}
