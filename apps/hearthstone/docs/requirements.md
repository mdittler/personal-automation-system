# Hearthstone — PAS Food Management App

## App Identity

- **App ID:** `hearthstone`
- **Display Name:** Hearthstone
- **Description:** A comprehensive household food management system covering recipe storage, meal planning, grocery lists, pantry tracking, nutrition, and family-specific food intelligence. Designed for a dual-income household with a toddler and a baby on the way.
- **Platform:** PAS (Personal Automation System) — Telegram bot interface, Node.js, YAML/Markdown file storage

---

## Architecture Context

Hearthstone is a PAS app. It must follow the PAS app contract:

- **Manifest:** `manifest.yaml` declaring commands, intents, scheduled jobs, config fields, required services, photo intents, and rules
- **Entry point:** TypeScript `AppModule` exporting `init()`, `handleMessage()`, `handleCommand()`, and optionally `handlePhoto()` and `shutdown()`
- **Dependency injection:** All infrastructure access via `CoreServices` object — never import infrastructure internals
- **Data storage:** Scoped per-user markdown/YAML files on the filesystem via the storage service. No database.
- **LLM access:** Request by tier (`fast`, `standard`, `reasoning`) — infrastructure routes to the best available model. Never import LLM SDKs directly. Use `classifyLLMError` from `@pas/core/utils/llm-errors` for actionable error messages.
- **Multi-user:** All data is per-user scoped. Household linking (see below) is an app-level concept built on top of per-user storage.
- **In-process:** No container isolation. App must be well-behaved (no unhandled exceptions, no blocking the event loop, no excessive memory).
- **Banned imports:** Never import `@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`, `child_process`, or `node:child_process`. Use `services.llm` for all LLM access.

### Reference Documents

The following PAS platform docs should be loaded alongside this requirements file:

- **`CREATING_AN_APP.md`** — full walkthrough of app development, testing, data conventions, Obsidian integration
- **`MANIFEST_REFERENCE.md`** — complete field reference for `manifest.yaml`
- **Scaffold template:** `core/src/cli/templates/app/` — used by `pnpm scaffold-app`

### Bootstrap Command

```bash
pnpm scaffold-app --name=hearthstone --description="Household food management — recipes, meal planning, grocery lists, pantry tracking, nutrition, and family food intelligence." --author="PAS Team"
```

This creates `apps/hearthstone/` with the scaffold template. Then customize the generated `manifest.yaml` and `src/index.ts` per the specs below.

---

## Core Concepts

### Household Linking

Multiple Telegram users can be linked into a single household. Linked users share:
- Grocery lists
- Meal plans
- Pantry inventory
- Freezer inventory
- Recipe library (all household members can access, search, and contribute)
- Voting on recipes and meal plans

One user creates the household, the other joins via a code or command. Each user retains their own individual preferences (dietary restrictions, macro targets, etc.) but operates on shared household data.

### Recipe Object Model

A recipe is a structured data object stored as a YAML/Markdown file. Every recipe has:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier |
| `title` | string | Recipe name |
| `source` | string | Where it came from (URL, book, "homemade", photo) |
| `sourcePhoto` | string? | Path to the original photo if saved from a photo |
| `ingredients` | Ingredient[] | Structured list with quantities, units, and item names |
| `instructions` | string[] | Ordered steps |
| `servings` | number | Default serving count |
| `prepTime` | number? | Minutes |
| `cookTime` | number? | Minutes |
| `tags` | string[] | Freeform tags: `easy`, `healthy`, `picnic`, `social-gathering`, `weeknight`, `batch-friendly`, `freezer-friendly`, `margot-approved`, `kid-friendly`, etc. |
| `cuisine` | string? | e.g., `Italian`, `Korean`, `Mexican` |
| `macros` | MacroData? | Per-serving macro breakdown (calories, protein, carbs, fat, fiber, etc.) |
| `ratings` | Rating[] | Per-user ratings with timestamps |
| `history` | CookEvent[] | When it was cooked, who cooked it, any notes |
| `householdNotes` | string? | Free-text notes from household members |
| `allergens` | string[] | Common allergens present |
| `kidAdaptation` | string? | Notes on how to adapt for toddlers/babies |
| `scalingNotes` | string? | LLM-generated notes for non-linear scaling (spices, baking chemistry, timing) |
| `costEstimate` | number? | Estimated cost per serving |
| `status` | `draft` \| `confirmed` \| `archived` | Lifecycle state |
| `createdAt` | ISO date | |
| `updatedAt` | ISO date | |

---

## Module 1: Recipe Storage

### Requirements

**RS-1. Save recipes from text.**
When a user sends a recipe (pasted text, URL, or describes it), use the LLM to parse it into the structured recipe format. Save as a `draft`. Confirm with the user that it was parsed correctly.

**RS-2. Save recipes from photos.**
When a user sends a photo of a recipe (cookbook page, handwritten card, screenshot), use the LLM vision tier to extract the recipe. Save both the original photo file and the parsed structured recipe. Both must be independently retrievable — the photo by asking for it, the text by searching.

**RS-3. Recipe confirmation flow.**
New recipes start as `draft`. After the recipe has been cooked, send a follow-up message (configurable delay, default 2 hours after marking as "cooking now") asking:
- Did you like it? (thumbs up / thumbs down / neutral)
- Any notes?
If liked, move to `confirmed`. If disliked, keep as `draft` with the rating attached. If no response after 24 hours, send one reminder, then leave as `draft`.

**RS-4. Search and retrieval.**
Users can search recipes by:
- Free text (title, ingredients, cuisine)
- Tags (exact or fuzzy via LLM intent matching)
- Cuisine type
- Rating (e.g., "show me our top-rated recipes")
- Cooking history (e.g., "what haven't we made in a while?")
- Macro criteria (e.g., "high protein recipes")
- Combination queries via natural language (e.g., "easy healthy dinners we haven't made in a month")

**RS-5. Recipe photo retrieval.**
If a recipe was saved from a photo, the user can request "show me the original photo for [recipe]" and receive the image via Telegram.

**RS-6. Recipe editing.**
Users can update any field on a recipe via natural language (e.g., "add the tag 'picnic' to the chicken salad recipe", "update the prep time on lasagna to 30 minutes").

---

## Module 2: Meal Planning

### Requirements

**MP-1. Plan generation.**
On a configurable schedule (or on demand), generate a meal plan for the upcoming period. The plan respects:
- Configurable meal types and counts (e.g., 5 dinners + 5 lunches per week)
- Configurable ratio of new-to-existing recipes (e.g., 3 existing, 2 new per week)
- Dietary preferences and restrictions from user config (e.g., "healthy and easy, avoid red meat")
- Macro nutrient targets if set
- Cuisine variety — flag if the plan is too repetitive on a single cuisine
- Seasonal produce awareness for the user's region (North Carolina) — bias toward what's in season
- Recent cooking history — avoid repeating recently cooked meals unless requested

**MP-2. New recipe discovery.**
When the plan calls for new recipes, the LLM generates suggestions that match the household's configured preferences, dietary needs, and constraints. New suggestions include full recipe details and estimated macros.

**MP-3. Household voting on meal plans.**
When a plan is generated, all linked household members receive the proposed plan via Telegram with the ability to:
- Upvote a recipe (want it)
- Downvote a recipe (don't want it)
- Stay neutral
Use Telegram inline buttons for voting. After a configurable voting window (default: 12 hours), finalize the plan based on votes. If a recipe is downvoted by anyone, suggest a replacement. Notify everyone of the final plan.

**MP-4. Post-meal rating.**
After a meal is planned and the cooking window passes, send a message to all household members asking them to rate the meal 1–5. Store ratings on the recipe object. Use ratings to inform future plan generation (higher-rated recipes appear more often, low-rated ones get deprioritized).

**MP-5. "What's for dinner?" resolver.**
Any household member can text "what's for dinner" (or any natural language variant) and get:
- Tonight's planned meal
- Brief prep summary
- Who's cooking (if assigned)
- Any prep steps that should have already happened (e.g., "the chicken should be defrosting")

**MP-6. Macro nutrient tracking.**
For each planned/cooked meal, track macro nutrients based on the recipe's macro data and recommended serving sizes. Store daily macro logs per user. Make this data queryable over configurable periods (daily, weekly, monthly). Support setting target macros per user and showing progress against targets.

**MP-7. Meal plan configuration.**
Expose the following as user-configurable settings via the PAS management GUI:

| Config Field | Type | Default | Description |
|---|---|---|---|
| `mealTypes` | object | `{ dinners: 5, lunches: 5 }` | How many of each meal type per planning period |
| `planningPeriod` | string | `weekly` | `weekly` or `biweekly` |
| `newRecipeRatio` | number | 0.4 | Fraction of meals that should be new recipes (0.0–1.0) |
| `dietaryPreferences` | string[] | `[]` | e.g., `["healthy", "easy"]` |
| `dietaryRestrictions` | string[] | `[]` | e.g., `["no red meat on weekdays"]` |
| `macroTargets` | MacroTargets? | null | Daily targets per user |
| `planGenerationDay` | string | `Sunday` | Day of week to auto-generate the plan |
| `planGenerationTime` | string | `09:00` | Time to auto-generate |
| `votingWindowHours` | number | 12 | How long household members have to vote |
| `ratingReminderDelay` | number | 120 | Minutes after expected cook time to ask for ratings |

---

## Module 3: Grocery Lists

### Requirements

**GL-1. Recipe-to-grocery conversion.**
Given one or more recipes, generate a consolidated grocery list. Use the LLM to:
- Merge duplicate ingredients across recipes (e.g., two recipes needing onions → one entry with combined quantity)
- Sort items by department (Produce, Dairy, Meat, Pantry, Frozen, Bakery, etc.)
- Handle unit conversions where needed

**GL-2. Staples handling.**
Maintain a configurable list of "staple" items (salt, pepper, olive oil, butter, etc.) that are assumed to be in the pantry. When converting a recipe to a grocery list, provide a single summary line: "This assumes you have: salt, pepper, olive oil" with an option to include any/all staples on the list if needed. Users can edit the staples list via config.

**GL-3. Manual item addition.**
Users can add items to the current grocery list via natural language (e.g., "add milk to the grocery list", "we need diapers and wipes"). Parse the item and quantity, add to the appropriate department section.

**GL-4. Photo-to-grocery-list.**
If a user sends a photo of a recipe, extract the ingredients via LLM vision and generate a grocery list. Offer to save the recipe as well (triggers the RS-1/RS-2 flow).

**GL-5. Shared grocery list.**
All linked household members see and can modify the same grocery list. Changes sync immediately — if one person adds an item, the other sees it on their next retrieval.

**GL-6. Duplicate removal.**
When adding items (manually or from recipes), check for duplicates against existing list items. Merge quantities where possible (e.g., "1 lb chicken breast" + "2 lbs chicken breast" → "3 lbs chicken breast"). Use LLM for fuzzy matching ("chicken" and "chicken breast" should flag as potential duplicate for user confirmation).

**GL-7. Retrieve current list.**
Any household member can request the current grocery list at any time (e.g., "show me the grocery list", "what do we need?"). Return the list sorted by department.

**GL-8. Interactive shopping mode.**
When a user says "I'm at the store" or "start shopping", enter shopping mode:
- Send the numbered grocery list
- User sends a number → that item is marked as purchased and removed from the active list
- User can send multiple numbers separated by commas
- User says "done" to exit shopping mode
- Purchased items are logged for pantry inference (see Module 4)

**GL-9. Shopping follow-up.**
After a configurable period following a shopping trip (default: 24 hours), send a message asking if shopping was completed and if anything should remain on the list. Items confirmed as still needed stay; everything else is cleared.

**GL-10. Store-aware pricing.**
Make grocery lists configurable by store. Users can set preferred stores (e.g., Aldi, Costco, Harris Teeter, Whole Foods). When generating or viewing a list:
- Optionally show estimated prices per item for each configured store
- Show total estimated cost per store for comparison
- Allow user to select a store as the "shopping at" context which filters the price estimates
- Price data can be sourced from LLM knowledge (approximate) and refined over time with user-reported actuals

**GL-11. Store configuration.**

| Config Field | Type | Default | Description |
|---|---|---|---|
| `preferredStores` | string[] | `[]` | List of stores for price comparison |
| `defaultStore` | string? | null | Default store for price estimates |
| `showPriceEstimates` | boolean | false | Whether to include price estimates on lists |
| `stapleItems` | string[] | `["salt", "pepper", "olive oil", "butter", "garlic"]` | Items assumed to be on hand |
| `shoppingFollowUpHours` | number | 24 | Hours after shopping mode to send follow-up |

---

## Module 4: Pantry & Inventory Awareness

### Requirements

**PI-1. Pantry tracker.**
Maintain a lightweight inventory of pantry items. Items can be added via:
- Manual text ("we have 2 cans of chickpeas")
- Photo of pantry/fridge shelves (LLM vision to identify items)
- Inference from grocery purchases (items bought → added to pantry)
- Inference from meals cooked (ingredients used → decremented from pantry)

**PI-2. "What can I make?" queries.**
User asks "what can I make with what we have?" → cross-reference pantry inventory against recipe library and return matches (full matches and close matches noting what's missing).

**PI-3. Auto-exclude from grocery lists.**
When generating a grocery list, check pantry inventory and exclude items already on hand. Flag any excluded items so the user can override ("I excluded olive oil since you have some — add it anyway?").

**PI-4. Perishable expiry alerts.**
Track rough expiry windows for perishable items. Send Telegram alerts when items are approaching expiry:
- "You bought salmon 3 days ago — cook tonight or freeze"
- "The avocados from Tuesday should be used soon"
Expiry estimates use LLM knowledge of typical shelf life. Users can snooze or dismiss alerts.

**PI-5. Freezer inventory (separate from pantry).**
Track items in the freezer with date frozen. Surface items before they get freezer-burned:
- "You have bolognese from 6 weeks ago — use this week or toss"
- "There's frozen chicken from March — still good but use soon"
Pairs with batch cooking module — when a recipe is doubled, prompt to log the extra as frozen.

---

## Module 5: Leftover & Waste Reduction

### Requirements

**LW-1. Leftover tracking.**
After a meal is cooked, the app asks "any leftovers?" (via the post-meal check-in). If yes:
- Log the leftover item and approximate quantity
- Assign a rough expiry window (LLM-estimated based on the food type)
- Store in a leftover tracker

**LW-2. Leftover meal suggestions.**
When leftovers are tracked, proactively suggest meals that use them:
- "You have half a roasted chicken — how about chicken quesadillas tomorrow?"
- "There's leftover rice from last night — fried rice tonight?"
Suggestions can be sent as scheduled nudges or triggered by "what should I do with leftovers?"

**LW-3. Use-or-freeze nudges.**
Before a leftover item hits its expiry window, send a nudge: "The leftover soup from Tuesday should be eaten today or frozen."

**LW-4. Waste tracking (informational).**
If a leftover expires without being used, prompt: "Did you use the [item] or should I mark it as wasted?" Over time, build data on what gets wasted most to inform future planning (e.g., reduce portion sizes, avoid certain recipes on busy weeks).

---

## Module 6: Toddler & Family Meal Adaptation

### Requirements

**TF-1. Kid-friendly adaptation.**
For any recipe, the user can request "how do I make this for Margot?" (or the configured child's name). The LLM generates:
- What to set aside before adding spice/heat
- Chopping/texture guidance appropriate for the child's age
- Allergen flags for common allergens (especially relevant during food introduction)
- Portion size guidance

**TF-2. "Margot approved" tagging.**
Track which recipes the child actually eats vs rejects. Users can tag a recipe as approved or rejected for the child. This data feeds into meal planning — kid-approved recipes get weighted higher when planning family meals.

**TF-3. Baby food introduction tracker.**
When baby #2 starts solids, track food introductions:
- Log new foods introduced with date
- Flag recommended wait periods between new allergens (typically 3–5 days)
- Alert if a new allergen is introduced too soon after the last one
- Maintain a history of introduced foods and any reactions noted

**TF-4. Family member configuration.**

| Config Field | Type | Default | Description |
|---|---|---|---|
| `children` | ChildProfile[] | `[]` | Name, date of birth, dietary notes, allergen introduction stage |
| `childMealAdaptation` | boolean | true | Whether to auto-suggest kid-friendly adaptations |
| `allergenWaitDays` | number | 3 | Days to wait between introducing new allergens |

---

## Module 7: Batch Cooking & Meal Prep Intelligence

### Requirements

**BC-1. Shared prep component detection.**
When a meal plan is finalized, analyze all recipes for shared prep components:
- "Three recipes this week use roasted sweet potato — roast it all on Sunday"
- "Both Wednesday and Thursday dinners need sautéed onions — make a big batch"

**BC-2. Consolidated prep plan.**
Generate a prep plan for a configurable prep day (default: Sunday) that consolidates shared work, orders tasks by timing, and estimates total prep time.

**BC-3. Freezer-friendly flagging.**
Flag recipes that freeze well. When a freezer-friendly recipe comes up in the plan, suggest doubling it and freezing the extra. Log the frozen portion in the freezer inventory (Module 4).

**BC-4. Defrost reminders.**
When a meal plan includes an item that uses frozen protein or other frozen ingredients, send a reminder the night before to defrost.

---

## Module 8: Cooking Execution Support

### Requirements

**CE-1. Cook mode.**
User activates cook mode for a specific recipe (e.g., "start cooking the lasagna"). The app:
- Sends the first step via Telegram
- Waits for "next", "n", or a button tap to advance
- Supports "back" / "previous" to go back a step
- Supports "repeat" to re-send the current step
- Shows a progress indicator (e.g., "Step 3 of 12")

**CE-2. Timer integration.**
If a step involves a time (e.g., "bake for 25 minutes"), offer to set a timer. When the timer fires, send a Telegram notification with the next instruction.

**CE-3. TTS / Chromecast support.**
Offer to push the current step to Chromecast audio via TTS for hands-free cooking. Each step is read aloud, and the user can advance via Telegram or voice (if voice input is available).

**CE-4. Recipe scaling in cook mode.**
Before starting cook mode, ask how many servings. If different from the recipe's default, scale all ingredient quantities. Use LLM for non-linear scaling (spices, baking chemistry, timing adjustments) and include scaling notes.

---

## Module 9: Quick-Answer Food Queries

### Requirements

**QA-1. Contextual food questions.**
Handle free-text questions about food safety, substitutions, and general cooking knowledge. The LLM should use household context from the context store:
- "Can Nina eat brie while pregnant?" → knows Nina is pregnant, answers accordingly
- "Is this safe for a 2 year old?" → knows Margot's age
- "What can I substitute for buttermilk?" → direct answer
- "How long does cooked rice last in the fridge?" → direct answer

**QA-2. Intent declaration.**
Declare a broad intent like "user has a food-related question" so that general food queries route to Hearthstone rather than the default chatbot.

---

## Module 10: Social & Hosting Mode

### Requirements

**SH-1. Event planning.**
User declares a social event: "We're having 6 adults and 2 toddlers over Saturday at 6pm."
The app:
- Suggests a menu scaled to the guest count
- Checks against stored dietary preferences/allergies for frequent guests (if configured)
- Generates a delta grocery list (what's needed beyond the current plan/pantry)
- Creates a prep timeline working backward from the event time

**SH-2. Guest profiles.**
Allow users to store profiles for frequent guests with name, dietary restrictions, and allergies. These are consulted during event planning.

**SH-3. Guest configuration.**

| Config Field | Type | Default | Description |
|---|---|---|---|
| `frequentGuests` | GuestProfile[] | `[]` | Name, dietary restrictions, allergies |

---

## Module 11: Cost Tracking

### Requirements

**CT-1. Receipt capture.**
User sends a photo of a grocery receipt. LLM vision extracts the total and optionally key line items. Log the data with date and store.

**CT-2. Cost-per-meal estimates.**
Over time, estimate cost-per-meal based on ingredient costs from receipts and recipe ingredient lists.

**CT-3. Weekly/monthly spend reports.**
On request or on a configurable schedule, generate a food spend summary: total spend, cost-per-meal average, trend vs previous periods.

**CT-4. Budget alerts.**
If a meal plan is trending expensive relative to the household's historical average, flag it and suggest swaps.

---

## Module 12: Seasonal & Regional Awareness

### Requirements

**SR-1. Seasonal produce calendar.**
Maintain a static dataset of seasonal produce for North Carolina (or configurable region). Use this to bias recipe suggestions toward what's in season.

**SR-2. Seasonal nudges.**
Optionally send seasonal nudges: "Strawberries are in season in NC — here are 3 recipes that feature them."

**SR-3. Region configuration.**

| Config Field | Type | Default | Description |
|---|---|---|---|
| `region` | string | `NC` | Region code for seasonal data |
| `seasonalNudges` | boolean | true | Whether to send seasonal produce suggestions |

---

## Module 13: Nutrition Reporting

### Requirements

**NR-1. Pediatrician visit report.**
On request, generate a summary report for a child's eating habits over a configurable period:
- Food variety (number of unique foods)
- Allergen exposure history (what's been introduced and when)
- Macro balance summary
- Any noted reactions
- Foods approved vs rejected
Format as a clean, readable Telegram message or exportable text.

**NR-2. Personal nutrition summary.**
For any household member, generate a nutrition summary over a configurable period showing macro intake vs targets, trends, and notable patterns.

---

## Module 14: Dietary Cycle & Health Integration

### Requirements

**DH-1. Diet-performance correlation (optional).**
If health/fitness data is available via other PAS apps (e.g., Garmin data), correlate dietary patterns with wellness metrics:
- "You sleep worse on days you eat heavy carbs at dinner"
- "Your running performance is better in weeks with higher iron intake"
This is pattern recognition, not medical advice. Always disclaim as observational.

**DH-2. Cross-app event subscription.**
Subscribe to relevant events from health/fitness apps if available on the PAS event bus.

---

## Module 15: Cultural Recipe Rotation

### Requirements

**CR-1. Cuisine diversity tracking.**
Track the cuisine distribution of recent meal plans. If the household has been defaulting to the same cuisine for 2+ weeks, suggest branching out.

**CR-2. Cultural calendar integration.**
Optionally suggest recipes tied to cultural events and holidays (Lunar New Year, Diwali, Thanksgiving, etc.). Configurable by which cultural calendars to include.

---

## Cross-App Integration (Event Bus)

Hearthstone should publish the following events for other PAS apps to consume:

| Event | Payload | Potential Consumer |
|---|---|---|
| `hearthstone.mealPlan.finalized` | Plan with dates and recipes | Calendar app (block prep time) |
| `hearthstone.groceryList.ready` | Grocery list | Reminders app (tie to errand window) |
| `hearthstone.recipe.scheduled` | Recipe + date | Reminders app (defrost reminder night before if frozen protein) |
| `hearthstone.meal.cooked` | Recipe + date + who cooked | Logging/journaling apps |
| `hearthstone.shopping.completed` | Store, total cost, items | Finance tracking apps |

---

## Slash Commands

| Command | Description |
|---|---|
| `/recipes` | Browse / search recipe library |
| `/mealplan` | View current meal plan or trigger new plan generation |
| `/grocery` | View current grocery list |
| `/addgrocery` | Quick-add items to grocery list |
| `/pantry` | View or update pantry inventory |
| `/freezer` | View or update freezer inventory |
| `/cook` | Start cook mode for a recipe |
| `/leftovers` | Log or view current leftovers |
| `/hosting` | Start social/hosting mode event planning |
| `/foodbudget` | View food cost tracking and reports |
| `/nutrition` | View nutrition summaries and reports |
| `/whatsfordinner` | Quick check: what's planned for tonight |

---

## Intent Declarations

The following natural language intents should be declared in the manifest for LLM-based routing:

- "user wants to save a recipe"
- "user wants to search for a recipe"
- "user wants to plan meals for the week"
- "user wants to see or modify the grocery list"
- "user wants to add items to the grocery list"
- "user wants to know what's for dinner"
- "user has a food-related question"
- "user wants to start cooking a recipe"
- "user wants to check or update the pantry"
- "user wants to log leftovers"
- "user wants to plan for hosting guests"
- "user wants to see food spending"
- "user wants to see nutrition information"
- "user wants to know what they can make with what they have"
- "user is sending a photo of a recipe to save"
- "user is sending a photo of a grocery receipt"
- "user is sending a photo of pantry/fridge contents"

---

## Photo Intent Declarations

- Recipe photos (cookbook pages, handwritten cards, screenshots) → parse and save recipe
- Grocery receipt photos → extract cost data
- Pantry/fridge photos → update inventory

---

## Scheduled Jobs

| Job | Schedule | Description |
|---|---|---|
| `generateWeeklyPlan` | Configurable (default: Sunday 9:00 AM) | Auto-generate the weekly meal plan and send for voting |
| `perishableCheck` | Daily at 9:00 AM | Check pantry for items approaching expiry, send alerts |
| `freezerCheck` | Weekly on Monday | Check freezer for items that should be used soon |
| `leftoverCheck` | Daily at 10:00 AM | Check leftovers approaching expiry, send use-or-freeze nudges |
| `shoppingFollowUp` | Triggered | Runs N hours after shopping mode ends |
| `postMealRating` | Triggered | Runs N minutes after expected cook time for a planned meal |
| `seasonalNudge` | 1st and 15th of each month | Check seasonal calendar, suggest in-season recipes |
| `weeklyNutritionSummary` | Configurable (default: Sunday 8:00 PM) | Send weekly macro/nutrition summary if tracking is enabled |
| `cuisineDiversityCheck` | Weekly on plan generation | Flag cuisine repetition |

---

## Data File Structure

Hearthstone uses two data scopes from PAS:

- **Shared data** (`services.data.forShared()`) — household-wide data that all linked users access. Scoped to `data/users/shared/hearthstone/`.
- **Per-user data** (`services.data.forUser(userId)`) — individual preferences, macro logs, and personal tracking. Scoped to `data/users/<userId>/hearthstone/`.

### Shared Data (household-wide)

```
data/users/shared/hearthstone/
├── household.yaml                    # Membership, join codes, shared config
├── recipes/
│   ├── {recipe-id}.md                # One file per recipe (Obsidian-compatible markdown with YAML frontmatter)
│   └── photos/
│       └── {recipe-id}.jpg           # Original photos for photo-sourced recipes
├── meal-plans/
│   ├── {year}-W{week}.yaml           # Weekly meal plan with votes and status
│   └── archive/                      # Past plans
├── grocery/
│   ├── current.yaml                  # Active grocery list
│   └── history/
│       └── {date}.yaml               # Past grocery lists
├── pantry.yaml                       # Current pantry inventory
├── freezer.yaml                      # Current freezer inventory
├── leftovers.yaml                    # Current leftover tracker
├── children/
│   ├── {child-name}/
│   │   ├── food-log.yaml             # What the child has eaten / rejected
│   │   └── allergen-introductions.yaml
├── guests.yaml                       # Frequent guest profiles
├── receipts/
│   ├── {date}-{store}.yaml           # Parsed receipt data
│   └── photos/
│       └── {date}-{store}.jpg        # Receipt photos
├── seasonal/
│   └── nc-produce.yaml               # Static seasonal produce data
└── waste-log.yaml                    # Food waste tracking
```

### Per-User Data (individual)

```
data/users/<userId>/hearthstone/
├── preferences.yaml                  # Dietary preferences, restrictions, macro targets
├── nutrition/
│   └── {year}-{month}.yaml           # Monthly macro intake logs
└── shopping-sessions/
    └── {date}.yaml                   # Shopping mode session history
```

### Obsidian Compatibility

All `.md` recipe files must use YAML frontmatter with `generateFrontmatter()` from `@pas/core/utils/frontmatter`. Use `buildAppTags()` for standardized tags.

**Recipe file example:**

```markdown
---
title: Chicken Stir Fry
tags:
  - pas/recipe
  - pas/hearthstone
  - ingredient/chicken
  - ingredient/broccoli
  - meal/dinner
  - cuisine/chinese
type: recipe
app: hearthstone
source: pas-hearthstone
aliases:
  - stir fry chicken
  - chicken stir-fry
calories: 450
protein: 35
carbs: 40
fat: 15
servings: 4
prep_time: 15
cook_time: 20
related:
  - "[[_shared/hearthstone/grocery/current]]"
---

## Ingredients
- 1 lb chicken breast, sliced
- 2 cups broccoli florets
...

## Instructions
1. Heat oil in a wok over high heat.
...
```

**Tag taxonomy for Hearthstone:**

| Pattern | Purpose | Examples |
|---|---|---|
| `pas/hearthstone` | Source app | Always included |
| `pas/recipe` | Content type | On all recipe files |
| `pas/meal-plan` | Content type | On meal plan files |
| `pas/grocery-list` | Content type | On grocery list files |
| `ingredient/<name>` | Food items | `ingredient/chicken`, `ingredient/salmon` |
| `meal/<type>` | Meal category | `meal/dinner`, `meal/lunch`, `meal/snack` |
| `cuisine/<type>` | Cuisine | `cuisine/italian`, `cuisine/korean` |
| `diet/<tag>` | Dietary tags | `diet/healthy`, `diet/low-carb`, `diet/batch-friendly` |

**Wiki-links:** Recipe files should use wiki-links to reference related grocery lists and meal plans (e.g., `[[_shared/hearthstone/grocery/current]]`). This enables Obsidian graph view across the food management system.

**Reading markdown:** Always use `stripFrontmatter()` from `@pas/core/utils/frontmatter` before passing recipe content to the LLM or processing as text.

---

## Manifest Blueprint

The following is the target `manifest.yaml` for Hearthstone. Implement incrementally per the phased rollout — only declare capabilities that are built.

```yaml
app:
  id: hearthstone
  name: "Hearthstone"
  version: "0.1.0"
  description: "Household food management — recipes, meal planning, grocery lists, pantry tracking, nutrition, and family food intelligence."
  author: "PAS Team"
  pas_core_version: ">=0.1.0"
  category: home
  tags:
    - food
    - recipes
    - meal-planning
    - grocery
    - cooking
    - nutrition
    - family
    - pantry
    - meal-prep

capabilities:
  messages:
    intents:
      - "user wants to save a recipe"
      - "user wants to search for a recipe"
      - "user wants to plan meals for the week"
      - "user wants to see or modify the grocery list"
      - "user wants to add items to the grocery list"
      - "user wants to know what's for dinner"
      - "user has a food-related question"
      - "user wants to start cooking a recipe"
      - "user wants to check or update the pantry"
      - "user wants to log leftovers"
      - "user wants to plan for hosting guests"
      - "user wants to see food spending"
      - "user wants to see nutrition information"
      - "user wants to know what they can make with what they have"
    commands:
      - name: /recipes
        description: "Browse and search your recipe library"
      - name: /mealplan
        description: "View current meal plan or generate a new one"
      - name: /grocery
        description: "View the current grocery list"
      - name: /addgrocery
        description: "Quick-add items to the grocery list"
        args: ["items"]
      - name: /pantry
        description: "View or update pantry inventory"
      - name: /freezer
        description: "View or update freezer inventory"
      - name: /cook
        description: "Start cook mode for a recipe"
        args: ["recipe"]
      - name: /leftovers
        description: "Log or view current leftovers"
      - name: /hosting
        description: "Plan a menu for hosting guests"
      - name: /foodbudget
        description: "View food cost tracking and reports"
      - name: /nutrition
        description: "View nutrition summaries and reports"
      - name: /whatsfordinner
        description: "See what's planned for tonight"
      - name: /household
        description: "Create, join, or manage your household link"
    accepts_photos: true
    photo_intents:
      - "photo of a recipe to save"
      - "photo of a grocery receipt"
      - "photo of pantry or fridge contents"

  schedules:
    - id: generate-weekly-plan
      description: "Auto-generate the weekly meal plan and send for voting"
      cron: "0 9 * * 0"
      handler: "dist/handlers/generate-plan.js"
      user_scope: shared
    - id: perishable-check
      description: "Check pantry for items approaching expiry"
      cron: "0 9 * * *"
      handler: "dist/handlers/perishable-check.js"
      user_scope: shared
    - id: freezer-check
      description: "Check freezer for items that should be used soon"
      cron: "0 9 * * 1"
      handler: "dist/handlers/freezer-check.js"
      user_scope: shared
    - id: leftover-check
      description: "Check leftovers approaching expiry"
      cron: "0 10 * * *"
      handler: "dist/handlers/leftover-check.js"
      user_scope: shared
    - id: seasonal-nudge
      description: "Suggest in-season recipes"
      cron: "0 10 1,15 * *"
      handler: "dist/handlers/seasonal-nudge.js"
      user_scope: shared
    - id: weekly-nutrition-summary
      description: "Send weekly macro/nutrition summary"
      cron: "0 20 * * 0"
      handler: "dist/handlers/nutrition-summary.js"
      user_scope: all
    - id: cuisine-diversity-check
      description: "Flag cuisine repetition in recent plans"
      cron: "0 8 * * 0"
      handler: "dist/handlers/cuisine-diversity.js"
      user_scope: shared

  events:
    emits:
      - id: "hearthstone:meal-plan-finalized"
        description: "Fired when a weekly meal plan is finalized after voting"
      - id: "hearthstone:grocery-list-ready"
        description: "Fired when a grocery list is generated or updated"
      - id: "hearthstone:recipe-scheduled"
        description: "Fired when a recipe is scheduled for a specific date"
      - id: "hearthstone:meal-cooked"
        description: "Fired when a meal is marked as cooked"
      - id: "hearthstone:shopping-completed"
        description: "Fired when a shopping session is completed"
    subscribes: []

requirements:
  services:
    - telegram
    - data-store
    - llm
    - scheduler
    - event-bus
    - audio
    - context-store
  data:
    shared_scopes:
      - path: "recipes/"
        access: read-write
        description: "Recipe library shared across the household"
      - path: "meal-plans/"
        access: read-write
        description: "Weekly meal plans and archives"
      - path: "grocery/"
        access: read-write
        description: "Active and historical grocery lists"
      - path: "pantry.yaml"
        access: read-write
        description: "Pantry inventory"
      - path: "freezer.yaml"
        access: read-write
        description: "Freezer inventory"
      - path: "leftovers.yaml"
        access: read-write
        description: "Leftover tracker"
      - path: "household.yaml"
        access: read-write
        description: "Household membership and shared config"
      - path: "children/"
        access: read-write
        description: "Child food logs and allergen tracking"
      - path: "guests.yaml"
        access: read-write
        description: "Frequent guest dietary profiles"
      - path: "receipts/"
        access: read-write
        description: "Grocery receipt data and photos"
      - path: "seasonal/"
        access: read-write
        description: "Seasonal produce reference data"
      - path: "waste-log.yaml"
        access: read-write
        description: "Food waste tracking"
    user_scopes:
      - path: "preferences.yaml"
        access: read-write
        description: "Individual dietary preferences and macro targets"
      - path: "nutrition/"
        access: read-write
        description: "Per-user monthly macro intake logs"
      - path: "shopping-sessions/"
        access: read-write
        description: "Shopping mode session history"
    context_reads:
      - "dietary_preferences"
      - "allergies"
      - "pregnancy_status"
      - "children_ages"
      - "preferred_units"
  llm:
    tier: standard
    rate_limit:
      max_requests: 60
      window_seconds: 3600
    monthly_cost_cap: 15.00

user_config:
  - key: meal_types
    type: string
    default: "dinners:5,lunches:5"
    description: "Meal types and counts per planning period (format: type:count,type:count)"
  - key: planning_period
    type: select
    default: "weekly"
    description: "How often to generate meal plans"
    options: ["weekly", "biweekly"]
  - key: new_recipe_ratio
    type: number
    default: 40
    description: "Percentage of meals that should be new recipes (0-100)"
  - key: dietary_preferences
    type: string
    default: ""
    description: "Comma-separated dietary preferences (e.g., healthy, easy)"
  - key: dietary_restrictions
    type: string
    default: ""
    description: "Comma-separated dietary restrictions (e.g., no red meat on weekdays)"
  - key: plan_generation_day
    type: select
    default: "Sunday"
    description: "Day of week to auto-generate the meal plan"
    options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
  - key: voting_window_hours
    type: number
    default: 12
    description: "Hours household members have to vote on meal plans"
  - key: rating_reminder_delay
    type: number
    default: 120
    description: "Minutes after expected cook time to ask for ratings"
  - key: preferred_stores
    type: string
    default: ""
    description: "Comma-separated list of stores for price comparison"
  - key: default_store
    type: string
    default: ""
    description: "Default store for price estimates"
  - key: show_price_estimates
    type: boolean
    default: false
    description: "Show estimated prices on grocery lists"
  - key: staple_items
    type: string
    default: "salt,pepper,olive oil,butter,garlic"
    description: "Comma-separated items assumed to be on hand"
  - key: shopping_followup_hours
    type: number
    default: 24
    description: "Hours after shopping mode to send follow-up"
  - key: region
    type: string
    default: "NC"
    description: "Region code for seasonal produce data"
  - key: seasonal_nudges
    type: boolean
    default: true
    description: "Send seasonal produce suggestions"
  - key: child_meal_adaptation
    type: boolean
    default: true
    description: "Auto-suggest kid-friendly recipe adaptations"
  - key: allergen_wait_days
    type: number
    default: 3
    description: "Days to wait between introducing new allergens for babies"
```

### LLM Tier Usage Guide

| Operation | Tier | Rationale |
|---|---|---|
| Intent classification, simple queries | `fast` | Speed, low cost |
| Recipe parsing (text & photo), meal plan generation, grocery list generation, kid adaptation, food safety questions | `standard` | Accuracy needed |
| Nutrition correlation analysis, complex scaling notes | `reasoning` | Complex multi-step reasoning |

### Project Structure

```
apps/hearthstone/
  manifest.yaml
  package.json
  tsconfig.json
  src/
    index.ts                          # AppModule entry point (init, handleMessage, handleCommand, handlePhoto)
    handlers/
      generate-plan.ts                # Scheduled: weekly meal plan generation
      perishable-check.ts             # Scheduled: pantry expiry alerts
      freezer-check.ts                # Scheduled: freezer expiry alerts
      leftover-check.ts               # Scheduled: leftover expiry nudges
      seasonal-nudge.ts               # Scheduled: seasonal produce suggestions
      nutrition-summary.ts            # Scheduled: weekly nutrition summary
      cuisine-diversity.ts            # Scheduled: cuisine repetition check
    modules/
      recipes.ts                      # Recipe CRUD, search, photo parsing
      meal-planning.ts                # Plan generation, voting, finalization
      grocery.ts                      # List generation, shopping mode, store pricing
      pantry.ts                       # Pantry & freezer inventory
      leftovers.ts                    # Leftover tracking & suggestions
      cooking.ts                      # Cook mode step-by-step
      family.ts                       # Kid adaptation, allergen tracking
      hosting.ts                      # Social event planning
      cost-tracking.ts                # Receipt parsing, budget tracking
      nutrition.ts                    # Macro tracking, reporting
      household.ts                    # Household linking, membership
      food-queries.ts                 # Quick-answer food Q&A
    utils/
      recipe-parser.ts                # LLM-based recipe extraction from text/photos
      ingredient-merger.ts            # Deduplication and unit conversion
      seasonal-data.ts                # Static seasonal produce calendar
      department-sort.ts              # Grocery department classification
    __tests__/
      app.test.ts
      recipes.test.ts
      grocery.test.ts
      meal-planning.test.ts
      ...
```

### Testing Approach

Use Vitest with PAS mock utilities:

```typescript
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext, createTestPhotoContext } from '@pas/core/testing/helpers';
```

- Mock `services.data.forShared()` for household data operations
- Mock `services.data.forUser(userId)` for individual preference reads
- Mock `services.llm.complete()` and `services.llm.extractStructured()` for recipe parsing, plan generation
- Mock `services.telegram.send()` and `services.telegram.sendOptions()` for message assertions
- Mock `services.scheduler` for one-off scheduled task assertions (follow-ups, reminders)

---

## Non-Functional Requirements

**NF-1. Response time.** Simple queries (what's for dinner, show grocery list) should respond within 2 seconds. LLM-heavy operations (meal plan generation, recipe parsing from photo) are allowed up to 30 seconds with a "working on it" acknowledgment sent via `services.telegram.send()` within 2 seconds.

**NF-2. Graceful degradation.** If LLM access is unavailable or rate-limited, the app should still serve data retrieval operations (show list, show plan, show recipes) from stored files. Use `classifyLLMError()` from `@pas/core/utils/llm-errors` to give users actionable messages. Check `isRetryable` to decide whether to offer retry.

**NF-3. Data durability.** All writes use `services.data.forUser()` or `services.data.forShared()` which provide atomic file operations. No data should be lost on crash.

**NF-4. Cost awareness.** Meal plan generation and recipe parsing use the `standard` LLM tier. Quick queries and classification use the `fast` tier. Only use the `reasoning` tier for complex operations like nutrition correlation analysis. The manifest sets `monthly_cost_cap: 15.00` and `rate_limit: 60/hour`.

**NF-5. Privacy.** Health data correlations (Module 14) stay local. No data leaves the PAS instance. All LLM calls go through the infrastructure's configured providers.

**NF-6. Idempotency.** Scheduled jobs must be idempotent — if they run twice, no duplicates or corruption. Use file existence checks and timestamps to guard against duplicate processing.

**NF-7. Timezone handling.** All user-facing dates and times use `services.timezone` (IANA string, e.g., `'America/New_York'`). Always fall back to `'UTC'` with `?? 'UTC'`. Store all timestamps as ISO 8601.

**NF-8. Logging.** Use `services.logger` (Pino-based, auto-tagged with `hearthstone` app ID) for all logging. Use `info` for user-facing operations, `debug` for data operations, `error` for failures. Never use `console.log`.

---

## Implementation Priority

For phased rollout, implement in this order:

### Phase 1 — Core Loop
1. Recipe Storage (RS-1 through RS-6)
2. Grocery Lists (GL-1 through GL-9)
3. Meal Planning basics (MP-1 through MP-5)
4. "What's for dinner?" resolver (MP-5)

### Phase 2 — Household & Intelligence
5. Household linking
6. Meal plan voting (MP-3)
7. Post-meal ratings (MP-4)
8. Pantry & inventory (PI-1 through PI-3)
9. Cook mode (CE-1, CE-2)

### Phase 3 — Family & Nutrition
10. Macro tracking (MP-6)
11. Toddler adaptation (TF-1 through TF-3)
12. Leftover tracking (LW-1 through LW-3)
13. Quick-answer queries (QA-1)

### Phase 4 — Advanced Features
14. Batch cooking intelligence (BC-1 through BC-4)
15. Social/hosting mode (SH-1, SH-2)
16. Freezer inventory (PI-5)
17. Cost tracking (CT-1 through CT-4)
18. Store price comparison (GL-10)
19. Seasonal awareness (SR-1, SR-2)
20. Recipe scaling intelligence (CE-4)
21. TTS/Chromecast cook mode (CE-3)

### Phase 5 — Insights & Integration
22. Nutrition reporting (NR-1, NR-2)
23. Cuisine diversity tracking (CR-1, CR-2)
24. Waste tracking analytics (LW-4)
25. Health integration (DH-1, DH-2)
26. Cross-app event bus publishing
