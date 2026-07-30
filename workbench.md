# LingoLoop — Gauntlet Loop Workbench

**Project:** AI Localization Agent for Micro-SaaS & Indie Games
**Branch:** `claude/ai-localization-agent-mvp-lch9v0`
**Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 · TypeScript · Vitest
**Last updated:** Wave 1 closed — 24 agents, 3.1M tokens, 84 min

---

## Legend

| Mark | Meaning |
| --- | --- |
| ⚪ | Queued | 🔵 In Loop | 🟡 Failed gauntlet | 🟢 Passed | ⬛ Blocked |

---

## Build health (measured, not asserted)

```
npx tsc --noEmit --incremental false   → exit 0
npx vitest run                         → 30 files, 792 tests, all passing
lib/**/*.ts                            → 63 files, 21,461 lines
```

---

## Foundation — complete

| Artifact | Status |
| --- | --- |
| Next.js 16 + React 19 + TS strict scaffold | 🟢 |
| Tailwind v4 design system (`app/globals.css`) | 🟢 |
| Shared domain contract (`lib/types.ts`) | 🟢 |
| Vitest harness · fixtures (indie game + micro-SaaS) | 🟢 |

---

## Wave 1 — Core engine · CLOSED AT ROUND CAP

All four modules exhausted the 3-round gauntlet. Each is functional with a
green suite, but **none earned `[PASSED]`** — the critics held the bar and
each round surfaced a narrower defect than the last. Honest status: 🟡.

| # | Component | Path | Status | Rounds |
| --- | --- | --- | --- | --- |
| C1 | JSON parse · flatten · placeholders · ambiguity | `lib/core/` | 🟡 | 3 |
| C2 | Locale profiles · width metrics · budgets · fit | `lib/layout/` | 🟡 | 3 |
| C3 | Prompt engine · Anthropic + offline providers | `lib/engine/` | 🟡 | 3 |
| C4 | Error taxonomy · validators · mechanical repair | `lib/validate/` | 🟡 | 3 |

### Defect trajectory — the loop did its job

| Round | C1 | C2 | C3 | C4 |
| --- | --- | --- | --- | --- |
| 1 | ICU plural shipped untranslated | `maxChars` overstated for CJK | Repair pass emitted empty string | Tag attributes dropped from parity |
| 2 | Integer keys reordered by JS rule | Advance table unit error (~1.9×) | Prompt injection via `_comment` | ICU nested placeholders double-counted |
| 3 | CRLF line endings not preserved | Role-less fallback: chars × width ratio | Key shown lossy, matched raw | Repair ceiling contradicts the overflow |

Round 1 gaps were architectural. Round 3 gaps are single-path unit errors.
That narrowing is the signal the loop was working — not that it stalled.

### Open gaps carried into the fix wave

- **C1** `parse.ts` captures `indent` and `trailingNewline` but never EOL
  style; `serializeWithCatalogFormatting` hard-codes `\n`, so a CRLF-authored
  file returns with every line rewritten.
- **C2** `describeBudgetForPrompt`'s role-less fallback computes
  `sourceChars * budget.maxRatio` — multiplying a character count by a width
  ratio, the exact error the module's own comments warn about.
- **C3** `buildUserPrompt` prints the key through a lossy `inline()`
  sanitiser while `parseProviderOutput` reconciles against the raw key, so an
  obedient model's reply is discarded.
- **C4** `characterCeiling` short-circuits to the advisory `fit.budget.maxChars`
  without reconciling against the attempt that actually overflowed, producing
  a self-contradictory repair directive.

---

## Wave 1.5 — Targeted fix pass 🔵

Four independent, fully-diagnosed fixes. No further discovery rounds: open-ended
critique had reached diminishing returns, and every remaining gap is named with
file, line, and a reproduction.

## Wave 2 — Surface & orchestration 🔵

| # | Component | Owner path | Status |
| --- | --- | --- | --- |
| C5 | Dashboard shell + drag-and-drop upload | `components/upload/`, `components/ui/` | 🔵 |
| C6 | Review table + one-click export | `components/review/`, `lib/export/` | 🔵 |
| C7 | Pipeline orchestrator + streaming API | `lib/pipeline/`, `app/api/` | 🔵 |
| C8 | GitHub sync foundation | `lib/sync/` | 🔵 |

## Wave 3 — Visual gauntlet + CTO integration ⚪

| # | Component | Status |
| --- | --- | --- |
| I1 | Screenshot-based UI critique vs. Vercel/Linear bar | ⚪ |
| I2 | Global wiring + conflict resolution | ⚪ |
| I3 | E2E on both fixtures + full gate | ⚪ |

---

## Quality bar (enforced by every critic)

1. Translated strings **never** overflow their UI bounds.
2. Output JSON is **structurally identical** to input — keys, nesting, array
   lengths, non-string leaves, indentation, key order, line endings.
3. Placeholders survive **exactly**.
4. Casual / gaming / technical register preserved, not flattened.
5. Ambiguous keywords resolve by UI role, not dictionary first-sense.
6. The interface reads as a premium developer tool.

---

## Notes for the record

- The CJK advance-table error originated in **the architect's spec**, which
  instructed `glyphWidth ~1.9-2.0`. A full-width glyph is one em box (~1.0em)
  in a table where Latin averages ~0.5em. The builder faithfully implemented a
  wrong instruction; the fresh critic caught it. Spec error, not builder error.
- Wave 2 critics run **after** the build stage, against a live server with
  screenshots — visual bounds cannot be judged from source alone.
