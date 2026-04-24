# Open Items

All outstanding work, deferred phases, corrections, and proposals in one place.
User manual actions are tracked separately in `user_actions.md`.

---

## Confirmed Phases (need planning before implementation)

These are greenlit but not yet planned. Each needs a spec/plan before coding.

- **D5c** — Per-household LLM cost caps + rate limits + ops dashboard + 40-user load test. All chunks (0–E) complete ✓. Plan: `docs/superpowers/plans/2026-04-20-d5c-per-household-governance.md`.
- **LLM Enhancement #2** — Replace Food's regex router with a fast structured classifier. Plan: `docs/superpowers/plans/2026-04-15-llm-enhancement-opportunities.md`.
- **LLM Enhancements #3–#7** — Ambiguous extraction via LLM, DataQuery keyword gate removal, chatbot system-data categorization, knowledge reranker, photo caption confidence routing. Same plan.
- **Phase H12c** — Alcohol + Meal Quality Signals. Deferred pending H12a stabilization.
- **Phase 27C** — CrossAppDataService + LinkResolver: read-only cross-app file access. Deferred until a concrete use case requires it.

---

## Planned Review Work

Cross-cutting review work that should happen in staged sessions before any cleanup or backfill implementation begins.

- **Staged test/spec coverage review** — Review-only effort to assess whether repo-local tests cover intended behavior, use meaningful assertions, avoid brittle or over-mocked patterns, and identify obsolete or superseded tests. Run this across multiple sessions by stage using `docs/test-review-roadmap.md`.

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
- **Stage 3 review follow-up — downstream user cleanup policy** — Decide whether `UserMutationService.removeUser()` should also scrub downstream shared state such as space memberships, active-space records, and household admin references. The smaller rollback/sync fixes from Stage 3 are complete; this broader cross-service cleanup question remains open.
- **Finding 21 — broader Telegram Markdown normalization** — Inline handler messages, budget reporter, household, hosting planner, and cook-mode all send dynamic content without escaping. Phase F9 deferred these to Finding 21. (See `docs/superpowers/specs/2026-04-11-f9-telegram-markdown-escaping-design.md` line 69.)
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
- **Shadow-primary persona sweep (collapsed-bucket overlap)** — Before flipping `routing_primary: shadow` in production, run targeted integration tests for the high-risk many-to-one bucket overlap phrases: freezer-vs-pantry (`add soup to the freezer` vs `add soup to the pantry`), leftover-view-vs-add (`show me my leftovers` vs `just finished the leftover chili`), grocery-generate-vs-view, edit-vs-save recipe, recipe-photo-vs-search, meal-plan generate-vs-view-vs-swap. Each phrase pair verifies the correct sub-dispatch closure fires. NOT one test per FOOD_PERSONAS persona — target the overlap boundaries only. Trigger: ≥95% telemetry agreement reached and production flip is being prepared.

---

## Accepted Risks (no action needed)

Documented decisions to live with known imperfections.

- **D40** — `getActiveSpace()` fire-and-forget persist. Acceptable: self-healing on next request.
- **D42** — Conversation history anti-instruction framing removed. Accepted: continuity > theoretical injection risk.

---

## LLM Enhancement #2 — Chunk A follow-up (deferred from 2026-04-22)

The following items are out of scope for Chunk A but must be addressed in future sessions:

| Chunk | Scope | Why deferred |
|---|---|---|
| A.1 — Allowlist: 'save a recipe' | Add `'user wants to save a recipe'` back to ROUTE_HANDLERS once `handleEditRecipe` is declared as a manifest intent. Currently removed because phrases like "edit the lasagna recipe" classify as save-intent, causing misrouting. The overlap vanishes once both recipe-save and recipe-edit are manifest-declared with distinct intents. | Overlaps with `handleEditRecipe` — violates strict 1:1 mapping criterion. |
| A.1 — Allowlist: 'search for a recipe' | Add `'user wants to search for a recipe'` back to ROUTE_HANDLERS once `handleRecipePhotoRetrieval` is declared as a manifest intent. Currently removed because phrases like "show me the recipe photo for X" classify as search-intent. | Overlaps with `handleRecipePhotoRetrieval` — violates strict 1:1 mapping criterion. |
| A.2 — Expand allowlist | Cover more manifest intents after auditing each for regex-branch collision. Likely adds pantry/grocery/leftovers/nutrition after manifest expansion or disambiguation. | Needs design decisions on ambiguous multi-sub-intent cases first. |
| B — Food-local fast-tier shadow classifier | `apps/food/src/routing/shadow-classifier.ts` — returns {action, confidence} over Food's internal action taxonomy. Runs in parallel with regex cascade; log-only. | **Complete (2026-04-22).** |
| C — Shadow integration | Wire `FoodShadowClassifier` + `FoodShadowLogger` into `handleMessage`; `computeVerdict`; `shadow_sample_rate` config; skipped-* gates for all early-exit paths. | **Complete (2026-04-22).** |
| D — Switchover | Promote shadow classifier to primary once `shadow-classifier-log.md` shows ≥95% agreement over ≥1 week of real usage. After switchover, remove regex cascade or demote to fallback. | **Complete (2026-04-23).** Shadow-primary machinery (`routing_primary` flag, `SHADOW_HANDLERS` table, `shadow_min_confidence` threshold, result reuse) + telemetry CLI (`pnpm analyze-shadow-log`) shipped. Production flip is a one-line config decision gated on ≥95% telemetry. Regex cascade remains as fallback. |
| Per-handler `is*Intent` classifiers | `apps/food/src/handlers/{budget,hosting,cultural-calendar-handler,health,nutrition,family}.ts` + `apps/food/src/services/price-store.ts`. | Many bypassed automatically when their manifest intent enters the allowlist. Remainder serve non-manifest sub-intents — stay as fallback. |
| Chatbot `MODEL_SWITCH_INTENT_REGEX` | `apps/chatbot/src/index.ts:78`. Same route-first pattern applied to chatbot. | Same approach, different app — straightforward follow-up. |
| Entity/slot extraction | Grocery items, quantities, stores, days, portions via `llm.extractStructured`. | User said classification only this session. |
