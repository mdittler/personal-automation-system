# Hearthstone App — Implementation Phases

This document tracks the phased implementation of the Hearthstone food management app. Each phase is a logical group of requirements that can be completed in a single session. See `requirements.md` for raw requirements and `urs.md` for formal requirement IDs.

**Full plan with file lists and verification steps:** `.claude/plans/vast-humming-cascade.md`

---

## Phase Summary

| Phase | Name | Reqs | Key Commands | Est. Tests | Depends On | Status |
|-------|------|------|----|------------|------------|--------|
| H1 | Foundation: Types, Household, Recipes | 11 | `/household`, `/recipes` | 70–90 | — | **Complete** |
| H2a | Grocery Lists and Manual Pantry | 9 | `/grocery`, `/addgrocery`, `/pantry` | 65–85 | H1 | **Complete** |
| H3 | Meal Planning + "What Can I Make?" | 8 | `/mealplan` | 60–80 | H1, H2a | Not Started |
| H4 | Voting, Ratings, Shopping | 6 | Inline keyboards, shopping mode | 55–75 | H2, H3 | Not Started |
| H5 | Cook Mode and Timers | 5 | `/cook`, food queries | 50–65 | H1 | Not Started |
| H6 | Leftovers and Waste | 6 | `/leftovers`, `/freezer`, 3 cron jobs | 55–70 | H2, H4 | Not Started |
| H7 | Batch Cooking and Cuisine | 5 | Prep plan, defrost, cuisine cron | 40–55 | H3, H6 | Not Started |
| H8 | Vision: Photos | 5 | 3 photo intents | 45–60 | H1, H2, *infra* | Not Started |
| H9 | Family Features | 4 | Kid adaptations, baby tracker | 40–55 | H1 | Not Started |
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

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

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

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

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

## Phase H3: Meal Planning, "What's for Dinner", and "What Can I Make?"

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-MEAL-001, REQ-MEAL-002, REQ-MEAL-005, REQ-MEAL-007, REQ-SEASON-001, REQ-SEASON-003

**Also includes (deferred from H2a):**
- REQ-PANTRY-002 (PI-2): "What can I make?" — LLM-assisted cross-reference of pantry against recipe library, grouped into full matches and near matches (with missing items listed)

**Note:** REQ-PANTRY-003 (auto-exclude from grocery) and REQ-SEASON-001 (seasonal produce) are handled differently than originally planned:
- PANTRY-003 was already implemented in H2a
- SEASON-001 uses LLM knowledge + user location instead of a static produce dataset

**What gets built:**
- Meal planner — AI plan generation via single standard-tier LLM call with constraints (meal types, ratios, prefs, history, location-based seasonality)
- Meal plan store — CRUD, archive, tonight resolver
- Pantry matcher — LLM-assisted "what can I make" cross-reference (fast tier)
- Meal plan config — user settings for generation schedule, dinners count, new recipe ratio, dietary prefs
- Location config — `location` field in pas.yaml user config for seasonal awareness
- Scheduled job — `generate-weekly-plan` cron handler (first Hearthstone scheduled job)

**Key files:** `src/services/meal-planner.ts`, `src/services/meal-plan-store.ts`, `src/services/pantry-matcher.ts`

**Data:** `shared/meal-plans/current.yaml`, `shared/meal-plans/archive/YYYY-Www.yaml`

### Progress

---

## Phase H4: Voting, Ratings, and Interactive Shopping

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-MEAL-003, REQ-MEAL-004, REQ-RECIPE-003 (full confirmation), REQ-GROCERY-008, REQ-GROCERY-009, REQ-NFR-006

**Also includes (deferred from H2a):**
- REQ-GROCERY-009 (GL-9): Shopping follow-up — post-shopping summary, missed items prompt, "did you get everything?" flow

**What gets built:**
- Voting — inline keyboard voting, window management, finalization
- Ratings — post-meal 1–5 prompts, storage on recipes
- Shopping mode — interactive numbered checklist state machine
- Shopping follow-up — post-trip summary, missed item handling (GL-9)
- Recipe confirmation — draft→confirmed after first successful cook
- Idempotency guards for scheduled plan generation

**Key files:** `src/services/voting.ts`, `src/services/rating.ts`, `src/services/shopping-mode.ts`, `src/services/recipe-confirmation.ts`, `src/handlers/scheduled/generate-plan.ts`

### Progress

---

## Phase H5: Cook Mode and Timers

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-COOK-001, REQ-COOK-002, REQ-COOK-003, REQ-COOK-004, REQ-QUERY-001

**What gets built:**
- Cook mode state machine — step-by-step navigation via Telegram
- Timer integration — extract times from steps, one-off scheduler
- Chromecast TTS — hands-free step reading via audio service
- Recipe scaler — LLM non-linear ingredient scaling
- Food query handler — safety, substitutions, knowledge questions

**Key files:** `src/services/cook-mode.ts`, `src/services/recipe-scaler.ts`, `src/services/cook-timer.ts`, `src/handlers/cook.ts`, `src/handlers/query.ts`

### Progress

---

## Phase H6: Leftovers and Waste Reduction

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-WASTE-001, REQ-WASTE-002, REQ-WASTE-003, REQ-WASTE-004, REQ-PANTRY-004, REQ-PANTRY-005

**Also includes (deferred from H2a):**
- REQ-PANTRY-004 (PI-4): Perishable expiry alerts — LLM-estimated shelf life, Telegram alerts when items approach expiry, snooze/dismiss
- REQ-PANTRY-005 (PI-5): Freezer inventory — separate from pantry, track items with frozen date, freezer-burn warnings

**What gets built:**
- Leftover store — CRUD, LLM expiry estimation, meal suggestions
- Freezer store — CRUD, date tracking (PI-5)
- Waste tracker — logging, analytics
- Expiry checker — shared logic for pantry/freezer/leftovers (PI-4)
- 3 scheduled jobs: perishable-check, freezer-check, leftover-check

**Key files:** `src/services/leftover-store.ts`, `src/services/freezer-store.ts`, `src/services/waste-tracker.ts`, `src/services/expiry-checker.ts`

**Data:** `shared/leftovers.yaml`, `shared/freezer.yaml`, `shared/waste-log.yaml`

### Progress

---

## Phase H7: Batch Cooking and Cuisine Tracking

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

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

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**⚠️ Infrastructure prerequisite:** `LLMService` needs vision support (image input). Must be added to core before this phase.

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

### Progress

---

## Phase H9: Family Features

**Status:** Not Started | **Tests:** 0 | **Started:** — | **Completed:** —

**Requirements:** REQ-FAMILY-001, REQ-FAMILY-002, REQ-FAMILY-003, REQ-FAMILY-004

**What gets built:**
- Kid adapter — LLM-based age-appropriate recipe adaptations
- Child tracker — food introduction log, allergen wait windows
- Family profiles — child profile CRUD
- "Margot approved" tagging with meal plan weighting

**Key files:** `src/services/kid-adapter.ts`, `src/services/child-tracker.ts`, `src/services/family-profiles.ts`, `src/handlers/family.ts`

**Data:** `shared/children/<name>.yaml`

### Progress

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
| H1 | — | — | 0 | — |
| H2 | — | — | 0 | — |
| H3 | — | — | 0 | — |
| H4 | — | — | 0 | — |
| H5 | — | — | 0 | — |
| H6 | — | — | 0 | — |
| H7 | — | — | 0 | — |
| H8 | — | — | 0 | — |
| H9 | — | — | 0 | — |
| H10 | — | — | 0 | — |
| H11 | — | — | 0 | — |
| H12 | — | — | 0 | — |
