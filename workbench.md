# LingoLoop — Gauntlet Loop Workbench

**Project:** AI Localization Agent for Micro-SaaS & Indie Games
**Branch:** `claude/ai-localization-agent-mvp-lch9v0`
**Stack:** Next.js 16 (App Router) · React 19 · Tailwind v4 · TypeScript strict · Vitest
**Status:** MVP complete and verified end-to-end in a real browser

---

## Verified state (measured, not asserted)

```
npx tsc --noEmit --incremental false   exit 0
npx vitest run                         61 files · 1336 tests · all passing
npm run build                          succeeds — /, /api/health,
                                       /api/translate, /preview/review, /icon.svg
node e2e/browser-flow.mjs              39/39 assertions
node e2e/review-interaction.mjs        4/4 rows open on a single pointer click
159 source files · 44,286 lines
```

Live run against `fixtures/indie-game-en.json`, de + ja, offline provider:
164 strings · 10 JobProgress frames · completedUnits 164/164 · 0 failed ·
12 strings refitted to budget by the repair loop · ZIP export 8.6 kB.

---

## Wave log

| Wave | Scope | Agents | Outcome |
| --- | --- | --- | --- |
| 0 | Architect: scaffold, design system, `lib/types.ts` contract, fixtures | — | 🟢 |
| 1 | Core engine C1–C4 | 24 | 🟡 closed at 3-round cap |
| 1.5 | Targeted fixes for the four named round-3 gaps | 4 | 🟢 |
| 2 | Surface C5–C8: dashboard, review, pipeline, sync | 4 | 🟢 |
| 3 | CTO integration pass | 1 | 🟢 |
| 3 | Visual gauntlet (3 lenses) | 3 | 1 ran · 2 died on session limit |
| 3b | Visual gauntlet re-run | 4 | 🟢 both FAILED-then-fixed |

---

## Components

| # | Component | Path | State |
| --- | --- | --- | --- |
| C1 | JSON parse · flatten · placeholders · roles · ambiguity | `lib/core/` | 🟢 |
| C2 | Locale profiles · width metrics · budgets · fit | `lib/layout/` | 🟢 |
| C3 | Prompt engine · Anthropic + offline providers | `lib/engine/` | 🟢 |
| C4 | Error taxonomy · validators · mechanical repair | `lib/validate/` | 🟢 |
| C5 | Dashboard shell · drag-and-drop · job settings | `components/upload/` | 🟢 |
| C6 | Review table · fit meter · export · ZIP writer | `components/review/`, `lib/export/` | 🟢 |
| C7 | Autonomous loop · bounded pool · SSE API | `lib/pipeline/`, `app/api/` | 🟢 |
| C8 | Sync plan · GitHub REST adapter · dry run | `lib/sync/` | 🟢 |
| I1 | Flow state machine wiring it into one product | `components/flow/` | 🟢 |

---

## What the gauntlet actually caught

Every one of these shipped-and-then-caught defects came from a critic in a
fresh context inspecting real output — none were found by the agent that wrote
the code, and none by the test suite that agent wrote alongside it.

**Round 1 — architectural**
- ICU plural messages (`{count, plural, one {# seat} other {# seats}}`) were
  classified `doNotTranslate` and shipped in English.
- `maxChars` overstated the limit for CJK, so an obedient model still overflowed.
- The offline provider emitted an empty string on repair, then oscillated.
- Angle-tag attributes were dropped from placeholder identity, so a translation
  that rewrote an `href` validated clean.

**Round 2 — subtler**
- Integer-like keys silently reordered by the ECMAScript property-order rule.
- Advance-table unit error: full-width glyphs measured ~1.9× too wide.
- Prompt injection through `_comment` free text forging unit boundaries.
- ICU nested placeholders double-counted, failing correct plural translations.

**Round 3 — single-path**
- CRLF line endings not preserved on re-emission.
- Role-less budget fallback multiplied a character count by a width ratio.
- Unit key shown lossily but reconciled raw, discarding obedient replies.
- Repair ceiling contradicted the attempt it was rejecting.

**Visual gauntlet — only findable in the running app**
- First pointer click on any review row was swallowed: focusing the grid without
  `preventScroll` moved the button 81px out from under a stationary cursor
  between mousedown and mouseup. `element.click()` and the keyboard path both
  worked, which is why no unit test saw it.
- `--text-tertiary` failed WCAG AA on every surface (3.48/3.33/3.16/2.91:1)
  across 86 text elements. Now 5.71/5.45/5.17/4.77:1.
- Dropping a catalog jumped the page 0 → 2185px, landing mid-card. A
  mount-firing `scrollIntoView` in `LocalePicker` scrolled underneath the
  `usePhaseScrollAnchor` mechanism built specifically to prevent that — two
  individually correct pieces composing into a defect.
- An illustrative example was hardcoded into per-string UI copy, so every short
  string's rationale quoted `"OK"` and a figure from a different row.
- Border-as-gap grid painted its border colour as a solid block in the trailing
  cell whenever the locale count was odd.

---

## Honest limitations

- **Output is pseudo-localisation, not translation, unless `ANTHROPIC_API_KEY`
  is set.** Every pipeline stage runs for real — parsing, budgeting, validation,
  the repair loop, export — but the strings come from a deterministic simulator.
  The UI states this in the header, above the results table, and in the footer.
  Linguistic quality claims are unproven until the key is supplied.
- **No component earned `[PASSED]` in Wave 1.** All four exhausted the 3-round
  cap. Their named gaps were then fixed and verified individually, but they were
  never re-run through a full clean gauntlet.
- **GitHub sync is a foundation, not a shipped feature.** `buildSyncPlan`,
  `describeSyncPlan` and `GitHubRestAdapter` are complete and tested against a
  mocked fetch; nothing has ever pushed to a real repository.
- **Browser E2E is not in CI.** `e2e/*.mjs` require a built app and a running
  server, and are run by hand.

---

## Running it

```bash
npm install
npm run dev                  # http://localhost:3000

npm test                     # 1336 unit + integration tests
npm run build && npm start   # then:
BASE_URL=http://localhost:3000 node e2e/browser-flow.mjs
BASE_URL=http://localhost:3000 node e2e/review-interaction.mjs

export ANTHROPIC_API_KEY=sk-...   # switches off simulation mode
```
