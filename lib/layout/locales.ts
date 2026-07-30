/**
 * Locale profile catalog.
 *
 * `expansion` is the *character-count* growth of short UI strings (roughly
 * 10-30 source characters) versus English. The numbers below follow the
 * classic IBM Globalization / W3C "text expansion" guidance, which is stated
 * as a band by source length — short strings expand far more than paragraphs:
 *
 *   source chars   typical expansion (Germanic/Romance)
 *   1-10           +100% .. +200%
 *   11-20          +60%  .. +80%
 *   21-30          +40%  .. +50%
 *   31-50          +30%  .. +40%
 *   51+            +20%  .. +30%
 *
 * A single scalar cannot express that curve, so `expansion` here is calibrated
 * to the *average short UI string* (the 11-30 char band, which is where button,
 * label, menu and badge text actually lives) and the extra headroom that very
 * short strings need is added separately as an absolute em allowance in
 * `budget.ts`. Encoding it that way keeps the ratios recognisable (German 1.35
 * is the number every localisation engineer expects to see) while still making
 * "OK" -> "Bestätigen" representable.
 *
 * `glyphWidth` is the orthogonal half of the story: CJK translations use *fewer*
 * characters (ja ~0.60x) but each character is a full-width em square, roughly
 * 1.9-2.0x the advance of an average Latin letter. Judging CJK by character
 * count alone is the single most common way to ship a broken Japanese button:
 * 0.60 * 2.0 = 1.20, i.e. Japanese is usually *wider* than English, not
 * narrower. `metrics.ts` measures per code point so this falls out naturally.
 *
 * `glyphWidth` is a *ratio*, not an em value: it counts average Latin
 * characters, so ja 1.95 means "1.95 x 0.55em = 1.0725em", one em box.
 * `metrics.ts` multiplies by `MEAN_LATIN_ADVANCE` before it touches the
 * advance table; feeding it in raw measures CJK ~1.9x too wide and produces
 * budgets no Japanese or Chinese string can satisfy.
 */

import type { LocaleCode, LocaleProfile } from "@/lib/types";

/**
 * Languages written right-to-left. Used both for the curated catalog and for
 * inferring a direction for locales that are not in the catalog at all.
 */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "he",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "yi",
  "dv",
  "ckb",
  "ku",
]);

/**
 * Advance width of an average RTL (Arabic/Hebrew) glyph relative to an average
 * Latin glyph. Both scripts have no capitals and comparatively narrow letter
 * forms, so the same character count renders ~5% narrower.
 */
const RTL_GLYPH_WIDTH = 0.95;

function profile(
  code: LocaleCode,
  name: string,
  nativeName: string,
  expansion: number,
  options: {
    direction?: "ltr" | "rtl";
    glyphWidth?: number;
    noWordBreaks?: boolean;
  } = {},
): LocaleProfile {
  return Object.freeze({
    code,
    name,
    nativeName,
    expansion,
    direction: options.direction ?? "ltr",
    glyphWidth: options.glyphWidth ?? 1,
    noWordBreaks: options.noWordBreaks ?? false,
  });
}

const CJK = (glyphWidth: number, noWordBreaks: boolean) => ({
  glyphWidth,
  noWordBreaks,
});

const RTL = { direction: "rtl" as const, glyphWidth: RTL_GLYPH_WIDTH };

/**
 * Curated profiles. Keys are normalised tags (lowercase language, Title-case
 * script, UPPERCASE region) so `getLocaleProfile` can look them up directly
 * after normalising its input.
 */
export const LOCALE_PROFILES: Readonly<Record<LocaleCode, LocaleProfile>> =
  Object.freeze({
    // --- Source / reference -------------------------------------------------
    en: profile("en", "English", "English", 1.0),
    "en-GB": profile("en-GB", "English (UK)", "English (UK)", 1.02),

    // --- Germanic: compounding drives the worst expansion in the industry ---
    // German is the canonical worst case for UI chrome: compound nouns cannot
    // be hyphen-broken by most CSS defaults, so a 35% mean hides a long tail.
    de: profile("de", "German", "Deutsch", 1.35),
    "de-CH": profile("de-CH", "German (Switzerland)", "Deutsch (Schweiz)", 1.35),
    nl: profile("nl", "Dutch", "Nederlands", 1.25),
    sv: profile("sv", "Swedish", "Svenska", 1.2),
    da: profile("da", "Danish", "Dansk", 1.2),
    no: profile("no", "Norwegian", "Norsk", 1.2),
    nb: profile("nb", "Norwegian Bokmål", "Norsk bokmål", 1.2),
    nn: profile("nn", "Norwegian Nynorsk", "Nynorsk", 1.2),
    is: profile("is", "Icelandic", "Íslenska", 1.25),

    // --- Romance: articles, prepositions and gendered agreement add length --
    fr: profile("fr", "French", "Français", 1.25),
    "fr-CA": profile("fr-CA", "French (Canada)", "Français (Canada)", 1.25),
    es: profile("es", "Spanish", "Español", 1.25),
    "es-419": profile(
      "es-419",
      "Spanish (Latin America)",
      "Español (Latinoamérica)",
      1.25,
    ),
    it: profile("it", "Italian", "Italiano", 1.2),
    pt: profile("pt", "Portuguese", "Português", 1.25),
    "pt-BR": profile(
      "pt-BR",
      "Portuguese (Brazil)",
      "Português (Brasil)",
      1.25,
    ),
    // European Portuguese runs marginally longer than Brazilian for UI copy
    // (fuller verb forms, less clipping of pronouns).
    "pt-PT": profile(
      "pt-PT",
      "Portuguese (Portugal)",
      "Português (Portugal)",
      1.27,
    ),
    ro: profile("ro", "Romanian", "Română", 1.25),
    ca: profile("ca", "Catalan", "Català", 1.25),

    // --- Slavic: rich inflection, long case endings -------------------------
    ru: profile("ru", "Russian", "Русский", 1.3),
    uk: profile("uk", "Ukrainian", "Українська", 1.3),
    pl: profile("pl", "Polish", "Polski", 1.3),
    cs: profile("cs", "Czech", "Čeština", 1.25),
    sk: profile("sk", "Slovak", "Slovenčina", 1.25),
    sl: profile("sl", "Slovenian", "Slovenščina", 1.25),
    hr: profile("hr", "Croatian", "Hrvatski", 1.25),
    sr: profile("sr", "Serbian", "Српски", 1.25),
    bg: profile("bg", "Bulgarian", "Български", 1.28),

    // --- Other European -----------------------------------------------------
    // Finnish and Hungarian are agglutinative: case suffixes stack onto the
    // stem, so "in your settings" collapses into one very long word.
    fi: profile("fi", "Finnish", "Suomi", 1.3),
    hu: profile("hu", "Hungarian", "Magyar", 1.3),
    et: profile("et", "Estonian", "Eesti", 1.25),
    lv: profile("lv", "Latvian", "Latviešu", 1.28),
    lt: profile("lt", "Lithuanian", "Lietuvių", 1.28),
    el: profile("el", "Greek", "Ελληνικά", 1.3),
    tr: profile("tr", "Turkish", "Türkçe", 1.15),

    // --- CJK: fewer characters, each roughly an em square -------------------
    ja: profile("ja", "Japanese", "日本語", 0.6, CJK(1.95, true)),
    // Korean uses spaces between eojeol, so it *does* have word breaks.
    ko: profile("ko", "Korean", "한국어", 0.65, CJK(1.9, false)),
    zh: profile("zh", "Chinese", "中文", 0.55, CJK(2.0, true)),
    "zh-CN": profile(
      "zh-CN",
      "Chinese (Simplified)",
      "简体中文",
      0.55,
      CJK(2.0, true),
    ),
    "zh-TW": profile(
      "zh-TW",
      "Chinese (Traditional)",
      "繁體中文",
      0.55,
      CJK(2.0, true),
    ),
    "zh-HK": profile(
      "zh-HK",
      "Chinese (Hong Kong)",
      "繁體中文（香港）",
      0.55,
      CJK(2.0, true),
    ),

    // --- RTL ----------------------------------------------------------------
    ar: profile("ar", "Arabic", "العربية", 1.2, RTL),
    he: profile("he", "Hebrew", "עברית", 1.2, RTL),
    fa: profile("fa", "Persian", "فارسی", 1.25, RTL),
    ur: profile("ur", "Urdu", "اردو", 1.2, RTL),

    // --- South & Southeast Asian -------------------------------------------
    // 1.13 is 0.62/0.55: the advance `metrics.ts` gives an Indic base consonant
    // over the mean Latin advance. It has to be exactly that quotient, not a
    // rounder-looking 1.05, because `typicalCharWidth` derives the script's
    // per-character advance from `glyphWidth` and `budget.ts` divides
    // `allowedWidth` by it to advertise a character limit. Understating it by
    // 8% is enough to hand a Tamil badge a `maxChars` that `evaluateFit` then
    // rejects — the same budget/fit disagreement that made CJK unshippable.
    hi: profile("hi", "Hindi", "हिन्दी", 1.2, { glyphWidth: 1.13 }),
    bn: profile("bn", "Bengali", "বাংলা", 1.2, { glyphWidth: 1.13 }),
    ta: profile("ta", "Tamil", "தமிழ்", 1.25, { glyphWidth: 1.13 }),
    // Thai has no inter-word spaces; the browser needs a line-break dictionary.
    th: profile("th", "Thai", "ไทย", 1.15, CJK(1.0, true)),
    vi: profile("vi", "Vietnamese", "Tiếng Việt", 1.25),
    id: profile("id", "Indonesian", "Bahasa Indonesia", 1.2),
    ms: profile("ms", "Malay", "Bahasa Melayu", 1.2),
    fil: profile("fil", "Filipino", "Filipino", 1.25),
  });

/**
 * Tags that are not themselves catalog keys but map onto one. Covers legacy
 * ISO codes still emitted by older toolchains and the script-subtag spellings
 * of Chinese, which are what CLDR-aware pipelines produce.
 */
const LOCALE_ALIASES: Readonly<Record<string, LocaleCode>> = Object.freeze({
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  "zh-Hans-CN": "zh-CN",
  "zh-Hans-SG": "zh-CN",
  "zh-Hant-TW": "zh-TW",
  "zh-Hant-HK": "zh-HK",
  "zh-SG": "zh-CN",
  "zh-MO": "zh-HK",
  iw: "he", // pre-1989 ISO 639 code for Hebrew, still in Java/Android output
  in: "id", // pre-1989 ISO 639 code for Indonesian
  tl: "fil",
  mo: "ro",
  sh: "sr",
});

/**
 * Neutral default for locales the catalog does not know.
 *
 * 1.25 is the median short-string expansion across the major Latin-script
 * targets (French, Spanish, Portuguese, Dutch, Czech, Romanian). It is
 * deliberately *not* the German worst case: budgets derived from it are used
 * to decide whether a translation must be retried, and an over-generous
 * default would let real overflow through, while an over-tight one (1.0) would
 * make every unknown locale permanently "overflow" and thrash the repair loop.
 */
export const DEFAULT_EXPANSION = 1.25;

export const NEUTRAL_LOCALE_PROFILE: LocaleProfile = Object.freeze({
  code: "und",
  name: "Unknown locale",
  nativeName: "Unknown locale",
  expansion: DEFAULT_EXPANSION,
  direction: "ltr",
  glyphWidth: 1,
  noWordBreaks: false,
});

/**
 * Normalise a BCP-47-ish tag to the catalog's key shape:
 * lowercase language, Title-case script, UPPERCASE region.
 * Accepts `_` separators (Java/Android style) and stray whitespace.
 */
export function normalizeLocaleCode(code: string): string {
  const parts = code
    .trim()
    .replace(/_/g, "-")
    .split("-")
    .filter((p) => p.length > 0);

  const language = parts[0];
  if (language === undefined) return "";

  const out: string[] = [language.toLowerCase()];
  for (const raw of parts.slice(1)) {
    if (raw.length === 4 && /^[A-Za-z]{4}$/.test(raw)) {
      // Script subtag, e.g. "Hans".
      out.push(raw[0]!.toUpperCase() + raw.slice(1).toLowerCase());
    } else if (/^[A-Za-z]{2}$/.test(raw) || /^\d{3}$/.test(raw)) {
      // Region subtag, e.g. "BR" or "419".
      out.push(raw.toUpperCase());
    } else {
      // Variant / extension: keep lowercase, it never affects our lookup.
      out.push(raw.toLowerCase());
    }
  }
  return out.join("-");
}

function lookup(tag: string): LocaleProfile | undefined {
  const direct = LOCALE_PROFILES[tag];
  if (direct !== undefined) return direct;
  const aliased = LOCALE_ALIASES[tag];
  if (aliased !== undefined) return LOCALE_PROFILES[aliased];
  return undefined;
}

/**
 * Resolve a locale code to a profile.
 *
 * Fallback chain, most specific first:
 *   1. exact normalised tag                       ("pt-BR")
 *   2. alias table                                ("zh-Hans" -> "zh-CN")
 *   3. language + region, script dropped          ("zh-Hant-TW" -> "zh-TW")
 *   4. language + script                          ("zh-Hant-XX" -> "zh-TW")
 *   5. base language                              ("pt-PT-x-foo" -> "pt")
 *   6. neutral default, with direction and glyph width inferred from the
 *      language subtag when it is a known RTL language.
 *
 * The returned object always carries the *requested* code so the UI can echo
 * what the developer actually asked for.
 */
export function getLocaleProfile(code: LocaleCode): LocaleProfile {
  const tag = normalizeLocaleCode(code);
  if (tag === "") return NEUTRAL_LOCALE_PROFILE;

  const exact = lookup(tag);
  if (exact !== undefined) return exact;

  const parts = tag.split("-");
  const language = parts[0] ?? tag;
  const script = parts.find((p) => p.length === 4 && /^[A-Z][a-z]{3}$/.test(p));
  const region = parts
    .slice(1)
    .find((p) => /^[A-Z]{2}$/.test(p) || /^\d{3}$/.test(p));

  if (region !== undefined) {
    const byRegion = lookup(`${language}-${region}`);
    if (byRegion !== undefined) return byRegion;
  }
  if (script !== undefined) {
    const byScript = lookup(`${language}-${script}`);
    if (byScript !== undefined) return byScript;
  }
  const byLanguage = lookup(language);
  if (byLanguage !== undefined) return byLanguage;

  const rtl = RTL_LANGUAGES.has(language);
  return Object.freeze({
    ...NEUTRAL_LOCALE_PROFILE,
    code,
    name: `Unknown locale (${code})`,
    nativeName: code,
    direction: rtl ? ("rtl" as const) : ("ltr" as const),
    glyphWidth: rtl ? RTL_GLYPH_WIDTH : 1,
  });
}

/** True when the catalog has a curated (non-inferred) profile for `code`. */
export function isKnownLocale(code: LocaleCode): boolean {
  const tag = normalizeLocaleCode(code);
  if (tag === "") return false;
  if (lookup(tag) !== undefined) return true;
  const language = tag.split("-")[0];
  return language !== undefined && lookup(language) !== undefined;
}

/** All curated profiles, sorted by English name — for locale pickers. */
export function listLocaleProfiles(): LocaleProfile[] {
  return Object.values(LOCALE_PROFILES).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
}

/** True when the profile's script is full-width (CJK). */
export function isFullWidthScript(profile_: LocaleProfile): boolean {
  // 1.5 sits comfortably between the widest non-CJK profile (Indic, 1.13)
  // and the narrowest CJK one (Korean, 1.9).
  return profile_.glyphWidth >= 1.5;
}
