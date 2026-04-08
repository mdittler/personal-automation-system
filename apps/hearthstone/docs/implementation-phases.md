# Hearthstone App — Implementation Phases

This document tracks the phased implementation of the Hearthstone food management app. Each phase is a logical group of requirements that can be completed in a single session. See `requirements.md` for raw requirements and `urs.md` for formal requirement IDs.

**Full plan with file lists and verification steps:** `.claude/plans/vast-humming-cascade.md`

---

## Phase Summary

| Phase | Name | Reqs | Key Commands | Est. Tests | Depends On | Status |
|-------|------|------|----|------------|------------|--------|
| H1 | Foundation: Types, Household, Recipes | 11 | `/household`, `/recipes` | 70–90 | — | Complete |
| H2 | Grocery Lists and Manual Pantry | 9 | `/grocery`, `/addgrocery`, `/pantry` | 65–85 | H1 | Complete |
| H3 | Meal Planning | 8 | `/mealplan`, `/whatsfordinner` | 60–80 | H1, H2 | Complete |
| H4 | Voting, Ratings, Shopping | 6 | Inline keyboards, shopping mode | 55–75 | H2, H3 | Complete |
| H5 | Cook Mode and Timers | 5 | `/cook`, food queries | 50–65 | H1 | Complete |
| H6 | Leftovers and Waste | 6 | `/leftovers`, `/freezer`, 3 cron jobs | 55–70 | H2, H4 | Complete |
| H7 | Batch Cooking and Cuisine | 5 | Prep plan, defrost, cuisine cron | 39 | H3, H6 | Complete |
| H8 | Vision: Photos | 5 | 3 photo intents | 47 | H1, H2, *infra* | Complete |
| H9 | Family Features | 4 | Kid adaptations, baby tracker | 156 | H1 | Complete |
| H10 | Cost Tracking | 5 | `/foodbudget` | 40–55 | H3, H8 | Not Started |
| H11 | Nutrition, Seasonal, Hosting | 7 | `/nutrition`, `/hosting`, 2 cron jobs | 55–70 | H3, H9 | Not Started |
| H12 | Health, Culture, Events | 4 | Health insights, 5 event emitters | 35–50 | H7, H11 | Not Started |

**Total:** 75 requirement implementations → 610–810 estimated tests

---

## Dependency Graph

```
H1 (Foundation) ──┬──► H2 (Grocery) ──► H3 (Meal Plan) ──► H4 (Voting/Shop)
                  │                       │                    │
                  │                       ├──► H7 (Batch)     │
                  │                       │                    │
                  │                       └──► H11 (Nutrition) │
                  │                             │              │
                  ├──► H5 (Cook Mode)           └──► H12      │
                  │                                            │
                  ├──► H9 (Family) ─────────► H11             │
                  │                                            │
                  └──► H8 (Vision) ──► H10 (Cost)             │
                                                               │
                                        H6 (Leftovers) ◄──────┘
                                          │
                                          └──► H7
```

**Parallel tracks after H1:** H5, H8, H9 can start independently.

---

## Cross-Cutting: /ask Discoverability

**Every phase must update `apps/hearthstone/help.md`** with user-friendly descriptions of newly activated features. This file is indexed by the chatbot's `AppKnowledgeBase` and is the primary source for `/ask` answers about Hearthstone.

The manifest's commands/intents are auto-indexed by `AppMetadataService`, but `help.md` provides the context and examples users need (e.g., "How do I save a recipe?" or "How do meal plans work?").

---

## Phase H1: Foundation — Types, Household, Recipe Storage

**Status:** Complete | **Tests:** ~1100 (baseline) | **Started:** 2026-03-30 | **Completed:** 2026-03-30

**Requirements:** REQ-HOUSEHOLD-001, REQ-RECIPE-001, REQ-RECIPE-003 (partial: draft only), REQ-RECIPE-004, REQ-RECIPE-006, REQ-QUERY-002, REQ-NFR-001, REQ-NFR-002, REQ-NFR-003, REQ-NFR-007, REQ-NFR-008

**What gets built:**
- All domain types (`types.ts`) — Recipe, Ingredient, MacroData, Household, MealPlan, GroceryList, PantryItem, etc.
- Household service — create, join code, membership
- Recipe store — CRUD, search by text/tags/cuisine/rating
- Recipe parser — LLM text-to-structured-recipe
- App entry point rewrite — command router, intent handler
- NFR patterns — acknowledgment, error handling, timezone, logging, frontmatter

**Key files:** `src/types.ts`, `src/services/household.ts`, `src/services/recipe-store.ts`, `src/services/recipe-parser.ts`, `src/utils/date.ts`, `src/utils/household-guard.ts`, `src/index.ts`

**Data:** `shared/household.yaml`, `shared/recipes/<id>.yaml`, `<userId>/preferences.yaml`

### Progress
<!-- Track incremental progress here -->

---

## Phase H2: Grocery Lists and Manual Pantry

**Status:** Complete | **Tests:** ~2605 (cumulative at H2a completion) | **Started:** 2026-03-30 | **Completed:** 2026-03-30

**Requirements:** REQ-GROCERY-001, REQ-GROCERY-002, REQ-GROCERY-003, REQ-GROCERY-005, REQ-GROCERY-006, REQ-GROCERY-007, REQ-GROCERY-011 (config only), REQ-PANTRY-001 (manual text), REQ-NFR-004

**What gets built:**
- Grocery generator — recipe→grocery with dedup, department sorting, staples
- Grocery store — list CRUD, manual add
- Pantry store — manual text add/remove
- LLM tier assignments for all calls (NFR-004)

**Key files:** `src/services/grocery-store.ts`, `src/services/grocery-generator.ts`, `src/services/pantry-store.ts`, `src/handlers/grocery.ts`, `src/handlers/pantry.ts`

**Data:** `shared/grocery/active.yaml`, `shared/grocery/archive/`, `shared/pantry.yaml`

### Progress

---

## Phase H3: Meal Planning and "What's for Dinner"

**Status:** Complete | **Tests:** ~104 new (2709 total) | **Started:** 2026-03-31 | **Completed:** 2026-03-31

**Requirements:** REQ-MEAL-001, REQ-MEAL-002, REQ-MEAL-005, REQ-MEAL-007, REQ-PANTRY-002, REQ-PANTRY-003, REQ-SEASON-001, REQ-SEASON-003

**What gets built:**
- Meal planner — AI plan generation with constraints (meal types, ratios, prefs, history, seasonality)
- Meal plan store — CRUD, archive
- Seasonal data — static produce calendar by region
- Pantry matcher — "what can I make" cross-reference
- Auto-exclude pantry items from generated grocery lists

**Key files:** `src/services/meal-planner.ts`, `src/services/meal-plan-store.ts`, `src/services/seasonal-data.ts`, `src/services/pantry-matcher.ts`, `src/handlers/mealplan.ts`

**Data:** `shared/meal-plans/current.yaml`, `shared/meal-plans/archive/`, `shared/seasonal/`

### Progress

---

## Phase H4: Voting, Ratings, and Interactive Shopping

**Status:** Complete | **Tests:** ~105 new (~750 cumulative) | **Started:** 2026-03-31 | **Completed:** 2026-03-31

**Requirements:** REQ-MEAL-003, REQ-MEAL-004, REQ-RECIPE-003 (full confirmation), REQ-GROCERY-009, REQ-NFR-006

**Also includes (deferred from H2a):**
- REQ-GROCERY-009 (GL-9): Shopping follow-up — 1-hour timed follow-up after clearing purchased items when items remain

**What gets built:**
- Voting — per-meal inline keyboard voting (👍/👎/😐), configurable window, hourly finalization, LLM replacement for downvoted meals, early finalization when all voted
- Ratings — nightly 8pm "What did you cook?" prompt, 👍/👎/skip per meal, ratings stored on recipes
- Recipe confirmation — draft→confirmed on positive rating (REQ-RECIPE-003)
- Shopping follow-up — 1-hour setTimeout after clear with remaining items, clear/keep buttons
- Cooked buttons — `/mealplan` view shows "✅ Cooked!" button per uncooked meal
- Handler extraction — new `handlers/` directory for H4 code (voting, rating, shopping-followup)
- Idempotency — finalize-votes job checks plan status, nightly prompt uses lastRatingPromptDate

**Key files:** `src/services/voting.ts`, `src/services/rating.ts`, `src/handlers/voting.ts`, `src/handlers/rating.ts`, `src/handlers/shopping-followup.ts`

**Scheduled jobs added:** `finalize-votes` (hourly), `nightly-rating-prompt` (daily 8pm)

**Config fields used:** `voting_window_hours` (default 12)

### Progress

- [x] Type additions (votingStartedAt, lastRatingPromptDate on MealPlan)
- [x] Voting service (pure logic: recordVote, netScore, isVotingExpired, allMembersVoted)
- [x] Voting handler (sendVotingMessages, handleVoteCallback, handleFinalizeVotesJob)
- [x] Rating service (getUncookedMeals, createRating, hasRatingPromptBeenSentToday)
- [x] Rating handler (handleCookedCallback, handleRateCallback, handleNightlyRatingPromptJob)
- [x] Shopping follow-up handler (scheduleShoppingFollowup, clear/keep callbacks)
- [x] buildPlanButtons updated to include Cooked buttons
- [x] Index.ts integration (new callback routes, job routes, voting flow for multi-member)
- [x] Manifest updates (2 new scheduled jobs)
- [x] Integration tests
- [x] Documentation updates

---

## Phase H5: Cook Mode and Timers

**Status:** Complete | **Tests:** ~160 new (~3160 cumulative) | **Started:** 2026-04-02 | **Completed:** 2026-04-02

**Requirements:** REQ-COOK-001, REQ-COOK-002, REQ-COOK-003, REQ-COOK-004, REQ-QUERY-001

**Implemented as H5a + H5b:**

**What gets built:**
- Cook mode state machine — step-by-step navigation via Telegram (4-button UI: Back, Repeat, Next, Done)
- Timer integration — extract times from steps, set/cancel timers, auto-cancel on navigation
- Chromecast TTS — hands-free step reading via audio service, configurable device
- Recipe scaler — flexible serving input parsing (numbers, "double", "half"), LLM scaling notes
- Food query handler — contextual food questions with active cook session awareness
- Text shortcuts — "next", "back", "repeat", "done" during active cook session

**Key files:** `src/handlers/cook-mode.ts`, `src/services/cook-session.ts`, `src/services/recipe-scaler.ts`, `src/services/timer-parser.ts`

### Progress

- [x] H5a: Cook mode navigation, recipe scaling, session management, 53 tests
- [x] H5b: TTS/hands-free, cooking timers, food queries with context, persona tests

---

## Phase H6: Leftovers and Waste Reduction

**Status:** Complete | **Tests:** ~200 new (~3400 cumulative) | **Started:** 2026-04-02 | **Completed:** 2026-04-03

**Requirements:** REQ-WASTE-001, REQ-WASTE-002, REQ-WASTE-003, REQ-WASTE-004, REQ-PANTRY-004, REQ-PANTRY-005

**Also includes (deferred from H2a):**
- REQ-PANTRY-004 (PI-4): Perishable expiry alerts — LLM-estimated shelf life, Telegram alerts when items approach expiry, snooze/dismiss
- REQ-PANTRY-005 (PI-5): Freezer inventory — separate from pantry, track items with frozen date, freezer-burn warnings

**What gets built:**
- Leftover store — CRUD, LLM expiry estimation, use/freeze/toss/keep actions
- Freezer store — CRUD, date tracking, Monday check job (PI-5)
- Waste store — append-only waste log with reason tracking (expired/spoiled/discarded)
- Perishable handler — daily 9am pantry expiry check with inline buttons (PI-4)
- Post-rating and post-cook leftover prompts
- 3 scheduled jobs: perishable-check (daily 9am), leftover-check (daily 10am), freezer-check (Monday 9am)

**Key files:** `src/services/leftover-store.ts`, `src/services/freezer-store.ts`, `src/services/waste-store.ts`, `src/handlers/leftover-handler.ts`, `src/handlers/freezer-handler.ts`, `src/handlers/perishable-handler.ts`

**Data:** `shared/leftovers.yaml`, `shared/freezer.yaml`, `shared/waste-log.yaml`

### Progress

- [x] Waste store, leftover store, freezer store services with tests
- [x] Leftover, freezer, perishable handlers with callback routing
- [x] Integration into index.ts — commands, callbacks, intents, scheduled jobs
- [x] Post-rating and post-cook leftover prompts
- [x] Perishable expiry estimation for pantry items
- [x] Security review fixes, persona NL tests

---

## Phase H7: Batch Cooking and Cuisine Tracking

**Status:** Complete | **Tests:** 39 | **Started:** 2026-04-03 | **Completed:** 2026-04-03

**Requirements:** REQ-BATCH-001, REQ-BATCH-002, REQ-BATCH-003, REQ-BATCH-004, REQ-CULTURE-001

**What gets built:**
- Batch analyzer — shared prep component detection via LLM
- Prep planner — consolidated prep plan with timing
- Defrost reminder — check plan for frozen items, night-before reminder
- Cuisine tracker — diversity analysis, weekly cron

**Key files:** `src/services/batch-analyzer.ts`, `src/services/prep-planner.ts`, `src/services/defrost-reminder.ts`, `src/services/cuisine-tracker.ts`

### Progress

---

## Phase H8: Vision — Photos

**Status:** Complete | **Tests:** 60 new (~3673 cumulative) | **Started:** 2026-04-06 | **Completed:** 2026-04-07

**Infrastructure prerequisite:** Added LLM vision support (image input) to core types, base provider, and all cloud providers (Anthropic, Google, OpenAI-compatible).

**Requirements:** REQ-RECIPE-002, REQ-RECIPE-005, REQ-GROCERY-004, REQ-PANTRY-001 (photo), REQ-COST-001

**Also includes (deferred from H2a):**
- REQ-GROCERY-004 (GL-4): Photo-to-grocery — photograph a recipe or handwritten list, LLM vision extracts items and adds to grocery list

**What gets built:**
- Photo handler dispatcher — route by photo intent type
- Recipe photo parser — LLM vision extraction
- Receipt parser — LLM vision item/total extraction
- Pantry photo parser — LLM vision item identification
- Grocery photo parser — LLM vision list/recipe extraction (GL-4)
- Photo storage and retrieval

**Key files:** `src/handlers/photo.ts`, `src/services/recipe-photo-parser.ts`, `src/services/receipt-parser.ts`, `src/services/pantry-photo-parser.ts`

### Completion Log

- Core LLM vision support: `LLMImage` type, `images` option on `complete()`, `supportsVision` provider flag with MIME type validation (`VALID_IMAGE_MIME_TYPES`)
- Provider implementations: Anthropic (ImageBlockParam), Google (inlineData), OpenAI (image_url data URI)
- Photo store: base64 storage/retrieval via ScopedDataStore
- 4 photo parsers: recipe, receipt, pantry, grocery — all with sanitized caption pass-through
- Photo handler dispatcher: caption keyword routing + LLM vision fallback (returns null for unclear, asks user for caption)
- Recipe photo retrieval: extracts recipe name from query, shows numbered selection when no name given
- Review fixes (2026-04-07): caption prompt injection fix (sanitizeInput), MIME type whitelist validation, vision classification null-instead-of-default, pantry correction hint, caption pass-through to receipt/grocery parsers

---

## Phase H9: Family Features

**Status:** Complete | **Tests:** 156 | **Started:** 2026-04-07 | **Completed:** 2026-04-07

**Requirements:** REQ-FAMILY-001, REQ-FAMILY-002, REQ-FAMILY-003, REQ-FAMILY-004

**What gets built:**
- Kid adapter — LLM-based age-appropriate recipe adaptations
- Child tracker — food introduction log, allergen wait windows, food-to-allergen mapping (80+ entries)
- Family profiles — child profile CRUD with flexible date parsing
- "Margot approved" tagging via buttons and natural language
- Intent detection for kid adapt, food intro, child approval
- `/family` command with add/remove/view/edit subcommands
- `fa:` callback prefix for recipe approval buttons, `fi:` for food intro reaction buttons
- Config-driven: `allergen_wait_days`, `child_meal_adaptation` toggle

**Key files:** `src/services/kid-adapter.ts`, `src/services/child-tracker.ts`, `src/services/family-profiles.ts`, `src/handlers/family.ts`

**Data:** `shared/children/<slug>.yaml` — profile + food introduction log per child

### Progress
- All 4 requirements implemented (REQ-FAMILY-001 through REQ-FAMILY-004)
- 156 tests across 4 test files (family-profiles: 34, child-tracker: 31, kid-adapter: 10, family-handler: 81)
- Types: ChildProfile, FoodIntroduction, ChildFoodLog, KidAdaptation + childApprovals on Recipe
- Index.ts wired: /family command, 3 intent handlers, fa: + fi: callback routing, config reads

### Review Fixes Applied
- C1: Approval buttons on recipe views via `buildRecipeApprovalButtons`
- C2: Config values from `services.config.get` instead of hardcoded defaults
- C3: Natural language approval intent ("Margot loved the chili")
- I1: Flexible date parsing (ISO, US MM/DD/YYYY, named month) with rollover validation
- I2: Confirmation buttons before removing child profile
- I3: LLM-based food name extraction with regex fallback
- I4: `/family edit` subcommand for stage, allergens, notes
- I5: Reaction recording via inline buttons after food introduction
- I6: Expanded food-to-allergen mapping (80+ entries, longest-match-first ordering)
- I7: Recipe name extraction from natural language for kid adapt intent
- I8: DST-safe date math (noon UTC normalization, Math.round instead of Math.floor)

---

## Phase H10: Cost Tracking and Store Pricing

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-COST-002, REQ-COST-003, REQ-COST-004, REQ-GROCERY-010, REQ-GROCERY-011 (full)

**Also includes (deferred from H2a):**
- REQ-GROCERY-010 (GL-10): Store pricing — per-item price estimates, multi-store comparison, user-reported actual prices
- REQ-GROCERY-011 (GL-11): Store configuration — preferred stores, store-specific department mapping, price history

**What gets built:**
- Cost tracker — cost-per-meal estimation, spend aggregation
- Store pricing — multi-store estimates, user-reported actuals (GL-10)
- Store configuration — preferred stores, department mapping (GL-11)
- Budget alerts — plan cost trending, swap suggestions

**Key files:** `src/services/cost-tracker.ts`, `src/services/store-pricing.ts`, `src/services/budget-alerts.ts`, `src/handlers/budget.ts`

### Progress

---

## Phase H11: Nutrition, Seasonal Nudges, and Hosting

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-MEAL-006, REQ-NUTR-001, REQ-NUTR-002, REQ-SEASON-002, REQ-SOCIAL-001, REQ-SOCIAL-002, REQ-SOCIAL-003

**What gets built:**
- Macro tracker — daily macro logging, target tracking
- Nutrition reporter — summaries, pediatrician reports
- Hosting planner — event planning, guest profiles, prep timelines
- 2 cron jobs: seasonal-nudge, weekly-nutrition-summary

**Key files:** `src/services/macro-tracker.ts`, `src/services/nutrition-reporter.ts`, `src/services/pediatrician-report.ts`, `src/services/hosting-planner.ts`, `src/services/guest-profiles.ts`

**Data:** `<userId>/nutrition/<YYYY-MM>.yaml`, `shared/guests.yaml`

### Progress

---

## Phase H12: Health, Culture, and Events

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-HEALTH-001, REQ-HEALTH-002, REQ-CULTURE-002, REQ-NFR-005

**What gets built:**
- Health correlator — diet-performance analysis via LLM
- Cultural calendar — holiday recipe suggestions
- All 5 event emitters wired throughout the app
- Cross-app event subscribers for health/fitness data
- End-to-end verification of complete lifecycle

**Key files:** `src/services/health-correlator.ts`, `src/services/cultural-calendar.ts`, `src/events/emitters.ts`, `src/events/subscribers.ts`

### Progress

---

## Completion Log

| Phase | Date Started | Date Completed | Tests | Notes |
|-------|-------------|----------------|-------|-------|
| H1 | 2026-03-30 | 2026-03-30 | ~1100 (infra baseline) | Foundation: types, household, recipes, recipe parser |
| H2 | 2026-03-30 | 2026-03-30 | ~2605 (cumulative) | Grocery lists, pantry (H2a complete) |
| H3 | 2026-03-31 | 2026-03-31 | ~104 new (2709 total) | Meal planning, "what can I make?", seasonal data |
| H4 | 2026-03-31 | 2026-03-31 | ~105 new (~2814 cumulative) | Voting, ratings, shopping follow-up, cooked buttons |
| H5 | 2026-04-02 | 2026-04-02 | ~160 new (~3160 cumulative) | Cook mode (H5a+H5b), timers, TTS, food queries |
| H6 | 2026-04-02 | 2026-04-03 | ~200 new (~3400 cumulative) | Leftovers, freezer, waste, perishable alerts |
| H7 | 2026-04-03 | 2026-04-03 | ~39 new (~3579 cumulative) | Batch cooking, cuisine tracking |
| H8 | 2026-04-06 | 2026-04-06 | ~47 new (~3660 cumulative) | Vision: LLM image support, photo parsers, receipt capture |
| H9 | 2026-04-07 | 2026-04-07 | ~243 new (~1824 cumulative) | Family profiles, kid adapter, child tracker, food intro, approval tagging, NL user simulation tests |
| H10 | — | — | 0 | — |
| H11 | — | — | 0 | — |
| H12 | — | — | 0 | — |
