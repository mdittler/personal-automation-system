# Regression Token Metering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch-by-batch. Steps use checkbox (`- [ ]`) syntax for tracking. Each batch is executed TDD-first (RED → verify-fail → GREEN → verify-pass → commit).

**Goal:** Surface real per-case input/output token counts in the PAS regression harness by adding a sanitized, process-local token-usage counter to `CostTracker` that the harness reads as a before/after delta — exactly as it already meters cost.

**Architecture:** `CostTracker` already receives `inputTokens`/`outputTokens` on every `record()` call from `BaseProvider.completeWithUsage()`. We sanitize those provider-supplied counts and accumulate them into a process-local running counter exposed via `getTokenUsageTotals()`. The regression dispatch + runner layers read the counter delta around each dispatch — including in `finally`, so token spend that happened before an error is still counted. `LLMService.complete()` is **not** changed and no caller is touched — `completeWithMeta()` already exposes usage, and the regression harness meters *closures around production classifiers*, so the fix belongs in `CostTracker`, not the LLM service interface.

**Tech Stack:** Node.js 22 + TypeScript 5 (ESM, strict), pnpm workspaces, Vitest, Biome, Fastify + Eta + htmx (GUI).

---

## Codex review — Round 1 (corrections applied)

This plan was reviewed before approval. All P1/P2 findings are applied in-place; P3 is applied conditionally. Codex confirmed the architecture is correct.

| # | Pri | Finding | Correction applied |
|---|-----|---------|--------------------|
| 1 | P1 | `getMonthlyTotalTokens()` is not actually monthly (not persisted to YAML) — misleading contract | **Renamed** to `getTokenUsageTotals()`, redefined as a **process-local monotonic counter** (not persisted, not restored, not month-reset, not rebuilt from the log). Honest name + JSDoc. Added a restart-semantics test. |
| 2 | P1 | `record()` consumes untrusted provider token counts without validation | Added a `safeTokenCount()` guard sanitizing `entry.inputTokens/outputTokens` **at the top of `record()`**, before cost estimation, log append, and the counter. Added `record({inputTokens: NaN/Infinity/-1})` tests. |
| 3 | P1 | Error-path tests wrongly expect 0 tokens — spend before a throw must be counted | Token metering is now **throw-resilient**: `meterCall`/recall compute the meter in `finally` and surface it via `MeteredError`; receipt/chatbot meter in `try/finally`. Each runner gets two error tests: "throws before any LLM → 0" and "throws after the tracker advanced → counted". |
| 4 | P1 | No test proves production deps thread the real tracker into the receipt runner | Added a `build-deps` wiring test asserting the receipt-runner deps receive the **same `CostTracker` instance** as production deps. |
| 5 | P2 | `rebuildFromLog()` token tests should cover legacy/blank row shapes | **Mooted by the Finding-1 redesign:** the counter is `record()`-driven and process-local — `rebuildFromLog()` does **not** parse token columns, so there is no new log-row parsing to test. Documented explicitly; `rebuildFromLog`'s existing cost parsing is untouched and out of scope. |
| 6 | P2 | A `Promise.all(meterCall)` test overclaims concurrency behavior | Removed the concurrent-`meterCall` test. The real invariant — runners dispatch inputs **sequentially** — is asserted by a runner-level call-order test in Batch 3. |
| 7 | P2 | Chatbot risks double-counting tokens between its own delta and `runRubricOracle()`'s meter | Chatbot `tokenCounts` comes from **one** before/after delta spanning route + oracle; it **ignores** `oracle.meter` token fields. Stated explicitly + a `{route:100/20, judge:30/10} → {130,30}` test. |
| 8 | P2 | GUI tests must fail independently for compare-row vs drilldown | Batch 4 asserts **four things separately**: compare column header, compare row cell, drilldown content, and absence of the stale footnote. |
| 9 | P3 | `looksLikeRunResult()` invalid-token tests may duplicate existing coverage | Batch 3 first checks `evaluated-tier.test.ts` / cache-reader suites; keeps the non-zero round-trip test always, adds the invalid-token table **only if not already covered**. |
| — | dir | "Make document updates part of the plan (URS, trace matrix, phase docs, CLAUDE.md, etc.)" | Batch 5 is now a full **Documentation** batch: URS (REQ-REG-013/017/018), traceability matrix, `docs/implementation-phases.md` (new dated section per the Implementation Status Discipline rule), the CLAUDE.md Implementation Status bullet, `docs/open-items.md`, and the `estimator.ts` JSDoc. |

---

## Context

**The problem.** `regression/src/runner/dispatch.ts` `meterCall()` hard-codes `tokenIn: 0, tokenOut: 0`. Every case-runner aggregates those zeros into `RunResult.tokenCounts`, and the regression GUI shows `—` / "plumbing pending" for every token count. Cost is already authoritative (metered via a `CostTracker.getMonthlyTotalCost()` before/after delta) — only the per-call token breakdown is missing.

**What prompted it.** The deferred item `docs/open-items.md` → "Persona Regression Suite — Chunk B.2 carry-forwards" → "LLMService.complete usage plumbing". The item's framing predates `LLMService.completeWithMeta()`, which **already** exists and already returns `{text, finishReason, usage}`. Exploration also established that the regression harness does not call `LLMService.complete()` directly — `meterCall(deps, tier, fn)` wraps closures (`fn`) around production classifiers (`classifyPASMessage`, `detectSessionControl`, `FoodShadowClassifier.classify`, `classifyRecallIntent`). The classifiers call the LLM internally; token usage is recorded into `CostTracker` but never bubbles back to the harness. So neither "change `complete()`'s return type" nor "add a new service method" actually unblocks the harness without threading usage through every classifier's return type. The `dispatch.ts` header comment names the real gap precisely: *"CostTracker has no per-call token surface."*

**Decision (confirmed with the operator).** Add the missing token surface to `CostTracker`. Token counts then become exactly as accurate as cost already is — both are before/after deltas on a `CostTracker` running total, and the orchestrator already enforces sequential dispatch (the invariant the cost delta already relies on).

**Intended outcome.**
- `RunResult.tokenCounts` carries real input/output counts for the routing, recall, receipt, and chatbot buckets — including spend that occurred before an error.
- The regression GUI compare table and per-case drilldown display real token counts; the "plumbing pending" copy is removed.
- `docs/open-items.md` items "LLMService.complete usage plumbing" (regression portion), "`RunResult.tokenCounts` hardcoded to `{0,0}`", and the estimator-approximation note are resolved/amended.
- Documentation is fully updated: URS (REQ-REG-013/017 updated, REQ-REG-018 added), traceability matrix, `docs/implementation-phases.md`, CLAUDE.md Implementation Status.

**Scope discipline.** Regression-scoped only. This plan does **not** build the T1 `completeWithTools` tool-calling substrate (a separate Confirmed Phase) and does **not** touch `LLMService.complete()`, `completeWithMeta()`, `LLMServiceImpl`, or any of the ~80 `complete()` callers.

## Decisions locked (operator-confirmed)

| Decision | Choice | Consequence |
|----------|--------|-------------|
| Token-data path | `CostTracker` process-local token counter + harness delta | No `LLMService` change, no caller fan-out |
| Token API contract | `getTokenUsageTotals()` — process-local monotonic counter | Not persisted, not restored on restart, not month-reset, not rebuilt from the log; only deltas are meaningful (Finding 1) |
| Provider token trust | Sanitize at the `record()` boundary via `safeTokenCount()` | Provider `usage` is untrusted input; NaN/Infinity/negative coerced to 0 (Finding 2) |
| Error-path metering | Throw-resilient (`finally` + `MeteredError`) | Tokens spent before a throw are still counted (Finding 3) |
| Receipt bucket | Wire receipt tokens | `costTracker` dep added to `ReceiptRunnerDeps`; threaded via `build-deps.ts`; wiring test added (Finding 4) |
| GUI surfaces | Compare table + drilldown only | Cross-run history view (`regression-history.eta`) left unchanged |
| Estimator (Batch 5) | Mechanism-ready, defer numeric recalibration | JSDoc updated only; numeric recalibration becomes a follow-up open-item — no LLM spend during this work |

## File Structure

**Modified — `core/` (production):**
- `core/src/services/llm/cost-tracker.ts` — add `safeTokenCount()`, two `tokenUsage*` accumulators, and `getTokenUsageTotals()`; sanitize + accumulate inside `record()`.
- `core/src/gui/routes/regression.ts` — `DisplayedCase` gains token fields; `buildDisplayedCase()` reads `result.tokenCounts`.
- `core/src/gui/views/partials/regression-tab-compare.eta` — add Tokens column header + remove the stale "plumbing pending" footnote.
- `core/src/gui/views/partials/regression-case-row.eta` — add token `<td>`.
- `core/src/gui/views/partials/regression-drilldown.eta` — replace the hard-coded `—` token row.
- `core/src/gui/services/regression/estimator.ts` — JSDoc only (mechanism-ready note).

**Modified — `regression/` (test harness):**
- `regression/src/runner/dispatch.ts` — `CostMeterSource` gains `getTokenUsageTotals()`; add `MeteredError` + `safeDelta`; `meterCall()` and `buildRecallAdapter()` meter in `finally` and surface the meter on the error path; header comment updated.
- `regression/src/runner/case-runners/chatbot-runner.ts` — single throw-resilient token delta spanning route + oracle; populate `tokenCounts`.
- `regression/src/runner/case-runners/receipt-runner.ts` — add `costTracker` dep; `try/finally` token delta around `parseReceiptFromPhoto`.
- `regression/src/runner/case-runners/routing-runner.ts`, `recall-runner.ts` — error-path catch reads `MeteredError.meter`; success path already aggregates `meter.tokenIn/tokenOut`.
- `regression/src/runner/build-deps.ts` — thread the real `CostTracker` into receipt-runner deps.
- `regression/src/runner/index.ts` — widen the orchestrator's inline `costTracker` stub type + fallback; synthesized dry-run/budget/env-failure `RunResult`s keep `{0,0}` (verify only).
- `regression/src/oracles/rubric.ts` — widen `costMeter` type; populate the `CallMeter` token fields from a delta (per-call accuracy; not aggregated by chatbot).

**Modified — docs:**
- `docs/urs.md` — update REQ-REG-013, REQ-REG-017; add REQ-REG-018; update the traceability matrix.
- `docs/open-items.md` — resolve/amend three items; add one follow-up.
- `docs/implementation-phases.md` — add a new dated section with the full batch breakdown.
- `CLAUDE.md` — add one Implementation Status bullet (per the Implementation Status Discipline rule).

**Tests (added to existing files):**
- `core/src/services/llm/__tests__/cost-tracker.test.ts`
- `regression/src/__tests__/dispatch.test.ts`, `routing-runner.test.ts`, `recall-runner.test.ts`, `chatbot-runner.test.ts`, the receipt-runner test file, and `build-deps.test.ts`
- `core/src/gui/__tests__/regression-routes.test.ts` (verify exact filename)
- the `looksLikeRunResult` test file (locate — likely `core/src/types/__tests__/regression.test.ts`)

No new test files are created; every new test lands in an existing suite.

---

## Pre-flight (execution setup)

- [ ] Create an isolated workspace: a feature branch (e.g. `feat/regression-token-metering`) or a git worktree via `superpowers:using-git-worktrees`. The repo's `require-feature-branch.sh` PreToolUse hook blocks Write/Edit on `main`.
- [ ] Copy this plan to the canonical location: `docs/superpowers/plans/2026-05-22-regression-token-metering.md`, and commit it (`docs: add regression token metering plan`).
- [ ] Confirm baseline green: `pnpm test`, `pnpm lint`, `pnpm build` all pass before starting.

---

## Batch 1 — CostTracker token-usage counter

**Goal:** `CostTracker` exposes `getTokenUsageTotals(): { input: number; output: number }`, a sanitized, process-local running counter incremented synchronously inside `record()`.

**Files:**
- Modify: `core/src/services/llm/cost-tracker.ts`
- Test: `core/src/services/llm/__tests__/cost-tracker.test.ts`

**Design (Finding 1 + Finding 2).** The counter is **process-local and monotonic**: it counts tokens seen by this `CostTracker` instance since construction. It is deliberately **not** persisted to `monthly-costs.yaml`, **not** restored on restart, **not** reset on month rollover, and **not** rebuilt from the usage log — only before/after *deltas* are consumed (by the regression harness), so the absolute value is irrelevant and persistence would be dead weight plus a YAML-schema migration. The name avoids "monthly" precisely because it makes no monthly guarantee. Provider-supplied token counts are **untrusted**: they are sanitized at the `record()` boundary so a malformed provider result cannot poison the counter *or* the cost estimate.

**Verified facts (re-confirm before editing):**
- `record()` calls its monthly-cache update **synchronously, before** the first `await` (the `appendEntry()` log write). The counter increment must sit in that same synchronous region so a before/after delta is consistent with cost.
- `record()` estimates cost from the token counts — so sanitizing tokens at the top of `record()` also protects the cost estimate (a NaN token count would otherwise produce a NaN cost).

**Implementation:**

Add a module-level helper:
```ts
/** Coerce an untrusted provider-supplied token count to a finite, non-negative integer. */
function safeTokenCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
```

Add two private fields:
```ts
private tokenUsageInput = 0;
private tokenUsageOutput = 0;
```

At the **top of `record()`**, sanitize once and use the sanitized values everywhere downstream (cost estimation, the logged row, and the counter):
```ts
const inTok = safeTokenCount(entry.inputTokens);
const outTok = safeTokenCount(entry.outputTokens);
// ...use inTok/outTok for estimateCallCost(), for the appended log row, and:
this.tokenUsageInput += inTok;   // synchronous — before the first await
this.tokenUsageOutput += outTok;
```

Add the public query:
```ts
/**
 * Process-local running token totals seen by this CostTracker instance.
 *
 * NOT a monthly figure: unlike `getMonthlyTotalCost()` this is never
 * persisted to `monthly-costs.yaml`, never restored on restart, and never
 * reset on month rollover. It exists so the regression harness can meter
 * per-call token usage as a before/after delta. Only deltas are meaningful;
 * the absolute value is process-lifetime arbitrary. Returns a fresh object.
 */
getTokenUsageTotals(): { input: number; output: number } {
  return { input: this.tokenUsageInput, output: this.tokenUsageOutput };
}
```

`updateMonthlyCache()`, `checkMonthRollover()`, and `rebuildFromLog()` are **not** touched — the counter is independent of the monthly cost machinery (Finding 5: there is therefore no new log-row parsing, and the column-shape concern does not apply to this change).

**Tests** — new `describe('token usage counter')` block in `cost-tracker.test.ts`. Covers the 7 categories: happy, edge, error, security, concurrency, state, configuration.

| # | Category | Test (`it` name) | Asserts |
|---|----------|------------------|---------|
| 1 | Happy | `getTokenUsageTotals is {input:0,output:0} on a fresh tracker` | initial state |
| 2 | Happy | `record() increments token totals by the entry's inputTokens/outputTokens` | single record, exact sums |
| 3 | Happy | `token totals accumulate across multiple record() calls` | 3 records, input/output summed independently |
| 4 | Timing | `token totals update synchronously even when the log write fails` | block the log write; assert **both** `getMonthlyTotalCost() > 0` and `getTokenUsageTotals().input > 0` (proves the increment precedes the fire-and-forget I/O) |
| 5 | Edge | `getTokenUsageTotals returns a fresh object each call` | mutate the first return; second return unaffected |
| 6 | Security | `record() coerces NaN / Infinity / -Infinity / negative token counts to 0` | table-driven; the counter stays finite and non-negative after each |
| 7 | Security | `record() with a NaN token count does not poison the cost estimate` | cost estimate stays finite (the same sanitized values feed `estimateCallCost`) |
| 8 | Config | `record() with a zero-token entry leaves token totals unchanged and finite` | `inputTokens:0, outputTokens:0`; no NaN |
| 9 | Concurrency | `concurrent record() calls sum token totals correctly` | `Promise.all` of 5 records; totals equal the arithmetic sum |
| 10 | State | `a freshly constructed CostTracker reports {0,0} after loadMonthlyCache()` | construct a new tracker, run `loadMonthlyCache()`; assert `getTokenUsageTotals()` is `{0,0}` — the counter is process-local and is **not** restored from YAML (locks the Finding-1 contract) |

**Steps:**
- [ ] Write tests 1–10 (RED). Run the file — verify each fails for the expected reason (`getTokenUsageTotals is not a function`, etc.).
- [ ] Implement `safeTokenCount()`, the two fields, the `record()` sanitization + increment, and `getTokenUsageTotals()` (GREEN).
- [ ] Run `cost-tracker.test.ts` — all green, output pristine. `pnpm lint`.
- [ ] Commit: `feat(cost-tracker): add sanitized process-local token-usage counter`.

---

## Batch 2 — Regression dispatch token metering

**Goal:** `meterCall()` and `buildRecallAdapter()` populate `CallMeter.tokenIn/tokenOut` from a `getTokenUsageTotals()` before/after delta, computed in `finally` so spend before a throw is preserved and surfaced. The project still typechecks after this batch.

**Files:**
- Modify: `regression/src/runner/dispatch.ts`
- Modify: `regression/src/runner/index.ts` (widen the orchestrator's inline `costTracker` stub type + fallback that feeds the adapters)
- Test: `regression/src/__tests__/dispatch.test.ts`

**Implementation:**

Extend `CostMeterSource`:
```ts
export interface CostMeterSource {
  getMonthlyTotalCost(): number;
  getTokenUsageTotals(): { input: number; output: number };
}
```

Add a non-negative, finite delta helper and a meter-carrying error:
```ts
/** Non-negative, finite delta. Guards a mis-reporting tracker. */
function safeDelta(after: number, before: number): number {
  const d = after - before;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Error carrying the CallMeter for spend that occurred before the throw. */
export class MeteredError extends Error {
  constructor(message: string, readonly meter: CallMeter) {
    super(message);
    this.name = 'MeteredError';
  }
}
```

Rework `meterCall()` so the meter is computed in `finally` and is available on **both** paths (Finding 3):
```ts
async function meterCall<T>(
  deps: BuildAdaptersDeps,
  tier: keyof TierModelSnapshot,
  fn: () => Promise<T>,
): Promise<{ value: T; meter: CallMeter }> {
  const costBefore = deps.costTracker.getMonthlyTotalCost();
  const tokBefore = deps.costTracker.getTokenUsageTotals();
  const buildMeter = (): CallMeter => {
    const model = deps.modelIds[tier];
    const tokAfter = deps.costTracker.getTokenUsageTotals();
    return {
      model: typeof model === 'string' ? model : 'unknown',
      tokenIn: safeDelta(tokAfter.input, tokBefore.input),
      tokenOut: safeDelta(tokAfter.output, tokBefore.output),
      costUsd: Math.max(0, deps.costTracker.getMonthlyTotalCost() - costBefore),
    };
  };
  try {
    const value = await fn();
    return { value, meter: buildMeter() };
  } catch (err) {
    throw new MeteredError(err instanceof Error ? err.message : String(err), buildMeter());
  }
}
```
Apply the same before/`finally`-after pattern in `buildRecallAdapter()`'s inline metering block; on a thrown classifier it likewise throws a `MeteredError` carrying the partial delta.

In the routing adapters, the `llm-error` branch currently throws a plain `Error` and **drops** the already-computed `meter`. Change those throws to `throw new MeteredError(message, meter)` so the runner can still count any spend. `ZERO_METER` stays `{ tokenIn: 0, tokenOut: 0 }` — it is intentionally the no-LLM-call meter for prefilter short-circuits.

Update the `dispatch.ts` header comment: remove "CostTracker has no per-call token surface… Token counts are best-effort 0"; replace with a line stating tokens are metered via the `getTokenUsageTotals()` delta (in `finally`, throw-resilient) under the same sequential-dispatch invariant as cost.

In `regression/src/runner/index.ts`, widen the orchestrator's inline `costTracker` type and fallback literal:
```ts
?? { getMonthlyTotalCost: () => 0, getTokenUsageTotals: () => ({ input: 0, output: 0 }) }
```
Update every `dispatch.test.ts` stub/helper (`fixedCostTracker`, `queuedCostTracker`) to satisfy the widened `CostMeterSource` (serve queued `{ cost, tokens }` pairs).

**Tests** — extend `dispatch.test.ts`:

| # | Category | Test | Asserts |
|---|----------|------|---------|
| 1 | Happy | `foodShadow adapter — meter reflects the before/after token delta` | tracker steps `{0,0}`→`{412,78}`; `meter.tokenIn===412`, `tokenOut===78` |
| 2 | Happy | `pas adapter LLM path populates meter token counts` | non-prefilter input; non-zero meter |
| 3 | Happy | `sessionControl NL path populates meter token counts` | NL phrasing hits the LLM; non-zero meter |
| 4 | Happy | `recall adapter LLM path populates meter token counts` | prefilter bypassed; delta `{300,45}` reflected |
| 5 | Edge | `sessionControl prefilter path yields ZERO_METER tokenIn/tokenOut=0` | `/newchat`; ZERO_METER override |
| 6 | Edge | `pas DATA_QUERY_PREFILTER short-circuit yields tokenIn/tokenOut=0` | prefilter message; no LLM call; delta naturally 0 |
| 7 | Edge | `recall adapter prefilter skip yields tokenIn/tokenOut=0` | short greeting; `recallPreFilter` skips |
| 8 | Security | `meterCall clamps a negative token delta to 0` | tracker reports `after < before`; `tokenIn===0` |
| 9 | Security | `meterCall produces finite token counts for a non-finite delta` | table-driven `NaN`/`Infinity`/`-Infinity`; result is 0 |
| 10 | Error | `meterCall throws MeteredError carrying the partial meter when fn() throws` | `fn()` throws after the tracker advanced `{50,10}`; caught error is a `MeteredError` with `meter.tokenIn===50` |
| 11 | Error | `meterCall throws MeteredError with a zero meter when fn() throws before any LLM call` | tracker did not advance; `meter.tokenIn===0` |
| 12 | Config | `provider with no usage object contributes 0 tokens` | tracker returns identical before/after; `tokenIn===0` while `costUsd` may be non-zero |

(Finding 6: no `Promise.all(meterCall)` concurrency test — the sequential-dispatch invariant is asserted at the runner level in Batch 3.)

**Steps:**
- [ ] Write tests 1–12 (RED). Verify each fails for the expected reason.
- [ ] Implement `CostMeterSource`, `safeDelta`, `MeteredError`, the `meterCall`/`buildRecallAdapter` rework, adapter `MeteredError` throws, header comment, `index.ts` widening, stub updates (GREEN).
- [ ] Run `dispatch.test.ts` green. Regression workspace typecheck — project compiles. `pnpm lint`.
- [ ] Commit: `feat(regression): meter throw-resilient token deltas in dispatch`.

---

## Batch 3 — Case-runner token propagation

**Goal:** All four buckets aggregate real token counts into `RunResult.tokenCounts`, counting spend that occurred before an error.

**Files:**
- Modify: `regression/src/runner/case-runners/routing-runner.ts`, `recall-runner.ts` — error-path catch reads `MeteredError.meter`.
- Modify: `regression/src/runner/case-runners/chatbot-runner.ts`, `receipt-runner.ts` — throw-resilient `try/finally` token deltas.
- Modify: `regression/src/runner/build-deps.ts` — thread the real `CostTracker` into receipt-runner deps.
- Modify: `regression/src/oracles/rubric.ts` — widen `costMeter`; populate the `CallMeter` token fields.
- Verify only: `regression/src/runner/index.ts` — synthesized dry-run / budget-exceeded / env-failure `RunResult`s keep `tokenCounts:{0,0}` (no LLM call happened; correct by construction).
- Tests: `routing-runner.test.ts`, `recall-runner.test.ts`, `chatbot-runner.test.ts`, the receipt-runner test file, `build-deps.test.ts`, and the `looksLikeRunResult` test file.

**Implementation:**

*routing-runner.ts / recall-runner.ts* — the success path already aggregates `r.meter.tokenIn/tokenOut` into `RunResult.tokenCounts`; confirm it. In the **catch** block that turns an infrastructure error into `verdict:'error'`, check `err instanceof MeteredError` and add `err.meter.tokenIn/tokenOut` so spend before the error is still counted. (No `costTracker` dep needed — the meter rides on the error.)

*chatbot-runner.ts* — currently hard-codes `tokenCounts: { input: 0, output: 0 }` and deltas only cost. Add **one** `getTokenUsageTotals()` before/after delta per turn, in a `try/finally` spanning `routeMessage` + `runRubricOracle`, so a `routeMessage` throw after recorded spend is still counted. Accumulate `tokenIn`/`tokenOut` across turns; set `tokenCounts: { input: tokenIn, output: tokenOut }`. **It does not also add `oracle.meter` token fields** — the single spanning delta already includes the judge call; adding the oracle meter would double-count (Finding 7). Widen `ChatbotRunnerDeps.costTracker` to the `CostMeterSource` shape.

*receipt-runner.ts* — replace the `tokenIn = 0 / tokenOut = 0` placeholders. Add `costTracker: CostMeterSource` to `ReceiptRunnerDeps`; bracket the `parseReceiptFromPhoto` call (and any continuation calls) in `try/finally` and add the `getTokenUsageTotals()` delta in `finally`. Accumulate across inputs. (Receipt's separate pre-existing *cost* faking via `estimateUsd` is intentionally left as-is — out of scope.)

*build-deps.ts* — pass the already-constructed real `CostTracker` into the receipt-runner deps (it satisfies `CostMeterSource` after Batch 1).

*rubric.ts* — `runRubricOracle` currently emits a `CallMeter` with `tokenIn/tokenOut: 0`. Widen `RubricOracleDeps.costMeter` to include `getTokenUsageTotals`; populate the meter's token fields from a before/after delta around the judge call. This keeps `runRubricOracle`'s own `CallMeter` honest for any caller that reads it; the chatbot runner deliberately ignores it (see above).

**Tests:**

`routing-runner.test.ts` — `describe('token propagation')`:
- Happy: `sums meter token counts into RunResult.tokenCounts` (single input, meter `{100,20}`).
- State: `multi-input routing case sums token counts across inputs` (3 inputs → `{300,60}`).
- Concurrency: `dispatches inputs sequentially so token deltas do not interleave` (call-order spy on the tracker; before/after pairs never interleave — the invariant REQ-REG-018 depends on).
- Error: `classifier error before any LLM call contributes 0 tokens for that input` (adapter throws `MeteredError` with a zero meter).
- Error: `classifier error after the tracker advanced still counts the spent tokens` (adapter throws `MeteredError{meter.tokenIn:80}` → that input contributes 80).
- Edge: `all-prefilter routing case yields tokenCounts {0,0}`.
- Edge: `budget-exceeded abort excludes unmetered inputs`.

`recall-runner.test.ts` — `describe('token propagation')`:
- Happy: `propagates adapter meter token counts into RunResult.tokenCounts`.
- State: `multi-input recall case sums token deltas` (input 1 prefilter-skip `{0,0}`, input 2 LLM `{200,40}` → `{200,40}`).
- Error: `recall classifier error after partial spend still counts the spent tokens` (`MeteredError` path).
- Edge: `observational input still contributes its token counts` (verdict stays `pass`, tokens counted).

`receipt-runner.test.ts` — `describe('token propagation')`:
- Happy: `records token counts from the CostTracker delta around parseReceiptFromPhoto`.
- State: `multi-input receipt case sums continuation-call token deltas` (`{1200,300}` + `{900,210}` → `{2100,510}`).
- Error: `parser throw before any LLM call contributes 0 tokens`.
- Error: `parser throw after the tracker advanced still counts the spent tokens` (delta read in `finally`).
- Edge: `budget-exceeded abort before dispatch contributes 0 tokens`.

`chatbot-runner.test.ts` — `describe('token propagation')`:
- Happy: `tokenCounts comes from one delta spanning route + oracle` — route advances `{100,20}`, judge advances `{30,10}`; assert `tokenCounts === {input:130, output:30}` **exactly once** (no double-count with `oracle.meter`) (Finding 7).
- State: `chatbot multi-turn case sums token counts across turns`.
- Error: `routeMessage throw before any LLM call contributes 0 tokens for that turn`.
- Error: `routeMessage throw after the tracker advanced still counts the spent tokens` (delta read in `finally`).
- Edge: `budget-exceeded abort yields partial token counts`.

`build-deps.test.ts` (Finding 4):
- Wiring: `production deps thread the same CostTracker instance into the receipt runner` — assert the receipt-runner deps' `costTracker` is the *same object reference* as the production `CostTracker`, not merely a structural stub.

`looksLikeRunResult` test file (Finding 9 — first locate it; check `evaluated-tier.test.ts` / cache-reader suites for existing coverage):
- Happy: `accepts a RunResult with non-zero tokenCounts` and `round-trips non-zero tokenCounts through JSON.stringify → parse → looksLikeRunResult` (always add — currently every fixture is `{0,0}`).
- Security: `rejects tokenCounts with NaN / Infinity / negative input or output` — add a table-driven test **only if** the existing suites do not already cover non-finite/negative `tokenCounts` rejection; if they do, note that and skip.

**Steps:**
- [ ] Write the runner, `build-deps`, and `looksLikeRunResult` tests (RED). Verify failures.
- [ ] Implement routing/recall catch handling, chatbot-runner, receipt-runner (+ `build-deps.ts` wiring), `rubric.ts` (GREEN).
- [ ] Run all four runner suites + `build-deps.test.ts` + the `looksLikeRunResult` suite green. Regression typecheck. `pnpm lint`.
- [ ] Commit: `feat(regression): propagate throw-resilient token counts into RunResult`.

---

## Batch 4 — Regression GUI token display

**Goal:** The compare table and the per-case drilldown show real token counts; the stale "plumbing pending" copy is gone. Tests fail independently for each surface (Finding 8).

**Files:**
- Modify: `core/src/gui/routes/regression.ts` — `DisplayedCase` + `buildDisplayedCase()`.
- Modify: `core/src/gui/views/partials/regression-tab-compare.eta` — `<th>Tokens</th>`; remove the footnote.
- Modify: `core/src/gui/views/partials/regression-case-row.eta` — token `<td>`.
- Modify: `core/src/gui/views/partials/regression-drilldown.eta` — replace the hard-coded `—` token row (~line 48).
- Test: `core/src/gui/__tests__/regression-routes.test.ts` (verify exact filename).

**Implementation:**
- `DisplayedCase` gains `tokensInput: string` and `tokensOutput: string`. `buildDisplayedCase()`: never-run branch → `'—'`; result branch → `String(result.tokenCounts.input)` / `.output`. Token values are numbers — format via `String(...)`, never raw-interpolate the `tokenCounts` object.
- Cached pre-change `RunResult`s carry `tokenCounts:{0,0}` (valid per `looksLikeRunResult`) → they render `0` until re-run. Correct and expected — no cache migration.
- Compare template: add a `Tokens` column header after `Cost`; **remove** the "not yet plumbed through `LLMService.complete()`" footnote.
- Case-row template: add a token `<td>`.
- Drilldown: `<dd>—<small> (plumbing pending…)</small></dd>` → real `N in / N out`, with `—` for never-run.

**Tests** — `regression-routes.test.ts`. Update the shared `tokenCounts` fixture from `{0,0}` to a non-zero value (e.g. `{input:412, output:78}`). Four independent assertions:

| Category | Test | Asserts (fails independently) |
|----------|------|-------------------------------|
| Happy | `compare table renders a Tokens column header` | the `<th>Tokens</th>` is present |
| Happy | `compare row renders per-case token counts` | the row cell shows `412` / `78` |
| Happy | `drilldown renders real input/output token counts when cache hit` | drilldown body shows `412 in / 78 out` |
| Config | `does not render the stale "not yet plumbed" token footnote` | body does **not** match `/not yet plumbed/i` (replaces the old footnote-presence test) |
| Edge | `drilldown renders — for token counts on a never-run case` | em-dash, no numbers |
| Edge | `drilldown renders 0 token counts distinctly from — for a ran case that used no tokens` | a real result with `{0,0}` renders `0`, not `—` |
| State | `server-rendered row reflects live token counts when ?runId= matches` | extend the existing live-row test with token assertions |
| Security | `token counts are numeric-formatted, not raw object interpolation` | rendered value is a number string, never `[object Object]` |

**Steps:**
- [ ] Write the GUI tests (RED). Verify failures.
- [ ] Implement `DisplayedCase`/`buildDisplayedCase` + the three templates (GREEN).
- [ ] Run the GUI route suite green. `pnpm lint`.
- [ ] Manual check: start the server, open `/gui/regression?view=compare`, trigger a small fresh routing run, confirm the Tokens column shows non-zero counts and the footnote is gone; open a drilldown and confirm `N in / N out`.
- [ ] Commit: `feat(gui): display real regression token counts`.

---

## Batch 5 — Documentation

**Goal:** Every doc surface matches reality — URS, traceability matrix, phase documentation, CLAUDE.md, open-items, and the estimator JSDoc.

**Files:** `docs/urs.md`, `docs/open-items.md`, `docs/implementation-phases.md`, `CLAUDE.md`, `core/src/gui/services/regression/estimator.ts`.

**5a — Estimator JSDoc** (mechanism-ready, defer numbers): leave `PER_CASE_USD_BY_BUCKET` values unchanged; rewrite the header JSDoc — remove "Recalibrate when LLMService usage plumbing lands"; state that `RunResult.tokenCounts` now carries real data (REQ-REG-018) and numeric recalibration is tracked as a follow-up open-item. No estimator test changes (constants unchanged → existing tests stay green; if a constants-snapshot doc test exists, confirm it still passes).

**5b — URS** (`docs/urs.md`):
- **REQ-REG-013** — drop the `(token counts as — — see open-items.md)` qualifier from `Status`; rewrite the description: token counts are real, sourced from `CostTracker.getTokenUsageTotals()` via the harness delta; best-effort (provider without `usage` → 0; all-prefilter case → 0, distinct from `—` = never-run). Replace the old `renders the token-counts footnote` test bullet with the Batch 4 tests (compare header, compare row, drilldown counts, 0-vs-—, footnote-absence).
- **REQ-REG-017** — note (dated 2026-05-22) that real token data now exists in `RunResult.tokenCounts`; constants remain documented approximations pending numeric recalibration (tracked in open-items). No status change.
- **NEW REQ-REG-018** — "The regression harness MUST meter per-call token usage and propagate it into `RunResult.tokenCounts`." Verify the next free `REQ-REG-NNN` number first. Full entry covering: `CostTracker.getTokenUsageTotals()` (process-local, sanitized via `safeTokenCount()`), the `meterCall`/runner deltas, throw-resilient metering (`MeteredError` + `finally`), the sequential-dispatch invariant, and the best-effort/0 semantics. Standard + Edge + Error + Security test bullets drawn from Batches 1–3 (exact `file.test.ts` > describe > it strings).
- **Traceability matrix** — update the REQ-REG-013 and REQ-REG-017 rows; insert a REQ-REG-018 row. **Recount Std/Edge mechanically from the final test files** — do not use arithmetic. Per the matrix's own scoping note, `regression/src/**` tests are excluded from the Totals row; only new `core/src/**` tests (in `cost-tracker.test.ts`, `regression-routes.test.ts`) affect Totals. No new test *files* are created, so the file count is unchanged — re-sum the Std/Edge/total columns from the final core files.

**5c — Phase documentation** (`docs/implementation-phases.md`): per the CLAUDE.md "Implementation Status Discipline" rule, add a **new dated section** (`### Regression Token Metering (2026-05-22)`) with the full batch-by-batch breakdown (Goal / Approach / Batch detail B1–B5 / Codex review round / Tests). This file is the canonical home for phase prose.

**5d — CLAUDE.md** (`CLAUDE.md`): add **one bullet** to the Implementation Status list — `**Regression Token Metering** (2026-05-22) — CostTracker process-local token counter + throw-resilient harness deltas surface real per-case token counts in RunResult + GUI; 1 new (REQ-REG-018) + 2 updated (REQ-REG-013/017) URS entries.` Do **not** add a "Current Priority" prose block. If the Implementation Status list now exceeds ~8 entries, demote the oldest bullet (its prose already lives in `docs/implementation-phases.md`).

**5e — open-items** (`docs/open-items.md`):
- "LLMService.complete usage plumbing" (Chunk B.2 carry-forwards) — **amend to "partially resolved (2026-05-22)"**: the regression consequences are closed via the `CostTracker` token counter (REQ-REG-018); REQ-REG-013 displays real counts. Explicitly note `LLMService.complete()` was **not** changed, and per-*step* metering for the T1 tool-calling substrate remains a separate T1 work item.
- "`RunResult.tokenCounts` hardcoded to `{input: 0, output: 0}`" — **close (2026-05-22)**: resolved via `CostTracker.getTokenUsageTotals()`; all four runners propagate real counts.
- "Regression GUI estimator constants are approximations (2026-05-11)" (Accepted Design) — **amend**: real token data now exists; constants kept as approximations by design; a follow-up tracks numeric recalibration.
- **Add a new follow-up item** (Deferred Infrastructure Work): "Numeric recalibration of regression estimator constants — recompute `PER_CASE_USD_BY_BUCKET` from observed `RunResult.tokenCounts` after a fresh full-suite run; mechanism ready as of 2026-05-22 (REQ-REG-018)."

**Steps:**
- [ ] Edit `estimator.ts` JSDoc; run its test suite (still green). `pnpm lint`.
- [ ] Update REQ-REG-013/017; add REQ-REG-018; update the traceability matrix (recount from files).
- [ ] Add the `docs/implementation-phases.md` dated section.
- [ ] Add the CLAUDE.md Implementation Status bullet (one line; demote oldest if needed).
- [ ] Edit `docs/open-items.md` — three amendments + one new item.
- [ ] Commit: `docs(regression): close token-metering open-items; URS REQ-REG-018; phase docs`.

---

## Persona / regression-suite testing note

The `persona-test` skill generates Telegram natural-language tests for **apps** (`apps/<app-id>/src/__tests__/natural-language.test.ts`, driven by an app `manifest.yaml`). This change is **core infrastructure** — `CostTracker`, the regression harness, and the GUI — with no Telegram app surface, so a classic natural-language persona-test file is not applicable and is intentionally **not** created.

The relevant "persona" coverage already exists: the **Persona Regression Suite** fixtures (routing / recall / receipt / chatbot cases) are the persona inputs. This change adds *measurement*, not behavior — `tokenCounts` is not part of `computeCacheKey`, so every existing fixture is unchanged and simply gains real token numbers in its `RunResult`. No new fixtures are required.

One verification task during execution: grep `core/src/gui/__tests__/` and the regression cache fixtures for any committed `RunResult` JSON asserted via exact deep-equal with `tokenCounts:{0,0}` baked in — update those to non-zero or exclude `tokenCounts` from the deep-equal. The operator-facing behavior change ("an operator opens a case drilldown and sees real token counts, not `—`") is covered by the Batch 4 GUI tests plus the Batch 4 manual check.

## Test coverage — 7-category checklist (pas-testing-standards)

Applied across Batches 1–4: **happy path** (counter, delta, propagation, render), **edge cases** (prefilter → 0, multi-call sums, fresh-object copy, 0-vs-—), **error handling** (throw-before-LLM → 0, throw-after-spend → counted, `MeteredError` plumbing), **security / trust boundary** (provider `usage` is untrusted → `safeTokenCount` at the `record()` boundary; `safeDelta` clamps; `looksLikeRunResult` fails closed; numeric-only GUI render), **concurrency / timing** (`Promise.all` record summation; synchronous-increment-before-I/O test; runner sequential-dispatch assertion), **state transitions** (multi-input/multi-turn accumulation; process-local restart semantics), **configuration** (zero-token / no-`usage` provider). Contract tests keep `CostMeterSource`, the URS text, the GUI copy, and the production wiring (`build-deps.test.ts`) synchronized with runtime behavior.

## Verification (end-to-end)

Run from repo root `/Users/mdittler/Projects/personal-automation-system`:
1. `pnpm lint` — zero errors.
2. `pnpm build` — both workspaces compile (typecheck clean).
3. `pnpm test` — full suite green, zero failures, output pristine. (Scoped inner-loop during development: run the specific `*.test.ts` files per batch.)
4. **Manual GUI check:** start the server; open `/gui/regression?view=compare`; trigger a small fresh run (routing bucket, "force fresh"); confirm the new Tokens column shows non-zero counts and the "plumbing pending" footnote is gone; open a case drilldown and confirm `N in / N out`; confirm a never-run case still shows `—` and a cached pre-change case shows `0` without error.
5. **Cache cross-check:** pick one freshly-run case; its `data/system/regression-cache/<case-id>/<key>.json` should show non-zero `tokenCounts` roughly proportional to `costUsd`.

## Codex review / risk checklist

- **No `LLMService` change** — confirm the diff touches `CostTracker`, `dispatch.ts`, the four runners, `rubric.ts`, `build-deps.ts`, the GUI route + 3 templates, `estimator.ts` JSDoc, and docs only.
- **Honest token API** — `getTokenUsageTotals()` is process-local; never claim it is monthly or persisted (Finding 1).
- **Trust boundary** — provider `usage` is sanitized at the `record()` boundary by `safeTokenCount()`; a NaN token count must not poison the counter *or* the cost estimate (Finding 2).
- **Throw-resilient metering** — tokens spent before a parser/router/classifier throw are counted via `MeteredError` (routing/recall) and `try/finally` (receipt/chatbot) (Finding 3). Error tests must cover both "throws before any LLM → 0" and "throws after spend → counted".
- **No double-count** — chatbot `tokenCounts` is one delta spanning route + oracle; `oracle.meter` token fields are not added on top (Finding 7).
- **Production wiring** — `build-deps.test.ts` proves the receipt runner gets the real `CostTracker` instance (Finding 4).
- **Sequential-dispatch invariant** — the delta is correct only under serial dispatch; asserted by a runner call-order test (Finding 6).

## Execution

Per project convention (subagent-driven, continuous batch execution, single end-of-chunk review):
1. Execute via `superpowers:subagent-driven-development` — a fresh subagent per batch (B1 → B5), each batch TDD-first, each ending in its own commit. Roll through all batches without pausing.
2. One Codex review at the end of the chunk; apply corrections in-place with a change table.
3. Finish via `superpowers:finishing-a-development-branch` (PR to `main`).

## Self-review (writing-plans checklist)

- **Spec coverage:** every consequence in the open-items entry maps to a batch — token surface (B1), harness delta (B2), `RunResult.tokenCounts` (B3), GUI `—` (B4), URS/matrix/phase-doc/CLAUDE.md/open-items/estimator (B5). All 9 Codex findings + the documentation directive map to a row in the change table above. T1 is explicitly out of scope.
- **Placeholders:** none — every batch names exact files, signatures, and test `it`-names with assertions.
- **Type consistency:** `getTokenUsageTotals(): {input,output}`, `CostMeterSource`, `MeteredError`, `safeDelta`, and `safeTokenCount` are referenced identically across B1→B2→B3; `tokenCounts` field name matches `RunResult` throughout.
