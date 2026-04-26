# Stage 7 Test Review Findings

Date: 2026-04-25
Stage: 7 - Food App Foundations
Status: Remediated

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

### 1. The targeted space-aware photo/store contract is now protected at the right seams

- Severity: high
- Status: remediated
- Code references:
  - `core/src/types/telegram.ts`
  - `core/src/services/router/index.ts`
  - `apps/food/src/utils/household-guard.ts`
  - `apps/food/src/handlers/photo.ts`
- Test references:
  - `apps/food/src/__tests__/household-guard.test.ts`
  - `apps/food/src/__tests__/photo-handler.test.ts`
  - `apps/food/src/__tests__/interaction-recording.test.ts`
  - `core/src/services/router/__tests__/router.test.ts`

Phase 7 now covers the specific foundational seam the Stage 7 review called out. `PhotoContext` carries optional `spaceId` / `spaceName`, router photo dispatch now enriches that context from the active space, and the food app now resolves photo writes through `resolveFoodStore(...)` instead of assuming shared-only storage.

The new behavioral coverage pins both the selection logic and the resulting paths. `household-guard.test.ts` now covers shared fallback, active-space store resolution, non-member rejection, and the deliberate “shared household membership first, then space membership” guard split. `photo-handler.test.ts` proves recipe, receipt, and grocery photo flows use the active space store when present. `interaction-recording.test.ts` proves those same three flows record `spaces/<spaceId>/food/...` paths and `scope: 'space'` in active-space mode while retaining the shared fallback when no space is active.

### 2. The broad route-level suites no longer hide shared-vs-user boundary mistakes behind one mock store

- Severity: medium
- Status: remediated
- Code references:
  - `apps/food/manifest.yaml:179-244`
- Test references:
  - `apps/food/src/__tests__/route-dispatch.test.ts`
  - `apps/food/src/__tests__/shadow-primary.integration.test.ts`

The two biggest route-level integration suites now use distinct shared and user scoped stores instead of flattening both paths onto one mock. That means a regression that reads per-user nutrition data from the shared food store, or vice versa, can now fail visibly.

The new regressions intentionally target a real mixed-scope path rather than a fake distinction: the macro-adherence route goes through the shared household guard and then into per-user nutrition data. Both broad suites now pin that boundary by allowing only the shared `household.yaml` read from the shared store while forcing nutrition-target reads onto the user store.

### 3. Food manifest/runtime storage compatibility is now protected above the local unit-test level

- Severity: medium
- Status: remediated
- Code references:
  - `apps/food/manifest.yaml:179-244`
  - `core/src/services/data-store/paths.ts`
- Test references:
  - `apps/food/src/__tests__/manifest-runtime-contract.test.ts`

Stage 7 now has the higher-level manifest/runtime contract test it was missing. The new food-specific contract suite validates `apps/food/manifest.yaml`, asserts `warnScopePathPrefix()` emits no warnings, proves representative shared and user paths are accepted, and proves legacy app-prefixed paths, traversal paths, and cross-scope misuse are rejected by real `DataStoreServiceImpl` enforcement.

That gives the food app a much stronger cross-layer safety net than the previous state, where recipe and grocery unit tests pinned local file paths but nothing verified those paths still matched the manifest’s declared scopes.

## Residual Limitations

- The separate PAS-wide `forShared(scope)` selector bug remains open in `docs/open-items.md`. The new food manifest/runtime contract test explicitly documents that limitation and only pins app-relative shared-scope compatibility, not selector-specific semantics.
- Pantry-photo space-awareness is still intentionally deferred. Phase 7 only migrated recipe, receipt, and grocery photo writes.
- This phase improves the targeted photo write path, not the entire food active-space model. Non-photo shared-data message/callback flows and cross-scope read/write reconciliation remain deferred to the broader active-space food migration.

## Follow-Up Tasks Closed By Stage 7

- `resolveFoodStore()` now exists and is covered in `apps/food/src/__tests__/household-guard.test.ts`.
- Recipe, receipt, and grocery photo writes plus interaction records now have active-space regressions proving `spaces/<spaceId>/food/...` paths.
- `route-dispatch.test.ts` and `shadow-primary.integration.test.ts` now use distinct shared and user stores so scope mistakes can fail.
- Food manifest/runtime compatibility is now pinned by `apps/food/src/__tests__/manifest-runtime-contract.test.ts`.

## Stage 7 Exit Decision

Stage 7 remediation is complete.

The original three Stage 7 review gaps are now closed in code, tests, and traceability docs. Verification for this remediation is: targeted Phase 7 suites passed, `pnpm build` passed, and a full `pnpm test` rerun was blocked by an unrelated timeout in `core/src/services/reports/__tests__/report-service.test.ts` while concurrent Hermes work was in flight. That full-suite timeout was not treated as a Phase 7 remediation target in this pass.
