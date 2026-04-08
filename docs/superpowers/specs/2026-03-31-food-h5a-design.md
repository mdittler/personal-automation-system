# Food H5a: Cook Mode State Machine + Recipe Scaling

## Context

With H1-H4 complete (recipes, grocery, meal planning, voting/ratings), the natural next step is helping users actually cook. H5 covers cook mode, timers, TTS, scaling, and food query context. To keep sessions focused, H5 is split:

- **H5a** (this spec): Cook mode state machine + recipe scaling
- **H5b** (separate spec): Timer integration, TTS/Chromecast, contextual food queries

## User Flow

1. User says `/cook lasagna` or "start cooking the lasagna"
2. App finds recipe, asks "How many servings? (Recipe serves 6)"
3. User replies "4" / "double" / "half" -- app scales ingredients
4. Shows scaled ingredients summary, then step 1 with navigation buttons
5. User taps Next/Back/Repeat/Done to navigate through steps
6. After last step -- completion message with rating prompt

## New Types

Added to `apps/food/src/types.ts`:

```typescript
export interface ScaledIngredient extends Ingredient {
  originalQuantity: number | null;
  scaledQuantity: number | null;
}

export interface CookSession {
  userId: string;
  recipeId: string;
  recipeTitle: string;
  currentStep: number;          // 0-based index into instructions
  totalSteps: number;
  targetServings: number;
  originalServings: number;
  scaledIngredients: ScaledIngredient[];
  scalingNotes: string | null;
  instructions: string[];
  startedAt: number;            // Date.now()
  lastActivityAt: number;       // for 24h inactivity timeout
  lastMessageId: number | null; // for editMessage on button taps
  lastChatId: number | null;
}

export type CookAction = 'next' | 'back' | 'repeat' | 'done';
```

Note: `scalingNotes` already exists on the `Recipe` type (types.ts line 60).

## New Files

### `src/services/recipe-scaler.ts`

Pure scaling logic + one LLM call for non-linear notes.

| Export | Description |
|--------|-------------|
| `parseServingsInput(input: string, originalServings: number): number \| null` | Parses "4", "double", "half", "quarter", "triple", "3 servings". Returns null for invalid/zero/negative. |
| `scaleIngredients(ingredients: Ingredient[], original: number, target: number): ScaledIngredient[]` | Linear: `qty * (target/original)`, rounded 2dp. Null quantities pass through. |
| `generateScalingNotes(services: CoreServices, recipe: Recipe, target: number): Promise<string>` | LLM standard tier, maxTokens ~300. Only called when ratio > 1.5x or < 0.67x. Covers spice adjustment, baking time, pan size, chemistry. Caches on `recipe.scalingNotes` via `updateRecipe()`. |
| `formatScaledIngredients(ingredients: ScaledIngredient[], target: number, original: number, notes: string \| null): string` | Telegram-formatted bullet list with "(originally X)" when quantities differ. Appends scaling notes if present. |

### `src/services/cook-session.ts`

In-memory session manager implementing the cook mode state machine.

Module-level state: `const activeSessions = new Map<string, CookSession>()`

| Export | Description |
|--------|-------------|
| `createSession(userId, recipe, targetServings, scaledIngredients, scalingNotes)` | Creates and stores session in map |
| `getSession(userId): CookSession \| null` | Lookup by userId |
| `advanceStep(session): 'ok' \| 'completed'` | Increments currentStep; returns 'completed' past last step |
| `goBack(session): 'ok' \| 'at_start'` | Decrements; returns 'at_start' if already step 0 |
| `endSession(userId): void` | Removes from map |
| `touchSession(session): void` | Updates lastActivityAt |
| `isSessionExpired(session): boolean` | True if 24h since lastActivityAt |
| `cleanExpiredSessions(): number` | Sweeps map, removes expired, returns count |
| `hasActiveSession(userId): boolean` | Quick check |
| `formatStepMessage(session): string` | "Step 3 of 12\n\n{instruction text}" |
| `buildStepButtons(session): InlineButton[][]` | [[< Back, Repeat, Next >, Done]] |
| `formatCompletionMessage(session): string` | Congratulations + rating prompt |
| `getSessionCount(): number` | For diagnostics |

State transitions:
```
[no session] --(/cook)--> SERVINGS_PROMPT --> INGREDIENTS_SHOWN --> STEP_1
STEP_N --(next)--> STEP_N+1
STEP_N --(back)--> STEP_N-1 (clamped to 0)
STEP_N --(repeat)--> STEP_N (re-send)
STEP_LAST --(next)--> COMPLETED (completion + rating prompt)
ANY --(done/exit)--> ENDED (session removed)
ANY --(24h inactivity)--> EXPIRED (cleaned by sweep)
```

### `src/handlers/cook-mode.ts`

Telegram orchestration layer. Follows pattern from `handlers/rating.ts` and `handlers/voting.ts`.

| Export | Description |
|--------|-------------|
| `handleCookCommand(services, args, ctx)` | `/cook` entry point -- find recipe, prompt servings |
| `handleCookIntent(services, text, ctx)` | NL entry ("start cooking the lasagna") |
| `handleCookCallback(services, data, userId, chatId, messageId)` | Button dispatch for ck:n/b/r/d |
| `handleCookTextAction(services, text, ctx): Promise<boolean>` | Intercepts "next"/"back"/"done" text during active session. Returns true if consumed. |
| `handleServingsReply(services, text, ctx)` | Handles servings input after recipe selection |
| `hasPendingCookRecipe(userId): boolean` | Checks pending recipe state |
| `isCookModeActive(userId): boolean` | Re-export of hasActiveSession |

Pending state: `pendingCookRecipes` map with 5-min TTL, same pattern as `pendingPantryItems` in index.ts (line 626-644).

**handleCookCommand flow:**
1. `requireHousehold()` guard
2. `loadAllRecipes()` + `findRecipeByTitle(recipes, args.join(' '))`
3. Not found: search recipes, show results, prompt to pick by number
4. Found: send servings prompt with recipe's default servings
5. Store pending recipe ID with 5-min TTL
6. On servings reply: parse with `parseServingsInput`, scale with `scaleIngredients`, optionally `generateScalingNotes`
7. `createSession`, send ingredients summary, then step 1 with buttons

**handleCookCallback:** Dispatches on n/b/r/d after `ck:` prefix. Looks up session by userId. Edits existing message via `services.telegram.editMessage`. On completion, sends new message with congratulations.

**handleCookTextAction:** Checks `hasActiveSession(userId)`, matches lowercase text against "next", "back", "previous", "repeat", "done", "exit", "stop", "quit". Returns true if consumed, false for fall-through to other intents.

## Modified Files

### `src/index.ts` -- 6 integration points

1. **Imports** (after line 66): Add cook-mode handler imports
2. **Cook text intercept** (in handleMessage, after number-selection at line 100, before intent detection at line 103): Check `isCookModeActive()` and `hasPendingCookRecipe()` first
3. **Cook intent** (after pantry intents at line 193, before fallback): Add `isCookIntent(lower)` check
4. **Command case** (replace default at line 251): `case 'cook': handleCookCommand(services, args, ctx)`
5. **Callback routing** (after shopping-followup at line 619): Add `ck:` prefix handling
6. **Intent detector** (with other `is*Intent` functions): Add `isCookIntent()` regex

### `src/types.ts` -- Add CookSession, ScaledIngredient, CookAction types

### `manifest.yaml` -- No changes needed (already declares `/cook` command and cook intent)

## Callback Data Format

Short prefixes, well under Telegram's 64-byte limit:

| Button | Data (after `app:food:` stripped) | Wire bytes |
|--------|------------------------------------------|------------|
| < Back | `ck:b` | 21 |
| Repeat | `ck:r` | 21 |
| Next > | `ck:n` | 21 |
| Done   | `ck:d` | 21 |

No recipe ID or step number encoded -- session is keyed by userId in the in-memory map.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| 1-step recipe | Show step 1 with all buttons. Next -> immediate completion |
| Back from step 1 | "You're already on the first step." + re-display step 1 |
| Advance past last step | Completion message with rating prompt |
| Recipe not found | "I couldn't find a recipe called '{X}'. Try /recipes to search." |
| Already in cook mode | "You're already cooking {title}! Say 'done' to finish." |
| Zero/negative servings | Friendly reprompt |
| Unparseable servings | "I didn't understand that. Try a number like '4', 'double', or 'half'." |
| Other intents during cook mode | handleCookTextAction returns false, falls through to normal routing. Session stays active. |
| Expired session (24h) | Cleaned on next interaction; cook actions treated as no-session |

## Testing Strategy (~53 tests)

### `recipe-scaler.test.ts` (~15 tests)
- scaleIngredients: 2x, 0.5x, 1x no-op, null quantities, rounding (2dp)
- parseServingsInput: "4", "double", "half", "quarter", "triple", "3 servings", "0" rejected, "-1" rejected, "banana" rejected, "" rejected
- formatScaledIngredients: with/without notes, mixed null/non-null quantities
- generateScalingNotes: mock LLM, verify prompt includes recipe + ingredients, tier is "standard"

### `cook-session.test.ts` (~18 tests)
- createSession: correct initialization, stored in map
- advanceStep: step 0->1, last step returns "completed"
- goBack: step 2->1, step 0 returns "at_start"
- touchSession: updates lastActivityAt
- isSessionExpired: fresh=false, 25h ago=true
- cleanExpiredSessions: removes expired, keeps active, returns count
- endSession: removes from map
- hasActiveSession: true/false
- formatStepMessage: 1-indexed display, progress format
- buildStepButtons: correct 4-button layout with ck: callback data
- formatCompletionMessage: includes congratulations
- Multi-user isolation: two concurrent sessions independent

### `cook-mode-handler.test.ts` (~20 tests)
- handleCookCommand: recipe found -> servings prompt; not found -> error; already cooking -> warning
- Servings flow: valid number creates session + sends ingredients; "double" scales; invalid -> retry
- handleCookCallback: ck:n advances, ck:b goes back, ck:r repeats, ck:d ends
- handleCookCallback: next on last step -> completion + rating prompt
- handleCookCallback: back on step 1 -> friendly message
- handleCookTextAction: "next" returns true, "what's for dinner" returns false, no session returns false
- handleCookIntent: extracts recipe from "start cooking the lasagna"
- 1-step recipe: next -> immediate completion
- Expired session: treated as no session

## H5b Deferred Items

The following are explicitly deferred to H5b. H5a's design leaves extension points for each.

### REQ-COOK-002: Timer Integration
- Extract timing from step text via regex + LLM (e.g., "bake for 25 minutes" -> 25 min)
- Offer "Set timer for X min" button when timing detected in a step
- Use `services.scheduler.scheduleOnce(appId, jobId, runAt, handler)` for one-off timer notifications
- Cancel timer automatically when user advances past the timed step
- Timer fires -> Telegram notification: "Timer done! {step text}. Ready for next step?" with Next button
- Duration parsing: ranges ("5-7 minutes" -> midpoint), approximations ("about 20 min"), conversions ("1.5 hours" -> 90 min)
- One timer per cook session; new timer replaces previous
- **Extension point:** CookSession gains `timerId?: string` field; `formatStepMessage` detects time references

### REQ-COOK-003: TTS / Chromecast Support
- On cook mode entry, offer hands-free mode: "Would you like hands-free cooking with voice?" Yes/No buttons
- Each step spoken via `services.audio.speak(stepText, deviceName?)`
- Device from `services.config.get('tts_device_name')` or system default
- Best-effort, non-blocking: audio failure logged, text continues uninterrupted
- Voice input for advancement is out of scope (no voice input service exists)
- **Extension point:** CookSession gains `ttsEnabled: boolean` field; step rendering calls `services.audio.speak()` alongside text
- **Config additions for manifest:** `tts_device_name` (string, default ""), `auto_advance_timer` (boolean, default false)

### REQ-QUERY-001: Contextual Food Questions
- Enhance existing `handleFoodQuestion()` in index.ts to load user context
- Context sources: `services.contextStore.searchForUser('food preferences allergies family dietary restrictions pregnancy', userId)`
- Include context summary in LLM prompt alongside the sanitized question
- Add health disclaimer for safety-related questions ("Not professional medical advice")
- Graceful fallback when context store has no entries for user
- **Extension point:** Active cook session provides recipe context (current recipe, current step) for in-cooking questions like "what temperature should the oven be?"
- **No new files needed** -- extends existing food question handler function

### Shared H5b Manifest Changes
- Add `tts_device_name` config field (string)
- Add `auto_advance_timer` config field (boolean)
- Add `cook_mode_timeout_hours` config field (number, default 24)
- No new scheduled jobs needed (timers are one-off via scheduler API)

## Verification

1. Run `pnpm test` -- all existing 2953 tests still pass
2. Run new tests: `pnpm test apps/food/src/__tests__/recipe-scaler.test.ts`
3. Run new tests: `pnpm test apps/food/src/__tests__/cook-session.test.ts`
4. Run new tests: `pnpm test apps/food/src/__tests__/cook-mode-handler.test.ts`
5. Run `pnpm build` -- no type errors
6. Run `pnpm lint` -- no lint errors
7. Manual smoke test: `/cook` with a known recipe, navigate through steps, test scaling
