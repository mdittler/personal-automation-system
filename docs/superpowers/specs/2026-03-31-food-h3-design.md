# Food Phase H3: Meal Planning + "What Can I Make?"

## Context

Phase H2a built grocery lists and pantry tracking. Users can save recipes, generate grocery lists, and track pantry inventory. But there's no way to plan meals for the week, get quick answers about tonight's dinner, or find recipes that match what's already in the pantry. H3 closes this gap with AI-powered meal planning and pantry-recipe cross-referencing.

## Scope

**6 requirements** from H3 + 1 deferred from H2a:

| ID | Name | Summary |
|----|------|---------|
| MEAL-001 | Plan generation | Generate weekly meal plan via LLM respecting preferences, history, seasonality |
| MEAL-002 | New recipe discovery | LLM suggests new recipes as titles+descriptions; full details generated on demand |
| MEAL-005 | "What's for dinner?" | Tonight's meal with prep summary |
| MEAL-007 | Meal plan configuration | User settings for schedule, counts, dietary prefs |
| PANTRY-002 | "What can I make?" | LLM cross-reference pantry vs recipe library (deferred from H2a) |
| SEASON-001 | Seasonal produce awareness | LLM-based using user location, no static dataset |
| SEASON-003 | Region configuration | `location` field in pas.yaml user config |

**Already implemented:** PANTRY-003 (auto-exclude from grocery) — done in H2a.

**Deferred to H4:** MEAL-003 (voting), MEAL-004 (post-meal ratings).
**Deferred to H11:** MEAL-006 (macro nutrient tracking).

## Architecture: Single LLM Call Plan Generation

Plan generation uses a single `standard` tier LLM call. The prompt includes:
- Recipe library summaries (title, tags, cuisine, rating, last cooked date)
- Current pantry inventory
- User location + current date (LLM infers seasonal produce)
- Dietary preferences and restrictions
- Recent cooking history (last 2-3 weeks)
- Config: number of dinners, new-to-existing ratio

The LLM returns a JSON array of planned meals — a mix of existing recipe IDs and new recipe suggestions (title + brief description only). New recipe full details are generated on demand when the user asks to see them.

**Why single call:** A recipe library of ~50 recipes with title/tags/cuisine/rating summaries is under 2k tokens. The LLM can make holistic decisions about variety, seasonality, and preferences in one pass. Simpler to implement, test, and debug than a multi-step pipeline.

## Data Model

### Types

Existing `MealPlan` and `PlannedMeal` types in `types.ts` need minor additions:

```typescript
interface PlannedMeal {
  recipeId: string;        // existing recipe ID, or '' for new suggestions
  recipeTitle: string;
  date: string;            // ISO date
  mealType: string;        // "dinner" (only type for now)
  assignedTo?: string;     // userId — unused until H4
  votes: Record<string, 'up' | 'down' | 'neutral'>;  // unused until H4
  cooked: boolean;
  rated: boolean;
  // New fields:
  isNew: boolean;          // true = LLM suggestion, not from library
  description?: string;    // brief description for new suggestions
}
```

`MealPlan` type unchanged — `id`, `startDate`, `endDate`, `meals[]`, `status`, `createdAt`, `updatedAt`. Status values: `draft | voting | active | completed`. H3 uses `active` and `completed` only (voting deferred to H4).

### Storage

- Active plan: `shared/meal-plans/current.yaml`
- Archive: `shared/meal-plans/archive/YYYY-Www.yaml` (ISO week)
- YAML frontmatter on all files (Obsidian compatibility)

### Configuration

New fields in Food user config (stored via app config system):

| Field | Type | Default | Description |
|---|---|---|---|
| `meal_plan_dinners` | number | `5` | Dinners per week |
| `plan_generation_day` | string | `Sunday` | Day for auto-generation |
| `plan_generation_time` | string | `09:00` | Time for auto-generation |
| `new_recipe_ratio` | number | `0.4` | Fraction of new vs existing (0.0–1.0) |
| `dietary_preferences` | string[] | `[]` | e.g. `["healthy", "easy"]` |
| `dietary_restrictions` | string[] | `[]` | e.g. `["no red meat on weekdays"]` |

### Infrastructure: Location Config

New `location` field on user config in `pas.yaml`:

```yaml
users:
  - id: "8187111554"
    name: "Matthew"
    location: "Raleigh, NC"
```

Food reads this from system config. Used in the LLM prompt for seasonal produce awareness. The LLM naturally knows what's in season for a given location and time of year — no static dataset needed.

The plan message includes which location is assumed: "🌱 In season (Raleigh, NC): asparagus, strawberries, peas"

## Services

### 1. `meal-plan-store.ts` — Data CRUD

- `loadCurrentPlan(store): Promise<MealPlan | null>`
- `savePlan(store, plan): Promise<void>` — with frontmatter
- `archivePlan(store, plan): Promise<void>` — moves to `meal-plans/archive/YYYY-Www.yaml`
- `getTonightsMeal(plan, timezone): PlannedMeal | null` — finds today's date in plan
- `formatPlanMessage(plan, recipes, location): string` — detailed card format with all meals visible
- `formatTonightMessage(meal, recipe): string` — tonight's meal with prep summary
- `buildPlanButtons(): InlineButton[][]` — "Grocery List" + "Regenerate" buttons

### 2. `meal-planner.ts` — LLM-Powered Generation

- `generatePlan(services, config): Promise<MealPlan>` — single standard-tier LLM call
  - Gathers: recipe library summaries, recent cook history, pantry state, user location + current date, dietary prefs/restrictions, config
  - Returns: `MealPlan` with mix of existing recipe IDs and new suggestions
  - Prompt includes anti-instruction framing, `sanitizeInput()` on all user content
- `swapMeal(services, plan, day, request): Promise<PlannedMeal>` — standard tier, suggests replacement
- `generateNewRecipeDetails(services, title, description): Promise<ParsedRecipe>` — standard tier, full recipe from suggestion. Saved via existing `recipe-store.saveRecipe()` as draft

### 3. `pantry-matcher.ts` — "What Can I Make?"

- `findMatchingRecipes(services, pantryItems, recipes): Promise<MatchResult>`
  - Fast-tier LLM call with pantry inventory + recipe ingredient lists
  - Returns: `{ fullMatches: RecipeMatch[], nearMatches: RecipeMatch[] }`
  - `RecipeMatch = { recipeId: string, title: string, prepTime?: number, missingItems: string[] }`
  - Full matches always shown first, near matches grouped separately with missing items listed
  - If no full matches exist, LLM still returns them as empty (no synthetic full matches)
- `formatMatchResults(fullMatches, nearMatches): string` — grouped Telegram message

### 4. Scheduled Job: `generate-weekly-plan`

- Cron handler registered in manifest (configurable, default: Sunday 9am)
- Checks if current plan already covers the upcoming week — skips if so (idempotency)
- Archives previous plan if one exists
- Calls `meal-planner.generatePlan()`
- Sends detailed card message to **all household members**

## Commands & Intents

### Commands

- `/mealplan` — view current plan, or generate if none exists
- `/mealplan generate` — force regenerate (archives and replaces current plan)

### Intents

- `isMealPlanViewIntent(text)` — "show the meal plan", "what's planned this week"
- `isWhatsForDinnerIntent(text)` — "what's for dinner", "what are we eating tonight"
- `isWhatCanIMakeIntent(text)` — "what can I make", "what can I cook with what we have"
- `isMealSwapIntent(text)` — "swap Monday", "change Tuesday's dinner"
- `isShowNewRecipeIntent(text)` — "show Lemon Herb Salmon" (detected when title matches a new suggestion in active plan)

### Interaction Flows

**1. Generate plan:**
User says `/mealplan generate` or "plan meals for this week" → "Planning your meals..." acknowledgment → LLM call (standard tier) → save plan as active → send detailed card message with inline buttons

**2. View plan:**
`/mealplan` or "show the meal plan" → load current plan → send detailed card message. If no plan exists → "No meal plan yet. Want me to generate one?" with inline button.

**3. What's for dinner:**
"what's for dinner" → find today's meal in plan → send tonight message with prep summary and "Full Recipe" / "Swap" buttons. If no plan or no meal today → "No dinner planned for tonight. Want me to generate a meal plan?"

Prep summary source: for existing recipes, derive from `instructions[0]` + `prepTime`/`cookTime`. For new suggestions not yet fleshed out, use the `description` field with a note to "show [title]" for full details.

**4. Swap a meal:**
"swap Monday" → LLM suggests replacement (standard tier, respecting same constraints as original plan) → show suggestion → user confirms or says "try another"

**5. New recipe details:**
"show Lemon Herb Salmon" → detect title matches a new suggestion in active plan → LLM generates full recipe (standard tier) → save to recipe library as draft → show full recipe using existing display → "Saved to your recipe library as a draft!"

**6. What can I make:**
"what can I make" → load pantry + all recipes → LLM fast-tier cross-reference → grouped response: "Ready to Cook" (full matches) first, then "Almost There" (near matches with missing items)

**7. Generate grocery list from plan:**
"Grocery List" button on plan message → collect all recipe IDs from plan. If any meals are still unresolved new suggestions (not yet fleshed out), include a note: "Skipped 2 new recipes — use 'show [title]' to save them first, then regenerate the grocery list." Only resolved recipe IDs pass to existing `grocery-generator.generateGroceryFromRecipes()` → adds to existing grocery list, excludes staples and pantry items with override buttons

### Callback Buttons

| Callback Data | Action |
|---|---|
| `app:food:grocery-from-plan` | Generate grocery list from all plan recipes |
| `app:food:regenerate-plan` | Regenerate entire plan |
| `app:food:show-recipe:<day>` | Show full recipe for a day (triggers detail generation for new suggestions) |
| `app:food:swap:<day>` | Swap a specific day's meal |

## Telegram Message Formats

### Meal Plan (all meals visible, no expanding)

```
🗓 Meal Plan: Mar 31 – Apr 6
5 dinners • 3 from your recipes, 2 new suggestions

Mon — Chicken Stir Fry
🕒 30 min • Asian • ⭐ 4.5

Tue — ✨ Lemon Herb Salmon (new)
Pan-seared salmon with lemon, dill, and roasted asparagus

Wed — Pasta Bolognese
🕒 45 min • Italian • ⭐ 4.0

Thu — ✨ Thai Basil Chicken (new)
Quick stir-fry with holy basil, chilies, and jasmine rice

Fri — Fish Tacos
🕒 25 min • Mexican • ⭐ 4.8

🌱 In season (Raleigh, NC): asparagus, strawberries, peas

• "swap Monday" to replace a meal
• "show Lemon Herb Salmon" for full recipe details
• "generate grocery list" to shop for this plan

[🛒 Grocery List] [🔄 Regenerate]
```

### "What's for Dinner?"

```
🍽 Tonight: Chicken Stir Fry
🕒 30 min total (10 prep + 20 cook) • Serves 4

Quick prep: Slice chicken and veggies, make sauce (soy sauce, ginger, garlic, sesame oil). Cook rice first.

[📖 Full Recipe] [🔄 Swap]
```

### "What Can I Make?"

```
🔍 What You Can Make

✅ Ready to Cook (3)
• Pasta Bolognese  🕒 45 min
• Garlic Butter Rice  🕒 20 min
• Simple Egg Fried Rice  🕒 15 min

🛒 Almost There (2)
• Chicken Stir Fry — need: chicken breast
• Fish Tacos — need: white fish, tortillas

Based on 8 pantry items matched against 12 recipes
Reply with a recipe name for full details
```

## LLM Tier Assignments

| Operation | Tier | Rationale |
|---|---|---|
| Plan generation | `standard` | Complex multi-constraint reasoning |
| Meal swap suggestion | `standard` | Needs plan context awareness |
| New recipe detail generation | `standard` | Full recipe creation |
| "What can I make?" matching | `fast` | Ingredient comparison |

## Security

- `sanitizeInput()` on all user content in LLM prompts (dietary prefs, restrictions, recipe titles)
- Anti-instruction framing on all LLM prompts
- `classifyLLMError()` on all LLM catch blocks with user-friendly messages
- Household membership enforced via `requireHousehold()` on all operations
- Callback data validated: day names checked against plan, recipe titles matched against plan state
- Location field validated as non-empty string before inclusion in prompts
- Frontmatter on all YAML writes

## Existing Code to Reuse

| Utility | Location | Used For |
|---------|----------|----------|
| `requireHousehold()` | `src/utils/household-guard.ts` | Guard all operations |
| `searchRecipes()`, `loadRecipe()`, `saveRecipe()` | `src/services/recipe-store.ts` | Recipe library access, saving new recipes |
| `loadPantry()` | `src/services/pantry-store.ts` | Pantry state for plan generation + "what can I make?" |
| `generateGroceryFromRecipes()` | `src/services/grocery-generator.ts` | "Grocery List" button on plan |
| `parseJsonResponse()` | `src/services/recipe-parser.ts` | LLM JSON response parsing |
| `sanitizeInput()` | `src/utils/sanitize.ts` | LLM prompt security |
| `classifyLLMError()` | `core/src/utils/llm-errors.ts` | User-friendly LLM errors |
| `generateFrontmatter()`, `stripFrontmatter()` | `core/src/utils/frontmatter.ts` | YAML read/write |
| `todayDate()`, `isoNow()`, `generateId()` | `src/utils/date.ts` | Dates and IDs |
| `sendWithButtons()`, `editMessage()` | `CoreServices.telegram` | Inline keyboards |
| `handleCallbackQuery()` | `src/index.ts` | Callback routing (extend existing) |

## New Files

| File | Purpose |
|------|---------|
| `src/services/meal-plan-store.ts` | Meal plan CRUD, formatting, archive |
| `src/services/meal-planner.ts` | LLM plan generation, swap, new recipe details |
| `src/services/pantry-matcher.ts` | LLM "what can I make?" cross-reference |
| `src/__tests__/meal-plan-store.test.ts` | Plan CRUD, formatting, tonight resolver |
| `src/__tests__/meal-planner.test.ts` | Plan generation, swap, new recipe detail |
| `src/__tests__/pantry-matcher.test.ts` | Matching logic, grouped output |

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `isNew` and `description` fields to `PlannedMeal` |
| `src/index.ts` | New commands, intents, callback handlers, scheduled job registration |
| `config/pas.yaml` | Add `location` field to user config |
| `manifest.yaml` | Verify `/mealplan` command and `generate-weekly-plan` schedule declared |
| `help.md` | Add meal planning and "what can I make?" sections |
| `docs/urs.md` | Update MEAL-001/002/005/007, PANTRY-002, SEASON-001/003 status + test refs |

## Verification

1. `pnpm build` — clean
2. `pnpm lint` — clean
3. `pnpm test` — all pass (existing + ~80-100 new)
4. Manual: `/mealplan generate` → see detailed card with all meals, seasonal note with location
5. Manual: "what's for dinner" → see tonight's meal with prep summary
6. Manual: "show [new recipe title]" → full recipe generated and saved as draft
7. Manual: "swap Monday" → get replacement suggestion
8. Manual: "what can I make" → grouped list with full matches first
9. Manual: tap "Grocery List" button → grocery list generated from plan recipes, staple/pantry exclusions shown
10. Manual: verify scheduled job generates plan on configured day/time
