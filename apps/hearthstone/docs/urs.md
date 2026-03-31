# Hearthstone User Requirements Specification

| Field | Value |
|-------|-------|
| **Doc ID** | PAS-URS-APP-hearthstone |
| **Purpose** | Functional and non-functional requirements with test coverage mapping |
| **Status** | Active |
| **Last Updated** | 2026-03-30 |

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

**Origin:** RS-2 | **Status:** Planned

When a user sends a photo of a recipe (cookbook page, handwritten card, screenshot), use the LLM vision tier to extract the recipe. Save both the original photo file and the parsed structured recipe. Both must be independently retrievable.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-RECIPE-003: Recipe confirmation flow

**Origin:** RS-3 | **Status:** Planned

New recipes start as `draft`. After cooking, send a follow-up message (configurable delay, default 2 hours) asking for rating and notes. If liked, move to `confirmed`. If disliked, keep as `draft` with rating attached. If no response after 24 hours, send one reminder, then leave as `draft`.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** RS-5 | **Status:** Planned

If a recipe was saved from a photo, the user can request the original photo and receive it via Telegram.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** MP-1 | **Status:** Planned

Generate a meal plan for the upcoming period respecting configurable meal types, new-to-existing recipe ratio, dietary preferences/restrictions, macro targets, cuisine variety, seasonal produce, and recent cooking history.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-MEAL-002: New recipe discovery

**Origin:** MP-2 | **Status:** Planned

When the plan calls for new recipes, the LLM generates suggestions matching household preferences, dietary needs, and constraints with full recipe details and estimated macros.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-MEAL-003: Household voting on meal plans

**Origin:** MP-3 | **Status:** Planned

All linked household members receive the proposed plan with Telegram inline buttons for upvote/downvote/neutral. After configurable voting window (default 12 hours), finalize plan based on votes. Downvoted recipes get replacement suggestions.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-MEAL-004: Post-meal rating

**Origin:** MP-4 | **Status:** Planned

After a planned meal's cooking window passes, send a message to all household members asking for 1-5 rating. Store ratings on the recipe object. Use ratings to inform future plan generation.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-MEAL-005: "What's for dinner?" resolver

**Origin:** MP-5 | **Status:** Planned

Any household member can ask "what's for dinner" and get tonight's planned meal, brief prep summary, who's cooking (if assigned), and any prep steps that should have already happened.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** MP-7 | **Status:** Planned

Expose meal planning configuration as user-configurable settings: meal types, planning period, new recipe ratio, dietary preferences/restrictions, macro targets, plan generation day/time, voting window hours, rating reminder delay.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** GL-4 | **Status:** Planned

Extract ingredients from a photo of a recipe via LLM vision and generate a grocery list. Offer to save the recipe as well.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** GL-9 | **Status:** Planned

After configurable period following shopping trip, send follow-up asking if shopping was completed. Confirmed items stay; everything else is cleared.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Edge case tests:**
- `pantry-store.test.ts` > loadPantry > empty store returns []
- `pantry-store.test.ts` > loadPantry > malformed YAML returns []
- `pantry-store.test.ts` > removePantryItem > no match returns unchanged
- `pantry-store.test.ts` > formatPantry > shows empty message
- `pantry-store.test.ts` > pantryContains > rejects short substrings (prevents false positives)
- `pantry-store.test.ts` > pantryContains > matches close-length substrings
- `pantry-store.test.ts` > pantryContains > returns false for empty pantry
- `app.test.ts` > handleCommand — /pantry > requires household

**Fixes:** None

---

### REQ-PANTRY-002: "What can I make?" queries

**Origin:** PI-2 | **Status:** Planned

Cross-reference pantry inventory against recipe library and return full matches and close matches noting what's missing.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** PI-4 | **Status:** Planned

Track rough expiry windows for perishable items. Send alerts when approaching expiry. Expiry estimates use LLM knowledge. Users can snooze or dismiss.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-PANTRY-005: Freezer inventory

**Origin:** PI-5 | **Status:** Planned

Track freezer items with date frozen. Surface items before freezer burn. Pairs with batch cooking module for frozen portion logging.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 5. Leftover & Waste Reduction

### REQ-WASTE-001: Leftover tracking

**Origin:** LW-1 | **Status:** Planned

After meal is cooked, ask about leftovers. Log leftover item, quantity, and LLM-estimated expiry window.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** LW-3 | **Status:** Planned

Before a leftover item hits expiry window, send a nudge to eat or freeze it.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-WASTE-004: Waste tracking

**Origin:** LW-4 | **Status:** Planned

If leftover expires without being used, prompt user. Build data on what gets wasted most to inform future planning.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** BC-1 | **Status:** Planned

Analyze finalized meal plan for shared prep components across recipes and suggest batch preparation.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-BATCH-002: Consolidated prep plan

**Origin:** BC-2 | **Status:** Planned

Generate prep plan for configurable prep day that consolidates shared work, orders by timing, and estimates total prep time.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-BATCH-003: Freezer-friendly flagging

**Origin:** BC-3 | **Status:** Planned

Flag freezer-friendly recipes, suggest doubling and freezing extra, log frozen portion in freezer inventory.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-BATCH-004: Defrost reminders

**Origin:** BC-4 | **Status:** Planned

When meal plan includes frozen ingredients, send reminder the night before to defrost.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 8. Cooking Execution Support

### REQ-COOK-001: Cook mode

**Origin:** CE-1 | **Status:** Planned

Step-by-step cooking guidance via Telegram: send first step, advance with "next"/"n"/button, go back with "back"/"previous", repeat current step, show progress indicator.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-COOK-002: Timer integration

**Origin:** CE-2 | **Status:** Planned

If a step involves a time, offer to set a timer. When timer fires, send Telegram notification with next instruction.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-COOK-003: TTS / Chromecast support

**Origin:** CE-3 | **Status:** Planned

Push current cooking step to Chromecast audio via TTS for hands-free cooking. User advances via Telegram.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

### REQ-COOK-004: Recipe scaling in cook mode

**Origin:** CE-4 | **Status:** Planned

Before starting cook mode, ask serving count. Scale ingredients if different from default. Use LLM for non-linear scaling (spices, baking chemistry, timing).

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

**Fixes:** None

---

## 9. Quick-Answer Food Queries

### REQ-QUERY-001: Contextual food questions

**Origin:** QA-1 | **Status:** Partially Implemented (Phase H1: basic food questions via LLM, no context store integration yet)

Handle free-text questions about food safety, substitutions, and cooking knowledge using household context from context store.

**Standard tests:**
- `app.test.ts` > `handleMessage — food question intent` > answers food questions

**Edge case tests:**
- `app.test.ts` > `handleMessage — food question intent` > handles food question LLM failure
- `app.test.ts` > `handleMessage — security` > sanitizes food question text for LLM

**Fixes:**
- 2026-03-31: Added sanitizeInput() + anti-instruction framing to food question prompt

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

**Origin:** CT-1 | **Status:** Planned

User sends photo of grocery receipt. LLM vision extracts total and key line items. Log with date and store.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** SR-1 | **Status:** Planned

Maintain static dataset of seasonal produce for configurable region. Use to bias recipe suggestions toward in-season produce.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** SR-3 | **Status:** Planned

Expose region-related settings: region code, seasonal nudges toggle.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** CR-1 | **Status:** Planned

Track cuisine distribution of recent meal plans. Suggest branching out if defaulting to same cuisine for 2+ weeks.

**Standard tests:**
- TBD

**Edge case tests:**
- TBD

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

**Origin:** NF-6 | **Status:** Planned

Scheduled jobs must be idempotent. File existence checks and timestamps guard against duplicate processing.

**Standard tests:**
- TBD

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
| REQ-RECIPE-002 | TBD | 0 | 0 | Planned |
| REQ-RECIPE-003 | TBD | 0 | 0 | Planned |
| REQ-RECIPE-004 | recipe-store.test.ts, app.test.ts | 8 | 15 | Implemented |
| REQ-RECIPE-005 | TBD | 0 | 0 | Planned |
| REQ-RECIPE-006 | recipe-parser.test.ts, recipe-store.test.ts, app.test.ts | 4 | 8 | Implemented |
| REQ-MEAL-001 | TBD | 0 | 0 | Planned |
| REQ-MEAL-002 | TBD | 0 | 0 | Planned |
| REQ-MEAL-003 | TBD | 0 | 0 | Planned |
| REQ-MEAL-004 | TBD | 0 | 0 | Planned |
| REQ-MEAL-005 | TBD | 0 | 0 | Planned |
| REQ-MEAL-006 | TBD | 0 | 0 | Planned |
| REQ-MEAL-007 | TBD | 0 | 0 | Planned |
| REQ-GROCERY-001 | grocery-generator.test.ts, app.test.ts | 4 | 4 | Implemented |
| REQ-GROCERY-002 | grocery-generator.test.ts | 2 | 2 | Implemented |
| REQ-GROCERY-003 | item-parser.test.ts, app.test.ts | 5 | 5 | Implemented |
| REQ-GROCERY-004 | TBD | 0 | 0 | Planned |
| REQ-GROCERY-005 | grocery-store.test.ts, app.test.ts | 3 | 3 | Implemented |
| REQ-GROCERY-006 | grocery-store.test.ts, grocery-dedup.test.ts | 4 | 6 | Implemented |
| REQ-GROCERY-007 | grocery-store.test.ts, app.test.ts | 6 | 3 | Implemented |
| REQ-GROCERY-008 | grocery-store.test.ts, app.test.ts, telegram-buttons.test.ts | 6 | 14 | Implemented |
| REQ-GROCERY-009 | TBD | 0 | 0 | Planned |
| REQ-GROCERY-010 | TBD | 0 | 0 | Planned |
| REQ-GROCERY-011 | TBD | 0 | 0 | Planned |
| REQ-PANTRY-001 | pantry-store.test.ts, app.test.ts | 11 | 8 | Implemented |
| REQ-PANTRY-002 | TBD | 0 | 0 | Planned |
| REQ-PANTRY-003 | grocery-generator.test.ts, pantry-store.test.ts | 3 | 3 | Implemented |
| REQ-PANTRY-004 | TBD | 0 | 0 | Planned |
| REQ-PANTRY-005 | TBD | 0 | 0 | Planned |
| REQ-WASTE-001 | TBD | 0 | 0 | Planned |
| REQ-WASTE-002 | TBD | 0 | 0 | Planned |
| REQ-WASTE-003 | TBD | 0 | 0 | Planned |
| REQ-WASTE-004 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-001 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-002 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-003 | TBD | 0 | 0 | Planned |
| REQ-FAMILY-004 | TBD | 0 | 0 | Planned |
| REQ-BATCH-001 | TBD | 0 | 0 | Planned |
| REQ-BATCH-002 | TBD | 0 | 0 | Planned |
| REQ-BATCH-003 | TBD | 0 | 0 | Planned |
| REQ-BATCH-004 | TBD | 0 | 0 | Planned |
| REQ-COOK-001 | TBD | 0 | 0 | Planned |
| REQ-COOK-002 | TBD | 0 | 0 | Planned |
| REQ-COOK-003 | TBD | 0 | 0 | Planned |
| REQ-COOK-004 | TBD | 0 | 0 | Planned |
| REQ-QUERY-001 | app.test.ts | 1 | 2 | Partial |
| REQ-QUERY-002 | app.test.ts | 1 | 2 | Implemented |
| REQ-SOCIAL-001 | TBD | 0 | 0 | Planned |
| REQ-SOCIAL-002 | TBD | 0 | 0 | Planned |
| REQ-SOCIAL-003 | TBD | 0 | 0 | Planned |
| REQ-COST-001 | TBD | 0 | 0 | Planned |
| REQ-COST-002 | TBD | 0 | 0 | Planned |
| REQ-COST-003 | TBD | 0 | 0 | Planned |
| REQ-COST-004 | TBD | 0 | 0 | Planned |
| REQ-SEASON-001 | TBD | 0 | 0 | Planned |
| REQ-SEASON-002 | TBD | 0 | 0 | Planned |
| REQ-SEASON-003 | TBD | 0 | 0 | Planned |
| REQ-NUTR-001 | TBD | 0 | 0 | Planned |
| REQ-NUTR-002 | TBD | 0 | 0 | Planned |
| REQ-HEALTH-001 | TBD | 0 | 0 | Planned |
| REQ-HEALTH-002 | TBD | 0 | 0 | Planned |
| REQ-CULTURE-001 | TBD | 0 | 0 | Planned |
| REQ-CULTURE-002 | TBD | 0 | 0 | Planned |
| REQ-HOUSEHOLD-001 | household.test.ts, household-guard.test.ts, app.test.ts | 7 | 31 | Implemented |
| REQ-NFR-001 | app.test.ts | 1 | 0 | Implemented |
| REQ-NFR-002 | app.test.ts | 2 | 1 | Implemented |
| REQ-NFR-003 | TBD | 0 | 0 | Planned |
| REQ-NFR-004 | recipe-parser.test.ts, app.test.ts | 3 | 0 | Implemented |
| REQ-NFR-005 | TBD | 0 | 0 | Planned |
| REQ-NFR-006 | TBD | 0 | 0 | Planned |
| REQ-NFR-007 | date-utils.test.ts | 3 | 5 | Implemented |
| REQ-NFR-008 | N/A | 0 | 0 | Implemented |
| REQ-SEC-001 | recipe-parser.test.ts, app.test.ts | 2 | 1 | Implemented |
| REQ-SEC-002 | recipe-store.test.ts | 2 | 5 | Implemented |
| REQ-UX-001 | app.test.ts | 1 | 5 | Implemented |
| REQ-UTIL-001 | date-utils.test.ts | 4 | 4 | Implemented |
| REQ-UTIL-002 | household-guard.test.ts | 4 | 7 | Implemented |
| **Totals** | **12 test files** | **85** | **147** | **232 tests** |
