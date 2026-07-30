/**
 * Request validation for the streaming translate endpoint.
 *
 * Everything arriving here is untrusted, including the parts that look boring.
 * Three rules:
 *
 *   1. **The server parses the source file, not the client.** The request
 *      carries the raw file text; `parseSourceFile` turns it into a catalog on
 *      this side. A client-supplied tree would mean trusting a stranger's idea
 *      of key order and indentation, and a hostile one could hand us a shape
 *      that no longer matches the file it claims to translate.
 *   2. **Bounded before parsed.** The body is read through a byte counter, so a
 *      200 MB upload is refused after 2 MB rather than after it has been
 *      buffered into a string.
 *   3. **Typed refusals.** Every rejection names the field and says what would
 *      have been accepted. A stack trace never reaches the wire.
 */

import { JsonParseError, parseSourceFile, type ParsedCatalog } from "@/lib/core";
import type {
  GlossaryTerm,
  LocaleCode,
  ToneProfile,
  TranslationSettings,
} from "@/lib/types";
import { PipelineRequestError } from "./errors";

/** Whole-request ceiling, JSON envelope included. */
export const MAX_REQUEST_BYTES = 2_000_000;
/** Ceiling on the source catalogue itself. */
export const MAX_SOURCE_TEXT_BYTES = 1_500_000;
export const MAX_TARGET_LOCALES = 24;
export const MAX_GLOSSARY_TERMS = 200;
export const MAX_GLOSSARY_TERM_LENGTH = 200;
export const MAX_PRODUCT_CONTEXT = 2_000;
export const MAX_REPAIR_ATTEMPTS = 4;
export const MAX_FILE_NAME_LENGTH = 200;
/** Locale codes are BCP-47-ish; anything else is a typo or an injection probe. */
export const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const TONES: ReadonlySet<string> = new Set<ToneProfile>([
  "neutral-product",
  "casual-indie",
  "gaming",
  "technical-developer",
  "formal-enterprise",
]);

export interface TranslateRequest {
  catalog: ParsedCatalog;
  settings: TranslationSettings;
}

// ---------------------------------------------------------------------------
// Body reading
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Read and JSON-parse the request body, refusing anything oversized.
 *
 * The stream is counted as it arrives so the cap is enforced against bytes on
 * the wire, not against a string we have already paid to materialise.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new PipelineRequestError(
      415,
      "unsupported-media-type",
      `Expected a JSON request body (Content-Type: application/json), received ${contentType.trim().length > 0 ? `"${contentType.trim().slice(0, 80)}"` : "no Content-Type"}.`,
    );
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      throw tooLarge(size, maxBytes);
    }
  }

  const text = await readBoundedText(request, maxBytes);
  if (text.trim().length === 0) {
    throw new PipelineRequestError(400, "invalid-json", "The request body is empty.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PipelineRequestError(
      400,
      "invalid-json",
      `The request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (body === null) {
    // Some runtimes (and hand-built Requests in tests) expose no stream.
    const text = await request.text();
    if (byteLength(text) > maxBytes) throw tooLarge(byteLength(text), maxBytes);
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let out = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > maxBytes) throw tooLarge(received, maxBytes);
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releasing before cancelling would throw; cancelling a finished stream is
    // a no-op, so this covers both the happy path and the refusal path.
    await reader.cancel().catch(() => undefined);
  }

  return out + decoder.decode();
}

function tooLarge(size: number, maxBytes: number): PipelineRequestError {
  return new PipelineRequestError(
    413,
    "payload-too-large",
    `The request body is larger than the ${Math.floor(maxBytes / 1000)} kB limit. Split the catalogue or translate fewer locales per request.`,
    { detail: { bytes: size, maxBytes } },
  );
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, field?: string): PipelineRequestError {
  return new PipelineRequestError(
    400,
    "invalid-body",
    message,
    field === undefined ? {} : { field },
  );
}

function requireString(
  value: unknown,
  field: string,
  { max, min = 1 }: { max: number; min?: number },
): string {
  if (typeof value !== "string") {
    throw invalid(`"${field}" must be a string.`, field);
  }
  if (value.length < min) {
    throw invalid(`"${field}" must not be empty.`, field);
  }
  if (value.length > max) {
    throw invalid(`"${field}" must be at most ${max} characters.`, field);
  }
  return value;
}

function requireLocale(value: unknown, field: string): LocaleCode {
  const raw = requireString(value, field, { max: 35 });
  const trimmed = raw.trim();
  if (!LOCALE_PATTERN.test(trimmed)) {
    throw invalid(
      `"${field}" must be a BCP-47 locale code such as "de", "pt-BR" or "zh-Hans".`,
      field,
    );
  }
  return trimmed;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`"${field}" must be true or false.`, field);
  }
  return value;
}

function parseGlossary(value: unknown): GlossaryTerm[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid(`"settings.glossary" must be an array.`, "settings.glossary");
  }
  if (value.length > MAX_GLOSSARY_TERMS) {
    throw invalid(
      `"settings.glossary" may hold at most ${MAX_GLOSSARY_TERMS} terms.`,
      "settings.glossary",
    );
  }

  const out: GlossaryTerm[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    const field = `settings.glossary[${i}]`;
    if (!isRecord(raw)) throw invalid(`"${field}" must be an object.`, field);

    const term = requireString(raw["term"], `${field}.term`, {
      max: MAX_GLOSSARY_TERM_LENGTH,
    });

    const translationsRaw = raw["translations"];
    const translations: Record<LocaleCode, string> = {};
    if (translationsRaw !== undefined) {
      if (!isRecord(translationsRaw)) {
        throw invalid(
          `"${field}.translations" must be an object mapping locale codes to strings.`,
          `${field}.translations`,
        );
      }
      for (const [locale, rendering] of Object.entries(translationsRaw)) {
        if (!LOCALE_PATTERN.test(locale)) {
          throw invalid(
            `"${field}.translations" has an invalid locale key.`,
            `${field}.translations`,
          );
        }
        if (typeof rendering !== "string") {
          throw invalid(
            `"${field}.translations.${locale}" must be a string.`,
            `${field}.translations`,
          );
        }
        if (rendering.length > MAX_GLOSSARY_TERM_LENGTH) {
          throw invalid(
            `"${field}.translations.${locale}" must be at most ${MAX_GLOSSARY_TERM_LENGTH} characters.`,
            `${field}.translations`,
          );
        }
        translations[locale] = rendering;
      }
    }

    const entry: GlossaryTerm = {
      term,
      translations,
      caseSensitive: raw["caseSensitive"] === true,
    };
    const note = raw["note"];
    if (typeof note === "string" && note.length > 0) {
      entry.note = note.slice(0, MAX_GLOSSARY_TERM_LENGTH);
    }
    out.push(entry);
  }

  return out;
}

export function parseSettings(value: unknown): TranslationSettings {
  if (!isRecord(value)) {
    throw invalid(`"settings" must be an object.`, "settings");
  }

  const sourceLocale = requireLocale(value["sourceLocale"], "settings.sourceLocale");

  const targetsRaw = value["targetLocales"];
  if (!Array.isArray(targetsRaw)) {
    throw invalid(
      `"settings.targetLocales" must be an array of locale codes.`,
      "settings.targetLocales",
    );
  }
  if (targetsRaw.length === 0) {
    throw invalid(
      `Select at least one target locale.`,
      "settings.targetLocales",
    );
  }
  if (targetsRaw.length > MAX_TARGET_LOCALES) {
    throw invalid(
      `At most ${MAX_TARGET_LOCALES} target locales can be translated in one request.`,
      "settings.targetLocales",
    );
  }
  const seen = new Set<string>();
  const targetLocales: LocaleCode[] = [];
  for (let i = 0; i < targetsRaw.length; i += 1) {
    const locale = requireLocale(targetsRaw[i], `settings.targetLocales[${i}]`);
    if (seen.has(locale)) continue;
    seen.add(locale);
    targetLocales.push(locale);
  }

  const toneRaw = value["tone"];
  if (typeof toneRaw !== "string" || !TONES.has(toneRaw)) {
    throw invalid(
      `"settings.tone" must be one of: ${[...TONES].join(", ")}.`,
      "settings.tone",
    );
  }

  const contextRaw = value["productContext"];
  const productContext =
    contextRaw === undefined
      ? ""
      : requireString(contextRaw, "settings.productContext", {
          max: MAX_PRODUCT_CONTEXT,
          min: 0,
        });

  const attemptsRaw = value["maxRepairAttempts"];
  if (
    typeof attemptsRaw !== "number" ||
    !Number.isFinite(attemptsRaw) ||
    !Number.isInteger(attemptsRaw) ||
    attemptsRaw < 0 ||
    attemptsRaw > MAX_REPAIR_ATTEMPTS
  ) {
    throw invalid(
      `"settings.maxRepairAttempts" must be an integer between 0 and ${MAX_REPAIR_ATTEMPTS}.`,
      "settings.maxRepairAttempts",
    );
  }

  return {
    sourceLocale,
    targetLocales,
    tone: toneRaw as ToneProfile,
    productContext,
    glossary: parseGlossary(value["glossary"]),
    enforceLayout: requireBoolean(value["enforceLayout"], "settings.enforceLayout"),
    maxRepairAttempts: attemptsRaw,
  };
}

/**
 * Validate a decoded body and parse the source file it carries.
 *
 * @throws {PipelineRequestError} for every malformed input, including a source
 * file that does not parse — which is a 400 with the parser's line/column, not
 * a 500.
 */
export function parseTranslateRequest(body: unknown): TranslateRequest {
  if (!isRecord(body)) {
    throw invalid("The request body must be a JSON object.");
  }

  const settings = parseSettings(body["settings"]);

  const fileNameRaw = body["fileName"];
  const fileName =
    fileNameRaw === undefined
      ? "en.json"
      : requireString(fileNameRaw, "fileName", { max: MAX_FILE_NAME_LENGTH });

  const text = requireString(body["text"], "text", {
    max: MAX_SOURCE_TEXT_BYTES,
  });
  if (byteLength(text) > MAX_SOURCE_TEXT_BYTES) {
    throw new PipelineRequestError(
      413,
      "payload-too-large",
      `The source catalogue is larger than the ${Math.floor(MAX_SOURCE_TEXT_BYTES / 1000)} kB limit.`,
      { field: "text", detail: { bytes: byteLength(text), maxBytes: MAX_SOURCE_TEXT_BYTES } },
    );
  }

  let catalog: ParsedCatalog;
  try {
    catalog = parseSourceFile(fileName, text, {
      sourceLocale: settings.sourceLocale,
    });
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new PipelineRequestError(
        400,
        "source-parse-failed",
        error.message,
        {
          field: "text",
          detail: {
            fileName: error.fileName,
            reason: error.reason,
            line: error.line,
            column: error.column,
          },
        },
      );
    }
    throw error;
  }

  return { catalog, settings };
}
