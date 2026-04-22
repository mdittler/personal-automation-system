# D5c Chunk D — Test-First Re-Validation & Bug Hunt

## Context

Chunk D of D5c (per-household LLM ops dashboard) landed in commit `d255c39` as a single
648-line commit: tests and production code written together, no Red → Green → Refactor,
`superpowers:executing-plans` not invoked, no persona test for the admin surface, and the
session violated the one-phase-per-session rule by merging Chunk C review + Chunk D in one
session.

The impl may or may not be correct — but we have no principled proof. Because the tests
were written alongside the code, they might describe what was built rather than what should
have been built.

**What this plan does**

1. Re-derive what Chunk D *should* do from the plan text + URS + the testing-standards
   skill — independently of what's already there.
2. Write an **ideal** test suite against that design (additions, not replacements).
3. Verify the suite covers every required test category (happy / edge / error / security /
   concurrency / state / config / contract / auth / XSS / wiring / persona).
4. **PAUSE** so the user can manually review the tests.
5. Once approved, run the suite against the *already-committed* impl. Classify each result —
   a failing test is a **candidate bug** until classified (it may also be a test mistake or
   a URS/impl spec drift); a passing test is evidence the impl matches the audit design.
6. Produce a findings list, separating critical bugs, minor issues, and deferred items.
   **No code fixes in this session** — fixes go to a follow-up `review/d5c-chunk-d` branch.

This is a **post-hoc audit**, not TDD. The "watch it fail" step of Red → Green → Refactor is
not preserved, because the production code already exists. What this flow *does* preserve is
the independence of the test suite: it is designed from the requirements and testing-standards
skill, not reverse-engineered from the impl. That gives stronger post-hoc evidence than the
original tests, but it is not equivalent to a real TDD loop and the findings file will say so.

---

## Design — What Chunk D Should Do

Derived from the plan (`docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`
lines 149–168, 203), URS `REQ-LLM-028`, and the reuse constraints noted in the plan.

### 1. `MessageRateTracker` — rolling 60s message-rate service

- Pure in-memory, single-process.
- `recordMessage(householdId?: string)` — append timestamped entry.
- `getMessagesPerMinute()` — total entries in the 60s window (including unattributed).
- `getActiveHouseholds()` — count of distinct *non-platform* household IDs in window.
- `getPerHouseholdRpm()` — `Map<householdId, count>` for non-platform entries in window.
- `dispose()` — stop internal cleanup interval; idempotent; safe after dispose (`recordMessage`
  becomes a no-op).
- Cleanup interval: every 10s, prune entries older than 60s. Interval must `.unref()` so it
  doesn't hold the process alive at shutdown.
- Unattributed (`undefined`) householdId and user-supplied literal `__platform__` collapse to
  the platform sentinel. Canonical sentinel must be `PLATFORM_SYSTEM_HOUSEHOLD_ID` from
  `core/src/types/auth-actor.ts` (contract invariant — single source of truth).

### 2. Router / API / Alert instrumentation

Every inbound message that reaches `Router.routeMessage(ctx)` must call
`this.messageRateTracker?.recordMessage(getCurrentHouseholdId())` as its first action.

All three dispatch origins must resolve to a household:
- Telegram/bot adapter: `requestContext.run({userId, householdId}, ...)` wraps the call.
- REST API `POST /api/messages`: same ALS wrapper before `routeMessage`.
- `AlertService.dispatch_message` action: same ALS wrapper before `routeMessage`.

Since all three go through `Router.routeMessage`, a single instrumentation point suffices —
but this is an invariant that must be *tested*, not assumed.

### 3. `parseUsageMarkdown` — 9-column support

- Accept 9-col rows (previous 6/7/8 formats still parse).
- Mixed 8-col and 9-col rows in the same file: only 9-col rows contribute to `perHousehold`.
- `cells[8]` values of `-` or `__platform__` are excluded from `perHousehold`.
- **Empty intermediate cells must not shift columns**: a 9-col row with a blank User cell
  must still parse Household from `cells[8]`, not treat the household id as the user. This
  is a real bug today — `.filter(Boolean)` collapses empties.
- `perHousehold` sorted by cost desc.
- Never crash on ragged/malformed rows.

### 4. `buildPerHouseholdRows`

- Returns one row per household from `householdService.listHouseholds()` (even zero-cost).
- Columns: `{ household, members, callCount, monthlyCost, cap, pctOfCap, overCap }`.
- `monthlyCost` pulled live from `costTracker.getMonthlyHouseholdCost(hhId)` — includes
  outstanding reservations (per CostTracker design).
- `cap` = `llmSafeguards.householdOverrides[hhId].monthlyCostCap ??
  llmSafeguards.defaultHouseholdMonthlyCostCap ??
  DEFAULT_LLM_SAFEGUARDS.defaultHouseholdMonthlyCostCap`.
- `pctOfCap` = `cap > 0 ? round(monthlyCost / cap * 100) : 0`.
- `overCap` = `monthlyCost > cap` (**note: strict "actually over", not ≥100% rounded**).
- If `householdService` absent → returns empty array (graceful degradation).
- Sorted by `monthlyCost` desc.

### 5. GUI `/gui/llm` rendering

- **Live card** at top of page: shows active-households + msg/min, `hx-get="/gui/llm/metrics"`
  `hx-trigger="every 5s"` `hx-swap="innerHTML"`.
- **Per-Household Breakdown** table: `Household | Members | Calls | Cost | Cap | % of Cap`.
- Progress bar color thresholds (**behavioral contract — test the semantic state, not the
  theme token**):
  - `pctOfCap < 80` — neutral rendering (no warning class).
  - `pctOfCap >= 80 && !overCap` — **warning** rendering (URS wording: "orange").
  - `overCap` — **danger** rendering (URS wording: "red") with visible "OVER CAP" label.
- Progress bar should *not* visually truncate over-cap — either show full bar + label, or
  extend numeric label to make "300%" obvious.
- Both household name and household id are HTML-escaped (Eta `<%= %>` handles this, but
  verify via XSS test with hostile names).
- Table renders even when the usage-log file is empty (data comes from `listHouseholds`).

### 6. `/gui/llm/metrics` partial endpoint

- Admin-only: inherits `requirePlatformAdmin` via plugin-level `preHandler` hook.
- Returns HTML fragment with two `<span>` updates (active households, msg/min).
- Non-admin request → 403.
- Unauthenticated request → redirect/401 (depends on GUI auth behavior).
- No `messageRateTracker` injected → renders `0` / `0`, never throws.

### 7. Bootstrap wiring

- `MessageRateTracker` constructed once, before Router.
- Passed to Router and GUI.
- Disposed on shutdown (once — double-dispose is safe but wiring should not call it twice).

### 8. URS REQ-LLM-028

- Requirement text in `docs/urs.md` must match the impl (notably the color-threshold wording
  and the over-cap semantics).
- URS test-name references should map to real `it(...)` names — see H below for the lighter,
  less-brittle form of this check.

---

## Test Matrix

Ideal test coverage, mapped to the `testing-standards` skill categories.

### A. Unit — `core/src/services/metrics/__tests__/message-rate-tracker.test.ts` (extend)

Existing file has 15 tests. Add these 9 to close gaps:

| # | Category | Test name |
|---|---|---|
| A1 | Edge | `excludes messages at exactly 60s old (boundary exclusive)` |
| A2 | Edge | `includes messages at 59.999s old (boundary inclusive)` |
| A3 | Edge | `treats empty-string householdId as platform sentinel` |
| A4 | Security/Contract | `uses PLATFORM_SYSTEM_HOUSEHOLD_ID from auth-actor as its sentinel` |
| A5 | Concurrency | `setInterval does not fire prune() after dispose (spy on clearInterval + spy on prune; no further calls after dispose)` |
| A6 | State | `prune() actually shrinks internal entries array length (assert via (tracker as any).entries.length after advance past window)` |
| A7 | Config | `default WINDOW_MS is 60_000 and CLEANUP_INTERVAL_MS is 10_000 (invariants documented via test)` |
| A8 | Timing | `unref() is called on the interval (spy on setInterval return value's unref)` |
| A9 | Timing (defensive hardening — not required by REQ-LLM-028) | `prune() converges after Date.now() rewinds mid-session (clock-regression via vi.setSystemTime)` |

### B. Unit — `parseUsageMarkdown` in `core/src/gui/__tests__/llm-usage.test.ts` (extend)

Existing file has 5 9-col tests. Add:

| # | Category | Test name |
|---|---|---|
| B1 | Edge | `handles interleaved 9-col → 8-col → 9-col rows (not just 9-after-8)` |
| B2 | Edge | `handles 9-col with cells[8] containing whitespace-only value` |
| B3 | Edge | `handles row with pipe-split yielding >9 cells (trailing pipe)` |
| B4 | State | `perHousehold sorted descending by cost` |
| B5 | Edge/Regression | `9-col row with blank User cell still parses Household from cells[8] (blank middle cell does not shift columns left)` |

**B5 is high-signal:** the current `.filter(Boolean)` in `parseUsageMarkdown` collapses empty
cells, so a blank User shifts Household into the User column and no household is recorded.
This is a real, reproducible bug and the audit suite must catch it.

### C. Unit — `buildPerHouseholdRows` in `core/src/gui/__tests__/llm-usage.test.ts` (new describe)

All tests new. Isolated unit test of the helper (export if not already; if helper is private,
assert via GET `/gui/llm` HTML).

| # | Category | Test name |
|---|---|---|
| C1 | Happy | `returns one row per household with correct cost/cap/pct` |
| C2 | Edge | `household with zero calls renders row with cost=0, pct=0, overCap=false` |
| C3 | Edge | `household override cap takes precedence over default cap` |
| C4 | Edge | `cap=0 does not divide by zero (pctOfCap=0)` |
| C5 | Edge | `overCap is true only when monthlyCost > cap (NOT when pctOfCap rounds to 100)` |
| C6 | Contract | `monthlyCost includes outstanding reservations (via costTracker.getMonthlyHouseholdCost)` |
| C7 | Contract | `members count matches householdService.getMembers(id).length` |
| C8 | Edge | `no householdService provided → returns empty array` |
| C9 | State | `rows sorted by monthlyCost desc` |
| C10 | Edge | `listHouseholds returns empty → returns empty array` |

### D. HTTP integration — `core/src/gui/__tests__/llm-usage.test.ts` (new describe `GET /gui/llm`)

| # | Category | Test name |
|---|---|---|
| D1 | Happy | `renders Per-Household Breakdown table when rows present` |
| D2 | Edge | `renders Per-Household Breakdown table even when usage-log file is empty` |
| D3 | State | `pctOfCap=45 → progress bar renders without warning or danger class` |
| D4 | State | `pctOfCap=85 (not over cap) → progress bar carries a warning marker (class/attr/data-state) distinct from the neutral and danger states` |
| D5 | State | `pctOfCap=110 with overCap=true → progress bar carries a danger marker AND an "OVER CAP" label in rendered HTML` |
| D6 | Edge | `pctOfCap=200 → rendered HTML surfaces the raw percentage somewhere (label or aria) — not visually clamped to 100` |
| D7 | Edge | `pctOfCap rounding boundary: cost/cap=0.995 rounds to 100 but overCap=false (no OVER CAP label, no danger marker)` |
| D8 | Security | `household name containing <script>alert(1)</script> is HTML-escaped in rendered table` |
| D9 | Security | `household id containing HTML entities is escaped` |
| D10 | Contract | `Live card emits hx-get="/gui/llm/metrics" with hx-trigger="every 5s" and hx-swap="innerHTML"` |

**Test design note (D3/D4/D5 following Codex M1/H3):** assertions are on the *semantic state*
(warning vs danger vs neutral), not a specific Pico CSS variable. Implementation may use a
class, a data attribute, or a token — tests must accept any of these as long as the three
states are visually distinguishable. The URS-vs-impl color mismatch surfaces by checking that
the warning and danger states render *different* HTML, not by binding to `--pico-ins-color`.

### E. HTTP integration — `/gui/llm/metrics` (extend existing describe)

Existing file has 1 test. Add:

| # | Category | Test name |
|---|---|---|
| E1 | Happy | `returns live counts reflecting recordMessage calls made on the tracker` |
| E2 | Edge | `tracker with only platform-sentinel messages → activeHouseholds=0, msgPerMin>0` |
| E3 | Edge | `no messageRateTracker injected → renders 0/0, does not throw` |
| E4 | Auth (negative) | `non-admin user receives 403 when hitting /gui/llm/metrics` |
| E5 | Auth (negative) | `unauthenticated request redirects to login (no HTML leak)` |
| E6 | Contract | `response fragment shape matches what htmx will swap into #live-metrics` |

### F. Production wiring — `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts` (new)

Bootstrap-level integration (follows pattern of `multi-household-isolation.integration.test.ts`).

| # | Category | Test name |
|---|---|---|
| F1 | Wiring | `incoming Telegram-originated message increments tracker (one end-to-end recordMessage)` |
| F2 | Wiring | `incoming REST /api/messages request increments tracker (goes through routeMessage)` |
| F3 | Wiring | `AlertService dispatch_message action increments tracker` |
| F4 | Wiring | `three dispatch sources with different households produce three distinct active households` |
| F5 | State | `shutdown handler invokes tracker.dispose() exactly once` |

### G. Persona — `core/src/gui/__tests__/llm-usage-ops-persona.test.ts` (new)

Mirrors `apps/chatbot/src/__tests__/natural-language-household-governance.test.ts`. Scoped to
the scenarios where the persona layer adds value on top of the route integration tests
(following Codex L1). Threshold permutations stay in D3–D7 at the route layer.

Personas:
- `MATT` — admin, household `hA` (2 members incl. Nina)
- `NINA` — non-admin, household `hA`
- `ALICE` — non-admin, household `hB` (1 member)

| # | Category | Test name |
|---|---|---|
| G1 | Happy | `Matt opens /gui/llm and sees both households listed with correct member counts and real cost values from costTracker + householdService` |
| G2 | Auth | `Nina (non-admin) is redirected/403 when opening /gui/llm` |
| G3 | Auth | `Alice (non-admin) is redirected/403 when hitting /gui/llm/metrics directly` |
| G4 | Contract | `cost shown to Matt reflects live reservations (mutate costTracker mid-render and re-fetch)` |
| G5 | Happy | `Live card updates after polling /gui/llm/metrics (two sequential requests with recordMessage() between them show monotonically increasing msg/min)` |

### H. Contract — URS alignment (lightweight; following Codex M5)

Not a unit test — a lightweight script or Phase-4 check.

| # | Category | Check |
|---|---|---|
| H1 | Contract | During Phase 4, grep each `REQ-LLM-028`-referenced test name in `docs/urs.md` and confirm there exists an `it(...)` with that exact string in the referenced file. Report discrepancies in the findings file, not in-test. |
| H2 | Contract | URS wording vs rendered HTML: if URS says "orange when ≥80%", the rendered HTML must have a warning state distinct from neutral and danger. Cross-checked implicitly by D4/D5. |

### Coverage Audit

Against the testing-standards checklist:

| Category | Covered by |
|---|---|
| Happy path | A (existing), B, C1, D1, E1, F, G1 |
| Edge cases | A1–A3, B1–B3, B5, C2–C4, C8–C10, D2, D6–D7, E2–E3 |
| Error handling | Existing 15 tracker tests + C4 (zero cap) |
| Security (XSS, unauthorized) | D8, D9, E4, E5, G2, G3 |
| Concurrency / timing | A5, A8, A9 |
| State transitions | A6, B4, C5, C9, D3–D5, F5 |
| Configuration | A7, C3 |
| Post-routing authorization | N/A for Chunk D (no verifier re-routes the GUI) |
| Output-context encoding | D8, D9 |
| Contract tests | A4, B5, C6, C7, D10, E6, H1, H2 |
| Production wiring | F1–F4 |
| Real concurrency (Promise.all) | N/A (tracker is synchronous ops) |
| Numeric edge cases | C4, C5, D6, D7 |

---

## Execution Order

### Phase 1 — Write tests (additions only)

New files:
- `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts`
- `core/src/gui/__tests__/llm-usage-ops-persona.test.ts`

Extended files:
- `core/src/services/metrics/__tests__/message-rate-tracker.test.ts` — add **9** tests (A1–A9)
- `core/src/gui/__tests__/llm-usage.test.ts` — add B1–B5 (5 tests), C1–C10 (10 tests), D1–D10
  (10 tests), E1–E6 (6 tests)

Totals: 2 new files, 2 extended files, 45 new `it(...)` tests.

I will **not** delete or weaken any existing test. Where an existing test overlaps a new
one, I'll keep both — the plan is to use the new suite as an additional conformance layer,
not to rewrite Chunk D's test surface.

Since the impl is already in place, many tests will pass immediately — that is expected for a
post-hoc audit. I will **not** alter the impl to make failing tests pass during this phase.

### Phase 2 — Self-audit the suite

Run coverage audit (above table). Confirm:
- Every testing-standards category has at least one test.
- Every "Concern" from the Chunk D exploration report has a test that would catch it.
- Every REQ-LLM-028 test reference in `docs/urs.md` corresponds to a real `it(...)` (H1 grep).

### Phase 3 — PAUSE for manual review

Deliverable: a summary table showing "new tests written vs. concerns addressed" for the user
to sanity-check before execution. The user reviews test names, spot-checks test bodies, and
approves (or requests additions/changes).

No execution in this phase.

### Phase 4 — Execute against current impl; surface bugs

Run `pnpm vitest run <new-files> <extended-files>`. Classify each failure:

- **Bug**: test is correct, impl is wrong → log to findings list with file:line.
- **Test mistake**: test encodes wrong expectation → fix the test.
- **Spec mismatch**: URS and impl disagree → flag for user decision.

Output: `docs/d5c-chunk-d-review-findings.md` with Critical / Important / Minor / Positive
sections matching the `/review` command format.

No code fixes to production files in this session. Fixes go to a follow-up session on a
`review/d5c-chunk-d` branch.

### Phase 5 — Update status docs (gated on findings outcome)

Conditional on Phase 4 classification:

- **No critical findings** → `CLAUDE.md` updated to "Chunk D reviewed, proceed to Chunk E".
- **Critical findings exist** → `CLAUDE.md` updated to "Chunk D reviewed — N critical
  findings pending; Chunk E blocked until `review/d5c-chunk-d` branch merges".

Either way:
- Memory updated with test count and review-complete marker.
- `docs/open-items.md` appended with any deferred findings.
- Findings file committed (read-only reference for the follow-up session).

---

## Concerns already surfaced from exploration (pre-test)

These are predictions the test suite should either confirm or refute. Listing them here so
the reader knows what to watch for in Phase 4. Each prediction is a candidate — Phase 4 will
classify.

1. **Color-state mismatch**: `llm-usage.eta:89–92` uses `--pico-ins-color` (green in Pico)
   for ≥80%. URS says orange. D4/D5 will check that the warning and danger states are
   distinguishable; a brittle "exact-token" assertion is avoided per Codex H3.
2. **Duplicated sentinel constant**: `message-rate-tracker.ts:11` hard-codes `'__platform__'`
   instead of importing `PLATFORM_SYSTEM_HOUSEHOLD_ID`. A4 will surface this.
3. **Rounded over-cap**: `buildPerHouseholdRows` sets `overCap = pctOfCap >= 100` (rounded),
   so 99.5% → 100% lights OVER CAP. C5 / D7 will surface this.
4. **Over-cap bar truncation**: progress `max=100` visually clamps 300% → looks identical to
   100%. D6 checks that the raw percentage is present in the rendered HTML.
5. **Clock regression** in `prune()`: unprotected against `Date.now()` going backwards.
   A9 exercises this as defensive hardening (not a required REQ-LLM-028 conformance case).
6. **`parseUsageMarkdown` `.filter(Boolean)` column-shift** on blank cells — pre-existing,
   amplified by the 9-col extension. B1–B3 probe related edges; **B5 directly targets the
   blank-middle-cell shift** per Codex H1.
7. **No auth-negative test** for `/gui/llm/metrics`. E4/E5/G3 add it.
8. **No rendering test** for Per-Household Breakdown. D1–D9 add it.
9. **No persona coverage** — the admin user surface. G1–G5 add it (trimmed from a larger set
   per Codex L1 since thresholds are already covered in D).
10. **No wiring test** proving API + alert dispatch are captured by Router instrumentation.
    F1–F4 add it.

---

## Critical files

| Path | Purpose |
|---|---|
| `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md` | Source of truth for Chunk D design (lines 149–168, 203) |
| `docs/urs.md` (REQ-LLM-028 at L3073–3097, matrix at L5371) | Contract to verify |
| `core/src/services/metrics/message-rate-tracker.ts` | Impl under review |
| `core/src/services/metrics/__tests__/message-rate-tracker.test.ts` | Extend with A1–A9 |
| `core/src/gui/routes/llm-usage.ts` | `parseUsageMarkdown`, `buildPerHouseholdRows`, `/metrics` |
| `core/src/gui/views/llm-usage.eta` | Template rendering under test |
| `core/src/gui/__tests__/llm-usage.test.ts` | Extend with B, C, D, E tests |
| `core/src/gui/__tests__/llm-usage-ops-persona.test.ts` | New persona file (G1–G5) |
| `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts` | New wiring file (F1–F5) |
| `core/src/bootstrap.ts` | Wiring under test (lines 83, 782, 801, 1050, 1195) |
| `core/src/services/router/index.ts` | Instrumentation site (line 246) |
| `core/src/api/routes/messages.ts` | API dispatch path (line 91) |
| `core/src/services/alerts/alert-executor.ts` | Alert dispatch path (line 478) |
| `core/src/types/auth-actor.ts` | `PLATFORM_SYSTEM_HOUSEHOLD_ID` — canonical sentinel |
| `core/src/services/llm/cost-tracker.ts:325–334` | `getMonthlyHouseholdCost` — includes reservations |
| `core/src/services/household/index.ts:195, 216` | `listHouseholds`, `getMembers` |
| `apps/chatbot/src/__tests__/natural-language-household-governance.test.ts` | Persona-test pattern to mirror |

---

## Verification

**Phase 2 gate**: coverage-audit table maps every category × concern to ≥1 test. If a row is
blank, the suite is incomplete.

**Phase 3 gate** (user-driven): user manually reviews test names + spot-checks bodies before
Phase 4 runs.

**Phase 4 gate**: `pnpm vitest run` completes with a zero-failure OR a fully-classified
failure list. No unclassified failures. All candidate failures tagged as bug / test mistake /
spec mismatch. Findings file produced.

**Phase 5 gate (conditional)**: Chunk E unblock requires zero critical findings remaining
open. CLAUDE.md and memory state match the actual finding status (no optimistic updates).

---

## Decisions (user-confirmed + Codex-refined)

1. **Test file locations**: default paths.
   - Persona: `core/src/gui/__tests__/llm-usage-ops-persona.test.ts`
   - Wiring: `core/src/__tests__/message-rate-tracker-wiring.integration.test.ts`
2. **Fix policy**: Phase 4 is **document-only**. No production-code changes in this session.
3. **Post-hoc TDD**: acceptable; findings file documents the compromise.
4. **Clock-regression test**: included as A9, labeled defensive hardening.
5. **Cleanup-behavior tests (A5/A6)**: assertions strengthened to spy on `clearInterval` /
   inspect `entries.length` directly, not rely on downstream counters (Codex M2).
6. **Color-state assertions (D3/D4/D5)**: test warning-vs-danger-vs-neutral as distinguishable
   states, not bind to a specific Pico CSS variable (Codex H3).
7. **URS name-alignment check (H1)**: downgraded from a unit test to a Phase-4 grep/docs
   check to avoid rename churn (Codex M5).
8. **Persona suite trim (G)**: threshold permutations live in D3–D7; persona tests keep
   auth/access/end-to-end scenarios only (Codex L1).
9. **Blank-middle-cell regression (B5)**: added as high-signal conformance test (Codex H1).
10. **Phase 5 gating**: Chunk E unblock is conditional on no critical findings (Codex M4).
11. **Language tone**: "candidate bug until classified" replaces "real bug" in Context /
    Phase-4 / findings (Codex M3).
