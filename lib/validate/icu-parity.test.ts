import { describe, expect, it } from "vitest";
import { extractPlaceholders } from "@/lib/core";
import type { FitResult, Issue, LengthBudget, TranslationUnit } from "@/lib/types";
import { buildRepairFeedback, needsRepair, resolveFinalStatus } from "./repair";
import {
  validatePlaceholderParity,
  validateString,
  validateTagBalance,
} from "./validators";

/**
 * Regression suite for locale-driven ICU branch divergence.
 *
 * The bug this file exists to prevent: comparing placeholders as a flat multiset
 * across a plural/select boundary. `extractPlaceholders` reports a complex ICU
 * argument as the whole-span placeholder PLUS every placeholder inside every
 * branch, so the occurrence count of anything inside branches is
 * `branch count × uses per branch` — and the branch count is decided by the
 * TARGET language's CLDR plural categories, not by English:
 *
 *   en, de  → one, other                        (2)
 *   ja, zh  → other                             (1)
 *   ru, pl  → one, few, many, other             (4)
 *   ar      → zero, one, two, few, many, other  (6)
 *
 * Every case below is a CORRECT, CLDR-conformant translation. Any issue at all
 * is a false positive, and a false positive here is worse than a miss: it drives
 * a repair pass whose prompt instructs the model to delete mandatory grammatical
 * branches or to paste untranslated English.
 */

const codes = (issues: readonly Issue[]): string[] => issues.map((i) => i.code);

// --- Correct translations that must produce nothing -------------------------

describe("branch-count divergence is not a defect", () => {
  const SOURCE_NAME =
    "{count, plural, one {{name} added a file} other {{name} added # files}}";

  it("accepts en→ru: 2 English categories become 4 Russian ones", () => {
    const target =
      "{count, plural, " +
      "one {{name} добавил файл} " +
      "few {{name} добавил # файла} " +
      "many {{name} добавил # файлов} " +
      "other {{name} добавил # файла}}";
    expect(validatePlaceholderParity(SOURCE_NAME, target, { locale: "ru" })).toEqual(
      [],
    );
    expect(validateString(SOURCE_NAME, target, { locale: "ru" })).toEqual([]);
  });

  it("accepts en→pl with markup inside every branch", () => {
    const source =
      "{count, plural, one {<b>#</b> file left} other {<b>#</b> files left}}";
    const target =
      "{count, plural, " +
      "one {Pozostał <b>#</b> plik} " +
      "few {Pozostały <b>#</b> pliki} " +
      "many {Pozostało <b>#</b> plików} " +
      "other {Pozostało <b>#</b> pliku}}";
    expect(validatePlaceholderParity(source, target, { locale: "pl" })).toEqual([]);
    expect(validateTagBalance(source, target, { locale: "pl" })).toEqual([]);
    expect(validateString(source, target, { locale: "pl" })).toEqual([]);
  });

  it("accepts en→ar: 2 English categories become 6 Arabic ones", () => {
    const target =
      "{count, plural, " +
      "zero {{name} لم يضف أي ملف} " +
      "one {{name} أضاف ملفًا} " +
      "two {{name} أضاف ملفين} " +
      "few {{name} أضاف # ملفات} " +
      "many {{name} أضاف # ملفًا} " +
      "other {{name} أضاف # ملف}}";
    expect(validatePlaceholderParity(SOURCE_NAME, target, { locale: "ar" })).toEqual(
      [],
    );
  });

  it("accepts en→ja: 2 English categories collapse to the single `other`", () => {
    const source = "{count, plural, one {{count} message} other {{count} messages}}";
    const target = "{count, plural, other {{count} 件のメッセージ}}";
    expect(validatePlaceholderParity(source, target, { locale: "ja" })).toEqual([]);
    expect(validateString(source, target, { locale: "ja" })).toEqual([]);
  });

  it("still accepts the same-branch-count control (en→de)", () => {
    const target =
      "{count, plural, one {{name} hat eine Datei hinzugefügt} other {{name} hat # Dateien hinzugefügt}}";
    expect(validatePlaceholderParity(SOURCE_NAME, target, { locale: "de" })).toEqual(
      [],
    );
    expect(resolveFinalStatus(validateString(SOURCE_NAME, target, { locale: "de" }), null)).toBe(
      "passed",
    );
  });

  it("reports the ru translation as passing end to end", () => {
    const target =
      "{count, plural, one {{name} добавил файл} few {{name} добавил # файла} many {{name} добавил # файлов} other {{name} добавил # файла}}";
    const issues = validateString(SOURCE_NAME, target, { locale: "ru" });
    expect(issues).toEqual([]);
    expect(needsRepair(issues, null)).toBe(false);
    expect(resolveFinalStatus(issues, null)).toBe("passed");
  });

  it("accepts a nested select whose plural parent gained branches", () => {
    const source =
      "{count, plural, one {{gender, select, male {he} female {she} other {they}} sent a file} other {{gender, select, male {he} female {she} other {they}} sent # files}}";
    const target =
      "{count, plural, " +
      "one {{gender, select, male {on} female {ona} other {oni}} wysłał plik} " +
      "few {{gender, select, male {on} female {ona} other {oni}} wysłał # pliki} " +
      "many {{gender, select, male {on} female {ona} other {oni}} wysłał # plików} " +
      "other {{gender, select, male {on} female {ona} other {oni}} wysłał # pliku}}";
    expect(validatePlaceholderParity(source, target, { locale: "pl" })).toEqual([]);
  });

  it("does not require a placeholder the source uses in only some branches", () => {
    // `=0` deliberately omits the number; `{count}` is therefore optional, and a
    // target branch that spells the count out in words must not be rejected.
    const source =
      "{count, plural, =0 {No files} one {{count} file} other {{count} files}}";
    const target =
      "{count, plural, =0 {Keine Dateien} one {Eine Datei} other {{count} Dateien}}";
    expect(validatePlaceholderParity(source, target, { locale: "de" })).toEqual([]);
  });

  it("does not object when a richer language adds a plural the source lacks", () => {
    // English needed no plural block; Russian does. Promoting a simple argument
    // is correct localisation, not an invented placeholder.
    const source = "{count} files";
    const target =
      "{count, plural, one {{count} файл} few {{count} файла} many {{count} файлов} other {{count} файла}}";
    expect(validatePlaceholderParity(source, target, { locale: "ru" })).toEqual([]);
  });
});

// --- Real defects inside branches must still be caught ----------------------

describe("branch-level defects", () => {
  const SOURCE =
    "{count, plural, one {{name} added a file} other {{name} added # files}}";

  it("flags a target branch that dropped {name}, naming the branch", () => {
    const target =
      "{count, plural, one {{name} добавил файл} few {добавил # файла} many {{name} добавил # файлов} other {{name} добавил # файла}}";
    const issues = validatePlaceholderParity(SOURCE, target, { locale: "ru" });
    expect(codes(issues)).toEqual(["placeholder-missing"]);
    const [only] = issues;
    expect(only?.detail?.["branch"]).toBe("few");
    expect(only?.message).toContain('"few" branch');
    expect(only?.message).toContain('"{name}"');
  });

  it("flags a target branch that invented {total}", () => {
    const target =
      "{count, plural, one {{name} добавил файл} few {{name} добавил {total} файла} many {{name} добавил # файлов} other {{name} добавил # файла}}";
    const issues = validatePlaceholderParity(SOURCE, target, { locale: "ru" });
    expect(codes(issues)).toEqual(["placeholder-added"]);
    const [only] = issues;
    expect(only?.detail?.["branch"]).toBe("few");
    expect(only?.detail?.["raw"]).toBe("{total}");
  });

  it("flags a flattened plural without quoting the English branch prose", () => {
    const target = "Пользователь добавил файлы";
    const issues = validatePlaceholderParity(SOURCE, target, { locale: "ru" });
    expect(codes(issues)).toEqual(["placeholder-missing"]);
    const [only] = issues;
    expect(only?.detail?.["reason"]).toBe("icu-block-missing");
    expect(only?.message).toContain("{count}");
    expect(only?.message).not.toContain("added a file");
  });

  it("flags a plural rewritten as a select", () => {
    const target =
      "{count, select, one {{name} добавил файл} other {{name} добавил файлы}}";
    const issues = validatePlaceholderParity(SOURCE, target, { locale: "ru" });
    expect(codes(issues)).toEqual(["placeholder-malformed"]);
    expect(issues[0]?.detail?.["reason"]).toBe("icu-format-changed");
  });

  it("flags a block invented for an argument the source does not have", () => {
    const source = "{name} added a file";
    const target =
      "{name} {count, plural, one {добавил файл} other {добавил файлы}}";
    const issues = validatePlaceholderParity(source, target, { locale: "ru" });
    expect(codes(issues)).toEqual(["placeholder-added"]);
    expect(issues[0]?.detail?.["reason"]).toBe("icu-block-added");
  });

  it("flags attribute drift inside a branch", () => {
    const source =
      '{count, plural, one {Read <a href="/terms">the term</a>} other {Read <a href="/terms">the terms</a>}}';
    const target =
      '{count, plural, one {Przeczytaj <a href="/warunki">warunek</a>} few {Przeczytaj <a href="/terms">warunki</a>} many {Przeczytaj <a href="/terms">warunków</a>} other {Przeczytaj <a href="/terms">warunku</a>}}';
    const issues = validatePlaceholderParity(source, target, { locale: "pl" });
    expect(codes(issues)).toEqual(["placeholder-malformed"]);
    expect(issues[0]?.detail?.["attribute"]).toBe("href");
    expect(issues[0]?.detail?.["actual"]).toBe("/warunki");
  });

  it("catches markup that only balances when branches are concatenated", () => {
    const source =
      "{count, plural, one {<b>#</b> file} other {<b>#</b> files}}";
    // Flattened, this reads <b> </b> <b> </b> and looks balanced; per branch,
    // `one` opens without closing and `other` closes without opening.
    const target =
      "{count, plural, one {<b># plik} other {# plików</b>}}";
    const issues = validateTagBalance(source, target, { locale: "pl" });
    expect(codes(issues)).toEqual(["tag-imbalance", "tag-imbalance"]);
    expect(issues.map((i) => i.detail?.["branch"])).toEqual(["one", "other"]);
  });
});

// --- The repair prompt must never order English prose reproduced ------------

const TOAST_BUDGET: LengthBudget = {
  maxRatio: 1.2,
  maxChars: 40,
  graceRatio: 1.05,
  rationale: "toast width",
};

function pluralUnit(source: string): TranslationUnit {
  return {
    key: "inbox.unread",
    source,
    role: "toast",
    placeholders: extractPlaceholders(source),
    ambiguities: [],
    budget: TOAST_BUDGET,
    allowedWidth: 12,
    neighbors: [],
  };
}

const OVERFLOW_FIT: FitResult = {
  verdict: "overflow",
  sourceWidth: 10,
  targetWidth: 16,
  ratio: 1.6,
  budget: TOAST_BUDGET,
  allowedWidth: 12,
  overBy: 6,
};

describe("repair feedback for ICU entries", () => {
  const SOURCE =
    "{count, plural, one {{count} unread message} other {{count} unread messages}}";

  it("never asks for the source's English branch prose to be reproduced", () => {
    const unit = pluralUnit(SOURCE);
    const feedback = buildRepairFeedback(
      unit,
      "{count, plural, one {{count} непрочитанное сообщение} other {{count} непрочитанных сообщений}}",
      [],
      OVERFLOW_FIT,
    );
    expect(feedback).not.toContain("unread message");
    expect(feedback).not.toContain("unread messages");
    expect(feedback).not.toContain("×3");
    // The constraint survives, expressed as the argument plus a licence to use
    // whatever plural categories the target language needs.
    expect(feedback).toContain("{count}");
    expect(feedback).toContain("ICU plural");
    expect(feedback).toContain("plural categories your language actually requires");
  });

  it("keeps the verbatim list for ordinary placeholders alongside ICU blocks", () => {
    const unit = pluralUnit(
      "{name}: {count, plural, one {# file} other {# files}}",
    );
    const feedback = buildRepairFeedback(unit, "{name}: файлы", [], OVERFLOW_FIT);
    expect(feedback).toContain("must appear exactly as written: {name}.");
    expect(feedback).toContain("ICU arguments that must survive: {count}");
  });

  it("tells the model to add the placeholder to a branch, not to delete branches", () => {
    const target =
      "{count, plural, one {{name} добавил файл} few {добавил # файла} many {{name} добавил # файлов} other {{name} добавил # файла}}";
    const source =
      "{count, plural, one {{name} added a file} other {{name} added # files}}";
    const issues = validatePlaceholderParity(source, target, { locale: "ru" });
    const feedback = buildRepairFeedback(pluralUnit(source), target, issues, null);
    expect(feedback).toContain('"few" branch');
    expect(feedback).toContain("{name}");
    expect(feedback).toContain("do not delete branches");
    expect(feedback).not.toContain("Remove the extra occurrence");
  });

  it("tells the model to restore a flattened block without quoting English", () => {
    const source =
      "{count, plural, one {{count} unread message} other {{count} unread messages}}";
    const issues = validatePlaceholderParity(source, "Непрочитанные сообщения", {
      locale: "ru",
    });
    const feedback = buildRepairFeedback(
      pluralUnit(source),
      "Непрочитанные сообщения",
      issues,
      null,
    );
    expect(feedback).toContain("{count, plural, …}");
    expect(feedback).not.toContain("unread message");
  });
});
