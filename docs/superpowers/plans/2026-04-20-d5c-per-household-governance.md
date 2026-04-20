# Phase D5c — Per-Household LLM Governance + Ops + Load Test

**Date:** 2026-04-20  
**Status:** In Progress — Chunk 0 complete ✓ · **Chunk A is next**  
**Part of:** Deployment Readiness Roadmap follow-on (post D1–D6)  
**Spec:** `docs/superpowers/specs/2026-04-13-deployment-readiness-roadmap-design.md` (D6 section, operational monitoring)

---

## Context

D5a/D5b delivered per-household auth, data-scoping, and admin UX. D5c adds **per-household resource governance** so no household monopolizes LLM bandwidth or cost on the shared Mac Mini, and verifies the system under 40 concurrent users across 5–10 households.

Today cost/rate-limit plumbing has only two dimensions — `appId` and `userId`. Households are invisible to the guards. D5c adds the household dimension, instruments an ops dashboard, and validates with a load test.

**Why this design was chosen:** Reviewed by Codex before implementation. Key decisions:
1. Household rate limit is **household-wide** (single `HouseholdLLMLimiter`), not per-app-per-household (which can't aggregate inside a per-app `LLMGuard`).
2. Exemption is "platform context" not "system/api" blanket — `systemLlm` and `apiLlm` are exempt only when `getCurrentHouseholdId()` returns `undefined` or `__platform__`; user-scoped system calls with a real householdId are enforced.
3. Cost cap uses bounded reservations to prevent concurrent bypass; acceptable overshoot ≈ $0.20.

---

## Scope

**In scope (6 chunks):**
- **Chunk 0.** Semantics decisions: household-wide rate limit, exemption policy, overshoot policy. URS entries + open-items.md fix. No code.
- **Chunk A.** Fix 3 remaining ALS dispatch gaps (bootstrap Telegram + onboard paths + GUI context routes). + regression guard test.
- **Chunk B.** `CostTracker` household dimension: 9th column in `llm-usage.md`, `households:` map in `monthly-costs.yaml`, cost reservations API.
- **Chunk C.** `HouseholdLLMLimiter` (shared cross-app, injected from bootstrap) + `RateLimiter` peek/commit API + full config/schema/error surface.
- **Chunk D.** Ops dashboard: extend `/gui/llm` with Per-Household Breakdown + live htmx metrics. Instrument at `Router.routeMessage`.
- **Chunk E.** `composeRuntime()` bootstrap refactor + `scripts/load-test.ts` (40 users × 8 households, stub provider, metrics report).

**Explicitly deferred:**
- D5a §1 — `forShared(scope)` path fix (~26 food callsites + data migration). Independent; fold into next food phase.
- D5a §4 — Collaboration space UX. Trigger: concrete cross-household use case.
- Per-user cost caps — out of scope.
- `llm-usage.md` sharding — revisit if log grows past MB.

---

## Confirmed Decisions

1. **D5a §1 and §4 deferred** from D5c.
2. **Default caps — conservative:** 200 req/hour per household, $20/month per household. Global cap stays $50/month.
3. **Cadence — one chunk per session** with Claude+Codex review gate between each.

---

## Chunk 0 — Semantics Decisions (docs + URS only)

### Decisions to record
1. **Household rate-limit is household-wide.** Key: `${householdId}` only. Single `HouseholdLLMLimiter` created in bootstrap and injected into every guard.
2. **Exemption = platform context, not blanket system/api.** If `getCurrentHouseholdId()` = `undefined` or `__platform__`, call is attributed to `platform` and exempt from per-household caps (still counts toward global). Real household context → enforced, even for infra/API callers.
3. **Overshoot = bounded reservations.** `reserveEstimated()` on entry, reconciled by `record()` on exit. 60s expiry on hung reservations. Acceptable overshoot ≈ $0.20.

### Artifacts
- `docs/urs.md` — add REQ-LLM-025, REQ-LLM-026, REQ-LLM-027 (Status: Planned).
- `docs/open-items.md` line 12 — correct "§1–§2" → "§1, §4".

---

## Chunk A — Fix remaining dispatch ALS gaps

### Gap inventory (Codex-verified)
Route-verification (bootstrap.ts:898) and app-callback (:961) already wrap `{userId, householdId}`. Remaining gaps:

| File | Line | Fix |
|---|---|---|
| `core/src/bootstrap.ts` | 816 | Add `householdId: householdService.getHouseholdForUser(messageCtx.userId) ?? undefined` |
| `core/src/bootstrap.ts` | 835 | Same for photo |
| `core/src/bootstrap.ts` | 924 | Same for onboard cb (null-safe) |
| `core/src/gui/routes/context.ts` | 60, 115, 163, 191 | Add householdId |

### Wiring note
`gui/routes/context.ts` needs `householdService` injected via `ContextRoutesOptions` (extend type + registration in `gui/index.ts`). Pattern: `gui/routes/spaces.ts`.

### Tests
- Extend `dispatch-context-wrap.test.ts` — regex assertions include `householdId:` at each wrap site. Whitelist the 2 already-correct paths.
- New/extend `base-provider.test.ts` — under `requestContext.run({ userId, householdId }, ...)`, stub provider's `completeWithUsage()` passes both ids to `costTracker.record()`.

### Verification
`pnpm test core/src/__tests__/dispatch-context-wrap.test.ts core/src/services/llm/__tests__/base-provider.test.ts`

---

## Chunk B — Household dimension in CostTracker

### Changes
- `UsageEntry` + `MonthlyCostData` + in-memory maps gain `householdId`/`households`.
- `doAppendEntry()` → 9-column row. Header `| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User | Household |`.
- **Header migration:** Detect 8-col header on load → rewrite header atomically; append upgrade-timestamp comment row; legacy data rows stay 8-col, parsed with `householdId = '-'`, excluded from household aggregates.
- `rebuildFromLog()` tolerates mixed 8/9-col rows.
- YAML cache upgrade: if `households:` key absent in `monthly-costs.yaml`, trigger `rebuildFromLog()`.
- New: `reserveEstimated(hhId, appId, userId, est) → reservationId`, `releaseReservation(id, actual | null)`, 60s expiry. `getMonthlyHouseholdCost()` = persisted + outstanding.
- `base-provider.ts:96–104` passes `householdId: getCurrentHouseholdId()` alongside userId to `record()`.

### Tests
- Legacy 8-col log readable; rows in user totals but not household totals.
- After header upgrade, new writes are 9-col; no data loss.
- Reservation lifecycle: reserve → check (sees persisted+pending) → release with actual → only actual persists. Expiry.
- Reservation concurrency: 10 simultaneous reserves sum correctly.

### Verification
Unit tests + manual restart with existing 8-col log.

---

## Chunk C — HouseholdLLMLimiter + RateLimiter peek/commit + config surface

### Architecture
`core/src/services/llm/household-llm-limiter.ts` (new) — single instance per process, constructed in bootstrap, injected into every guard. Two responsibilities: household-wide rate check + household cost cap (via reservations).

### RateLimiter peek/commit
`check(key): { allowed: boolean; commit: () => void }` — peek without recording; `commit()` records only after all guards agree. `isAllowed()` becomes a thin wrapper. No state mutation on partial denial.

### LLMGuard integration (order matters)
1. App rate peek → if denied: throw `LLMRateLimitError('app')`.
2. Household rate peek → if denied: throw `LLMRateLimitError('household')`. No app slot consumed.
3. App cost cap check. 4. Household cost cap check (persisted + reservations). 5. Global cap. 6. Both commits. 7. `reserveEstimated(...)`. 8. Provider call. 9. `releaseReservation(id, actual)` on completion; `releaseReservation(id, null)` on error.

### Config surface (must all move together)
| File | Change |
|---|---|
| `core/src/types/config.ts` (38–58) | Add `defaultHouseholdRateLimit`, `defaultHouseholdMonthlyCostCap`, `householdOverrides?` to `LLMSafeguardsConfig` |
| `core/src/services/config/index.ts` (45–48, 375–387) | Extend YAML shape, camelCase mapper, fallback defaults |
| `core/src/services/config/pas-yaml-schema.ts` (52) | Extend Zod schema |
| `core/src/services/config/__tests__/config.test.ts` (354–381) | Add parse test + default assertions |
| `config/pas.yaml` | Uncomment and extend `llm.safeguards` |
| `config/pas.yaml.example` | Same + comments |
| `core/src/services/system-info/index.ts` | Extend if it exposes per-app caps |
| `core/src/testing/mock-services.ts` | Add `HouseholdLLMLimiter` mock + household defaults |

### Error types (`core/src/services/llm/errors.ts`)
- `LLMCostCapError.scope`: add `'household'`, `'reservation-exceeded'`.
- `LLMRateLimitError`: add `scope: 'app' | 'household'`.
- Extend error-detail tests and any callers that pattern-match on scope.

### Tests
- Household-denied does not consume app rate slot.
- Concurrent burst: at most 1 bounded overshoot ($0.20).
- Platform-attributed calls exempt from household cap; real-household-context system calls enforced.
- New `household-llm-limiter.test.ts` standalone.

### Verification
`pnpm test core/src/services/llm/__tests__/ core/src/middleware/__tests__/rate-limiter.test.ts core/src/services/config/__tests__/config.test.ts`

---

## Chunk D — Ops dashboard

### Metrics source
Instrument at `Router.routeMessage` entry (`:218`) and `api/routes/messages.ts:~90` and `alerts/alert-executor.ts:~477`. One-liner: `services.messageRateTracker?.recordMessage(householdId)`.

### New service
`core/src/services/metrics/message-rate-tracker.ts` — rolling 60s window, methods: `recordMessage(hhId)`, `getActiveHouseholds()`, `getMessagesPerMinute()`, `getPerHouseholdRpm()`. Pure in-memory; cleanup timer every 10s.

### LlmUsageOptions injection
Extend to add `config: LLMConfig` (for cap values), `householdService: HouseholdService` (member counts), `messageRateTracker: MessageRateTracker`. Update `gui/index.ts:143` registration.

### Template additions
- Top-of-page **Live** card: active households / messages-per-minute, `hx-get="/gui/llm/metrics" hx-trigger="every 5s"`.
- **Per-Household Breakdown** table: `Household | Members | Calls | Cost ($) | Cap | % of Cap`. Pico CSS progress bar when `>80%`.

### Tests
- `parseUsageMarkdown` handles mixed 8/9-col; household aggregation correct.
- `message-rate-tracker.test.ts` rolling window via `vi.useFakeTimers()`.
- Admin-only gate; partial returns expected fragment.

---

## Chunk E — Bootstrap refactor + load-test harness

### Part E-1: composeRuntime()
Factor `core/src/bootstrap.ts` into `export async function composeRuntime(overrides?: RuntimeOverrides): Promise<RuntimeHandle>` (returns services without starting Telegraf/Fastify/scheduler). `main()` calls it then starts. `RuntimeOverrides`: stub provider, fake telegramService, custom dataDir, custom config. Rewire `multi-household-isolation.integration.test.ts` to use `composeRuntime`.

### Part E-2: Load-test harness
`scripts/load-test.ts`:
- Uses `composeRuntime` with stub `BaseProvider` subclass (Pareto-distributed latency, keeps full guard/cost-tracker stack).
- Seeds users into `config/pas.yaml` format; households into `data/system/households.yaml`.
- 40 workers × 8 households, 120s duration, 5–15s think time.
- Traffic: 70% chatbot, 20% `/ask`, 10% food.
- Each worker wraps with `requestContext.run({ userId, householdId }, ...)`.
- Reports: p50/p95/p99 latency, throughput, per-household cost, cap trigger count, writeQueue depth.
- Output to `docs/load-test-report-YYYY-MM-DD.md`.

`package.json`: `"load-test": "tsx scripts/load-test.ts"`.

### Concurrency flags to measure (not fix)
- `CostTracker.writeQueue` single chain — p99 at 40 concurrent?
- `file-mutex.ts` global `AsyncLock` — household path contention?
- Router same-user interleaving — observable races?

---

## Critical Files

| Chunk | Files |
|---|---|
| 0 | `docs/urs.md`, `docs/open-items.md` |
| A | `core/src/bootstrap.ts` (816, 835, 924), `core/src/gui/routes/context.ts` (60/115/163/191), `core/src/gui/index.ts`, `core/src/__tests__/dispatch-context-wrap.test.ts`, `core/src/services/llm/__tests__/base-provider.test.ts` |
| B | `core/src/services/llm/cost-tracker.ts`, `core/src/types/llm.ts`, `core/src/services/llm/providers/base-provider.ts` (96–104), `core/src/services/llm/__tests__/cost-tracker.test.ts` |
| C | `core/src/services/llm/household-llm-limiter.ts` (new), `core/src/services/llm/llm-guard.ts`, `core/src/services/llm/system-llm-guard.ts`, `core/src/services/llm/errors.ts`, `core/src/middleware/rate-limiter.ts`, `core/src/middleware/__tests__/rate-limiter.test.ts`, `core/src/types/config.ts`, `core/src/services/config/index.ts`, `core/src/services/config/pas-yaml-schema.ts`, `core/src/services/config/__tests__/config.test.ts`, `core/src/services/system-info/index.ts`, `core/src/testing/mock-services.ts`, `config/pas.yaml`, `config/pas.yaml.example`, `core/src/services/llm/__tests__/llm-guard.test.ts`, `core/src/services/llm/__tests__/household-llm-limiter.test.ts` (new), `core/src/services/llm/__tests__/system-llm-guard.test.ts`, `core/src/bootstrap.ts` |
| D | `core/src/services/metrics/message-rate-tracker.ts` (new), `core/src/services/router/index.ts` (218), `core/src/api/routes/messages.ts`, `core/src/services/alerts/alert-executor.ts`, `core/src/gui/routes/llm-usage.ts`, `core/src/gui/views/llm-usage.eta`, `core/src/gui/index.ts`, `core/src/bootstrap.ts` |
| E | `core/src/bootstrap.ts`, `core/src/__tests__/multi-household-isolation.integration.test.ts`, `core/src/testing/fixtures/` (new), `scripts/load-test.ts` (new), `package.json` |

## Reuse

- `HouseholdService.getHouseholdForUser()` (`core/src/services/household/index.ts:204`) — O(1).
- `requirePlatformAdmin` hook — already on `/gui/llm:166`.
- `parseUsageMarkdown()` (`llm-usage.ts:63–152`) — extend only.
- `RateLimiter` — extend with peek/commit; existing factories stay unchanged.
- `rebuildFromLog()` (`cost-tracker.ts:164–210`) — extend for mixed-width tolerance.

## Codex Patterns to Preempt

- Per-app guards can't aggregate cross-app → use shared injected limiter.
- Rate-limit check must not mutate state before all guards agree → peek/commit.
- Cost-cap concurrency bypass needs reservations.
- Error `scope` unions must expand in lockstep across errors.ts, callers, and tests.
- `X is exempt` = "X in platform context is exempt, X with real householdId is not."
- Bootstrap that self-starts is not test-composable → `composeRuntime()`.
- Don't equate `actor.userId === 'api'` with platform-admin in household paths.

## Phase-level Verification

1. `pnpm test` — all 6699+ tests green.
2. `pnpm lint` — no banned-import warnings.
3. `pnpm build` — clean.
4. Manual: messages from 2 households → `/gui/llm` shows both; deliberately hit household cap → Telegram error surface.
5. `pnpm load-test --users 40 --households 8 --duration 120s` — completes, attribution correct, cap triggers.
6. URS: REQ-LLM-025/026/027 moved from Planned to Implemented in matrix.
