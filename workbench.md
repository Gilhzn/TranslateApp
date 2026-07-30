# LingoLoop — Gauntlet Loop Workbench

**Project:** AI Localization Agent for Micro-SaaS & Indie Games
**Branch:** `claude/ai-localization-agent-mvp-lch9v0`
**Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 · TypeScript · Vitest
**Last updated:** Wave 1 dispatch

---

## Legend

| Mark | Meaning |
| --- | --- |
| ⚪ | Queued — not yet dispatched |
| 🔵 | In Loop — builder or critic actively working |
| 🟡 | Failed gauntlet — returned to builder with a named gap |
| 🟢 | Passed — critic emitted `[PASSED]` |
| ⬛ | Blocked |

---

## Foundation (architect pass — complete)

| Artifact | Status | Notes |
| --- | --- | --- |
| Next.js 16 + React 19 + TS scaffold | 🟢 | `npm run build` green |
| Tailwind v4 design system (`app/globals.css`) | 🟢 | OKLCH ramp, hairline cards, motion tokens |
| Shared domain contract (`lib/types.ts`) | 🟢 | Single interlock for all parallel modules |
| Vitest harness | 🟢 | `npm test` wired |

---

## Wave 1 — Core engine (pure logic, parallel)

| # | Component | Owner path | Status | Gap / note |
| --- | --- | --- | --- | --- |
| C1 | JSON parser · flattener · placeholder extractor | `lib/core/` | 🔵 | Round-trip fidelity is the bar |
| C2 | UI context checking · length budgets · fit engine | `lib/layout/` | 🔵 | Overflow must be provably impossible |
| C3 | Prompt engine · providers (Anthropic + deterministic) | `lib/engine/` | 🔵 | Ambiguity + slang handling |
| C4 | Validation · error taxonomy · repair planner | `lib/validate/` | 🔵 | Placeholder parity, JSON integrity |

## Wave 2 — Surface & orchestration

| # | Component | Owner path | Status | Gap / note |
| --- | --- | --- | --- | --- |
| C5 | Dashboard shell + drag-and-drop upload | `components/upload/`, `components/ui/` | ⚪ | Vercel/Linear bar |
| C6 | Review table + one-click export | `components/review/`, `lib/export/` | ⚪ | Overflow badges, diffing |
| C7 | Pipeline orchestrator + streaming API | `lib/pipeline/`, `app/api/` | ⚪ | SSE progress |
| C8 | GitHub sync foundation | `lib/sync/` | ⚪ | Modular, PR-payload builder |

## Wave 3 — CTO integration pass

| # | Component | Status | Gap / note |
| --- | --- | --- | --- |
| I1 | Global wiring + conflict resolution | ⚪ | |
| I2 | E2E + build/typecheck/test gate | ⚪ | |
| I3 | Final visual gauntlet vs. quality bar | ⚪ | |

---

## Quality bar (enforced by every critic)

1. Translated strings **never** overflow their UI bounds — the layout engine
   must make overflow unrepresentable, not merely warned about.
2. Output JSON is **structurally identical** to the input: same keys, same
   nesting, same array lengths, same non-string leaves, same indentation.
3. Placeholders survive **exactly** — none dropped, added, or malformed.
4. Casual / gaming / technical register is preserved, not flattened to
   corporate neutral.
5. Ambiguous keywords ("Run", "Save", "Load") resolve by UI role, not by
   dictionary first-sense.
6. The interface reads as a premium developer tool — hairline borders, real
   empty/loading/error states, keyboard reachable, no default-Tailwind look.

---

## Gauntlet log

_Appended by the pipeline as components clear or fail._
