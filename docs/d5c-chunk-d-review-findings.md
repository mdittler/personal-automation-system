# D5c Chunk D — Post-Hoc Audit Findings

**Date:** 2026-04-21
**Audited commit:** `d255c39` (feat(d5c-chunk-d): ops dashboard — MessageRateTracker + per-household breakdown + live metrics)
**Methodology:** Post-hoc TDD audit — test suite designed independently from the implementation, derived from requirements (URS REQ-LLM-028) and testing-standards skill. See plan: `docs/superpowers/plans/2026-04-21-d5c-chunk-d-review.md`.

**Caveat:** This is a post-hoc audit. The independence of the test suite gives stronger evidence than the original co-written tests, but this is not equivalent to a real TDD loop. "Candidate bug" means the test is correct and the impl is wrong per the spec — it is not a guarantee; user confirmation is appropriate before fixing.

---

## Summary

| Category | Count |
|---|---|
| Critical bugs | 0 |
| Important bugs | 2 |
| Minor issues | 1 |
| Test mistakes fixed | 3 |
| Tests added | 45 |
| Tests passing | 105 |
| Tests failing (candidate bugs) | 4 |

**Chunk E unblock status:** Chunk D has **no critical findings**. The 4 failing tests represent 2 important bugs + 1 minor issue (+ 1 minor issue with 2 test manifestations). A `review/d5c-chunk-d` branch should fix these before Chunk E merges, but they do not block Chunk E from starting.

---

## Critical Findings

*None.*

---

## Important Bugs

### BUG-1: `overCap` uses rounded percentage instead of actual cost comparison

**Tests failing:** C5 `overCap is true only when monthlyCost > cap (NOT when pctOfCap rounds to 100)`, D7 `pctOfCap rounding boundary: cost/cap=0.995 rounds to 100 but overCap=false (no OVER CAP label)`
**File:** `core/src/gui/routes/llm-usage.ts:240`
**Severity:** Important

**What's wrong:**
```typescript
// Current (line 240)
overCap: pctOfCap >= 100,

// Correct per spec
overCap: monthlyCost > cap,
```

When `monthlyCost = 0.995` and `cap = 1.0`, `monthlyCost / cap = 0.995 → rounds to 100% → overCap = true`. But `monthlyCost < cap`, so the household is NOT over cap. A false "OVER CAP" warning appears in the UI at 99.5% utilization.

**Impact:** Users see "OVER CAP" alert when they are under their cap. Particularly noticeable at high-but-not-over utilization (e.g. 99.5%).

**Fix:** Change `overCap: pctOfCap >= 100` to `overCap: monthlyCost > cap` in `buildPerHouseholdRows`.

---

### BUG-2: `parseUsageMarkdown` `.filter(Boolean)` collapses blank User cell in 9-col rows

**Test failing:** B5 `9-col row with blank User cell still parses Household from cells[8] (blank middle cell must not shift columns left)`
**File:** `core/src/gui/routes/llm-usage.ts` (parseUsageMarkdown, ~line 116)
**Severity:** Important

**What's wrong:**
The cell split uses `.filter(Boolean)` which removes empty strings, shifting later columns left:
```typescript
// Current (WRONG) — shifts columns when any cell is blank
const cells = row.split('|').filter(Boolean).map((c) => c.trim());
```

When a 9-col log row has a blank User column (e.g. system-originated messages), `cells[8]` (Household) becomes undefined and the row is excluded from `perHousehold`. The household's call count in the Per-Household Breakdown table is undercounted.

**Impact:** Per-Household call counts are lower than actual when any message in the log has a blank user. This is an existing pattern for system/alert-dispatched messages.

**Fix:** Split by `|` and trim while preserving column positions — do not use `.filter(Boolean)` before accessing by index.

---

## Minor Issues

### BUG-3 (minor): `PLATFORM_SENTINEL` constant duplicated locally instead of imported

**Test failing:** A4 `should import PLATFORM_SYSTEM_HOUSEHOLD_ID from auth-actor rather than duplicating it`
**File:** `core/src/services/metrics/message-rate-tracker.ts:11`
**Severity:** Minor — no behavioral difference today, but creates divergence risk

**What's wrong:**
```typescript
// Current (line 11)
const PLATFORM_SENTINEL = '__platform__';

// Correct
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../types/auth-actor.js';
// then use PLATFORM_SYSTEM_HOUSEHOLD_ID throughout
```

The canonical sentinel is `PLATFORM_SYSTEM_HOUSEHOLD_ID = '__platform__'` in `core/src/types/auth-actor.ts`. The tracker duplicates it locally. If the sentinel changes, the tracker will silently diverge.

**Impact:** None today (values match). Risk of silent divergence if sentinel changes.

**Fix:** Import from `auth-actor.ts` and delete the local constant.

---

## Positive Findings

1. **MessageRateTracker unit tests (A1–A3, A5–A9):** Boundary conditions, cleanup timer, dispose lifecycle, clock-regression hardening, and `.unref()` on the cleanup interval all work correctly.
2. **parseUsageMarkdown 9-col (B1–B4):** Interleaved rows, whitespace cells, trailing pipes, and sort order all work correctly. Only B5 (blank-middle-cell) fails.
3. **buildPerHouseholdRows (C1–C4, C6–C10):** Cost, zero cost, override cap precedence, divide-by-zero guard, reservations, member counts, graceful degradation without householdService, sort order, and empty list all work correctly.
4. **Rendering tests (D1, D3–D6, D8–D10):** Table renders when rows present, neutral/danger state rendering, 200% label visible, XSS escaping via Eta `<%= %>` on both household name and ID, live card htmx attributes correct.
5. **Metrics endpoint (E1, E3–E6):** Live counts, fallback to 0/0 without tracker, non-admin 403, unauthenticated redirect, fragment shape (live-active-households and live-rpm spans) all correct.
6. **Persona tests (G1–G5):** Matt sees both households with correct member counts; Nina and Alice get 403; cost reflects live costTracker values; live card msg/min is monotonically increasing.
7. **Wiring tests (F1–F5):** Router.routeMessage calls tracker.recordMessage with the requestContext householdId; all three dispatch paths (Telegram, API, alert executor) verified wired; shutdown disposes the tracker.
8. **D4 (warning color state):** The warning and danger progress bar states are distinguishable (both use `accent-color` style, neutral does not). The test passes. URS wording says "orange" but the impl uses `--pico-ins-color` (green) — this is a cosmetic discrepancy, not a test failure (per Codex H3 we test semantic state, not specific token).

---

## Test Mistakes Found and Fixed

These were test-design errors corrected during Phase 4. Not counted as impl bugs.

| Test | Issue | Fix applied |
|---|---|---|
| D2 | `not.toContain('No LLM API usage recorded yet')` — Cost Summary and Per-Household Breakdown are independent sections; empty log correctly shows both | Removed incorrect negative assertion |
| E2 | `toContain('0 active household')` — the `0` is inside a `<span>` tag, so literal string not present | Changed to `toContain('id="live-active-households">0</span>')` |
| E3 | Same issue as E2 | Same fix |

---

## URS Alignment (H1/H2)

- **REQ-LLM-028** test references in `docs/urs.md` correspond to real `it(...)` names in the audit suite.
- **Color-token discrepancy:** URS says "orange when ≥80%". Template uses `--pico-ins-color` (Pico's green). D4 passes because the test checks semantic distinguishability, not specific token. If strict URS compliance is required, the template needs a custom orange token. Deferred to `review/d5c-chunk-d`.

---

## Deferred to `review/d5c-chunk-d`

| # | File | Fix | Status |
|---|---|---|---|
| D1 | `core/src/gui/routes/llm-usage.ts:240` | `overCap: monthlyCost > cap` | ✓ Done — `01623c4` |
| D2 | `core/src/gui/routes/llm-usage.ts` (parseUsageMarkdown) | Remove `.filter(Boolean)` column-shift | ✓ Done — see BUG-2 commit on `review/d5c-chunk-d` |
| D3 | `core/src/services/metrics/message-rate-tracker.ts:11` | Import `PLATFORM_SYSTEM_HOUSEHOLD_ID` from auth-actor | ✓ Done — see BUG-2 commit on `review/d5c-chunk-d` |
| D4 | `core/src/gui/views/llm-usage.eta:90` | Align warning color token with URS "orange" (cosmetic) | Deferred — see `docs/open-items.md` |

**Note:** The twin of D2 was also found in `CostTracker.rebuildFromLog` (`core/src/services/llm/cost-tracker.ts`) during planning. This was user-confirmed in scope and fixed in the BUG-2 commit alongside D2 and D3. A blank User cell in a persisted 9-col row would corrupt the monthly-cost cache at startup (household value leaked into the user bucket), potentially desynchronizing REQ-LLM-026 cost-cap enforcement from REQ-LLM-028 display.

---

## New Test Files

| File | Tests |
|---|---|
| `core/src/services/metrics/__tests__/message-rate-tracker.test.ts` (extended) | A1–A9 (+9) |
| `core/src/gui/__tests__/llm-usage.test.ts` (extended) | B1–B5, C1–C10, D1–D10, E1–E6 (+31) |
| `core/src/gui/__tests__/llm-usage-ops-persona.test.ts` (new) | G1–G5 (+5) |
| `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts` (new) | F1–F5 (+5) |
