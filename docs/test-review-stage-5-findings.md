# Stage 5 Test Review Findings

Date: 2026-04-24
Stage: 5 - Core LLM, Routing, Query, and Edit Flows
Status: Remediated

## Scope

This stage reviewed the LLM, router, data-query, interaction-context, edit, and chatbot test areas under:

- `core/src/services/llm`
- `core/src/services/router`
- `core/src/services/data-query`
- `core/src/services/interaction-context`
- `core/src/services/edit`
- `apps/chatbot/src/__tests__`

The review goal was to judge whether the Stage 5 tests protect real routing, prompt framing, guard enforcement, context-aware behavior, and edit-flow correctness without becoming too brittle or too dependent on internal string shape.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `test_strategy_summary.md`
- `docs/urs.md`
- `docs/uat-checklist.md`
- `docs/open-items.md`
- `docs/codebase-review-findings.md`
- `docs/superpowers/specs/2026-04-08-route-verification-design.md`
- `docs/superpowers/specs/2026-04-14-d2c-interaction-context-and-edit-design.md`

Key URS areas for this stage:

- `REQ-LLM-001`, `REQ-LLM-008`, `REQ-LLM-009`, `REQ-LLM-010`, `REQ-LLM-011`, `REQ-LLM-015`, `REQ-LLM-016`, `REQ-LLM-017`, `REQ-LLM-018`, `REQ-LLM-019`, `REQ-LLM-023`, `REQ-LLM-025`, `REQ-LLM-026`, `REQ-LLM-027`, `REQ-LLM-029`
- `REQ-ROUTE-001`, `REQ-ROUTE-002`, `REQ-ROUTE-004`, `REQ-ROUTE-005`, `REQ-ROUTE-006`, `REQ-ROUTE-007`
- `REQ-CHATBOT-001`, `REQ-CHATBOT-002`, `REQ-CHATBOT-004`, `REQ-CHATBOT-005`, `REQ-CHATBOT-007`, `REQ-CHATBOT-008`, `REQ-CHATBOT-009`, `REQ-CHATBOT-012`, `REQ-CHATBOT-013`, `REQ-CHATBOT-016`, `REQ-CHATBOT-017`
- `REQ-DATAQUERY-001`, `REQ-DATAQUERY-002`, `REQ-DATAQUERY-003`, `REQ-DATAQUERY-004`
- `REQ-IC-001`, `REQ-IC-002`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 5 coverage today is:

- `core/src/services/router/__tests__/router.test.ts`, `router-verification.test.ts`, `route-verifier.test.ts`, and `context-promotion.test.ts`
  These are the best router suites for verifier routing, disabled-app rejection, route metadata, low-confidence promotion, and authorization after route changes.
- `core/src/services/data-query/__tests__/data-query.test.ts` and `context-hints.test.ts`
  Good direct protection for scope filtering, hostile LLM output validation, prompt-injection framing, path hardening, and recent-file hint handling inside `DataQueryService`.
- `core/src/services/interaction-context/__tests__/interaction-context.test.ts`, `integration.test.ts`, and `persistence.test.ts`
  Good evidence for TTL pruning, per-user isolation, debounce/drain behavior, and persistence/reload handling.
- `core/src/services/edit/__tests__/edit.test.ts`
  Strong direct coverage for stale-write protection, symlink escape blocking, manifest write-scope enforcement, household boundaries, confirm serialization, and `proposalId` supersession.
- `core/src/services/llm/__tests__/llm-guard.test.ts`, `system-llm-guard.test.ts`, and `cost-tracker.test.ts`
  Good component-level coverage for app/global/household caps, reservation lifecycle, attribution, and accumulated-cost accounting.
- `apps/chatbot/src/__tests__/data-query-wiring.test.ts`, `context-injection.test.ts`, `pas-classifier.test.ts`, and the system-data parts of `chatbot.test.ts`
  These are the most useful chatbot-side tests for YES_DATA routing, PAS classification, context injection, system-question shaping, and model-switch guardrails.

## Findings

### 1. Context-aware `/edit` discovery is still missing in the implementation, and the Stage 5 tests do not catch it

- Severity: high
- Type: spec/runtime mismatch plus cross-service coverage gap
- Code references:
  - `docs/superpowers/specs/2026-04-14-d2c-interaction-context-and-edit-design.md:81-88`
  - `docs/superpowers/specs/2026-04-14-d2c-interaction-context-and-edit-design.md:189-190`
  - `core/src/services/data-query/index.ts:76-88`
  - `core/src/services/data-query/index.ts:170-202`
  - `core/src/services/data-query/index.ts:235-236`
  - `core/src/services/edit/index.ts:94-103`
  - `core/src/services/edit/index.ts:122-130`
  - `core/src/services/edit/index.ts:144-146`
- Test references:
  - `core/src/services/data-query/__tests__/context-hints.test.ts:230-239`
  - `core/src/services/data-query/__tests__/context-hints.test.ts:245-278`
  - `core/src/services/data-query/__tests__/context-hints.test.ts:333-343`
  - `core/src/services/edit/__tests__/edit.test.ts:113-116`
  - `core/src/services/edit/__tests__/edit.test.ts:136-177`
  - `apps/chatbot/src/__tests__/edit-command.test.ts:49-53`
  - `apps/chatbot/src/__tests__/edit-command.test.ts:116-126`

The D2c spec explicitly says `EditService` should call `DataQueryService.query(description, userId)` with interaction-context hints so recent authorized files are preferentially considered during `/edit` discovery. `DataQueryService` already implements that behavior through `options.recentFilePaths`, including the no-auth-bypass and priority-label logic. But `EditServiceImpl` has no `interactionContext` dependency at all and still calls `this.dataQueryService.query(description, userId)` with only two arguments.

That means the intended context-aware edit flow is not just untested; it is currently absent. The nearby tests split the behavior apart rather than protecting the real contract: `context-hints.test.ts` proves `DataQueryService` can use recent-file hints, while `edit.test.ts` only mocks `query()` as a two-argument black box, and the chatbot `/edit` tests stub `interactionContext` as `{}` without asserting any recent-file handoff. A regression-free Stage 5 should include at least one end-to-end edit test where recent interaction history biases `/edit` toward the intended authorized file.

### 2. Model-priced reservation sizing is supported inside the guards but still unprotected in the assembled runtime

- Severity: medium
- Type: production-wiring coverage gap
- Code references:
  - `core/src/services/llm/llm-guard.ts:60-63`
  - `core/src/services/llm/llm-guard.ts:76-88`
  - `core/src/services/llm/llm-guard.ts:155-160`
  - `core/src/services/llm/llm-guard.ts:217-244`
  - `core/src/services/llm/system-llm-guard.ts:47-50`
  - `core/src/services/llm/system-llm-guard.ts:60-76`
  - `core/src/services/llm/system-llm-guard.ts:112-116`
  - `core/src/services/llm/system-llm-guard.ts:151-157`
  - `core/src/compose-runtime.ts:323-341`
  - `core/src/compose-runtime.ts:611-626`
- Test references:
  - `core/src/__tests__/llm-household-governance.integration.test.ts:1-5`
  - `core/src/__tests__/llm-household-governance.integration.test.ts:35-42`
  - `core/src/__tests__/llm-household-governance.integration.test.ts:66-79`
  - `core/src/__tests__/compose-runtime.smoke.integration.test.ts:59-96`

Both `LLMGuard` and `SystemLLMGuard` support `priceLookup` and `tier` inputs so reservation estimates can scale with actual model pricing instead of falling back to the flat `DEFAULT_LLM_SAFEGUARDS.defaultReservationUsd`. But `composeRuntime()` still constructs the app, system, and API guards without passing either value. So the production assembly continues to use the flat fallback even though the guard layer already supports model-aware estimates.

The test shape does not protect this seam. The strongest household-governance integration test explicitly says it hand-wires the components without going through `composeRuntime()`, and its own base config uses a flat `defaultReservationUsd`. The `composeRuntime` smoke test proves routing can record usage, but it never asserts reservation size, tier sensitivity, or pricing-adapter injection. This is the same unresolved runtime seam already called out in `docs/open-items.md`, and Stage 5 still lacks the integration test that would catch it.

## Transitional Or Lower-Trust Coverage To Treat Carefully

- `core/src/services/edit/__tests__/bootstrap-wiring.test.ts:19-24` and `:47-70` plus `core/src/services/interaction-context/__tests__/bootstrap-wiring.test.ts:28-32` and `:61-91` are source-scan wiring tests. They are useful refactor tripwires, but they are weak evidence of real runtime composition because they only assert that `compose-runtime.ts` contains certain strings and simulated `declaredServices.has(...)` branches.
- The prompt-heavy chatbot suites contain a lot of literal copy assertions, especially `apps/chatbot/src/__tests__/chatbot.test.ts:338-370`, `:747-769`, and `:1643-1663`, plus `apps/chatbot/src/__tests__/natural-language.test.ts:84-105` and `apps/chatbot/src/__tests__/user-persona.test.ts:146-175`. Some of these are valuable for security framing, but many are guarding branding or prose rather than the higher-level behavior. They are likely to create noisy failures during harmless prompt wording changes.
- `core/src/services/router/__tests__/realistic-verification.test.ts` remains valuable as a prompt-shaping smoke test, but many of its assertions are necessarily prompt-text-oriented, so it should not be treated as the sole evidence for routing correctness when a smaller behavior-level test could exist.

## Stage 5 Remediation Completed (2026-04-24)

- `EditServiceImpl` now receives the shared `InteractionContextService`, flattens `getRecent(userId)` file paths in newest-first order, dedupes by first occurrence, and forwards authorized `recentFilePaths` hints to `DataQueryService.query(...)`.
- `composeRuntime()` now injects a live `PriceLookup` into app, system, and API guards. The lookup reads the active tier assignment from `ModelSelector` on every call, converts per-million model pricing to the guard's per-1k format, and returns zero-cost pricing for Ollama-backed tiers.
- `LLMGuard` and `SystemLLMGuard` now estimate `complete()` reservations with `options.tier` when present, falling back to the guard default tier only when omitted. `classify()` and `extractStructured()` remain fast-tier estimates.
- Behavioral coverage now exists at the right seams:
  - `core/src/services/edit/__tests__/edit.test.ts` asserts the exact deduped `recentFilePaths` handoff.
  - `core/src/__tests__/compose-runtime.smoke.integration.test.ts` proves fast-vs-standard reservation sizing in the composed runtime, proves app-owned chatbot calls reserve priced amounts rather than the flat fallback, and proves a poisoned cross-user recent-path hint cannot steer `/edit` into another user's file.
  - `core/src/services/llm/__tests__/llm-guard.test.ts` and `system-llm-guard.test.ts` pin the per-call tier override behavior directly.
- The most copy-coupled chatbot prompt tests now share semantic helpers from `apps/chatbot/src/__tests__/helpers/prompt-assertions.ts`, reducing brittleness while preserving exact assertions for security-sensitive prompt/data shaping.

## Stage 5 Exit Decision

Stage 5 is complete.

The strongest coverage in this stage is around router verification, data-query trust boundaries, interaction-context persistence, context-aware `/edit`, composed-runtime guard pricing, edit confirm safety, and component-level LLM guard logic. The original Stage 5 follow-ups are now closed.
