# Stage 7 Test Review Findings

Date: 2026-04-23
Stage: 7 - Food App Foundations
Status: Completed

## Scope

This stage reviewed the food-app foundational routing, service, utility, and shared-plumbing test areas under:

- `apps/food/src/routing`
- `apps/food/src/services`
- `apps/food/src/utils`
- Foundational food store and plumbing tests under `apps/food/src/__tests__`

The review goal was to judge whether the Stage 7 tests protect the real food-foundation contracts around routing labels, store paths, shared-vs-user boundaries, household gating, normalization, and interaction recording, rather than only checking helper behavior in isolation.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `test_strategy_summary.md`
- `apps/food/docs/requirements.md`
- `apps/food/docs/urs.md`
- `apps/food/manifest.yaml`
- `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 7 coverage today is:

- `apps/food/src/routing/__tests__/shadow-taxonomy.test.ts`, `shadow-handlers-parity.test.ts`, and `dispatch.test.ts`
  Good protection for routing label inventory, handler parity, and core dispatch helper behavior. `shadow-taxonomy.test.ts` also sanity-checks that manifest message intents stay aligned with routing labels.
- `apps/food/src/__tests__/pantry-store.test.ts`, `ingredient-normalizer.test.ts`, `grocery-store.test.ts`, and `recipe-store.test.ts`
  Strong local coverage for pantry parsing, ingredient canonicalization, grocery persistence paths, recipe serialization, and frontmatter/entity-key enrichment.
- `apps/food/src/__tests__/file-mutex-integration.test.ts`
  High-value concurrency coverage for grocery, pantry, waste, and multi-lock behavior. This is one of the better "real behavior over mocks" tests in the food suite.
- `apps/food/src/__tests__/household-guard.test.ts` and `household.test.ts`
  Useful baseline protection for household membership rules and shared-store household loading, even though the newer space-aware path is still uncovered.

## Findings

### 1. The space-aware food-store contract is still unprotected, and foundational tests still encode shared-only assumptions

- Severity: high
- Type: shared-vs-space data contract gap plus test corpus drift
- Code references:
  - `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md:58-99`
  - `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md:101-140`
  - `docs/superpowers/specs/2026-04-14-space-aware-food-data-design.md:284-289`
  - `apps/food/src/utils/household-guard.ts:48`
  - `apps/food/src/handlers/photo.ts:85`
  - `apps/food/src/handlers/photo.ts:166-167`
  - `apps/food/src/handlers/photo.ts:222-223`
  - `apps/food/src/handlers/photo.ts:329-330`
- Test references:
  - `apps/food/src/__tests__/household-guard.test.ts:8`
  - `apps/food/src/__tests__/household-guard.test.ts:82-112`
  - `apps/food/src/__tests__/interaction-recording.test.ts:386-390`
  - `apps/food/src/__tests__/interaction-recording.test.ts:463-469`
  - `test_strategy_summary.md:191-194`

The space-aware food-data design explicitly calls for a new `resolveFoodStore()` helper, migration of interactive callers away from `requireHousehold()`, and test coverage proving receipt writes and interaction file paths switch from `users/shared/food/...` to `spaces/<spaceId>/food/...` when a space is active. That contract is still unprotected in the foundational suite.

The current codebase still exposes only `requireHousehold()` in `household-guard.ts`, and the photo flow still uses that shared-store helper while recording hard-coded shared file paths and `scope: 'shared'`. The supporting foundational tests mirror that older assumption: `household-guard.test.ts` only exercises `requireHousehold()`, and `interaction-recording.test.ts` still expects shared-only recipe and grocery paths. So the stage has decent coverage for the legacy shared-store path, but it still lacks the test seam that would catch regressions or incomplete work in the space-aware migration described by the current food data design.

### 2. The main route-level integration tests collapse shared and user stores to the same mock, so they cannot catch scope-boundary mistakes

- Severity: medium
- Type: trust-boundary blind spot in integration coverage
- Code references:
  - `apps/food/manifest.yaml:179-244`
- Test references:
  - `apps/food/src/__tests__/route-dispatch.test.ts:121-122`
  - `apps/food/src/__tests__/shadow-primary.integration.test.ts:125-126`
  - `apps/food/src/__tests__/shadow-primary.integration.test.ts:147-148`
  - `apps/food/src/__tests__/shadow-primary.integration.test.ts:497-498`

The food manifest declares materially different shared and user data scopes: recipes, grocery, pantry, prices, receipts, and meal plans live in shared scopes, while preferences, nutrition, shopping sessions, health, and quick meals are user-scoped. But the biggest route-level integration suites flatten those distinctions by returning the same mock store from both `services.data.forShared(...)` and `services.data.forUser(...)`.

That makes these tests useful for routing and handler invocation confidence, but weak evidence for the scope-isolation contract that matters in production. A handler can accidentally read from or write to the wrong scope and these tests still pass, because the shared and personal paths terminate in the same fake backing store. For a stage specifically about food foundations and shared plumbing, that is a real gap in trustworthiness.

### 3. Manifest-to-store scope compatibility is still not protected above the local store unit level

- Severity: medium
- Type: cross-layer contract coverage gap
- Code references:
  - `apps/food/manifest.yaml:179-244`
- Test references:
  - `apps/food/src/routing/__tests__/shadow-taxonomy.test.ts:22-24`
  - `apps/food/src/__tests__/grocery-store.test.ts:304-344`
  - `apps/food/src/__tests__/recipe-store.test.ts:164`
  - `apps/food/src/__tests__/recipe-store.test.ts:502-594`
  - `test_strategy_summary.md:185-206`

The local store tests are pretty good at pinning direct file paths and serialization details: grocery tests prove reads and writes go to `grocery/active.yaml`, and recipe tests cover `recipes/<id>.yaml` plus frontmatter and `entity_keys` enrichment. That is valuable coverage.

But the stage still lacks a higher-level contract test proving those store paths remain compatible with the app manifest's declared shared/user scopes and the runtime scope-enforcement model. `shadow-taxonomy.test.ts` reads the manifest, but only to check message-intent labels, not the data-scope declarations that matter for actual storage behavior. `test_strategy_summary.md` already flags missing manifest/data-scope contract tests, and the current Stage 7 suite does not close that gap for the food app.

## Transitional Or Lower-Trust Coverage To Treat Carefully

- `apps/food/src/routing/__tests__/shadow-classifier.test.ts` is useful for parser hardening and prompt-shape drift, but much of it is tightly coupled to exact prompt text, delimiter counts, and response formatting details. It is lower-trust evidence for user-visible routing behavior than the parity and dispatch tests.
- `apps/food/src/__tests__/route-dispatch.test.ts` and `shadow-primary.integration.test.ts` are broad and valuable, but they should be read as routing-flow coverage, not as strong evidence of storage-scope correctness, because shared and user stores are frequently collapsed into one mock.
- `apps/food/src/__tests__/household-guard.test.ts` is still worth keeping, but it now documents only the legacy shared-store household guard. It should not be treated as evidence that the newer space-aware store-resolution path is covered.

## Follow-Up Tasks Opened By Stage 7

- Add `resolveFoodStore()` coverage in `apps/food/src/__tests__/household-guard.test.ts`, including shared fallback and space-scoped store selection when `spaceId` is present.
- Add foundational photo/interaction-recording tests proving receipt, recipe, and grocery interaction file paths become `spaces/<spaceId>/food/...` when a space is active.
- Split shared and user scoped stores in the route-level integration suites so incorrect scope usage can fail visibly.
- Add food-manifest/runtime compatibility tests that tie `apps/food/manifest.yaml` shared/user scopes to the real store helpers and reject scope drift at the app-contract level.
- Keep using the current pantry/grocery/recipe/unit tests as the low-level base, but layer contract tests above them instead of replacing them.

## Stage 7 Exit Decision

Stage 7 is complete.

The strongest coverage in this stage is around routing taxonomy/parity, ingredient and pantry normalization, store serialization/frontmatter behavior, and concurrency protection for shared food files. The main remaining weaknesses are the unprotected space-aware store contract, the scope-collapsing route integration tests, and the missing manifest-to-runtime data-scope compatibility checks above the local store level.
