# Stage 8 Test Review Findings

Date: 2026-04-23
Stage: 8 - Food App User Workflows and Feature Coverage
Status: Completed

## Scope

This stage reviewed the user-facing food workflow tests under:

- `apps/food/src/__tests__`
- `apps/food/src/__tests__/handlers`

The review goal was to judge whether the Stage 8 tests protect the real user-visible food workflows across recipe, meal-planning, grocery, pantry, leftovers, nutrition, family, hosting, health, culture, and photo flows, rather than only proving helper internals or prompt text in isolation.

## Main Source Documents

Primary expected-behavior sources used for this stage:

- `test_strategy_summary.md`
- `apps/food/docs/requirements.md`
- `apps/food/docs/urs.md`
- `apps/food/manifest.yaml`

## High-Value Tests Worth Keeping Trust In

The strongest Stage 8 coverage today is:

- `apps/food/src/__tests__/photo-handler.test.ts` and `photo-user-scenarios.test.ts`
  Strong user-scenario coverage for caption routing, photo storage, friendly user copy, household guard behavior, strict classification fallback, and several good negative cases around malformed recipe attachment and save failures.
- `apps/food/src/__tests__/natural-language.test.ts` and `app.test.ts`
  Broad real-message and command coverage across recipe search, grocery/pantry flows, meal planning, scheduled jobs, and fallback behavior. These are still some of the best “what would a real user type and see?” tests in the food suite.
- `apps/food/src/__tests__/meal-plan-store.test.ts`, `voting-handler.test.ts`, `rating-handler.test.ts`, and `batch-cooking.test.ts`
  Good protection for "what's for dinner," meal voting, nightly rating prompts, batch-prep analysis, and defrost reminders.
- `apps/food/src/__tests__/cook-session.test.ts`, `cook-timer.test.ts`, and `cook-mode-handler.test.ts`
  Strong coverage for cook-mode state transitions, timer handling, and step-by-step cooking execution.
- `apps/food/src/__tests__/handlers/nutrition-per-user-config.integration.test.ts`, `nutrition-smart-log.integration.test.ts`, `nutrition-summary.test.ts`, and `targets-flow.test.ts`
  High-value integration coverage for per-user macro targets, smart logging, summary generation, and the request-context/config propagation path.
- `apps/food/src/__tests__/handlers/family-handler.test.ts`, `guest-add-flow.test.ts`, and `hosting-handler.test.ts`
  Good user-flow coverage for child profiles, approval/introduction flows, guest management, and hosting orchestration.

## Findings

### 1. Leftover meal suggestions are still effectively uncovered at the workflow level

- Severity: medium
- Type: missing user-facing workflow coverage
- Code references:
  - `apps/food/docs/requirements.md` (Module 5, `LW-2`)
  - `apps/food/docs/urs.md:901-911`
  - `apps/food/src/handlers/leftover-handler.ts:2-5`
  - `apps/food/src/handlers/leftover-handler.ts:27-32`
  - `apps/food/src/handlers/leftover-handler.ts:165-173`
- Test references:
  - `apps/food/src/__tests__/handlers/leftover-handler.test.ts:1-220`
  - `apps/food/docs/urs.md:2311`

The food requirements call for proactive leftover meal suggestions such as "how about chicken quesadillas tomorrow?" when leftovers are present. But the current Stage 8 traceability still marks `REQ-WASTE-002` as `TBD`, with zero standard tests and zero edge-case tests.

That matches the current test footprint. `leftover-handler.test.ts` gives good coverage for callback actions like use, freeze, toss, keep, and the daily leftover check job, but it does not cover a suggestion workflow. The handler implementation itself is scoped to status changes and expiry notifications, not leftover-to-next-meal suggestion behavior. So this remains a real user-visible gap, not just a missing edge case.

### 2. Recipe photo retrieval is marked implemented, but the suite still does not test the real send-photo workflow end to end

- Severity: medium
- Type: helper-level coverage overstating user-flow confidence
- Code references:
  - `apps/food/src/index.ts:717`
  - `apps/food/src/index.ts:2316-2364`
- Test references:
  - `apps/food/docs/urs.md:162-171`
  - `apps/food/docs/urs.md:2284`
  - `apps/food/src/__tests__/natural-language.test.ts:4666-4684`
  - `apps/food/src/__tests__/photo-store.test.ts:17-61`
  - `apps/food/src/__tests__/photo-user-scenarios.test.ts:593-639`

The live app does have a real recipe-photo retrieval flow: detect the intent, resolve recipes with photos, optionally show a numbered selection list, load the stored photo, and send it via `services.telegram.sendPhoto(...)`. But the Stage 8 suite still mostly proves the edges around that feature rather than the actual delivery path.

The URS traceability for `REQ-RECIPE-005` points to intent-detection tests and the low-level photo store helper, plus phrase-only coverage in `photo-user-scenarios.test.ts`. That is useful, but it still leaves the user-visible branches in `handleRecipePhotoRetrieval()` under-protected: no-photo, one-photo direct send, multi-photo numbered selection, missing underlying photo file, and successful `sendPhoto(...)` delivery are not pinned as a real end-to-end workflow.

### 3. The broader food-app data-durability contract is still not closed by Stage 8, despite a few good targeted regressions

- Severity: medium
- Type: non-functional workflow contract gap
- Code references:
  - `apps/food/docs/urs.md:1989-1999`
  - `apps/food/src/handlers/leftover-handler.ts:83-100`
  - `apps/food/src/index.ts:3872-3875`
- Test references:
  - `apps/food/src/__tests__/photo-handler.test.ts:366-442`
  - `apps/food/docs/urs.md:2349`

The app has started to add some worthwhile durability-style workflow tests, especially the grocery-photo atomic-write coverage in `photo-handler.test.ts`. That regression test is valuable because it verifies a malformed attached recipe does not accidentally produce the wrong combination of saved artifacts.

But the broader app-level durability contract is still open. The URS still lists `REQ-NFR-003` as planned with `TBD` tests, and several user-facing flows still involve multi-write behavior where the suite does not prove crash-safe or failure-safe semantics at the workflow level. Stage 8 therefore has some good local durability regressions, but not yet the broader confidence that user-facing food data cannot be left in an inconsistent state across the main workflow boundaries.

## Transitional Or Lower-Trust Coverage To Treat Carefully

- `apps/food/src/__tests__/natural-language-h11w-persona.test.ts`, `natural-language-h12a-persona.test.ts`, and `natural-language-h12b-persona.test.ts` are useful regression corpora, but they are tightly coupled to specific phrase inventories, prompt wording, and user-facing copy. They should not be the main evidence for whether a workflow is truly protected.
- `apps/food/src/__tests__/photo-user-scenarios.test.ts` is stronger than a pure prompt test, but several sections still validate prompt content and phrase routing more than final persisted state or callback follow-through. It is good supporting evidence, not complete end-to-end proof on its own.
- `apps/food/src/__tests__/app.test.ts` provides a valuable broad smoke net, but because it is a large catch-all with heavy stubbing, it should be paired with smaller focused integration tests for the trickier workflows rather than treated as sufficient by itself.

## Follow-Up Tasks Opened By Stage 8

- Add actual leftover-suggestion workflow coverage for `REQ-WASTE-002`, including scheduled/proactive suggestion behavior and user-triggered "what should I do with leftovers?" paths.
- Add end-to-end recipe-photo retrieval tests that exercise `handleRecipePhotoRetrieval()` through successful `sendPhoto(...)`, missing-photo, no-query selection, and multi-photo numbered-choice branches.
- Add broader food-app durability tests for representative multi-write user workflows beyond the current grocery-photo regression, especially leftovers/freezer transitions and other partial-failure boundaries.
- Keep the current scenario suites, but continue shifting confidence toward tests that assert final user-visible outcomes and persisted state rather than only phrase matching or prompt shape.

## Stage 8 Exit Decision

Stage 8 is complete.

The strongest coverage in this stage is around broad natural-language routing, photo happy paths plus several negative cases, meal-plan/voting/rating flows, cook mode, nutrition integrations, and family/hosting workflows. The main remaining weaknesses are the still-uncovered leftover-suggestion workflow, the shallow recipe-photo-retrieval coverage, and the unfinished app-level durability contract for multi-write user flows.
