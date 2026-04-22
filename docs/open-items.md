# Open Items

All outstanding work, deferred phases, corrections, and proposals in one place.
User manual actions are tracked separately in `user_actions.md`.

---

## Confirmed Phases (need planning before implementation)

These are greenlit but not yet planned. Each needs a spec/plan before coding.

- **D5c** ⬅ **ACTIVE PRIORITY** — Per-household LLM cost caps + rate limits + ops dashboard + 40-user load test. Chunk A complete ✓, Chunk B complete ✓ — Chunk C is next. Plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`. One chunk per session; Claude+Codex review between each. Does NOT depend on §1 or §4 below.
- **LLM Enhancement #2** — Replace Food's regex router with a fast structured classifier. Plan: `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`.
- **LLM Enhancements #3–#7** — Ambiguous extraction via LLM, DataQuery keyword gate removal, chatbot system-data categorization, knowledge reranker, photo caption confidence routing. Same plan.
- **Phase H12c** — Alcohol + Meal Quality Signals. Deferred pending H12a stabilization.
- **Phase 27C** — CrossAppDataService + LinkResolver: read-only cross-app file access. Deferred until a concrete use case requires it.

---

## Deferred Infrastructure Work

Confirmed gaps that need to be addressed; timing depends on which phase picks them up.

- **D5a §1 — `forShared(scope)` path segment** — `forShared()` ignores its scope argument. Fixing requires migrating ~30+ food callsites + existing shared files. Target: D5c or later. Search `forShared(` in `core/` and `apps/`.
- **D5a §4 — Collaboration space UX** — `kind: 'collaboration'` is fully modeled but no production code creates one. Add `SpaceService.createCollaboration()`, admin command `/collab create`, GUI screen. Do NOT weaken isolation tests. Target: post-D5c.
- **One-off task user scope** — `OneOffTask` has no `user_scope` field; all tasks run as `userScope: 'system'`. Apps needing per-user one-off tasks need the schema extended + bootstrap wiring.
- **Per-space scheduled jobs** — Space-scoped apps have no way to register scheduled jobs that run per-space. Needs scheduler support. (From `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`.)

---

## Unfinished Corrections

Known issues or cleanup items that should be addressed in a near-term session.

- **Energy/mood field removal** — Remove `energyLevel` and `mood` from `HealthDailyMetricsPayload` and the correlator table columns (`energy_1_10`, `mood_1_10`). The `isHealthCorrelationIntent` biometric exclusion regex already excludes these terms. Do this when next touching the health correlator.
- **`isPasRelevant()` deprecation** — Function is deprecated (not removed) in `apps/chatbot/src/index.ts`. Its backward-compat tests remain. Remove the function and its tests once confirmed no callers remain.
- **Finding 21 — broader Telegram Markdown normalization** — Inline handler messages, budget reporter, household, hosting planner, and cook-mode all send dynamic content without escaping. Phase F9 deferred these to Finding 21. (See `docs/superpowers/specs/2026-04-11-f9-telegram-markdown-escaping-design.md` line 69.)
- **Phase 26 URS requirement descriptions** — REQ-API-007 through REQ-API-013 have placeholder descriptions in `docs/urs.md`. Full descriptions were deferred to a future URS update session.
- **Provider integration tests** — `GoogleProvider`, `OpenAICompatibleProvider`, and `OllamaProvider` lack dedicated integration tests (REQ-LLM-021). Blocked on API keys being available. Once keys exist, add tests alongside `AnthropicProvider`'s test pattern.
- **D5c-review F3 — bootstrap pricing not wired into guards** — `bootstrap.ts:208,493` constructs `LLMGuard` and `SystemLLMGuard` without `priceLookup` or resolved `tier`. Both guards fall back to `DEFAULT_LLM_SAFEGUARDS.defaultReservationUsd` (a flat default). Reservations are therefore flat rather than proportional to model pricing. Fix: inject a `PriceLookup` adapter (from `ModelCatalog` pricing) and the resolved tier at bootstrap. Add an integration test asserting reservation size scales with model/tier. Deferred because the flat default is functional and the fix requires `ModelCatalog` pricing integration work.
- **D5c-review — `revokeLastCheckCommit()` not request-specific under concurrency** — `HouseholdLLMLimiter.revokeLastCheckCommit()` calls `rl.revokeLastCommit(householdId!)` which pops the *last* timestamp. Under concurrent callers at the same `await` point (currently not possible since `reserveEstimated` is sync), rollback could revoke the wrong slot. Low risk today; fix if `reserveEstimated` is ever made async. Consider returning a per-commit handle from `check()` instead of popping last.
- **D5c Chunk E — rewire `multi-household-isolation.integration.test.ts` to composeRuntime.** The existing 717-line integration test hand-wires ~11 services at the data-layer slice with no LLM/Router path. Rewiring to `composeRuntime()` would drag it through the full service graph with no current motivation. Defer until a future food-app phase expands the test's scope to require LLM.
- **D5c Chunk E — `composeRuntime({ config })` configPath footgun.** When `config` is overridden but `configPath` is not, `UserMutationService` defaults to the real `config/pas.yaml` and will write-back on invite redemption or user mutation. Current test callers (smoke + load-test) always pass `seed.configPath`, so no one is burned today. Future fix: either require `configPath` when `config` is provided, or derive a temp path automatically. See comment at `compose-runtime.ts` line 182.
- **D5c Chunk E — chatbot `natural-language.test.ts` assertion brittleness.** Several tests assert on exact prompt substrings and internal call structure. Small prompt-copy refactors could create noisy failures. Future improvement: extract `'PAS-aware path chosen'` / `'basic prompt chosen'` helper assertions so the suite stays expressive without being brittle.

---

## Food App Enhancements

Feature work identified in H6 spec (`docs/superpowers/specs/2026-04-02-food-h6-design.md`) but deferred.

- **Waste reporting** — `/waste` command with monthly summary of wasted items and estimated cost.
- **Meal plan awareness** — Suggest meals based on leftovers and freezer inventory.
- **Nutrition tracking for waste** — Attribute nutritional/cost loss to wasted food entries.

---

## Proposals (unconfirmed — implement when triggered)

Ideas that are not yet approved. Each has a stated trigger condition.

- **Fitness/Health app** — Subjective signals (energy, mood, wearables) belong in a dedicated app. Food's `HealthDailyMetricsPayload` intentionally omits these; a future fitness app should emit `health:daily-metrics` events.
- **Full Telegram data access audit** — Each new app phase should verify read + correct NL intents for all stored data. Several food stores still lack this (price store, receipt items, health metrics).
- **App registry/marketplace** — Static JSON index + GUI browse page. Trigger: 10+ apps exist.
- **App signing** — Cryptographic verification for reviewed apps. Trigger: community review process established.
- **Container isolation** — Trigger: community forms and multi-tenant security requirements harden.
- **Smart freeze suitability** — Warn when foods that don't freeze well are being frozen. (H6 spec.)
- **Batch expiry estimation** — Estimate multiple pantry items in one LLM call instead of per-item. (H6 spec.)
- **Agentic loops** — 6 agent proposals (Routing-Learning, Data Steward, Receipt/OCR QA, Household Planning, Ops, App Onboarding). See `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`.

---

## Accepted Risks (no action needed)

Documented decisions to live with known imperfections.

- **D40** — `getActiveSpace()` fire-and-forget persist. Acceptable: self-healing on next request.
- **D42** — Conversation history anti-instruction framing removed. Accepted: continuity > theoretical injection risk.
