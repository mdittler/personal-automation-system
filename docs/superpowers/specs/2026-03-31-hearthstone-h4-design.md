# Hearthstone Phase H4: Voting, Ratings, and Interactive Shopping

| Field | Value |
|-------|-------|
| **Phase** | H4 |
| **Status** | Design Complete |
| **Date** | 2026-03-31 |
| **Requirements** | REQ-MEAL-003, REQ-MEAL-004, REQ-RECIPE-003, REQ-GROCERY-009, REQ-NFR-006 (REQ-GROCERY-008 already implemented in H2a) |
| **Dependencies** | H2a (grocery), H3 (meal planning) — both complete |
| **Estimated tests** | 55–75 new tests |

---

## Context

H3 delivers weekly meal plan generation, but the plan is currently fire-and-forget — no household input, no feedback loop after cooking, and no follow-up after shopping trips. H4 closes these loops: household members vote on proposed meals, rate them after cooking, and get shopping follow-ups for forgotten items. This feedback data improves future plan generation (highly-rated recipes are preferred, downvoted ones avoided) and promotes draft LLM-suggested recipes to confirmed status.

---

## 1. Voting System (REQ-MEAL-003)

### Flow

1. When a meal plan is generated (manually via `/mealplan` or via the `generate-weekly-plan` scheduled job), plan status is set to `voting`
2. Each meal in the plan is sent as an **individual Telegram message** to all household members, with inline buttons: `👍` / `👎` / `😐`
3. Votes are stored on `PlannedMeal.votes` (existing field: `Record<string, 'up' | 'down' | 'neutral'>`)
4. **Implicit neutral:** not voting = neutral. Only explicit 👍/👎 carry signal
5. A `finalize-votes` scheduled job runs hourly. When the voting window expires:
   - Meals with net-negative votes (more 👎 than 👍) are flagged for replacement
   - LLM generates replacement suggestions for downvoted meals (single standard-tier call)
   - Plan status moves from `voting` → `active`
   - All household members receive a finalized plan summary
6. **Early finalization:** if all household members have voted on all meals before the window expires, finalize immediately
7. The number of meals adapts to the `meal_plan_dinners` config field — not hardcoded

### Callback data format

- `vote:<mealIndex>:<up|down|neutral>` — records a vote on a specific meal

### New config fields

| Field | Default | Description |
|-------|---------|-------------|
| `voting_window_hours` | 12 | Hours before votes are finalized |

### New scheduled job

| Job ID | Schedule | Scope | Description |
|--------|----------|-------|-------------|
| `finalize-votes` | `0 * * * *` (hourly) | shared | Check voting windows, finalize expired ones |

### Idempotency (REQ-NFR-006)

The finalization job only processes plans in `voting` status. Setting status to `active` is the terminal state — re-running is a no-op. The `votingStartedAt` timestamp (new field on MealPlan) determines window expiry.

### New files

- `services/voting.ts` — vote recording, window check, finalization logic, replacement generation via LLM
- `handlers/voting.ts` — callback handler for vote buttons, message formatting for vote messages and finalized summary

### Type changes

Add to `MealPlan`:
```typescript
votingStartedAt?: string; // ISO datetime — set when plan enters voting
```

---

## 2. Rating & Recipe Confirmation (REQ-MEAL-004, REQ-RECIPE-003)

### Flow

1. **Daily 8pm scheduled job** (`nightly-rating-prompt`) checks the active meal plan for meals where `cooked === false` and the meal's `date` is today or earlier
2. Sends a message to all household members: "What did you cook tonight?" with compact inline buttons — one button per uncooked meal title
3. User taps a meal → bot sends a follow-up: "How was {meal title}?" with `👍` / `👎` / `⏭ Skip` buttons
4. **👍** → stores positive rating on Recipe (`ratings` array), marks `PlannedMeal.cooked = true` and `rated = true`. If recipe status is `draft`, auto-promotes to `confirmed`
5. **👎** → stores negative rating on Recipe, marks cooked + rated. Recipe stays `draft`
6. **⏭ Skip** → marks `PlannedMeal.cooked = true`, `rated = true`. No rating stored (neutral signal)
7. **Non-response** to the nightly prompt = completely neutral, no state change, no negative signal
8. **Alternative entry:** `/mealplan` view shows a "✅ Cooked!" button next to each uncooked meal. Tapping triggers the same rating follow-up

### Rating storage

Ratings are stored on the existing `Recipe.ratings` array:
```typescript
{ userId: string, score: number, date: string, notes?: string }
```

Map: 👍 = score 5, 👎 = score 1, Skip = no entry.

### Recipe confirmation (REQ-RECIPE-003)

When a `draft` recipe receives a 👍 rating:
1. Call `updateRecipe()` to set `status: 'confirmed'`
2. Include a note in the rating response: "Recipe confirmed! It'll appear more often in future plans."

No separate confirmation flow — the rating interaction handles it.

### Callback data format

- `cooked:<mealIndex>` — marks a meal as cooked, triggers rating prompt
- `rate:<mealIndex>:<up|down|skip>` — records rating for a cooked meal

### New scheduled job

| Job ID | Schedule | Scope | Description |
|--------|----------|-------|-------------|
| `nightly-rating-prompt` | `0 20 * * *` (8pm daily) | shared | Prompt household for what they cooked |

### Idempotency (REQ-NFR-006)

Meals with `cooked === true` are excluded from the nightly prompt. To prevent duplicate prompts on the same day, store `lastRatingPromptDate` on the MealPlan. The job checks this before sending.

### New files

- `services/rating.ts` — rating storage on recipes, nightly prompt meal selection, recipe confirmation logic
- `handlers/rating.ts` — callback handlers for meal selection and rating buttons, message formatting

### Type changes

Add to `MealPlan`:
```typescript
lastRatingPromptDate?: string; // ISO date — prevents duplicate nightly prompts
```

---

## 3. Shopping Follow-up (REQ-GROCERY-009)

### Flow

1. When user clears purchased items (existing `clear` callback), the current pantry prompt still fires as-is
2. **New:** after clearing, if items remain on the grocery list, schedule a one-off follow-up message for 1 hour later using `services.scheduler.scheduleOnce()`
3. Follow-up message (sent to all household members): "You still have {N} items on your grocery list:\n{item list}\n\nDone shopping?" with buttons: `✅ Clear remaining` / `📋 Keep for next trip`
4. **Clear remaining** — archives leftover items, empties the list, sends confirmation
5. **Keep for next trip** — dismisses the follow-up, items stay on list

### Implementation

Uses the existing `SchedulerService.scheduleOnce()` with `jobId: 'shopping-followup'`. The `handleScheduledJob` router dispatches to the follow-up handler.

If a new clear happens before the follow-up fires, the old one-off is cancelled (`cancelOnce`) and a new one is scheduled.

### Callback data format

- `shop-followup:clear` — clear all remaining items
- `shop-followup:keep` — keep items for next trip

### New files

- `handlers/shopping-followup.ts` — follow-up message formatting and callback handlers

### Changes to existing files

- `index.ts` — after the existing `clear` callback, add logic to schedule the follow-up if items remain. Add routing for new callbacks and the new scheduled job ID.

---

## 4. Architecture: Handler Extraction (Approach B)

New H4 handlers live in a `handlers/` directory. Existing H1-H3 handlers remain in `index.ts` untouched.

### File structure

```
apps/hearthstone/src/
├── handlers/
│   ├── voting.ts              # Vote callback handlers + message formatting
│   ├── rating.ts              # Rating callback handlers + message formatting
│   └── shopping-followup.ts   # Shopping follow-up callbacks + formatting
├── services/
│   ├── voting.ts              # Vote recording, finalization, LLM replacement
│   └── rating.ts              # Rating storage, nightly prompt logic, confirmation
├── index.ts                   # Routes new callbacks/jobs to handler modules
└── ... (existing files unchanged)
```

### Routing in index.ts

`handleCallbackQuery` gains new `if` branches that delegate to handler modules:
- `vote:*` → `handlers/voting.ts`
- `cooked:*`, `rate:*` → `handlers/rating.ts`
- `shop-followup:*` → `handlers/shopping-followup.ts`

`handleScheduledJob` gains two new job IDs:
- `finalize-votes` → `services/voting.ts`
- `nightly-rating-prompt` → `services/rating.ts`
- `shopping-followup` → `handlers/shopping-followup.ts`

---

## 5. Manifest Changes

Add to `manifest.yaml` schedules:

```yaml
- id: finalize-votes
  cron: "0 * * * *"
  description: Check voting windows and finalize expired meal plan votes
  user_scope: shared

- id: nightly-rating-prompt
  cron: "0 20 * * *"
  description: Prompt household members for what they cooked today
  user_scope: shared
```

Add to config fields:

```yaml
voting_window_hours:
  type: number
  default: 12
  description: Hours to wait before finalizing meal plan votes
```

---

## 6. LLM Usage

| Operation | Tier | When |
|-----------|------|------|
| Vote finalization — replacement suggestions | standard | When downvoted meals need replacements (finalize-votes job) |

All other H4 operations are deterministic — no LLM calls for voting, rating, or shopping follow-up.

---

## 7. Security Considerations

- **Callback data validation:** all callback handlers validate `mealIndex` is a valid number within bounds, same as existing `toggle:N` pattern
- **Household guard:** all callbacks require household membership (existing `requireHousehold` pattern)
- **Vote manipulation:** votes are keyed by userId — a user can only have one vote per meal (last vote wins)
- **Rating spam:** `PlannedMeal.rated` flag prevents multiple ratings for the same meal-cook event
- **Input sanitization:** no user-provided text enters LLM prompts in H4 (replacement suggestions use recipe titles from the system)

---

## 8. Testing Strategy

### New test files

| File | Focus | Est. tests |
|------|-------|-----------|
| `voting.test.ts` | Vote recording, window expiry, finalization, replacement LLM call, early finalization | 15–20 |
| `rating.test.ts` | Nightly prompt generation, rating storage on recipe, recipe confirmation on 👍, skip, non-response | 15–20 |
| `shopping-followup.test.ts` | Follow-up scheduling, clear-remaining callback, keep callback, cancellation on re-clear | 8–12 |
| `app.test.ts` (additions) | New callback routing, new scheduled job routing, idempotency | 10–15 |
| `natural-language.test.ts` (additions) | Persona tests for voting/rating interactions | 5–8 |

### Key test scenarios

**Voting:**
- Record vote, verify on PlannedMeal
- Change vote (last vote wins)
- Window expiry triggers finalization
- Net-negative meal gets LLM replacement
- All members voted → early finalization
- Finalize job is no-op on `active` plans

**Rating:**
- Nightly prompt shows only uncooked meals
- 👍 stores rating + confirms draft recipe
- 👎 stores rating, draft stays draft
- Skip marks cooked with no rating
- Duplicate nightly prompt prevented by lastRatingPromptDate
- `/mealplan` "Cooked!" button triggers same flow

**Shopping follow-up:**
- Follow-up scheduled 1h after clear with remaining items
- No follow-up if all items were purchased
- Clear-remaining archives and empties
- Keep keeps items on list
- Re-clear cancels pending follow-up

---

## 9. Verification Plan

1. `pnpm build` — no type errors
2. `pnpm test` — all existing + new tests pass
3. `pnpm lint` — no lint errors
4. Manual Telegram testing:
   - Generate a meal plan → verify individual vote messages sent
   - Vote on meals → verify votes recorded, finalization works
   - Wait for nightly prompt → tap cooked → rate → verify recipe updated
   - Clear grocery list with remaining items → verify follow-up after 1h
   - `/mealplan` shows "Cooked!" buttons on uncooked meals
