# Hearthstone User Requirements Specification

| Field | Value |
|-------|-------|
| **Doc ID** | PAS-URS-APP-hearthstone |
| **Purpose** | Functional and non-functional requirements with test coverage mapping |
| **Status** | Active |
| **Last Updated** | 2026-04-03 |

## Conventions

- **Requirement ID format:** `REQ-<AREA>-<NNN>` (e.g., `REQ-RECIPE-001`)
- **Status values:** `Implemented` | `Planned` | `Deferred`
- **Standard tests** = happy-path behavior verifying the requirement works correctly
- **Edge case tests** = all other tests: boundary conditions, error handling, invalid inputs, empty states, security (injection, unauthorized access), concurrency/timing, state transitions, and configuration (defaults, overrides, missing values)
- **Fixes** section tracks bug corrections with date and description
- **See also** cross-references related requirements to avoid excessive duplication
- **Origin** references the original requirement ID from `docs/requirements.md` (e.g., RS-1, MP-3)

### Area Codes

| Code | Scope |
|------|-------|
| RECIPE | Recipe storage, parsing, search, retrieval, editing |
| MEAL | Meal planning, voting, ratings, scheduling |
| GROCERY | Grocery list generation, shopping mode, store pricing |
| PANTRY | Pantry and freezer inventory tracking |
| WASTE | Leftover tracking and waste reduction |
| FAMILY | Toddler/family meal adaptation, allergen tracking |
| BATCH | Batch cooking, prep planning, freezer-friendly flagging |
| COOK | Cook mode, timers, TTS, recipe scaling |
| QUERY | Quick-answer food questions |
| SOCIAL | Social/hosting event planning, guest profiles |
| COST | Receipt capture, cost tracking, budget alerts |
| SEASON | Seasonal produce awareness, nudges |
| NUTR | Nutrition reporting, macro summaries |
| HEALTH | Diet-performance correlation, cross-app events |
| CULTURE | Cuisine diversity tracking, cultural calendar |
| HOUSEHOLD | Household linking and membership |
| UTIL | Utility functions (date, slugify, guard) |
| SEC | Security (prompt injection, input validation) |
| UX | User experience (disambiguation, selection, error messages) |
| NFR | Non-functional requirements |

---

## 1. Recipe Storage

### REQ-RECIPE-001: Save recipes from text

**Origin:** RS-1 | **Status:** Implemented

When a user sends a recipe (pasted text, URL, or describes it), use the LLM to parse it into the structured recipe format. Save as a `draft`. Confirm with the user that it was parsed correctly.

**Standard tests:**
- `recipe-parser.test.ts` > `parseRecipeText` > parses LLM response into structured recipe
- `recipe-parser.test.ts` > `parseRecipeText` > calls LLM with standard tier
- `recipe-store.test.ts` > `saveRecipe` > saves a parsed recipe as draft
- `recipe-store.test.ts` > `saveRecipe` > preserves all parsed fields
- `app.test.ts` > `handleMessage — save recipe intent` > parses and saves recipe from text

**Edge case tests:**
- `recipe-parser.test.ts` > `parseRecipeText` > handles markdown-wrapped JSON response
- `recipe-parser.test.ts` > `parseRecipeText` > throws on incomplete recipe
- `recipe-parser.test.ts` > `parseRecipeText` > throws on invalid JSON
- `recipe-parser.test.ts` > `parseRecipeText` > normalizes missing optional fields
- `recipe-parser.test.ts` > `parseRecipeText` > propagates LLM errors
- `recipe-store.test.ts` > `saveRecipe` > generates unique IDs
- `recipe-store.test.ts` > `loadRecipe — error handling` > returns null for malformed YAML
- `recipe-store.test.ts` > `saveRecipe — frontmatter` > saves recipe with frontmatter header
- `recipe-store.test.ts` > `loadRecipe — frontmatter handling` > strips frontmatter before parsing
- `recipe-parser.test.ts` > `error handling — edge cases` > throws clear error when LLM returns empty string
- `recipe-parser.test.ts` > `error handling — edge cases` > throws clear error when LLM returns array instead of object
- `recipe-parser.test.ts` > `error handling — edge cases` > accepts JSON with extra unknown fields gracefully
- `app.test.ts` > `handleMessage — save recipe intent` > handles LLM failure gracefully
- `app.test.ts` > `handleMessage — save recipe intent` > handles parse failure gracefully
- `app.test.ts` > `handleMessage — save recipe intent` > requires household for save
- `app.test.ts` > `handleMessage — auto-detect recipe` > auto-detects long text with ingredient patterns

**Fixes:** None

---

### REQ-RECIPE-002: Save recipes from photos

**Origin:** RS-2 | **Status:** Implemented

When a user sends a photo of a recipe (cookbook page, handwritten card, screenshot), use the LLM vision tier to extract the recipe. Save both the original photo file and the parsed structured recipe. Both must be independently retrievable.

**Standard tests:**
- `photo-parsers.test.ts` > Recipe Photo Parser > extracts structured recipe from photo via LLM vision
- `photo-parsers.test.ts` > Recipe Photo Parser > passes image to LLM with standard tier
- `photo-handler.test.ts` > caption-based routing > routes recipe caption to recipe parser
- `photo-handler.test.ts` > recipe photo — storage > saves photo and recipe to data store

**Edge case tests:**
- `photo-parsers.test.ts` > Recipe Photo Parser > throws on missing required fields
- `photo-parsers.test.ts` > Recipe Photo Parser > throws on invalid JSON from LLM
- `photo-parsers.test.ts` > Recipe Photo Parser > includes caption context when provided
- `photo-handler.test.ts` > error handling > sends friendly error on LLM failure

**Fixes:** None

---

### REQ-RECIPE-003: Recipe confirmation flow

**Origin:** RS-3 | **Status:** Implemented

New recipes start as `draft`. When rated 👍 after cooking, auto-promoted to `confirmed`. When rated 👎, stay as `draft` with rating attached. Confirmation is integrated into the H4 rating flow — no separate confirmation step needed.

**Standard tests:**
- `rating-handler.test.ts` > handleRateCallback > thumbs-up adds rating score 5 and confirms a draft recipe

**Edge case tests:**
- `rating-handler.test.ts` > handleRateCallback > thumbs-down adds rating score 1 and does not change draft status
- `rating-handler.test.ts` > handleRateCallback > thumbs-up on confirmed recipe does not re-confirm

**Fixes:** None

---

### REQ-RECIPE-004: Search and retrieval

**Origin:** RS-4 | **Status:** Implemented

Users can search recipes by free text (title, ingredients, cuisine), tags, cuisine type, rating, cooking history, macro criteria, and combination queries via natural language.

**Standard tests:**
- `recipe-store.test.ts` > `searchRecipes` > searches by text in title
- `recipe-store.test.ts` > `searchRecipes` > searches by ingredient
- `recipe-store.test.ts` > `searchRecipes` > searches by cuisine
- `recipe-store.test.ts` > `searchRecipes` > filters by tag
- `recipe-store.test.ts` > `searchRecipes` > filters by minimum rating
- `recipe-store.test.ts` > `searchRecipes` > filters by protein
- `app.test.ts` > `handleMessage — search intent` > searches recipes by text
- `app.test.ts` > `handleCommand — /recipes` > searches recipes by query

**Edge case tests:**
- `recipe-store.test.ts` > `searchRecipes` > excludes archived recipes
- `recipe-store.test.ts` > `searchRecipes` > respects limit
- `recipe-store.test.ts` > `searchRecipes` > returns empty for no matches
- `recipe-store.test.ts` > `searchRecipes` > filters by maxDaysSinceCooked
- `recipe-store.test.ts` > `searchRecipes` > combines text and tag filters
- `app.test.ts` > `handleMessage — search intent` > handles no results
- `app.test.ts` > `handleCommand — /recipes` > shows empty message when no recipes
- `app.test.ts` > `handleCommand — /recipes` > lists all recipes when no query
- `recipe-store.test.ts` > `formatSearchResults — numbered` > uses numbered list instead of bullets
- `recipe-store.test.ts` > `formatSearchResults — numbered` > includes footer prompt
- `app.test.ts` > `handleMessage — number selection` > shows full recipe when sending number after search
- `app.test.ts` > `handleMessage — number selection` > falls through to intent detection when no cached results
- `app.test.ts` > `handleMessage — search query stripping` > strips "recipes" word from search query
- `app.test.ts` > `handleMessage — error handling` > shows friendly error when loadAllRecipes fails in search
- `app.test.ts` > `handleMessage — error handling` > shows friendly error when loadAllRecipes fails in /recipes

**Fixes:** None

---

### REQ-RECIPE-005: Recipe photo retrieval

**Origin:** RS-5 | **Status:** Implemented

If a recipe was saved from a photo, the user can request the original photo and receive it via Telegram.

**Standard tests:**
- `natural-language.test.ts` > H8 > detects recipe photo intent (5 variants)
- `photo-store.test.ts` > loadPhoto > loads base64 and returns Buffer

**Edge case tests:**
- `natural-language.test.ts` > H8 > does NOT match non-photo-retrieval (5 variants)
- `photo-store.test.ts` > loadPhoto > returns null for missing file

**Fixes:** None

---

### REQ-RECIPE-006: Recipe editing

**Origin:** RS-6 | **Status:** Implemented

Users can update any field on a recipe via natural language (e.g., "add the tag 'picnic' to the chicken salad recipe").

**Standard tests:**
- `recipe-parser.test.ts` > `applyRecipeEdit` > returns updated recipe fields
- `recipe-parser.test.ts` > `applyRecipeEdit` > uses standard tier
- `recipe-store.test.ts` > `updateRecipe` > writes updated recipe with new updatedAt
- `app.test.ts` > `handleMessage — edit intent` > edits recipe via LLM

**Edge case tests:**
- `recipe-parser.test.ts` > `applyRecipeEdit` > throws on invalid JSON response
- `recipe-store.test.ts` > `EDITABLE_RECIPE_FIELDS whitelist` > includes standard editable fields
- `recipe-store.test.ts` > `EDITABLE_RECIPE_FIELDS whitelist` > excludes id, status, createdAt, updatedAt, ratings, history
- `app.test.ts` > `handleMessage — edit intent` > handles edit failure gracefully
- `app.test.ts` > `handleMessage — edit with disambiguation` > shows options when multiple recipes match
- `app.test.ts` > `handleMessage — edit with disambiguation` > proceeds directly with single match
- `app.test.ts` > `handleMessage — edit with no match` > shows helpful message when no recipe matches
- `app.test.ts` > `intent detection — edge cases` > "replace the chicken recipe" triggers edit, not food question

**Fixes:**
- 2026-03-31: Replaced LLM-based recipe identification with local search + sendOptions disambiguation (removes prompt injection surface, saves LLM cost)
- 2026-03-31: Added EDITABLE_RECIPE_FIELDS whitelist — Object.assign replaced with field-level merge

---

## 2. Meal Planning

### REQ-MEAL-001: Plan generation

**Origin:** MP-1 | **Status:** Implemented

Generate a meal plan for the upcoming period respecting configurable meal types, new-to-existing recipe ratio, dietary preferences/restrictions, macro targets, cuisine variety, seasonal produce, and recent cooking history.

**Standard tests:**
- `meal-planner.test.ts` > `generatePlan` > generates a MealPlan from LLM response
- `meal-planner.test.ts` > `generatePlan` > calls LLM with standard tier
- `meal-planner.test.ts` > `generatePlan` > includes location in prompt
- `meal-planner.test.ts` > `generatePlan` > includes dietary preferences in prompt
- `meal-plan-store.test.ts` > `savePlan` > writes to correct path
- `app.test.ts` > `handleCommand — /mealplan` > `/mealplan generate calls LLM and sends plan`

**Edge case tests:**
- `meal-planner.test.ts` > `generatePlan` > throws on LLM failure
- `meal-planner.test.ts` > `generatePlan` > throws on invalid JSON from LLM
- `meal-plan-store.test.ts` > `loadCurrentPlan` > returns null for empty content
- `meal-plan-store.test.ts` > `loadCurrentPlan` > returns null for malformed YAML
- `app.test.ts` > `handleCommand — /mealplan` > shows no-plan message with generate button when no plan exists
- `app.test.ts` > `handleScheduledJob` > generates weekly plan and sends to all members

**Fixes:** None

---

### REQ-MEAL-002: New recipe discovery

**Origin:** MP-2 | **Status:** Implemented

When the plan calls for new recipes, the LLM generates suggestions matching household preferences, dietary needs, and constraints with full recipe details and estimated macros.

**Standard tests:**
- `meal-planner.test.ts` > `generateNewRecipeDetails` > returns a ParsedRecipe from LLM response
- `meal-planner.test.ts` > `generateNewRecipeDetails` > calls LLM with standard tier
- `meal-planner.test.ts` > `swapMeal` > returns a PlannedMeal from LLM response
- `app.test.ts` > `handleMessage — meal swap` > swap happy path: replaces Monday meal, saves plan, sends updated plan

**Edge case tests:**
- `meal-planner.test.ts` > `generateNewRecipeDetails` > throws on LLM failure
- `meal-planner.test.ts` > `swapMeal` > throws on LLM failure
- `app.test.ts` > `handleMessage — meal swap` > swap with no current meal plan tells user to generate one

**Fixes:** None

---

### REQ-MEAL-003: Household voting on meal plans

**Origin:** MP-3 | **Status:** Implemented

All linked household members receive the proposed plan with Telegram inline buttons for upvote/downvote/neutral. After configurable voting window (default 12 hours), finalize plan based on votes. Downvoted recipes get replacement suggestions.

**Standard tests:**
- `voting.test.ts` > recordVote > returns true and records vote when no prior vote exists
- `voting.test.ts` > allMembersVoted > returns true when all members have voted on all meals
- `voting.test.ts` > isVotingExpired > returns true when outside the voting window
- `voting-handler.test.ts` > sendVotingMessages > sends one message per meal per member (2 meals × 2 members = 4 calls)
- `voting-handler.test.ts` > handleVoteCallback > records the vote and edits the message with a confirmation
- `voting-handler.test.ts` > handleFinalizeVotesJob > finalizes plan when voting window has expired

**Edge case tests:**
- `voting.test.ts` > recordVote > returns false when vote is unchanged
- `voting.test.ts` > isVotingExpired > returns false when votingStartedAt is not set
- `voting.test.ts` > allMembersVoted > returns false when a member has not voted on a meal
- `voting-handler.test.ts` > handleVoteCallback > rejects vote with "Voting has ended" when plan not in voting status
- `voting-handler.test.ts` > handleVoteCallback > returns early without editing message when meal date not found
- `voting-handler.test.ts` > handleVoteCallback > ignores invalid vote type
- `voting-handler.test.ts` > handleFinalizeVotesJob > does nothing when no plan exists
- `voting-handler.test.ts` > handleFinalizeVotesJob > does nothing when plan is not in voting status
- `voting-handler.test.ts` > handleFinalizeVotesJob > calls LLM swap for net-negative meals before finalizing
- `voting-handler.test.ts` > handleFinalizeVotesJob > uses default 12-hour window when config not set

**Fixes:** None

---

### REQ-MEAL-004: Post-meal rating

**Origin:** MP-4 | **Status:** Implemented

After a planned meal's cooking window passes, send a message to all household members asking for 👍/👎/skip rating. Store ratings on the recipe object. Use ratings to inform future plan generation.

**Standard tests:**
- `rating.test.ts` > getUncookedMeals > returns meals on or before today that are not cooked
- `rating.test.ts` > createRating > creates a Rating with userId and score
- `rating-handler.test.ts` > handleCookedCallback > marks meal as cooked and shows rate buttons
- `rating-handler.test.ts` > handleRateCallback > thumbs-up adds rating score 5 and confirms a draft recipe
- `rating-handler.test.ts` > handleNightlyRatingPromptJob > sends prompt to all household members for uncooked meals

**Edge case tests:**
- `rating.test.ts` > getUncookedMeals > returns empty array when all past meals are cooked
- `rating.test.ts` > hasRatingPromptBeenSentToday > returns false when lastRatingPromptDate is not set
- `rating-handler.test.ts` > handleCookedCallback > does nothing when meal date is not found in plan
- `rating-handler.test.ts` > handleCookedCallback > shows "already rated" when meal was already rated
- `rating-handler.test.ts` > handleRateCallback > skip marks rated=true with no rating stored
- `rating-handler.test.ts` > handleRateCallback > thumbs-down adds rating score 1 and does not change draft status
- `rating-handler.test.ts` > handleRateCallback > handles missing recipe gracefully (still marks meal rated)
- `rating-handler.test.ts` > handleNightlyRatingPromptJob > is idempotent — skips if already sent today
- `rating-handler.test.ts` > handleNightlyRatingPromptJob > skips when all meals are already cooked

**Fixes:** None

---

### REQ-MEAL-005: "What's for dinner?" resolver

**Origin:** MP-5 | **Status:** Implemented

Any household member can ask "what's for dinner" and get tonight's planned meal, brief prep summary, who's cooking (if assigned), and any prep steps that should have already happened.

**Standard tests:**
- `meal-plan-store.test.ts` > `getTonightsMeal` > returns meal matching the given date
- `meal-plan-store.test.ts` > `getTonightsMeal` > returns the correct meal from multiple options
- `natural-language.test.ts` > `End-to-end: What's for dinner with plan` > shows tonight's meal from the plan

**Edge case tests:**
- `meal-plan-store.test.ts` > `getTonightsMeal` > returns null when no meal matches the date
- `meal-plan-store.test.ts` > `getTonightsMeal` > returns null for empty meal list
- `app.test.ts` > `handleCommand — /whatsfordinner` > shows message when no plan exists

**Fixes:** None

---

### REQ-MEAL-006: Macro nutrient tracking

**Origin:** MP-6 | **Status:** Planned

Track macro nutrients per planned/cooked meal. Store daily macro logs per user. Make data queryable over configurable periods. Support target macros per user with progress tracking.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-MEAL-007: Meal plan configuration

**Origin:** MP-7 | **Status:** Implemented

Expose meal planning configuration as user-configurable settings: meal types, planning period, new recipe ratio, dietary preferences/restrictions, macro targets, plan generation day/time, voting window hours, rating reminder delay.

**Standard tests:**
- `meal-planner.test.ts` > `generatePlan` > includes dietary preferences in prompt
- `meal-planner.test.ts` > `generatePlan` > includes dietary restrictions in prompt
- `app.test.ts` > `handleScheduledJob` > generates weekly plan and sends to all members

**Edge case tests:**
- `meal-planner.test.ts` > `generatePlan` > uses defaults when config keys are missing
- `app.test.ts` > `handleScheduledJob` > skips when no household exists

**Fixes:** None

---

## 3. Grocery Lists

### REQ-GROCERY-001: Recipe-to-grocery conversion

**Origin:** GL-1 | **Status:** Implemented

Given one or more recipes, generate a consolidated grocery list. Ingredients aggregated, exact-merge duplicates, LLM fuzzy dedup (fast tier), department assignment from lookup table. User disambiguates when multiple recipes match via inline buttons with "All of these" option.

**Standard tests:**
- `grocery-generator.test.ts` > generates a grocery list from recipes, excluding staples
- `grocery-generator.test.ts` > aggregates and merges ingredients from multiple recipes
- `grocery-generator.test.ts` > assigns departments to generated grocery items
- `app.test.ts` > intent detection — grocery > detects grocery generate intents

**Edge case tests:**
- `grocery-generator.test.ts` > throws error when no recipes provided
- `grocery-generator.test.ts` > handles empty pantry gracefully
- `grocery-generator.test.ts` > gracefully degrades when LLM dedup fails
- `grocery-generator.test.ts` > adds items to an existing grocery list

**Fixes:** None

---

### REQ-GROCERY-002: Staples handling

**Origin:** GL-2 | **Status:** Implemented

Configurable staples list (from user config `staple_items`, default: salt, pepper, olive oil, butter, garlic). Excluded during recipe-to-grocery conversion with summary shown.

**Standard tests:**
- `grocery-generator.test.ts` > generates a grocery list from recipes, excluding staples
- `grocery-generator.test.ts` > respects custom staple items from config

**Edge case tests:**
- `grocery-generator.test.ts` > uses default staples when config returns undefined
- `grocery-generator.test.ts` > both staples and pantry items are excluded simultaneously

**Fixes:** None

---

### REQ-GROCERY-003: Manual item addition

**Origin:** GL-3 | **Status:** Implemented

Users add items via `/addgrocery` command or natural language ("add milk and eggs to grocery list"). Local regex parser extracts quantity+unit+name, assigns departments from 200+ item lookup table.

**Standard tests:**
- `item-parser.test.ts` > parseManualItems > parses simple item name
- `item-parser.test.ts` > parseManualItems > parses quantity and unit
- `item-parser.test.ts` > parseManualItems > parses comma-separated items
- `app.test.ts` > handleCommand — /addgrocery > adds items and confirms
- `app.test.ts` > intent detection — grocery > detects grocery add intents

**Edge case tests:**
- `item-parser.test.ts` > parseManualItems > returns empty for empty input
- `item-parser.test.ts` > parseManualItems > filters out whitespace-only items
- `item-parser.test.ts` > parseManualItems > parses decimal quantities
- `item-parser.test.ts` > parseManualItems > handles "and" separator
- `app.test.ts` > handleCommand — /addgrocery > shows usage when no args

**Fixes:** None

---

### REQ-GROCERY-004: Photo-to-grocery-list

**Origin:** GL-4 | **Status:** Implemented

Extract ingredients from a photo of a recipe via LLM vision and generate a grocery list. Offer to save the recipe as well.

**Standard tests:**
- `photo-parsers.test.ts` > Grocery Photo Parser > extracts grocery items from photo via LLM vision
- `photo-parsers.test.ts` > Grocery Photo Parser > passes image to LLM with standard tier
- `photo-parsers.test.ts` > Grocery Photo Parser > detects recipe photos and extracts recipe data
- `photo-handler.test.ts` > caption-based routing > routes grocery list caption to grocery parser

**Edge case tests:**
- `photo-parsers.test.ts` > Grocery Photo Parser > returns empty items on parse failure

**Fixes:** None

---

### REQ-GROCERY-005: Shared grocery list

**Origin:** GL-5 | **Status:** Implemented

All household members share one grocery list via shared data store. Inline keyboard refresh button shows partner's changes.

**Standard tests:**
- `grocery-store.test.ts` > loadGroceryList > parses valid YAML
- `grocery-store.test.ts` > saveGroceryList > writes with correct path and frontmatter
- `app.test.ts` > handleCommand — /grocery > sends buttons when list has items

**Edge case tests:**
- `grocery-store.test.ts` > loadGroceryList > returns null for empty store
- `grocery-store.test.ts` > loadGroceryList > returns null on malformed YAML
- `app.test.ts` > handleCommand — /grocery > requires household

**Fixes:** None

---

### REQ-GROCERY-006: Duplicate removal

**Origin:** GL-6 | **Status:** Implemented

Two-tier dedup: exact-match merge (local, free) merges same-name/same-unit items with quantity addition. LLM fuzzy dedup (fast tier) for similar items ("chicken breast" vs "boneless chicken") with department assignment.

**Standard tests:**
- `grocery-store.test.ts` > addItems > deduplicates by name (case-insensitive)
- `grocery-store.test.ts` > addItems > merges quantities when same unit
- `grocery-dedup.test.ts` > returns merged and reassigned items from LLM
- `grocery-dedup.test.ts` > preserves recipeIds and addedBy from original items

**Edge case tests:**
- `grocery-store.test.ts` > addItems > does not merge quantities when different units
- `grocery-store.test.ts` > addItems > resets purchased on re-add
- `grocery-dedup.test.ts` > skips LLM for single item with known department
- `grocery-dedup.test.ts` > returns items unchanged when LLM throws
- `grocery-dedup.test.ts` > returns items unchanged when LLM returns empty array
- `grocery-dedup.test.ts` > uses sentinel values when LLM returns unrecognized name

**Fixes:** None

---

### REQ-GROCERY-007: Retrieve current list

**Origin:** GL-7 | **Status:** Implemented

`/grocery` command or "show grocery list" intent displays department-grouped list with inline keyboard checkboxes.

**Standard tests:**
- `grocery-store.test.ts` > formatGroceryMessage > groups items by department
- `grocery-store.test.ts` > formatGroceryMessage > shows check marks for purchased
- `grocery-store.test.ts` > buildGroceryButtons > creates one button per item
- `grocery-store.test.ts` > buildGroceryButtons > includes control row
- `app.test.ts` > handleCommand — /grocery > sends buttons when list has items
- `app.test.ts` > intent detection — grocery > detects grocery view intents

**Edge case tests:**
- `grocery-store.test.ts` > formatGroceryMessage > shows empty message
- `grocery-store.test.ts` > buildGroceryButtons > handles empty list
- `app.test.ts` > handleCommand — /grocery > shows empty message when no list exists

**Fixes:** None

---

### REQ-GROCERY-008: Interactive shopping mode

**Origin:** GL-8 | **Status:** Implemented

Tap-to-toggle inline keyboard buttons. Each item tap toggles purchased status and updates display in-place via `editMessage`. Control row: Refresh (re-reads for partner changes), Clear purchased, Move to pantry (with confirmation).

**Standard tests:**
- `grocery-store.test.ts` > togglePurchased > toggles item on
- `grocery-store.test.ts` > togglePurchased > toggles item off
- `grocery-store.test.ts` > clearPurchased > separates purchased from remaining
- `app.test.ts` > handleCallbackQuery > toggles item and edits message
- `app.test.ts` > handleCallbackQuery > handles refresh callback
- `app.test.ts` > handleCallbackQuery > handles clear callback

**Edge case tests:**
- `grocery-store.test.ts` > togglePurchased > no-op for out-of-bounds index
- `grocery-store.test.ts` > clearPurchased > empty when none purchased
- `app.test.ts` > handleCallbackQuery > ignores invalid toggle index
- `app.test.ts` > handleCallbackQuery > ignores toggle:NaN
- `app.test.ts` > handleCallbackQuery > ignores negative toggle index
- `app.test.ts` > handleCallbackQuery > ignores unknown callback data
- `app.test.ts` > handleCallbackQuery > pantry-prompt with no purchased items sends guidance
- `app.test.ts` > handleCallbackQuery > pantry-prompt with purchased items shows confirmation
- `app.test.ts` > handleCallbackQuery > pantry-all with no pending items shows "No items"
- `app.test.ts` > handleCallbackQuery > handles pantry-skip and returns to grocery list
- `app.test.ts` > handleCallbackQuery > callback handler catches and logs errors
- `app.test.ts` > handleCallbackQuery > requires household membership
- `telegram-buttons.test.ts` > sendWithButtons builds keyboard and returns IDs
- `telegram-buttons.test.ts` > editMessage handles "not modified" error gracefully

**Fixes:** None

---

### REQ-GROCERY-009: Shopping follow-up

**Origin:** GL-9 | **Status:** Implemented

After clearing purchased items, if items remain on the grocery list, a 1-hour follow-up is scheduled. The follow-up asks "Done shopping?" with options to clear remaining items or keep them for the next trip.

**Standard tests:**
- `shopping-followup.test.ts` > handleShoppingFollowupJob > sends follow-up message when unpurchased items remain
- `shopping-followup.test.ts` > handleShopFollowupClearCallback > archives remaining items and saves empty list
- `shopping-followup.test.ts` > handleShopFollowupKeepCallback > edits the message to confirm items are kept

**Edge case tests:**
- `shopping-followup.test.ts` > re-scheduling > cancels the previous timer and starts a fresh one
- `shopping-followup.test.ts` > handleShoppingFollowupJob > does nothing when no pending data
- `shopping-followup.test.ts` > cancelShoppingFollowup > prevents the timer from firing
- `shopping-followup.test.ts` > handleShoppingFollowupJob > shows max 10 items and adds "...and X more"
- `shopping-followup.test.ts` > handleShopFollowupClearCallback > edits message even when grocery list is missing

**Fixes:** None

---

### REQ-GROCERY-010: Store-aware pricing

**Origin:** GL-10 | **Status:** Planned

Grocery lists configurable by store. Show estimated prices per item and total per store for comparison. Support "shopping at" context. Price data from LLM knowledge refined with user-reported actuals.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-GROCERY-011: Store configuration

**Origin:** GL-11 | **Status:** Planned

Expose store-related settings: preferred stores, default store, show price estimates, staple items, shopping follow-up hours.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 4. Pantry & Inventory Awareness

### REQ-PANTRY-001: Pantry tracker

**Origin:** PI-1 | **Status:** Implemented

Maintain pantry inventory via text input ("add eggs and milk to pantry"), grocery purchase inference (move purchased items to pantry), and `/pantry` command for viewing. Quantity+unit extracted from text.

**Standard tests:**
- `pantry-store.test.ts` > loadPantry > parses YAML array format
- `pantry-store.test.ts` > loadPantry > parses { items: [...] } object format
- `pantry-store.test.ts` > savePantry > calls store.write
- `pantry-store.test.ts` > addPantryItems > adds new items
- `pantry-store.test.ts` > addPantryItems > updates existing (case-insensitive)
- `pantry-store.test.ts` > removePantryItem > removes by name
- `pantry-store.test.ts` > groceryToPantryItems > converts with quantity formatting
- `pantry-store.test.ts` > formatPantry > groups items by category
- `pantry-store.test.ts` > parsePantryItems > comma/and separated
- `app.test.ts` > handleCommand — /pantry > shows pantry contents
- `app.test.ts` > intent detection — pantry > detects pantry view/add/remove intents
- `photo-parsers.test.ts` > Pantry Photo Parser > identifies pantry items from photo via LLM vision
- `photo-parsers.test.ts` > Pantry Photo Parser > passes image to LLM with standard tier
- `photo-handler.test.ts` > caption-based routing > routes pantry caption to pantry parser

**Edge case tests:**
- `pantry-store.test.ts` > loadPantry > empty store returns []
- `pantry-store.test.ts` > loadPantry > malformed YAML returns []
- `pantry-store.test.ts` > removePantryItem > no match returns unchanged
- `pantry-store.test.ts` > formatPantry > shows empty message
- `pantry-store.test.ts` > pantryContains > rejects short substrings (prevents false positives)
- `pantry-store.test.ts` > pantryContains > matches close-length substrings
- `pantry-store.test.ts` > pantryContains > returns false for empty pantry
- `app.test.ts` > handleCommand — /pantry > requires household
- `photo-parsers.test.ts` > Pantry Photo Parser > returns empty array for empty/unclear photo
- `photo-parsers.test.ts` > Pantry Photo Parser > normalizes items with missing category

**Fixes:** None

---

### REQ-PANTRY-002: "What can I make?" queries

**Origin:** PI-2 | **Status:** Implemented

Cross-reference pantry inventory against recipe library and return full matches and close matches noting what's missing.

**Standard tests:**
- `pantry-matcher.test.ts` > `findMatchingRecipes` > returns full and near matches from LLM response
- `pantry-matcher.test.ts` > `findMatchingRecipes` > enriches full matches with prepTime from recipe data
- `pantry-matcher.test.ts` > `findMatchingRecipes` > uses fast tier LLM
- `app.test.ts` > `handleMessage — meal planning intents` > "what can I make" routes to pantry matcher

**Edge case tests:**
- `pantry-matcher.test.ts` > `findMatchingRecipes` > returns empty results without calling LLM when pantry is empty
- `pantry-matcher.test.ts` > `findMatchingRecipes` > returns empty results without calling LLM when recipes is empty
- `pantry-matcher.test.ts` > `findMatchingRecipes` > returns empty results on LLM error (graceful degradation)
- `natural-language.test.ts` > `End-to-end: What can I make with pantry and recipes` > calls LLM and sends match results

**Fixes:** None

---

### REQ-PANTRY-003: Auto-exclude from grocery lists

**Origin:** PI-3 | **Status:** Implemented

When generating grocery list, pantry items excluded with 60%+ length-ratio matching to prevent false positives. Excluded items listed in result summary.

**Standard tests:**
- `grocery-generator.test.ts` > excludes pantry items and lists them in excludedPantry
- `pantry-store.test.ts` > pantryContains > matches exact name
- `pantry-store.test.ts` > pantryContains > matches case-insensitively

**Edge case tests:**
- `pantry-store.test.ts` > pantryContains > rejects short substrings (prevents false positives)
- `grocery-generator.test.ts` > handles empty pantry gracefully
- `grocery-generator.test.ts` > both staples and pantry items are excluded simultaneously

**Fixes:** None

---

### REQ-PANTRY-004: Perishable expiry alerts

**Origin:** PI-4 | **Status:** Implemented

Daily 9am check for pantry items with `expiryEstimate` within 2 days. Alerts sent to all household members with Freeze/Toss/Still Good action buttons. "Move to Freezer" performs cross-store operation (removes from pantry, adds to freezer). LLM estimates expiry for perishable categories (Produce, Dairy & Eggs, Meat & Seafood, Bakery) when items are added to pantry via the grocery-to-pantry flow. Name verification in callback data prevents wrong-item mutations from concurrent use.

**Standard tests:**
- `perishable-handler.test.ts` > handlePerishableCallback > freeze removes item from pantry and adds to freezer
- `perishable-handler.test.ts` > handlePerishableCallback > ok just edits message with no data change
- `perishable-handler.test.ts` > handlePerishableCallback > toss removes from pantry and logs waste
- `perishable-handler.test.ts` > handlePerishableCheckJob > sends alert for items expiring within 2 days
- `perishable-handler.test.ts` > handlePerishableCheckJob > sends to all household members
- `pantry-store.test.ts` > expiry estimation > enrichWithExpiry adds expiryEstimate to perishable items
- `pantry-store.test.ts` > expiry estimation > isPerishableCategory returns true for perishable categories

**Edge case tests:**
- `perishable-handler.test.ts` > handlePerishableCheckJob > skips items without expiryEstimate
- `perishable-handler.test.ts` > handlePerishableCheckJob > sends nothing when no items expiring
- `perishable-handler.test.ts` > handlePerishableCheckJob > skips when no household
- `perishable-handler.test.ts` > handlePerishableCheckJob > uses pantry index for callback data
- `perishable-handler.test.ts` > security > rejects freeze when item name does not match
- `perishable-handler.test.ts` > security > rejects toss when item name does not match
- `pantry-store.test.ts` > expiry estimation > skips items that already have expiryEstimate
- `pantry-store.test.ts` > expiry estimation > defaults to no expiry on LLM failure
- `pantry-store.test.ts` > expiry estimation > isPerishableCategory returns false for shelf-stable

**Fixes:** None

---

### REQ-PANTRY-005: Freezer inventory

**Origin:** PI-5 | **Status:** Implemented

`/freezer` command shows inventory with age warnings (3+ months). Items added via command, natural language ("add chicken to freezer"), or transferred from leftovers/pantry. Thaw/Toss inline buttons per item with name verification to prevent wrong-item mutations. Monday 9am check job alerts household on aging items (3+ months). Waste logging on toss. YAML storage at `freezer.yaml` in shared scope.

**Standard tests:**
- `freezer-store.test.ts` > loadFreezer > parses { items: [...] } format
- `freezer-store.test.ts` > saveFreezer > writes YAML with frontmatter
- `freezer-store.test.ts` > addFreezerItem > adds new item
- `freezer-store.test.ts` > removeFreezerItem > removes item by index
- `freezer-store.test.ts` > formatFreezerList > formats items with source info
- `freezer-store.test.ts` > buildFreezerButtons > creates thaw and toss buttons with name
- `freezer-store.test.ts` > parseFreezerInput > extracts name and quantity
- `freezer-handler.test.ts` > handleFreezerCallback > thaw removes item, confirms
- `freezer-handler.test.ts` > handleFreezerCallback > toss removes item and logs waste
- `freezer-handler.test.ts` > handleFreezerCheckJob > sends reminder for 3+ month items
- `natural-language.test.ts` > H6 > routes "add chicken to the freezer" to freezer add
- `natural-language.test.ts` > H6 > routes "what's in the freezer?" to freezer view

**Edge case tests:**
- `freezer-store.test.ts` > loadFreezer > returns empty for null, malformed YAML
- `freezer-store.test.ts` > addFreezerItem > updates existing with same name
- `freezer-store.test.ts` > removeFreezerItem > returns unchanged for invalid index
- `freezer-store.test.ts` > getAgingFreezerItems > inclusive boundary at threshold
- `freezer-store.test.ts` > formatFreezerList > returns empty message for no items
- `freezer-handler.test.ts` > handleFreezerCheckJob > sends nothing when no aging items
- `freezer-handler.test.ts` > handleFreezerCheckJob > skips when no household

**Fixes:** None

---

## 5. Leftover & Waste Reduction

### REQ-WASTE-001: Leftover tracking

**Origin:** LW-1 | **Status:** Implemented

Log leftovers via `/leftovers` command, natural language ("we have leftover chili"), or post-meal prompt after rating/cooking. LLM estimates fridge shelf life (defaults to 3 days on failure). Use/Freeze/Toss inline buttons per item. Status transitions: active → used/frozen/wasted. Post-rating and post-cook leftover prompts pass recipe title through callback data for `fromRecipe` tracking. Name verification in callbacks prevents double-action and wrong-item mutations. YAML storage at `leftovers.yaml` in shared scope.

**Standard tests:**
- `leftover-store.test.ts` > loadLeftovers > parses { items: [...] } format
- `leftover-store.test.ts` > saveLeftovers > writes YAML with frontmatter
- `leftover-store.test.ts` > addLeftover > adds new leftover
- `leftover-store.test.ts` > updateLeftoverStatus > transitions status at index
- `leftover-store.test.ts` > getActiveLeftovers > filters to active only
- `leftover-store.test.ts` > formatLeftoverList > formats with expiry indicators
- `leftover-store.test.ts` > buildLeftoverButtons > creates Use/Freeze/Toss buttons
- `leftover-store.test.ts` > parseLeftoverInput > extracts name and quantity
- `leftover-handler.test.ts` > handleLeftoverCallback > use marks used
- `leftover-handler.test.ts` > handleLeftoverCallback > freeze marks frozen and creates freezer item
- `leftover-handler.test.ts` > handleLeftoverCallback > toss marks wasted and logs waste
- `natural-language.test.ts` > H6 > routes "we have leftover chili" to leftover add
- `natural-language.test.ts` > H6 > routes "any leftovers?" to leftover view

**Edge case tests:**
- `leftover-store.test.ts` > loadLeftovers > returns empty for null, malformed YAML, frontmatter
- `leftover-store.test.ts` > addLeftover > dedup by name case-insensitive
- `leftover-store.test.ts` > updateLeftoverStatus > returns unchanged for invalid index
- `leftover-store.test.ts` > getExpiringLeftovers > includes already-expired items
- `leftover-store.test.ts` > formatLeftoverList > shows ⚠️ for tomorrow, ❌ for today/past
- `leftover-handler.test.ts` > security > rejects callback with name mismatch
- `leftover-handler.test.ts` > security > rejects double-action on used/frozen/wasted items
- `leftover-handler.test.ts` > state transitions > freeze creates freezer item with fromRecipe
- `leftover-handler.test.ts` > state transitions > auto-expire creates waste log entry

**Fixes:** None

---

### REQ-WASTE-002: Leftover meal suggestions

**Origin:** LW-2 | **Status:** Planned

Proactively suggest meals that use tracked leftovers. Suggestions sent as scheduled nudges or on-demand.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-WASTE-003: Use-or-freeze nudges

**Origin:** LW-3 | **Status:** Implemented

Daily 10am leftover check job auto-wastes expired leftovers and sends "freeze it or lose it" alerts for items expiring today/tomorrow. Action buttons: Freeze/Eat/Toss for today, Freeze/Got it for tomorrow. Expired items logged to waste log automatically. Alerts sent to all household members.

**Standard tests:**
- `leftover-handler.test.ts` > handleLeftoverCheckJob > auto-wastes expired items
- `leftover-handler.test.ts` > handleLeftoverCheckJob > sends alert for expiring items
- `leftover-handler.test.ts` > handleLeftoverCheckJob > handles mix of expired, today, tomorrow
- `leftover-handler.test.ts` > handleLeftoverCheckJob > sends to all household members

**Edge case tests:**
- `leftover-handler.test.ts` > handleLeftoverCheckJob > sends nothing when no active leftovers
- `leftover-handler.test.ts` > handleLeftoverCheckJob > skips when no household
- `leftover-handler.test.ts` > handleLeftoverCheckJob > no-op when nothing expiring

**Fixes:** None

---

### REQ-WASTE-004: Waste tracking

**Origin:** LW-4 | **Status:** Implemented

Append-only waste log at `waste-log.yaml`. Automatic logging when leftovers expire (daily check job) or items are tossed via buttons. Natural language waste logging ("the milk went bad") with pantry auto-removal. Input sanitized before storage. Each entry tracks name, quantity, reason (expired/spoiled/discarded), source (leftover/pantry/freezer), and date.

**Standard tests:**
- `waste-store.test.ts` > loadWasteLog > parses { entries: [...] } format
- `waste-store.test.ts` > appendWaste > adds entry to empty log
- `waste-store.test.ts` > appendWaste > appends to existing entries
- `waste-store.test.ts` > formatWasteSummary > formats entries with reason emojis
- `natural-language.test.ts` > H6 > routes "the milk went bad" to waste logging
- `natural-language.test.ts` > H6 > routes "threw out the old rice" to waste logging

**Edge case tests:**
- `waste-store.test.ts` > loadWasteLog > returns empty for null, malformed YAML
- `waste-store.test.ts` > loadWasteLog > strips frontmatter
- `waste-store.test.ts` > formatWasteSummary > returns empty message for no entries
- `natural-language.test.ts` > H6 > waste intent removes matching item from pantry

**Fixes:** None

---

## 6. Toddler & Family Meal Adaptation

### REQ-FAMILY-001: Kid-friendly adaptation

**Origin:** TF-1 | **Status:** Planned

For any recipe, generate LLM-based adaptation for the child: what to set aside before spice/heat, chopping/texture guidance for age, allergen flags, portion size guidance.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-FAMILY-002: Child approval tagging

**Origin:** TF-2 | **Status:** Planned

Track which recipes the child actually eats vs rejects. Tag recipes as approved/rejected. Feed into meal planning weighting.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-FAMILY-003: Baby food introduction tracker

**Origin:** TF-3 | **Status:** Planned

Track food introductions for baby: log new foods with date, flag recommended wait periods between allergens, alert if too soon, maintain history with reactions.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-FAMILY-004: Family member configuration

**Origin:** TF-4 | **Status:** Planned

Expose family-related settings: children profiles, child meal adaptation toggle, allergen wait days.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 7. Batch Cooking & Meal Prep Intelligence

### REQ-BATCH-001: Shared prep component detection

**Origin:** BC-1 | **Status:** Implemented (Phase H7)

Analyze finalized meal plan for shared prep components across recipes and suggest batch preparation.

**Standard tests:**
- `batch-cooking.test.ts` > `analyzeBatchPrep` > calls LLM with recipe details and returns parsed analysis
- `batch-cooking.test.ts` > `analyzeBatchPrep` > includes new/external suggestions with just title, no ingredients
- `natural-language.test.ts` > `H7: Batch prep analysis` > "plan meals for the week" → sends batch prep analysis after the plan
- `natural-language.test.ts` > `H7: Batch prep analysis` > "create a new meal plan" → batch prep message includes shared tasks

**Edge case tests:**
- `batch-cooking.test.ts` > `analyzeBatchPrep` > returns null when LLM fails
- `batch-cooking.test.ts` > `analyzeBatchPrep` > returns null when LLM returns invalid JSON
- `natural-language.test.ts` > `H7: Batch prep analysis` > "make a meal plan" → still delivers plan even if batch prep LLM fails
- `natural-language.test.ts` > `H7: Batch prep analysis` > "plan our dinners" → batch prep not sent when LLM returns invalid JSON

**Security tests:**
- `natural-language.test.ts` > `H7: Batch prep analysis` > "plan meals for next week" → batch prep sanitizes recipe content in LLM prompt

**Fixes:** None

---

### REQ-BATCH-002: Consolidated prep plan

**Origin:** BC-2 | **Status:** Implemented (Phase H7)

Generate prep plan for configurable prep day that consolidates shared work, orders by timing, and estimates total prep time.

**Standard tests:**
- `batch-cooking.test.ts` > `formatBatchPrepMessage` > formats shared tasks with recipes and time savings
- `batch-cooking.test.ts` > `formatBatchPrepMessage` > includes freezer-friendly suggestions when present
- `natural-language.test.ts` > `H7: Batch prep analysis` > "generate meal plan" → batch prep includes "double & freeze" suggestion

**Edge case tests:**
- `batch-cooking.test.ts` > `formatBatchPrepMessage` > omits freezer-friendly section when empty
- `batch-cooking.test.ts` > `formatBatchPrepMessage` > handles empty shared tasks gracefully

**Fixes:** None

---

### REQ-BATCH-003: Freezer-friendly flagging

**Origin:** BC-3 | **Status:** Implemented (Phase H7)

Flag freezer-friendly recipes, suggest doubling and freezing extra, log frozen portion in freezer inventory via inline keyboard buttons.

**Standard tests:**
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > matches freezer items to recipe ingredients (case-insensitive)
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > matches substring (ingredient name contains freezer item name)
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > matches when freezer item name contains ingredient name
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > handles multiple matches across meals
- `batch-cooking.test.ts` > `buildBatchFreezeButtons` > builds one button row per freezer-friendly recipe using numeric index
- `natural-language.test.ts` > `H7: Batch freeze callback` > tapping "Double & freeze: Pasta Bolognese" → logs frozen batch in freezer
- `natural-language.test.ts` > `H7: Batch freeze callback` > tapping freeze button saves item with source and "doubled batch" label

**Edge case tests:**
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > returns empty when no matches found
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > returns empty when freezer is empty
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > skips meals with no matching recipe in library
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > does not match when term appears mid-word (no word boundary)
- `batch-cooking.test.ts` > `matchFreezerToRecipes` > matches when term is at a word boundary
- `batch-cooking.test.ts` > `buildBatchFreezeButtons` > returns empty array when no recipes
- `batch-cooking.test.ts` > `buildBatchFreezeButtons` > callback data stays within Telegram 64-byte limit even with long recipe names
- `natural-language.test.ts` > `H7: Batch freeze callback` > expired or unknown index shows friendly expiry message
- `natural-language.test.ts` > `H7: Batch freeze callback` > non-household member cannot use batch freeze button

**Fixes:**
- 2026-04-03: Switched callback data from URL-encoded recipe names to numeric indices to stay within Telegram's 64-byte callback data limit
- 2026-04-03: Added word-boundary matching to prevent false positives (e.g., "ice" no longer matches "rice")

---

### REQ-BATCH-004: Defrost reminders

**Origin:** BC-4 | **Status:** Implemented (Phase H7)

When meal plan includes frozen ingredients, send reminder the night before to defrost.

**Standard tests:**
- `batch-cooking.test.ts` > `checkDefrostNeeded` > sends reminder when tomorrow's meal uses frozen ingredient
- `batch-cooking.test.ts` > `checkDefrostNeeded` > consolidates multiple frozen items into one message
- `batch-cooking.test.ts` > `formatDefrostMessage` > formats single defrost item
- `batch-cooking.test.ts` > `formatDefrostMessage` > formats multiple defrost items
- `natural-language.test.ts` > `H7: Defrost check` > sends defrost reminder when tomorrow dinner uses a frozen item
- `natural-language.test.ts` > `H7: Defrost check` > defrost message tells you which meal the frozen item is for
- `natural-language.test.ts` > `H7: Defrost check` > multiple frozen items matching same meal are consolidated into one message

**Edge case tests:**
- `batch-cooking.test.ts` > `checkDefrostNeeded` > does not send when no frozen ingredients match
- `batch-cooking.test.ts` > `checkDefrostNeeded` > does not send when freezer is empty
- `batch-cooking.test.ts` > `checkDefrostNeeded` > does not send when no meals planned for tomorrow
- `batch-cooking.test.ts` > `checkDefrostNeeded` > does not send when household is null
- `natural-language.test.ts` > `H7: Defrost check` > does not send defrost reminder when no frozen items match tomorrow
- `natural-language.test.ts` > `H7: Defrost check` > does not send when freezer is empty
- `natural-language.test.ts` > `H7: Defrost check` > does not send when no meal plan exists
- `natural-language.test.ts` > `H7: Defrost check` > does not crash when no household is set up

**Fixes:** None

---

## 8. Cooking Execution Support

### REQ-COOK-001: Cook mode

**Origin:** CE-1 | **Status:** Implemented (Phase H5a)

Step-by-step cooking guidance via Telegram: send first step, advance with "next"/"n"/button, go back with "back"/"previous", repeat current step, show progress indicator. Recipe selection via search buttons when not found. 24h inactivity timeout.

**Standard tests:**
- `cook-session.test.ts` > `createSession` > creates a session with correct fields
- `cook-session.test.ts` > `createSession` > stores the session in the map
- `cook-session.test.ts` > `getSession` > returns the session for an active user
- `cook-session.test.ts` > `advanceStep` > advances from step 0 to step 1
- `cook-session.test.ts` > `advanceStep` > advances through all steps sequentially
- `cook-session.test.ts` > `goBack` > goes back from step 2 to step 1
- `cook-session.test.ts` > `endSession` > removes the session from the map
- `cook-session.test.ts` > `formatStepMessage` > shows 1-indexed step number and progress
- `cook-session.test.ts` > `formatStepMessage` > shows correct step after advancing
- `cook-session.test.ts` > `buildStepButtons` > returns a row with 4 buttons
- `cook-session.test.ts` > `buildStepButtons` > uses ck: callback data prefix
- `cook-session.test.ts` > `formatCompletionMessage` > includes recipe title
- `cook-mode-handler.test.ts` > `handleCookCommand` > sends servings prompt when recipe found
- `cook-mode-handler.test.ts` > `handleCookCallback` > advances step on ck:n
- `cook-mode-handler.test.ts` > `handleCookCallback` > goes back on ck:b
- `cook-mode-handler.test.ts` > `handleCookCallback` > repeats current step on ck:r
- `cook-mode-handler.test.ts` > `handleCookCallback` > ends session on ck:d
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and advances on "next"
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and goes back on "back"
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and goes back on "previous"
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and repeats on "repeat"
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and ends on "done"
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns true and ends on "exit"

**Edge case tests:**
- `cook-session.test.ts` > `getSession` > returns null for a user with no session
- `cook-session.test.ts` > `advanceStep` > returns completed when advancing past last step
- `cook-session.test.ts` > `goBack` > returns at_start when already at step 0
- `cook-session.test.ts` > `endSession` > does not error when ending a non-existent session
- `cook-session.test.ts` > `touchSession` > updates lastActivityAt
- `cook-session.test.ts` > `isSessionExpired` > returns false for a fresh session
- `cook-session.test.ts` > `isSessionExpired` > returns true for a session inactive for 25 hours
- `cook-session.test.ts` > `cleanExpiredSessions` > removes expired sessions and keeps active ones
- `cook-session.test.ts` > `cleanExpiredSessions` > returns 0 when no sessions are expired
- `cook-session.test.ts` > `multi-user isolation` > maintains independent sessions for different users
- `cook-session.test.ts` > `single-step recipe` > completes immediately on advance
- `cook-session.test.ts` > `getSessionCount` > returns the number of active sessions
- `cook-mode-handler.test.ts` > `handleCookCommand` > shows search results as buttons when recipe not found by title but has search matches
- `cook-mode-handler.test.ts` > `handleCookCommand` > shows no-match message when no search results
- `cook-mode-handler.test.ts` > `handleCookCommand` > sends error when no household exists
- `cook-mode-handler.test.ts` > `handleCookCommand` > warns when already in cook mode
- `cook-mode-handler.test.ts` > `handleCookCommand` > shows recipe selection buttons when no recipe name given
- `cook-mode-handler.test.ts` > `handleCookCommand` > handles recipe selection callback
- `cook-mode-handler.test.ts` > `handleCookCallback` > shows completion when advancing past last step
- `cook-mode-handler.test.ts` > `handleCookCallback` > sends friendly message when going back from step 1
- `cook-mode-handler.test.ts` > `handleCookCallback` > ignores callback when no active session
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns false for non-cook text
- `cook-mode-handler.test.ts` > `handleCookTextAction` > returns false when no active session
- `cook-mode-handler.test.ts` > `single-step recipe` > completes immediately on next

**Fixes:** None

---

### REQ-COOK-002: Timer integration

**Origin:** CE-2 | **Status:** Implemented (Phase H5b)

Regex-based time detection in recipe steps (compound, range, approximate, simple, seconds). "Set Timer" button appears when timing detected. setTimeout-based timer with auto-cancel on step navigation. Timer fire sends Telegram notification with Next button. One timer per session, new replaces old. TTS announcement on fire when hands-free enabled.

**Standard tests:**
- `timer-parser.test.ts` > `parseStepTimer` > parses "bake for 25 minutes"
- `timer-parser.test.ts` > `parseStepTimer` > parses compound "1 hour 30 minutes"
- `timer-parser.test.ts` > `parseStepTimer` > parses range "5-7 minutes" as midpoint
- `timer-parser.test.ts` > `parseStepTimer` > parses "about 20 minutes"
- `timer-parser.test.ts` > `parseStepTimer` > parses "30 sec" as fractional minutes
- `timer-parser.test.ts` > `formatDuration` > formats minutes, hours, seconds
- `cook-timer.test.ts` > timer set > sets timer and sends confirmation
- `cook-timer.test.ts` > timer set > fires notification after duration
- `cook-timer.test.ts` > timer cancel > cancels and restores buttons
- `cook-timer.test.ts` > auto-cancel > cancels on next/back/done navigation
- `cook-session.test.ts` > buildStepButtons with timer > returns 2 rows when timer provided
- `cook-session.test.ts` > buildStepButtons with timer > shows cancel button when active timer

**Edge case tests:**
- `timer-parser.test.ts` > `parseStepTimer` > returns null for step without timing
- `timer-parser.test.ts` > `parseStepTimer` > ignores temperature references
- `cook-timer.test.ts` > timer set > does nothing when step has no timing
- `cook-timer.test.ts` > timer set > replaces existing timer
- `cook-timer.test.ts` > timer fire with TTS > speaks when enabled, skips when disabled

**Fixes:** None

---

### REQ-COOK-003: TTS / Chromecast support

**Origin:** CE-3 | **Status:** Implemented (Phase H5b)

Hands-free mode prompt after ingredients shown. Yes/No buttons (ck:hf:y/n). Each step spoken via AudioService.speak(). Device from user config cooking_speaker_device. Best-effort non-blocking: audio failure logged, text continues. Auto-enable when hands_free_default config is true. Graceful skip when audio service unavailable.

**Standard tests:**
- `cook-tts.test.ts` > hands-free prompt > shows prompt when audio available
- `cook-tts.test.ts` > hands-free prompt > skips prompt when hands_free_default true
- `cook-tts.test.ts` > hands-free prompt > skips prompt when audio unavailable
- `cook-tts.test.ts` > hands-free callbacks > ck:hf:y enables TTS and speaks first step
- `cook-tts.test.ts` > hands-free callbacks > ck:hf:n disables TTS
- `cook-tts.test.ts` > hands-free callbacks > uses configured speaker device
- `cook-tts.test.ts` > hands-free callbacks > TTS failure does not prevent step display

**Edge case tests:** None

**Fixes:** None

---

### REQ-COOK-004: Recipe scaling in cook mode

**Origin:** CE-4 | **Status:** Implemented (Phase H5a)

Before starting cook mode, ask serving count. Parse "4", "double", "half", "quarter", "triple", "N servings". Scale ingredients linearly. Use LLM for non-linear scaling notes (spices, baking chemistry, timing).

**Standard tests:**
- `recipe-scaler.test.ts` > `parseServingsInput` > parses a bare number
- `recipe-scaler.test.ts` > `parseServingsInput` > parses "double"
- `recipe-scaler.test.ts` > `parseServingsInput` > parses "half"
- `recipe-scaler.test.ts` > `parseServingsInput` > parses "triple"
- `recipe-scaler.test.ts` > `parseServingsInput` > parses "quarter"
- `recipe-scaler.test.ts` > `parseServingsInput` > parses "3 servings"
- `recipe-scaler.test.ts` > `scaleIngredients` > doubles quantities when scaling 2x
- `recipe-scaler.test.ts` > `scaleIngredients` > halves quantities when scaling 0.5x
- `recipe-scaler.test.ts` > `scaleIngredients` > returns unchanged quantities when scaling 1x
- `recipe-scaler.test.ts` > `scaleIngredients` > preserves all other ingredient fields
- `recipe-scaler.test.ts` > `scaleIngredients` > handles multiple ingredients
- `recipe-scaler.test.ts` > `formatScaledIngredients` > formats scaled ingredients with original quantities shown
- `recipe-scaler.test.ts` > `formatScaledIngredients` > includes scaling notes when provided
- `recipe-scaler.test.ts` > `generateScalingNotes` > calls LLM with recipe details and returns notes
- `recipe-scaler.test.ts` > `generateScalingNotes` > includes recipe title and ingredients in the LLM prompt
- `recipe-scaler.test.ts` > `generateScalingNotes` > uses standard tier
- `cook-mode-handler.test.ts` > `handleServingsReply` > creates session and sends first step for valid servings
- `cook-mode-handler.test.ts` > `handleServingsReply` > scales when user says "double"

**Edge case tests:**
- `recipe-scaler.test.ts` > `parseServingsInput` > returns null for zero
- `recipe-scaler.test.ts` > `parseServingsInput` > returns null for negative
- `recipe-scaler.test.ts` > `parseServingsInput` > returns null for unparseable text
- `recipe-scaler.test.ts` > `parseServingsInput` > returns null for empty string
- `recipe-scaler.test.ts` > `scaleIngredients` > passes through null quantities unchanged
- `recipe-scaler.test.ts` > `scaleIngredients` > rounds to 2 decimal places
- `recipe-scaler.test.ts` > `formatScaledIngredients` > omits scaling notes section when null
- `cook-mode-handler.test.ts` > `handleServingsReply` > sends error for invalid servings input
- `cook-mode-handler.test.ts` > `handleServingsReply` > allows retry after invalid input
- `cook-mode-handler.test.ts` > `handleServingsReply` > does nothing when no pending recipe

**Security tests:**
- `recipe-scaler.test.ts` > `generateScalingNotes` > sanitizes recipe title and ingredients to neutralize backtick injection

**Fixes:** None

---

## 9. Quick-Answer Food Queries

### REQ-QUERY-001: Contextual food questions

**Origin:** QA-1 | **Status:** Implemented (Phase H5b)

Handle free-text questions about food safety, substitutions, and cooking knowledge. Enhanced with user context from context store (dietary preferences, allergies, restrictions) and active cook session context (current recipe and step). Graceful fallback when context store unavailable or empty.

**Standard tests:**
- `app.test.ts` > `handleMessage — food question intent` > answers food questions
- `contextual-food-question.test.ts` > food question with user context in prompt
- `contextual-food-question.test.ts` > food question with active cook session context
- `contextual-food-question.test.ts` > food question with both context and session
- `contextual-food-question.test.ts` > food question without context (basic prompt)

**Edge case tests:**
- `app.test.ts` > `handleMessage — food question intent` > handles food question LLM failure
- `app.test.ts` > `handleMessage — security` > sanitizes food question text for LLM
- `contextual-food-question.test.ts` > context store throws — graceful degradation
- `contextual-food-question.test.ts` > context store returns empty — no context section

**Fixes:**
- 2026-03-31: Added sanitizeInput() + anti-instruction framing to food question prompt
- 2026-04-02: Added context store integration + active cook session context (H5b)

---

### REQ-QUERY-002: Intent declaration

**Origin:** QA-2 | **Status:** Implemented

Declare broad food-related intent so general food queries route to Hearthstone rather than the default chatbot. Intent detection implemented via local regex patterns in Phase H1 (save, search, edit, food question intents).

**Standard tests:**
- `app.test.ts` > `handleMessage — fallback` > shows help for unrecognized messages

**Edge case tests:**
- `app.test.ts` > `handleMessage — fallback` > ignores empty messages
- `app.test.ts` > `handleMessage — fallback` > ignores whitespace-only messages

**Fixes:** None

---

## 10. Social & Hosting Mode

### REQ-SOCIAL-001: Event planning

**Origin:** SH-1 | **Status:** Planned

User declares a social event. App suggests scaled menu, checks guest dietary needs, generates delta grocery list, creates prep timeline working backward from event time.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-SOCIAL-002: Guest profiles

**Origin:** SH-2 | **Status:** Planned

Store profiles for frequent guests with name, dietary restrictions, and allergies. Consulted during event planning.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-SOCIAL-003: Guest configuration

**Origin:** SH-3 | **Status:** Planned

Expose guest-related settings: frequent guest profiles.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 11. Cost Tracking

### REQ-COST-001: Receipt capture

**Origin:** CT-1 | **Status:** Implemented

User sends photo of grocery receipt. LLM vision extracts total and key line items. Log with date and store.

**Standard tests:**
- `photo-parsers.test.ts` > Receipt Parser > extracts receipt data from photo via LLM vision
- `photo-parsers.test.ts` > Receipt Parser > passes image to LLM with standard tier
- `photo-handler.test.ts` > caption-based routing > routes receipt caption to receipt parser
- `photo-handler.test.ts` > receipt photo — storage > saves receipt data to data store

**Edge case tests:**
- `photo-parsers.test.ts` > Receipt Parser > throws when total is missing
- `photo-parsers.test.ts` > Receipt Parser > defaults missing subtotal and tax to null

**Fixes:** None

---

### REQ-COST-002: Cost-per-meal estimates

**Origin:** CT-2 | **Status:** Planned

Estimate cost-per-meal based on ingredient costs from receipts and recipe ingredient lists.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-COST-003: Weekly/monthly spend reports

**Origin:** CT-3 | **Status:** Planned

Generate food spend summary on request or schedule: total spend, cost-per-meal average, trend vs previous periods.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-COST-004: Budget alerts

**Origin:** CT-4 | **Status:** Planned

If a meal plan is trending expensive relative to historical average, flag it and suggest swaps.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 12. Seasonal & Regional Awareness

### REQ-SEASON-001: Seasonal produce calendar

**Origin:** SR-1 | **Status:** Implemented

Maintain static dataset of seasonal produce for configurable region. Use to bias recipe suggestions toward in-season produce.

**Standard tests:**
- `meal-planner.test.ts` > `generatePlan` > includes location in prompt
- `meal-plan-store.test.ts` > `formatPlanMessage` > includes location in season note

**Edge case tests:**
- `meal-planner.test.ts` > `generatePlan` > uses defaults when config keys are missing

**Fixes:** None

---

### REQ-SEASON-002: Seasonal nudges

**Origin:** SR-2 | **Status:** Planned

Optionally send seasonal nudges with in-season produce and matching recipes.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-SEASON-003: Region configuration

**Origin:** SR-3 | **Status:** Implemented

Expose region-related settings: region code, seasonal nudges toggle.

**Standard tests:**
- `meal-planner.test.ts` > `generatePlan` > includes location in prompt
- `meal-planner.test.ts` > `generatePlan` > includes dietary preferences in prompt

**Edge case tests:**
- `meal-planner.test.ts` > `generatePlan` > uses defaults when config keys are missing

**Fixes:** None

---

## 13. Nutrition Reporting

### REQ-NUTR-001: Pediatrician visit report

**Origin:** NR-1 | **Status:** Planned

Generate summary report for a child's eating habits: food variety, allergen exposure history, macro balance, reactions, foods approved vs rejected.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-NUTR-002: Personal nutrition summary

**Origin:** NR-2 | **Status:** Planned

Generate nutrition summary for any household member over configurable period: macro intake vs targets, trends, notable patterns.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 14. Dietary Cycle & Health Integration

### REQ-HEALTH-001: Diet-performance correlation

**Origin:** DH-1 | **Status:** Planned

If health/fitness data available via other PAS apps, correlate dietary patterns with wellness metrics. Pattern recognition with observational disclaimer.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-HEALTH-002: Cross-app event subscription

**Origin:** DH-2 | **Status:** Planned

Subscribe to relevant events from health/fitness apps via PAS event bus.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 15. Cultural Recipe Rotation

### REQ-CULTURE-001: Cuisine diversity tracking

**Origin:** CR-1 | **Status:** Implemented (Phase H7)

Track cuisine distribution of recent meal plans. Suggest branching out if defaulting to same cuisine for 2+ weeks.

**Standard tests:**
- `cuisine-tracker.test.ts` > `classifyCuisines` > calls LLM with fast tier and returns parsed classifications
- `cuisine-tracker.test.ts` > `findRepetition` > flags cuisine appearing 3+ times
- `cuisine-tracker.test.ts` > `checkCuisineDiversity` > sends diversity alert to all household members
- `natural-language.test.ts` > `H7: Cuisine diversity check` > flags repetition when 3+ meals share a cuisine
- `natural-language.test.ts` > `H7: Cuisine diversity check` > uses fast LLM tier for cuisine classification
- `natural-language.test.ts` > `H7: Cuisine diversity check` > message suggests mixing in variety

**Edge case tests:**
- `cuisine-tracker.test.ts` > `findRepetition` > returns empty when no cuisine appears 3+ times
- `cuisine-tracker.test.ts` > `findRepetition` > case-insensitive cuisine counting
- `cuisine-tracker.test.ts` > `classifyCuisines` > returns null when LLM fails
- `cuisine-tracker.test.ts` > `classifyCuisines` > returns null when LLM returns invalid JSON
- `cuisine-tracker.test.ts` > `checkCuisineDiversity` > skips silently when no plan exists
- `cuisine-tracker.test.ts` > `checkCuisineDiversity` > skips silently when no household
- `cuisine-tracker.test.ts` > `checkCuisineDiversity` > skips silently when LLM fails
- `natural-language.test.ts` > `H7: Cuisine diversity check` > stays quiet when meals are diverse
- `natural-language.test.ts` > `H7: Cuisine diversity check` > stays quiet when no meal plan exists
- `natural-language.test.ts` > `H7: Cuisine diversity check` > stays quiet when LLM classification fails
- `natural-language.test.ts` > `H7: Cuisine diversity check` > stays quiet when LLM returns garbage instead of JSON
- `natural-language.test.ts` > `H7: Cuisine diversity check` > does not crash when no household is set up

**Security tests:**
- `natural-language.test.ts` > `H7: Cuisine diversity — security` > recipe titles with injection attempts are sanitized in LLM prompt

**Fixes:** None

---

### REQ-CULTURE-002: Cultural calendar integration

**Origin:** CR-2 | **Status:** Planned

Optionally suggest recipes tied to cultural events and holidays. Configurable cultural calendars.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 16. Household Linking

### REQ-HOUSEHOLD-001: Household creation and joining

**Origin:** Household Linking (Core Concepts) | **Status:** Implemented

Users can create a household and link other users via code or command. Linked users share grocery lists, meal plans, pantry, freezer, and recipe library. Each user retains individual preferences.

**Standard tests:**
- `household.test.ts` > `createHousehold` > creates a new household
- `household.test.ts` > `joinHousehold` > joins with correct code
- `household.test.ts` > `leaveHousehold` > allows non-creator to leave
- `household.test.ts` > `getHouseholdInfo` > shows household info for members
- `app.test.ts` > `handleCommand — /household` > creates household
- `app.test.ts` > `handleCommand — /household` > joins household with code
- `app.test.ts` > `handleCommand — /household` > shows info when no subcommand

**Edge case tests:**
- `household.test.ts` > `createHousehold` > uses default name when none provided
- `household.test.ts` > `createHousehold` > rejects if household already exists
- `household.test.ts` > `createHousehold` > rejects if user is already a member
- `household.test.ts` > `joinHousehold` > joins with case-insensitive code
- `household.test.ts` > `joinHousehold` > rejects wrong code
- `household.test.ts` > `joinHousehold` > rejects if already a member
- `household.test.ts` > `joinHousehold` > rejects if no household exists
- `household.test.ts` > `leaveHousehold` > prevents creator from leaving
- `household.test.ts` > `leaveHousehold` > rejects if not a member
- `household.test.ts` > `leaveHousehold` > rejects if no household
- `household.test.ts` > `getHouseholdInfo` > rejects non-members
- `household.test.ts` > `getHouseholdInfo` > returns setup message when no household
- `household.test.ts` > `input validation` > truncates household name to 100 chars
- `household.test.ts` > `input validation` > rejects join with invalid code format
- `household.test.ts` > `input validation` > rejects join with code containing spaces
- `household.test.ts` > `input validation` > handles household name with YAML special chars
- `household-guard.test.ts` > `loadHousehold` > loads valid YAML household
- `household-guard.test.ts` > `loadHousehold` > returns null for empty file
- `household-guard.test.ts` > `loadHousehold` > returns null for malformed YAML
- `household-guard.test.ts` > `loadHousehold` > handles YAML with frontmatter
- `household-guard.test.ts` > `saveHousehold` > writes YAML with frontmatter
- `household-guard.test.ts` > `requireHousehold` > returns household and store for member
- `household-guard.test.ts` > `requireHousehold` > returns null for non-member
- `household-guard.test.ts` > `requireHousehold` > returns null when no household exists
- `household-guard.test.ts` > `generateJoinCode` > generates 6-character code
- `household-guard.test.ts` > `generateJoinCode` > matches join code pattern
- `household-guard.test.ts` > `generateJoinCode` > does not contain ambiguous chars
- `app.test.ts` > `handleCommand — /household` > shows usage for join without code
- `app.test.ts` > `handleCommand — /household` > leaves household
- `app.test.ts` > `handleCommand — /recipes` > requires household

**Fixes:**
- 2026-03-31: Added JOIN_CODE_PATTERN validation — rejects malformed codes before comparison
- 2026-03-31: Household name clamped to 100 chars
- 2026-03-31: YAML parse wrapped in try-catch — malformed files return null instead of throwing

---

## 17. Non-Functional Requirements

### REQ-NFR-001: Response time

**Origin:** NF-1 | **Status:** Implemented

Simple queries respond within 2 seconds. LLM-heavy operations allowed up to 30 seconds with "working on it" acknowledgment within 2 seconds.

**Standard tests:**
- `app.test.ts` > `handleMessage — save recipe intent` > parses and saves recipe from text (sends "Parsing your recipe..." acknowledgment before LLM call)

**Edge case tests:**
- N/A (timing validated by acknowledgment pattern)

**Fixes:** None

---

### REQ-NFR-002: Graceful degradation

**Origin:** NF-2 | **Status:** Implemented

If LLM unavailable, serve data retrieval from stored files. Use `classifyLLMError()` for actionable messages.

**Standard tests:**
- `app.test.ts` > `handleMessage — save recipe intent` > handles LLM failure gracefully (classifyLLMError)
- `app.test.ts` > `handleMessage — food question intent` > handles food question LLM failure

**Edge case tests:**
- `app.test.ts` > `handleMessage — save recipe intent` > handles parse failure gracefully (SyntaxError from bad JSON)

**Fixes:** None

---

### REQ-NFR-003: Data durability

**Origin:** NF-3 | **Status:** Planned

All writes use scoped data store atomic operations. No data lost on crash.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-NFR-004: Cost awareness

**Origin:** NF-4 | **Status:** Implemented

Standard tier for recipe parsing and meal planning. Fast tier for quick queries. Reasoning tier only for complex analysis. Monthly cost cap: $15.00, rate limit: 60/hour.

**Standard tests:**
- `recipe-parser.test.ts` > `parseRecipeText` > calls LLM with standard tier
- `recipe-parser.test.ts` > `applyRecipeEdit` > uses standard tier
- `app.test.ts` > `handleMessage — food question intent` > answers food questions (uses fast tier)

**Edge case tests:**
- N/A (tier enforcement via infrastructure LLMGuard)

**Fixes:** None

---

### REQ-NFR-005: Privacy

**Origin:** NF-5 | **Status:** Planned

Health data stays local. No data leaves the PAS instance. All LLM calls through infrastructure providers.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-NFR-006: Idempotency

**Origin:** NF-6 | **Status:** Implemented

Scheduled jobs must be idempotent. File existence checks and timestamps guard against duplicate processing. Finalize-votes checks plan status (voting→active is terminal). Nightly rating prompt checks lastRatingPromptDate. Generate-weekly-plan checks existing plan start date.

**Standard tests:**
- `app.test.ts` > handleScheduledJob > skips when plan already exists for upcoming week

**Edge case tests:**
- `voting-handler.test.ts` > handleFinalizeVotesJob > does nothing when plan is not in voting status
- `rating-handler.test.ts` > handleNightlyRatingPromptJob > is idempotent — skips if already sent today
- `voting-handler.test.ts` > handleFinalizeVotesJob > uses default 12-hour window when config not set

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-NFR-007: Timezone handling

**Origin:** NF-7 | **Status:** Implemented

All user-facing dates use `services.timezone` with UTC fallback. Store timestamps as ISO 8601.

**Standard tests:**
- `date-utils.test.ts` > `todayDate` > returns YYYY-MM-DD format for valid timezone
- `date-utils.test.ts` > `currentTime` > returns HH:MM format for valid timezone
- `date-utils.test.ts` > `isoNow` > returns a valid ISO 8601 string

**Edge case tests:**
- `date-utils.test.ts` > `todayDate` > returns valid date for UTC
- `date-utils.test.ts` > `todayDate` > throws on invalid timezone
- `date-utils.test.ts` > `currentTime` > throws on invalid timezone
- `date-utils.test.ts` > `generateId` > returns a non-empty string
- `date-utils.test.ts` > `generateId` > generates unique IDs across many calls

**Fixes:** None

---

### REQ-NFR-008: Logging

**Origin:** NF-8 | **Status:** Implemented

Use `services.logger` for all logging. Never use `console.log`. Log successful operations for observability.

**Standard tests:**
- N/A (verified by code review — all handlers use `services.logger.info()` on success)

**Edge case tests:**
- N/A

**Fixes:**
- 2026-03-31: Added `services.logger.info()` calls to search, list, edit, and food question handlers

---

## 18. Security

### REQ-SEC-001: LLM prompt injection prevention

**Origin:** Phase H1 Security Review | **Status:** Implemented

All user-provided text sent to LLM prompts must be sanitized via `sanitizeInput()` (truncation + backtick neutralization) and wrapped with anti-instruction framing. Applies to: recipe parsing, recipe editing, food questions.

**Standard tests:**
- `recipe-parser.test.ts` > `security — prompt injection` > sanitizes user text in parseRecipeText
- `recipe-parser.test.ts` > `security — prompt injection` > sanitizes both inputs in applyRecipeEdit

**Edge case tests:**
- `app.test.ts` > `handleMessage — security` > sanitizes food question text for LLM

**Fixes:** None

---

### REQ-SEC-002: Input validation

**Origin:** Phase H1 Security Review | **Status:** Implemented

All external inputs validated before use: recipe slugs reject path traversal and empty results, join codes validated against pattern, household names clamped to 100 chars, EDITABLE_RECIPE_FIELDS whitelist prevents overwriting protected fields.

**Standard tests:**
- `recipe-store.test.ts` > `slugify` > converts title to slug
- `recipe-store.test.ts` > `slugify` > handles special characters

**Edge case tests:**
- `recipe-store.test.ts` > `slugify` > handles path traversal attempt safely
- `recipe-store.test.ts` > `slugify` > handles all-special-chars input
- `recipe-store.test.ts` > `slugify` > handles unicode/emoji input
- `recipe-store.test.ts` > `slugify` > handles empty string with fallback
- `recipe-store.test.ts` > `slugify` > truncates long titles

**Fixes:** None

---

## 19. User Experience

### REQ-UX-001: Recipe disambiguation and selection

**Origin:** Phase H1 UX Review | **Status:** Implemented

Search results display as numbered list with "reply with number" footer. Users select recipes by sending the number. Edit disambiguation uses `sendOptions` (inline buttons) for 2-5 matches. Fallback message shows natural language examples instead of command syntax.

**Standard tests:**
- `app.test.ts` > `handleMessage — number selection` > shows full recipe when sending number after search

**Edge case tests:**
- `app.test.ts` > `handleMessage — number selection` > falls through to intent detection when no cached results
- `app.test.ts` > `handleMessage — edit with disambiguation` > shows options when multiple recipes match
- `app.test.ts` > `handleMessage — edit with no match` > shows helpful message when no recipe matches
- `app.test.ts` > `handleMessage — fallback` > shows natural language examples in fallback
- `app.test.ts` > `intent detection — edge cases` > "show my household" does NOT trigger search intent

**Fixes:** None

---

## 20. Utilities

### REQ-UTIL-001: Date utilities

**Origin:** Phase H1 Foundation | **Status:** Implemented

Timezone-aware date/time formatting, ISO timestamp generation, and unique ID generation for recipes and households.

**Standard tests:**
- `date-utils.test.ts` > `todayDate` > returns YYYY-MM-DD format for valid timezone
- `date-utils.test.ts` > `currentTime` > returns HH:MM format for valid timezone
- `date-utils.test.ts` > `isoNow` > returns a valid ISO 8601 string
- `date-utils.test.ts` > `generateId` > returns a non-empty string

**Edge case tests:**
- `date-utils.test.ts` > `todayDate` > returns valid date for UTC
- `date-utils.test.ts` > `todayDate` > throws on invalid timezone
- `date-utils.test.ts` > `currentTime` > throws on invalid timezone
- `date-utils.test.ts` > `generateId` > generates unique IDs across many calls

**Fixes:** None

---

### REQ-UTIL-002: Household guard

**Origin:** Phase H1 Foundation | **Status:** Implemented

Load/save household YAML with frontmatter support, membership checks, and join code generation with ambiguous character exclusion.

**Standard tests:**
- `household-guard.test.ts` > `loadHousehold` > loads valid YAML household
- `household-guard.test.ts` > `saveHousehold` > writes YAML with frontmatter
- `household-guard.test.ts` > `requireHousehold` > returns household and store for member
- `household-guard.test.ts` > `generateJoinCode` > generates 6-character code

**Edge case tests:**
- `household-guard.test.ts` > `loadHousehold` > returns null for empty file
- `household-guard.test.ts` > `loadHousehold` > returns null for malformed YAML
- `household-guard.test.ts` > `loadHousehold` > handles YAML with frontmatter
- `household-guard.test.ts` > `requireHousehold` > returns null for non-member
- `household-guard.test.ts` > `requireHousehold` > returns null when no household exists
- `household-guard.test.ts` > `generateJoinCode` > matches join code pattern
- `household-guard.test.ts` > `generateJoinCode` > does not contain ambiguous chars

**Fixes:** None

---

## Traceability Matrix

| Requirement ID | Test File | Standard Count | Edge Count | Status |
|----------------|-----------|----------------|------------|--------|
| REQ-RECIPE-001 | recipe-parser.test.ts, recipe-store.test.ts, app.test.ts | 5 | 16 | Implemented |
| REQ-RECIPE-002 | photo-parsers.test.ts, photo-handler.test.ts | 4 | 4 | Implemented |
| REQ-RECIPE-003 | rating-handler.test.ts | 1 | 2 | Implemented |
| REQ-RECIPE-004 | recipe-store.test.ts, app.test.ts | 8 | 15 | Implemented |
| REQ-RECIPE-005 | natural-language.test.ts, photo-store.test.ts | 7 | 6 | Implemented |
| REQ-RECIPE-006 | recipe-parser.test.ts, recipe-store.test.ts, app.test.ts | 4 | 8 | Implemented |
| REQ-MEAL-001 | meal-planner.test.ts, meal-plan-store.test.ts, app.test.ts | 6 | 6 | Implemented |
| REQ-MEAL-002 | meal-planner.test.ts, app.test.ts | 4 | 3 | Implemented |
| REQ-MEAL-003 | voting.test.ts, voting-handler.test.ts, app.test.ts | 6 | 10 | Implemented |
| REQ-MEAL-004 | rating.test.ts, rating-handler.test.ts, app.test.ts | 5 | 9 | Implemented |
| REQ-MEAL-005 | meal-plan-store.test.ts, app.test.ts, natural-language.test.ts | 3 | 3 | Implemented |
| REQ-MEAL-006 | TBD | 0 | 0 | Planned |
| REQ-MEAL-007 | meal-planner.test.ts, app.test.ts | 3 | 2 | Implemented |
| REQ-GROCERY-001 | grocery-generator.test.ts, app.test.ts | 4 | 4 | Implemented |
| REQ-GROCERY-002 | grocery-generator.test.ts | 2 | 2 | Implemented |
| REQ-GROCERY-003 | item-parser.test.ts, app.test.ts | 5 | 5 | Implemented |
| REQ-GROCERY-004 | photo-parsers.test.ts, photo-handler.test.ts | 4 | 1 | Implemented |
| REQ-GROCERY-005 | grocery-store.test.ts, app.test.ts | 3 | 3 | Implemented |
| REQ-GROCERY-006 | grocery-store.test.ts, grocery-dedup.test.ts | 4 | 6 | Implemented |
| REQ-GROCERY-007 | grocery-store.test.ts, app.test.ts | 6 | 3 | Implemented |
| REQ-GROCERY-008 | grocery-store.test.ts, app.test.ts, telegram-buttons.test.ts | 6 | 14 | Implemented |
| REQ-GROCERY-009 | shopping-followup.test.ts, app.test.ts | 3 | 5 | Implemented |
| REQ-GROCERY-010 | TBD | 0 | 0 | Planned |
| REQ-GROCERY-011 | TBD | 0 | 0 | Planned |
| REQ-PANTRY-001 | pantry-store.test.ts, app.test.ts, photo-parsers.test.ts, photo-handler.test.ts | 14 | 10 | Implemented |
| REQ-PANTRY-002 | pantry-matcher.test.ts, app.test.ts, natural-language.test.ts | 4 | 4 | Implemented |
| REQ-PANTRY-003 | grocery-generator.test.ts, pantry-store.test.ts | 3 | 3 | Implemented |
| REQ-PANTRY-004 | perishable-handler.test.ts, pantry-store.test.ts | 7 | 9 | Implemented |
| REQ-PANTRY-005 | freezer-store.test.ts, freezer-handler.test.ts, natural-language.test.ts | 12 | 7 | Implemented |
| REQ-WASTE-001 | leftover-store.test.ts, leftover-handler.test.ts, natural-language.test.ts | 13 | 9 | Implemented |
| REQ-WASTE-002 | TBD | 0 | 0 | Planned |
| REQ-WASTE-003 | leftover-handler.test.ts | 4 | 3 | Implemented |
| REQ-WASTE-004 | waste-store.test.ts, natural-language.test.ts | 6 | 4 | Implemented |
| REQ-FAMILY-001 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-002 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-003 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-004 | TBD | 0 | 0 | Planned |
| REQ-BATCH-001 | batch-cooking.test.ts, natural-language.test.ts | 4 | 5 | Implemented |
| REQ-BATCH-002 | batch-cooking.test.ts, natural-language.test.ts | 3 | 2 | Implemented |
| REQ-BATCH-003 | batch-cooking.test.ts, natural-language.test.ts | 7 | 9 | Implemented |
| REQ-BATCH-004 | batch-cooking.test.ts, natural-language.test.ts | 7 | 8 | Implemented |
| REQ-COOK-001 | cook-session.test.ts, cook-mode-handler.test.ts | 23 | 24 | Implemented |
| REQ-COOK-002 | timer-parser.test.ts, cook-timer.test.ts, cook-session.test.ts | 30 | 18 | Implemented |
| REQ-COOK-003 | cook-tts.test.ts | 10 | 5 | Implemented |
| REQ-COOK-004 | recipe-scaler.test.ts, cook-mode-handler.test.ts | 18 | 11 | Implemented |
| REQ-QUERY-001 | app.test.ts, contextual-food-question.test.ts | 10 | 6 | Implemented |
| REQ-QUERY-002 | app.test.ts | 1 | 2 | Implemented |
| REQ-SOCIAL-001 | TBD | 0 | 0 | Planned |
| REQ-SOCIAL-002 | TBD | 0 | 0 | Planned |
| REQ-SOCIAL-003 | TBD | 0 | 0 | Planned |
| REQ-COST-001 | photo-parsers.test.ts, photo-handler.test.ts | 4 | 2 | Implemented |
| REQ-COST-002 | TBD | 0 | 0 | Planned |
| REQ-COST-003 | TBD | 0 | 0 | Planned |
| REQ-COST-004 | TBD | 0 | 0 | Planned |
| REQ-SEASON-001 | meal-planner.test.ts, meal-plan-store.test.ts | 2 | 1 | Implemented |
| REQ-SEASON-002 | TBD | 0 | 0 | Planned |
| REQ-SEASON-003 | meal-planner.test.ts | 2 | 1 | Implemented |
| REQ-NUTR-001 | TBD | 0 | 0 | Planned |
| REQ-NUTR-002 | TBD | 0 | 0 | Planned |
| REQ-HEALTH-001 | TBD | 0 | 0 | Planned |
| REQ-HEALTH-002 | TBD | 0 | 0 | Planned |
| REQ-CULTURE-001 | cuisine-tracker.test.ts, natural-language.test.ts | 6 | 13 | Implemented |
| REQ-CULTURE-002 | TBD | 0 | 0 | Planned |
| REQ-HOUSEHOLD-001 | household.test.ts, household-guard.test.ts, app.test.ts | 7 | 31 | Implemented |
| REQ-NFR-001 | app.test.ts | 1 | 0 | Implemented |
| REQ-NFR-002 | app.test.ts | 2 | 1 | Implemented |
| REQ-NFR-003 | TBD | 0 | 0 | Planned |
| REQ-NFR-004 | recipe-parser.test.ts, app.test.ts | 3 | 0 | Implemented |
| REQ-NFR-005 | TBD | 0 | 0 | Planned |
| REQ-NFR-006 | voting-handler.test.ts, rating-handler.test.ts, app.test.ts | 1 | 3 | Implemented |
| REQ-NFR-007 | date-utils.test.ts | 3 | 5 | Implemented |
| REQ-NFR-008 | N/A | 0 | 0 | Implemented |
| REQ-SEC-001 | recipe-parser.test.ts, app.test.ts | 2 | 1 | Implemented |
| REQ-SEC-002 | recipe-store.test.ts | 2 | 5 | Implemented |
| REQ-UX-001 | app.test.ts | 1 | 5 | Implemented |
| REQ-UTIL-001 | date-utils.test.ts | 4 | 4 | Implemented |
| REQ-UTIL-002 | household-guard.test.ts | 4 | 7 | Implemented |
| **Totals** | **35 test files** | **264** | **318** | **582 tests** |
