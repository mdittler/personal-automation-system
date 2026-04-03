# H7: Batch Cooking & Cuisine Tracking — Design Spec

## Context

Hearthstone phases H1–H6 are complete, covering recipes, meal planning, grocery lists, voting, cook mode, pantry/freezer tracking, leftovers, and waste management. H7 adds intelligent batch prep analysis and cuisine diversity tracking — logical next steps that leverage the existing meal plan and freezer infrastructure.

## Requirements Covered

- **REQ-BATCH-001:** Shared prep component detection across recipes
- **REQ-BATCH-002:** Consolidated prep plan with timing estimates
- **REQ-BATCH-003:** Freezer-friendly flagging — suggest doubling, log frozen portions
- **REQ-BATCH-004:** Defrost reminders for frozen ingredients in meal plan
- **REQ-CULTURE-001:** Cuisine diversity tracking and repetition alerts

## Architecture

Two new service files, plus integration in `index.ts` and `handleScheduledJob`.

### File: `apps/hearthstone/src/services/batch-cooking.ts`

Exports three functions:

#### `analyzeBatchPrep(services, sharedStore, plan, recipes)`

1. Load full recipe details for each meal in the plan
2. Call LLM (`standard` tier) with all recipe ingredients and instructions, asking it to:
   - Identify shared prep tasks (e.g., "dice onions — used in Recipe A, Recipe C")
   - Estimate time for each prep task
   - Flag which recipes are freezer-friendly (suitable for doubling)
3. Parse LLM response into structured `BatchAnalysis`:
   ```ts
   interface SharedPrepTask {
     task: string;           // "Dice onions"
     recipes: string[];      // Recipe names that use this
     estimatedMinutes: number;
   }
   
   interface BatchAnalysis {
     sharedTasks: SharedPrepTask[];
     totalPrepMinutes: number;
     estimatedSavingsMinutes: number;
     freezerFriendlyRecipes: string[];  // REQ-BATCH-003
   }
   ```
4. Format a Telegram message:
   - Shared prep tasks grouped by type, with which meals they serve
   - Total estimated prep time and time saved by batching
   - Freezer-friendly suggestions: "Consider doubling [recipe] — it freezes well!"
5. Send to all household members

**Trigger:** Called after meal plan generation/confirmation in `index.ts` (both manual via `handleMealPlanGenerate` and scheduled via `generate-weekly-plan`), and after plan regeneration via `regenerate-plan` callback. Also called after voting finalization when a plan is confirmed.

#### `checkDefrostNeeded(services, sharedStore, plan, recipes)`

1. Load freezer inventory via `freezer-store.ts`
2. For each meal in the plan, check if any recipe ingredients match freezer items (case-insensitive substring match on item name)
3. If matches found for tomorrow's meal(s), format a defrost reminder message
4. Send to all household members

**Trigger:** New `defrost-check` cron job, daily at 7pm.

#### `logFrozenPortion(services, sharedStore, recipeName, portions)` (REQ-BATCH-003)

Convenience function to add a frozen portion to the freezer inventory when a user doubles a recipe. Called from a callback button on the batch prep message ("Double & freeze [recipe]").

### File: `apps/hearthstone/src/services/cuisine-tracker.ts`

Exports one function:

#### `checkCuisineDiversity(services, sharedStore)`

1. Load current week's meal plan
2. If no plan exists, skip silently
3. Call LLM (`fast` tier) with recipe names/descriptions, asking it to classify each meal by cuisine type (return JSON array of `{recipe, cuisine}`)
4. Count occurrences per cuisine — if any appears 3+ times, flag it
5. Send Telegram message to all household members: "Your meal plan has [cuisine] [N] times this week — consider mixing in some variety next time!"
6. If no repetition, skip sending (no noise)

**Trigger:** Existing `cuisine-diversity-check` cron job, Sunday 8am (already declared in manifest).

## Integration Points in `index.ts`

### Meal plan generation hook

After plan is saved and messages sent, call `analyzeBatchPrep()`. Three call sites:

1. `handleMealPlanGenerate()` (~line 1579, after `savePlan`)
2. `handleScheduledJob` for `generate-weekly-plan` (~line 1863, after `savePlan`)
3. `regenerate-plan` callback (~line 579, after `savePlan`)

For multi-member voting households: call `analyzeBatchPrep()` after votes are finalized and plan confirmed (in `handleFinalizeVotesJob`).

### `handleScheduledJob` additions

```ts
if (jobId === 'defrost-check') {
    await handleDefrostCheck(services);
    return;
}
if (jobId === 'cuisine-diversity-check') {
    await handleCuisineDiversityCheck(services);
    return;
}
```

### Callback handler for freeze suggestion

New callback prefix `batch:freeze:` — when user taps "Double & freeze [recipe]", call `logFrozenPortion()` to add to freezer inventory. Sends confirmation message.

## Manifest Changes

Add new schedule entry:

```yaml
- id: defrost-check
  description: "Check if tomorrow's meals need frozen ingredients defrosted"
  cron: "0 19 * * *"
  handler: "dist/handlers/defrost-check.js"
  user_scope: shared
```

## LLM Prompts

### Batch Prep Analysis Prompt

Input: all recipe names, ingredients, and instructions for the week's plan.

Ask LLM to return JSON:
```json
{
  "sharedTasks": [
    { "task": "Dice onions (2 large)", "recipes": ["Pasta Bolognese", "Stir Fry"], "estimatedMinutes": 10 }
  ],
  "totalPrepMinutes": 45,
  "estimatedSavingsMinutes": 15,
  "freezerFriendlyRecipes": ["Pasta Bolognese", "Chili"]
}
```

Use `sanitizeInput()` on all recipe content before sending to LLM. Anti-instruction framing around user content.

### Cuisine Classification Prompt

Input: recipe names and brief descriptions.

Ask LLM to return JSON array:
```json
[
  { "recipe": "Pasta Bolognese", "cuisine": "Italian" },
  { "recipe": "Tacos", "cuisine": "Mexican" }
]
```

## Error Handling

- LLM failures: log error, skip sending batch/cuisine message (non-critical feature — don't block meal plan delivery)
- JSON parse failures from LLM: retry once with a more explicit prompt, then skip
- Empty meal plan: skip analysis silently
- No freezer inventory: skip defrost check silently

## Testing Plan (~45 tests)

### `batch-cooking.test.ts` (~30 tests)

**Shared prep detection (REQ-BATCH-001):**
- Identifies shared ingredients across 2+ recipes
- Handles single-recipe plans (no shared tasks possible)
- Handles plan with no overlapping ingredients

**Prep plan formatting (REQ-BATCH-002):**
- Formats shared tasks with recipe names and time estimates
- Calculates total prep time and savings
- Handles edge case: all tasks unique (no savings)

**Freezer-friendly flagging (REQ-BATCH-003):**
- Identifies freezer-friendly recipes from LLM response
- Formats "double & freeze" suggestion message
- `logFrozenPortion` adds item to freezer store correctly
- Callback handler sends confirmation

**Defrost reminders (REQ-BATCH-004):**
- Matches freezer items to tomorrow's recipe ingredients (case-insensitive)
- No match = no message sent
- Multiple matches consolidated into one message
- Empty freezer = skip silently
- No plan = skip silently

**Integration:**
- Called after manual plan generation
- Called after scheduled plan generation
- Called after plan regeneration
- Called after vote finalization (multi-member)
- LLM failure doesn't block plan delivery

### `cuisine-tracker.test.ts` (~15 tests)

**Diversity check (REQ-CULTURE-001):**
- Detects cuisine appearing 3+ times
- No repetition = no message sent
- Handles plan with all different cuisines
- Handles single-meal plans
- No plan = skip silently
- LLM classification failure = skip silently
- Message includes cuisine name and count
- Sends to all household members

## Files Modified

| File | Change |
|------|--------|
| `apps/hearthstone/src/services/batch-cooking.ts` | **New** — batch analyzer, prep planner, defrost check, freeze logging |
| `apps/hearthstone/src/services/cuisine-tracker.ts` | **New** — cuisine diversity analysis |
| `apps/hearthstone/src/index.ts` | Wire batch prep after plan generation (3 call sites + vote finalization), add defrost-check + cuisine-diversity-check to schedule handler, add batch:freeze callback |
| `apps/hearthstone/manifest.yaml` | Add `defrost-check` schedule entry |
| `apps/hearthstone/src/__tests__/batch-cooking.test.ts` | **New** — ~30 tests |
| `apps/hearthstone/src/__tests__/cuisine-tracker.test.ts` | **New** — ~15 tests |
| `apps/hearthstone/docs/urs.md` | Update REQ-BATCH-001–004, REQ-CULTURE-001 status to Implemented, fill in test references |
| `apps/hearthstone/docs/implementation-phases.md` | Mark H7 as complete |

## Verification

1. Run `pnpm test` — all existing + new tests pass
2. Run `pnpm build` — no type errors
3. Run `pnpm lint` — no lint errors
4. Manual: generate a meal plan, verify batch prep analysis message is sent
5. Manual: add items to freezer, generate plan with matching ingredients, verify defrost reminder at 7pm
6. Manual: verify cuisine diversity check runs (or trigger manually)
