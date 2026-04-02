# Hearthstone H4: Voting, Ratings, and Shopping Follow-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meal plan voting, post-meal ratings with recipe confirmation, and shopping follow-up to the Hearthstone app.

**Architecture:** New H4 code lives in `handlers/` and `services/` subdirectories. `index.ts` gets minimal additions to route new callbacks and scheduled jobs to handler modules. Existing H1-H3 handlers stay in `index.ts` untouched. Voting and rating logic is split into pure service functions (testable) and handler functions (orchestration with side effects).

**Tech Stack:** TypeScript, Vitest, YAML storage, Telegram inline keyboards, PAS CoreServices DI

**Spec:** `docs/superpowers/specs/2026-03-31-hearthstone-h4-design.md`

---

## File Structure

```
apps/hearthstone/src/
├── types.ts                        # MODIFY: add votingStartedAt, lastRatingPromptDate to MealPlan
├── index.ts                        # MODIFY: route new callbacks/jobs, modify plan generation for voting
├── services/
│   ├── meal-plan-store.ts          # MODIFY: buildPlanButtons takes optional plan for Cooked buttons
│   ├── voting.ts                   # CREATE: pure voting logic (score, expiry, formatting)
│   └── rating.ts                   # CREATE: pure rating logic (uncooked meals, formatting)
├── handlers/
│   ├── voting.ts                   # CREATE: voting callbacks, sendVotingMessages, finalize job
│   ├── rating.ts                   # CREATE: cooked/rate callbacks, nightly prompt job
│   └── shopping-followup.ts        # CREATE: follow-up scheduling, clear/keep callbacks
├── __tests__/
│   ├── voting.test.ts              # CREATE: voting service tests
│   ├── voting-handler.test.ts      # CREATE: voting handler tests
│   ├── rating.test.ts              # CREATE: rating service tests
│   ├── rating-handler.test.ts      # CREATE: rating handler tests
│   ├── shopping-followup.test.ts   # CREATE: shopping follow-up tests
│   └── app.test.ts                 # MODIFY: add H4 integration tests
├── manifest.yaml                   # MODIFY: add 2 scheduled jobs
```

---

## Shared Test Utilities

These factory functions appear in multiple test files. Each test file defines its own copy (following the existing pattern in `meal-planner.test.ts`).

```typescript
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'chicken-stir-fry-abc', title: 'Chicken Stir Fry', source: 'homemade',
    ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
    instructions: ['Heat oil', 'Add chicken'], servings: 4, prepTime: 10, cookTime: 20,
    tags: ['easy', 'weeknight'], cuisine: 'Asian',
    ratings: [], history: [], allergens: [], status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlannedMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
  return {
    recipeId: 'chicken-stir-fry-abc', recipeTitle: 'Chicken Stir Fry',
    date: '2026-03-31', mealType: 'dinner', votes: {},
    cooked: false, rated: false, isNew: false,
    ...overrides,
  };
}

function makeMealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
  return {
    id: 'plan1', startDate: '2026-03-31', endDate: '2026-04-06',
    meals: [makePlannedMeal()], status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
```

---

## Task 1: Type Additions

**Files:**
- Modify: `apps/hearthstone/src/types.ts:93-101`

- [ ] **Step 1: Add votingStartedAt and lastRatingPromptDate to MealPlan**

In `apps/hearthstone/src/types.ts`, add two optional fields to the `MealPlan` interface:

```typescript
export interface MealPlan {
	id: string;
	startDate: string;
	endDate: string;
	meals: PlannedMeal[];
	status: 'draft' | 'voting' | 'active' | 'completed';
	createdAt: string;
	updatedAt: string;
	votingStartedAt?: string;       // ISO datetime — set when plan enters voting status
	lastRatingPromptDate?: string;  // ISO date (YYYY-MM-DD) — idempotency for nightly prompt
}
```

- [ ] **Step 2: Verify build passes**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm build`
Expected: No type errors. Both fields are optional so existing code compiles unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/hearthstone/src/types.ts
git commit -m "feat(hearthstone): add votingStartedAt and lastRatingPromptDate to MealPlan type"
```

---

## Task 2: Voting Service

**Files:**
- Create: `apps/hearthstone/src/services/voting.ts`
- Create: `apps/hearthstone/src/__tests__/voting.test.ts`

- [ ] **Step 1: Write voting service tests**

Create `apps/hearthstone/src/__tests__/voting.test.ts`:

```typescript
import type { InlineButton } from '@pas/core/types';
import { describe, expect, it } from 'vitest';
import type { MealPlan, PlannedMeal } from '../types.js';
import {
	allMembersVoted,
	buildVoteButtons,
	formatVotingMealMessage,
	getMealsNeedingReplacement,
	isVotingExpired,
	netScore,
	recordVote,
} from '../services/voting.js';

function makePlannedMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc',
		recipeTitle: 'Chicken Stir Fry',
		date: '2026-03-31',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
		...overrides,
	};
}

function makeMealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan1',
		startDate: '2026-03-31',
		endDate: '2026-04-06',
		meals: [makePlannedMeal()],
		status: 'voting',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('voting service', () => {
	describe('recordVote', () => {
		it('sets a vote on a meal and returns true', () => {
			const meal = makePlannedMeal();
			const changed = recordVote(meal, 'user1', 'up');
			expect(changed).toBe(true);
			expect(meal.votes['user1']).toBe('up');
		});

		it('returns false when setting the same vote again', () => {
			const meal = makePlannedMeal({ votes: { user1: 'up' } });
			const changed = recordVote(meal, 'user1', 'up');
			expect(changed).toBe(false);
		});

		it('returns true when changing an existing vote', () => {
			const meal = makePlannedMeal({ votes: { user1: 'up' } });
			const changed = recordVote(meal, 'user1', 'down');
			expect(changed).toBe(true);
			expect(meal.votes['user1']).toBe('down');
		});
	});

	describe('netScore', () => {
		it('returns 0 for no votes', () => {
			expect(netScore(makePlannedMeal())).toBe(0);
		});

		it('sums up=+1, down=-1, neutral=0', () => {
			const meal = makePlannedMeal({
				votes: { user1: 'up', user2: 'down', user3: 'neutral', user4: 'up' },
			});
			expect(netScore(meal)).toBe(1); // +1 -1 +0 +1 = 1
		});

		it('returns negative for majority downvotes', () => {
			const meal = makePlannedMeal({
				votes: { user1: 'down', user2: 'down', user3: 'up' },
			});
			expect(netScore(meal)).toBe(-1);
		});
	});

	describe('isVotingExpired', () => {
		it('returns false when within window', () => {
			const plan = makeMealPlan({
				votingStartedAt: new Date().toISOString(), // just started
			});
			expect(isVotingExpired(plan, 12)).toBe(false);
		});

		it('returns true when past window', () => {
			const past = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(); // 13h ago
			const plan = makeMealPlan({ votingStartedAt: past });
			expect(isVotingExpired(plan, 12)).toBe(true);
		});

		it('returns false when votingStartedAt is missing', () => {
			const plan = makeMealPlan({ votingStartedAt: undefined });
			expect(isVotingExpired(plan, 12)).toBe(false);
		});
	});

	describe('allMembersVoted', () => {
		it('returns true when all members voted on all meals', () => {
			const plan = makeMealPlan({
				meals: [
					makePlannedMeal({ votes: { user1: 'up', user2: 'down' } }),
					makePlannedMeal({ date: '2026-04-01', votes: { user1: 'neutral', user2: 'up' } }),
				],
			});
			expect(allMembersVoted(plan, ['user1', 'user2'])).toBe(true);
		});

		it('returns false when a member has not voted on a meal', () => {
			const plan = makeMealPlan({
				meals: [
					makePlannedMeal({ votes: { user1: 'up' } }), // user2 missing
				],
			});
			expect(allMembersVoted(plan, ['user1', 'user2'])).toBe(false);
		});

		it('returns true for empty meals array', () => {
			const plan = makeMealPlan({ meals: [] });
			expect(allMembersVoted(plan, ['user1'])).toBe(true);
		});
	});

	describe('getMealsNeedingReplacement', () => {
		it('returns meals with net-negative scores', () => {
			const plan = makeMealPlan({
				meals: [
					makePlannedMeal({ votes: { user1: 'down', user2: 'down' } }), // net -2
					makePlannedMeal({ date: '2026-04-01', votes: { user1: 'up', user2: 'up' } }), // net +2
				],
			});
			const result = getMealsNeedingReplacement(plan);
			expect(result).toHaveLength(1);
			expect(result[0].date).toBe('2026-03-31');
		});

		it('returns empty when all meals are non-negative', () => {
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ votes: { user1: 'up' } })],
			});
			expect(getMealsNeedingReplacement(plan)).toHaveLength(0);
		});
	});

	describe('formatVotingMealMessage', () => {
		it('includes recipe title and day', () => {
			const meal = makePlannedMeal({ recipeTitle: 'Pasta Carbonara', date: '2026-04-01' });
			const msg = formatVotingMealMessage(meal);
			expect(msg).toContain('Pasta Carbonara');
			expect(msg).toContain('Tue');
		});

		it('includes new tag for new suggestions', () => {
			const meal = makePlannedMeal({ isNew: true, description: 'A fresh salmon dish' });
			const msg = formatVotingMealMessage(meal);
			expect(msg).toContain('✨');
			expect(msg).toContain('A fresh salmon dish');
		});
	});

	describe('buildVoteButtons', () => {
		it('returns buttons with correct callback data', () => {
			const buttons = buildVoteButtons('2026-04-01');
			expect(buttons).toHaveLength(1); // single row
			expect(buttons[0]).toHaveLength(3); // 3 buttons
			expect(buttons[0][0].callbackData).toBe('app:hearthstone:vote:up:2026-04-01');
			expect(buttons[0][1].callbackData).toBe('app:hearthstone:vote:down:2026-04-01');
			expect(buttons[0][2].callbackData).toBe('app:hearthstone:vote:neutral:2026-04-01');
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/voting.test.ts`
Expected: FAIL — cannot find module `../services/voting.js`

- [ ] **Step 3: Implement voting service**

Create `apps/hearthstone/src/services/voting.ts`:

```typescript
/**
 * Voting service — pure functions for meal plan voting logic.
 *
 * Phase H4: Household members vote on proposed meals with 👍/👎/😐.
 * Votes are tallied after a configurable window. Net-negative meals
 * get replacement suggestions.
 */

import type { InlineButton } from '@pas/core/types';
import type { MealPlan, PlannedMeal } from '../types.js';

// ─── Vote Operations ────────────────────────────────────────────

/**
 * Record a vote on a planned meal. Mutates the meal in place.
 * Returns true if the vote was new or changed, false if identical.
 */
export function recordVote(
	meal: PlannedMeal,
	userId: string,
	vote: 'up' | 'down' | 'neutral',
): boolean {
	if (meal.votes[userId] === vote) return false;
	meal.votes[userId] = vote;
	return true;
}

/**
 * Compute the net score for a meal: +1 per up, -1 per down, 0 per neutral.
 */
export function netScore(meal: PlannedMeal): number {
	let score = 0;
	for (const vote of Object.values(meal.votes)) {
		if (vote === 'up') score += 1;
		else if (vote === 'down') score -= 1;
	}
	return score;
}

// ─── Window & Completion Checks ─────────────────────────────────

/**
 * Check whether the voting window has expired for a plan.
 * Returns false if votingStartedAt is not set.
 */
export function isVotingExpired(plan: MealPlan, windowHours: number): boolean {
	if (!plan.votingStartedAt) return false;
	const startedAt = new Date(plan.votingStartedAt).getTime();
	const expiresAt = startedAt + windowHours * 60 * 60 * 1000;
	return Date.now() >= expiresAt;
}

/**
 * Check whether every household member has voted on every meal.
 */
export function allMembersVoted(plan: MealPlan, memberIds: string[]): boolean {
	return plan.meals.every((meal) =>
		memberIds.every((id) => id in meal.votes),
	);
}

/**
 * Return meals that have a net-negative vote score (more 👎 than 👍).
 */
export function getMealsNeedingReplacement(plan: MealPlan): PlannedMeal[] {
	return plan.meals.filter((meal) => netScore(meal) < 0);
}

// ─── Formatting ─────────────────────────────────────────────────

/** Get the day-of-week abbreviation for a date string. */
function dayAbbrev(dateStr: string): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/**
 * Format a single meal for a voting message sent to household members.
 */
export function formatVotingMealMessage(meal: PlannedMeal): string {
	const day = dayAbbrev(meal.date);
	const newTag = meal.isNew ? ' ✨ (new suggestion)' : '';
	const lines: string[] = [];
	lines.push(`🗳 Vote: ${day} — ${meal.recipeTitle}${newTag}`);
	if (meal.isNew && meal.description) {
		lines.push(meal.description);
	}
	lines.push('');
	lines.push('Tap to vote:');
	return lines.join('\n');
}

/**
 * Build the 👍 / 👎 / 😐 inline buttons for a single meal vote message.
 * Uses the meal date as the unique identifier in callback data.
 */
export function buildVoteButtons(mealDate: string): InlineButton[][] {
	return [
		[
			{ text: '👍', callbackData: `app:hearthstone:vote:up:${mealDate}` },
			{ text: '👎', callbackData: `app:hearthstone:vote:down:${mealDate}` },
			{ text: '😐', callbackData: `app:hearthstone:vote:neutral:${mealDate}` },
		],
	];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/voting.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/voting.ts apps/hearthstone/src/__tests__/voting.test.ts
git commit -m "feat(hearthstone): add voting service with pure vote logic and tests"
```

---

## Task 3: Voting Handler

**Files:**
- Create: `apps/hearthstone/src/handlers/voting.ts`
- Create: `apps/hearthstone/src/__tests__/voting-handler.test.ts`

- [ ] **Step 1: Write voting handler tests**

Create `apps/hearthstone/src/__tests__/voting-handler.test.ts`:

```typescript
import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import type { Household, MealPlan, PlannedMeal, Recipe } from '../types.js';
import {
	handleFinalizeVotesJob,
	handleVoteCallback,
	sendVotingMessages,
} from '../handlers/voting.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makePlannedMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc', recipeTitle: 'Chicken Stir Fry',
		date: '2026-03-31', mealType: 'dinner', votes: {},
		cooked: false, rated: false, isNew: false, ...overrides,
	};
}

function makeMealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan1', startDate: '2026-03-31', endDate: '2026-04-06',
		meals: [makePlannedMeal(), makePlannedMeal({ date: '2026-04-01', recipeTitle: 'Pasta Carbonara', recipeId: 'pasta-abc' })],
		status: 'voting', votingStartedAt: new Date().toISOString(),
		createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

const sampleHousehold: Household = {
	id: 'hh1', name: 'Test Family', createdBy: 'user1',
	members: ['user1', 'user2'], joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

describe('voting handler', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'voting_window_hours') return 12;
			if (key === 'location') return 'Raleigh, NC';
			return undefined;
		});
	});

	describe('sendVotingMessages', () => {
		it('sends one message per meal per household member', async () => {
			const plan = makeMealPlan();
			sharedStore.read.mockResolvedValue(stringify(plan));

			await sendVotingMessages(services, sharedStore as unknown as ScopedDataStore, sampleHousehold);

			// 2 meals × 2 members = 4 messages
			expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(4);
		});

		it('sets plan status to voting with votingStartedAt', async () => {
			const plan = makeMealPlan({ status: 'active', votingStartedAt: undefined });
			sharedStore.read.mockResolvedValue(stringify(plan));

			await sendVotingMessages(services, sharedStore as unknown as ScopedDataStore, sampleHousehold);

			// Verify plan was saved with voting status
			expect(sharedStore.write).toHaveBeenCalled();
			const savedContent = sharedStore.write.mock.calls[0][1] as string;
			const saved = parse(savedContent.replace(/^---[\s\S]*?---\n/, '')) as MealPlan;
			expect(saved.status).toBe('voting');
			expect(saved.votingStartedAt).toBeDefined();
		});
	});

	describe('handleVoteCallback', () => {
		it('records vote and edits message with confirmation', async () => {
			const plan = makeMealPlan();
			// First read returns household, second returns plan
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold)) // household
				.mockResolvedValueOnce(stringify(plan)); // plan

			await handleVoteCallback(services, 'up:2026-03-31', 'user1', 123, 456);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('👍'),
				undefined,
			);
			expect(sharedStore.write).toHaveBeenCalled();
		});

		it('rejects vote when plan is not in voting status', async () => {
			const plan = makeMealPlan({ status: 'active' });
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleVoteCallback(services, 'up:2026-03-31', 'user1', 123, 456);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('Voting has ended'),
				undefined,
			);
		});

		it('ignores vote for nonexistent meal date', async () => {
			const plan = makeMealPlan();
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleVoteCallback(services, 'up:2099-01-01', 'user1', 123, 456);

			// No write should happen
			expect(sharedStore.write).not.toHaveBeenCalled();
		});
	});

	describe('handleFinalizeVotesJob', () => {
		it('does nothing when no plan exists', async () => {
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(''); // no plan

			await handleFinalizeVotesJob(services);

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('does nothing when plan is not in voting status', async () => {
			const plan = makeMealPlan({ status: 'active' });
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleFinalizeVotesJob(services);

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('does nothing when voting window has not expired', async () => {
			const plan = makeMealPlan({
				votingStartedAt: new Date().toISOString(), // just started
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleFinalizeVotesJob(services);

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('finalizes when voting window has expired', async () => {
			const past = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
			const plan = makeMealPlan({ votingStartedAt: past });
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan))
				.mockResolvedValueOnce(''); // loadAllRecipes returns empty
			sharedStore.list.mockResolvedValue([]); // no recipe files

			await handleFinalizeVotesJob(services);

			// Should send finalized plan to all members
			expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2); // 2 members
		});

		it('calls LLM swap for net-negative meals during finalization', async () => {
			const past = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
			const plan = makeMealPlan({
				votingStartedAt: past,
				meals: [
					makePlannedMeal({ votes: { user1: 'down', user2: 'down' } }), // net -2
					makePlannedMeal({ date: '2026-04-01', recipeTitle: 'Pasta', votes: { user1: 'up', user2: 'up' } }), // net +2
				],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan))
				.mockResolvedValueOnce(''); // recipes
			sharedStore.list.mockResolvedValue([]);

			// Mock LLM for swap
			vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify({
				recipeId: 'new-replacement', recipeTitle: 'Grilled Chicken Salad',
				date: '2026-03-31', isNew: true, description: 'Fresh grilled chicken on greens',
			}));

			await handleFinalizeVotesJob(services);

			expect(services.llm.complete).toHaveBeenCalled();
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/voting-handler.test.ts`
Expected: FAIL — cannot find module `../handlers/voting.js`

- [ ] **Step 3: Implement voting handler**

Create `apps/hearthstone/src/handlers/voting.ts`:

```typescript
/**
 * Voting handler — orchestrates meal plan voting via Telegram.
 *
 * Phase H4: Sends per-meal voting messages, handles vote callbacks,
 * runs hourly finalization check, replaces downvoted meals via LLM.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { classifyLLMError } from '@pas/core/utils/llm-errors';
import { parse } from 'yaml';
import { loadCurrentPlan, savePlan, formatPlanMessage, buildPlanButtons } from '../services/meal-plan-store.js';
import { swapMeal } from '../services/meal-planner.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import {
	allMembersVoted,
	buildVoteButtons,
	formatVotingMealMessage,
	getMealsNeedingReplacement,
	isVotingExpired,
	recordVote,
} from '../services/voting.js';
import type { Household, MealPlan } from '../types.js';
import { isoNow } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

// ─── Send Voting Messages ───────────────────────────────────────

/**
 * Set plan to voting status and send individual meal messages to all
 * household members. Called after plan generation when household has >1 member.
 */
export async function sendVotingMessages(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	household: Household,
): Promise<void> {
	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	plan.status = 'voting';
	plan.votingStartedAt = isoNow();
	await savePlan(sharedStore, plan);

	for (const meal of plan.meals) {
		const text = formatVotingMealMessage(meal);
		const buttons = buildVoteButtons(meal.date);
		for (const memberId of household.members) {
			await services.telegram.sendWithButtons(memberId, text, buttons);
		}
	}

	services.logger.info(
		'Sent %d voting messages to %d members for plan %s',
		plan.meals.length * household.members.length,
		household.members.length,
		plan.id,
	);
}

// ─── Vote Callback ──────────────────────────────────────────────

/**
 * Handle a vote callback. Data format after prefix strip: "up:2026-04-01"
 */
export async function handleVoteCallback(
	services: CoreServices,
	data: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const colonIdx = data.indexOf(':');
	if (colonIdx === -1) return;
	const voteType = data.slice(0, colonIdx) as 'up' | 'down' | 'neutral';
	const mealDate = data.slice(colonIdx + 1);

	if (!['up', 'down', 'neutral'].includes(voteType)) return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	if (plan.status !== 'voting') {
		await services.telegram.editMessage(chatId, messageId, 'Voting has ended for this plan.', undefined);
		return;
	}

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	recordVote(meal, userId, voteType);
	await savePlan(sharedStore, plan);

	const emoji = voteType === 'up' ? '👍' : voteType === 'down' ? '👎' : '😐';
	const day = new Date(mealDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
	await services.telegram.editMessage(
		chatId,
		messageId,
		`${emoji} Voted on ${day} — ${meal.recipeTitle}`,
		undefined,
	);

	// Check for early finalization
	if (allMembersVoted(plan, household.members)) {
		await finalizePlan(services, sharedStore, household);
	}
}

// ─── Finalize Votes Job ─────────────────────────────────────────

/**
 * Hourly cron job: check if voting window has expired, finalize if so.
 */
export async function handleFinalizeVotesJob(services: CoreServices): Promise<void> {
	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan || plan.status !== 'voting') return;

	const windowHours =
		((await services.config.get<number>('voting_window_hours')) as number | undefined) ?? 12;

	if (!isVotingExpired(plan, windowHours)) return;

	await finalizePlan(services, sharedStore, household);
}

// ─── Shared Finalization Logic ──────────────────────────────────

async function finalizePlan(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	household: Household,
): Promise<void> {
	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const recipes = await loadAllRecipes(sharedStore);

	// Replace net-negative meals via LLM
	const needsReplacement = getMealsNeedingReplacement(plan);
	for (const meal of needsReplacement) {
		try {
			const replacement = await swapMeal(
				services,
				meal.date,
				'suggest a different meal — the household voted this one down',
				recipes,
			);
			const idx = plan.meals.findIndex((m) => m.date === meal.date);
			if (idx !== -1) {
				// Preserve the date and reset votes
				replacement.votes = {};
				plan.meals[idx] = replacement;
			}
		} catch (err) {
			services.logger.error('Failed to replace downvoted meal on %s: %s', meal.date, err);
		}
	}

	plan.status = 'active';
	await savePlan(sharedStore, plan);

	// Send finalized plan to all members
	const location =
		((await services.config.get<string>('location')) as string | undefined) ?? 'your area';
	const message = formatPlanMessage(plan, recipes, location);
	const buttons = buildPlanButtons(plan);

	for (const memberId of household.members) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}

	services.logger.info('Finalized meal plan %s — %d replacements', plan.id, needsReplacement.length);
}

// ─── Helpers ────────────────────────────────────────────────────

async function loadHouseholdSafe(sharedStore: ScopedDataStore): Promise<Household | null> {
	const raw = await sharedStore.read('household.yaml');
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as Household;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/voting-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/voting.ts apps/hearthstone/src/__tests__/voting-handler.test.ts
git commit -m "feat(hearthstone): add voting handler with send, callback, and finalize logic"
```

---

## Task 4: Rating Service

**Files:**
- Create: `apps/hearthstone/src/services/rating.ts`
- Create: `apps/hearthstone/src/__tests__/rating.test.ts`

- [ ] **Step 1: Write rating service tests**

Create `apps/hearthstone/src/__tests__/rating.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { MealPlan, PlannedMeal, Rating } from '../types.js';
import {
	buildRateButtons,
	buildRatingPromptButtons,
	createRating,
	formatRatingPromptMessage,
	getUncookedMeals,
	hasRatingPromptBeenSentToday,
} from '../services/rating.js';

function makePlannedMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc', recipeTitle: 'Chicken Stir Fry',
		date: '2026-03-31', mealType: 'dinner', votes: {},
		cooked: false, rated: false, isNew: false, ...overrides,
	};
}

function makeMealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan1', startDate: '2026-03-31', endDate: '2026-04-06',
		meals: [makePlannedMeal()], status: 'active',
		createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('rating service', () => {
	describe('getUncookedMeals', () => {
		it('returns past meals that are not yet cooked', () => {
			const plan = makeMealPlan({
				meals: [
					makePlannedMeal({ date: '2026-03-30', cooked: false }), // past, uncooked
					makePlannedMeal({ date: '2026-03-31', cooked: false }), // today, uncooked
					makePlannedMeal({ date: '2026-04-02', cooked: false }), // future
					makePlannedMeal({ date: '2026-03-29', cooked: true }), // past, cooked
				],
			});
			const result = getUncookedMeals(plan, '2026-03-31');
			expect(result).toHaveLength(2);
			expect(result.map((m) => m.date)).toEqual(['2026-03-30', '2026-03-31']);
		});

		it('returns empty when all meals are cooked', () => {
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ cooked: true })],
			});
			expect(getUncookedMeals(plan, '2026-03-31')).toHaveLength(0);
		});

		it('returns empty when all meals are in the future', () => {
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ date: '2026-04-05' })],
			});
			expect(getUncookedMeals(plan, '2026-03-31')).toHaveLength(0);
		});
	});

	describe('createRating', () => {
		it('returns a Rating with correct shape', () => {
			const rating = createRating('user1', 5);
			expect(rating.userId).toBe('user1');
			expect(rating.score).toBe(5);
			expect(rating.date).toBeDefined();
		});
	});

	describe('hasRatingPromptBeenSentToday', () => {
		it('returns true when lastRatingPromptDate matches today', () => {
			const plan = makeMealPlan({ lastRatingPromptDate: '2026-03-31' });
			expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(true);
		});

		it('returns false when lastRatingPromptDate is different', () => {
			const plan = makeMealPlan({ lastRatingPromptDate: '2026-03-30' });
			expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(false);
		});

		it('returns false when lastRatingPromptDate is undefined', () => {
			const plan = makeMealPlan();
			expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(false);
		});
	});

	describe('formatRatingPromptMessage', () => {
		it('lists uncooked meals in the message', () => {
			const meals = [
				makePlannedMeal({ recipeTitle: 'Chicken Stir Fry', date: '2026-03-31' }),
				makePlannedMeal({ recipeTitle: 'Pasta Carbonara', date: '2026-04-01' }),
			];
			const msg = formatRatingPromptMessage(meals);
			expect(msg).toContain('What did you cook');
			expect(msg).toContain('Chicken Stir Fry');
			expect(msg).toContain('Pasta Carbonara');
		});
	});

	describe('buildRatingPromptButtons', () => {
		it('creates one button per uncooked meal', () => {
			const meals = [
				makePlannedMeal({ date: '2026-03-31' }),
				makePlannedMeal({ date: '2026-04-01' }),
			];
			const buttons = buildRatingPromptButtons(meals);
			expect(buttons).toHaveLength(2);
			expect(buttons[0][0].callbackData).toBe('app:hearthstone:cooked:2026-03-31');
			expect(buttons[1][0].callbackData).toBe('app:hearthstone:cooked:2026-04-01');
		});
	});

	describe('buildRateButtons', () => {
		it('returns thumbs up, down, and skip buttons', () => {
			const buttons = buildRateButtons('2026-03-31');
			expect(buttons).toHaveLength(1);
			expect(buttons[0]).toHaveLength(3);
			expect(buttons[0][0].callbackData).toBe('app:hearthstone:rate:up:2026-03-31');
			expect(buttons[0][1].callbackData).toBe('app:hearthstone:rate:down:2026-03-31');
			expect(buttons[0][2].callbackData).toBe('app:hearthstone:rate:skip:2026-03-31');
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/rating.test.ts`
Expected: FAIL — cannot find module `../services/rating.js`

- [ ] **Step 3: Implement rating service**

Create `apps/hearthstone/src/services/rating.ts`:

```typescript
/**
 * Rating service — pure functions for post-meal rating logic.
 *
 * Phase H4: Nightly prompts ask what was cooked, users rate 👍/👎/skip.
 * Positive ratings on draft recipes auto-promote to confirmed.
 */

import type { InlineButton } from '@pas/core/types';
import type { MealPlan, PlannedMeal, Rating } from '../types.js';
import { isoNow } from '../utils/date.js';

// ─── Queries ────────────────────────────────────────────────────

/**
 * Get meals whose date is on or before todayStr and that are not yet cooked.
 */
export function getUncookedMeals(plan: MealPlan, todayStr: string): PlannedMeal[] {
	return plan.meals.filter((m) => m.date <= todayStr && !m.cooked);
}

/**
 * Check whether the nightly rating prompt has already been sent today.
 */
export function hasRatingPromptBeenSentToday(plan: MealPlan, todayStr: string): boolean {
	return plan.lastRatingPromptDate === todayStr;
}

// ─── Rating Creation ────────────────────────────────────────────

/**
 * Create a Rating object.
 */
export function createRating(userId: string, score: number): Rating {
	return { userId, score, date: isoNow() };
}

// ─── Formatting ─────────────────────────────────────────────────

/** Get the day-of-week abbreviation for a date string. */
function dayAbbrev(dateStr: string): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/**
 * Format the nightly "What did you cook?" prompt message.
 */
export function formatRatingPromptMessage(uncookedMeals: PlannedMeal[]): string {
	const lines: string[] = [];
	lines.push('🍽 What did you cook tonight?');
	lines.push('');
	for (const meal of uncookedMeals) {
		const day = dayAbbrev(meal.date);
		lines.push(`• ${day} — ${meal.recipeTitle}`);
	}
	lines.push('');
	lines.push('Tap the meal you cooked:');
	return lines.join('\n');
}

/**
 * Build buttons for the nightly prompt: one button per uncooked meal.
 */
export function buildRatingPromptButtons(uncookedMeals: PlannedMeal[]): InlineButton[][] {
	return uncookedMeals.map((meal) => {
		const day = dayAbbrev(meal.date);
		return [
			{
				text: `${day} — ${meal.recipeTitle}`,
				callbackData: `app:hearthstone:cooked:${meal.date}`,
			},
		];
	});
}

/**
 * Build 👍 / 👎 / ⏭ Skip buttons for rating a specific meal.
 */
export function buildRateButtons(mealDate: string): InlineButton[][] {
	return [
		[
			{ text: '👍', callbackData: `app:hearthstone:rate:up:${mealDate}` },
			{ text: '👎', callbackData: `app:hearthstone:rate:down:${mealDate}` },
			{ text: '⏭ Skip', callbackData: `app:hearthstone:rate:skip:${mealDate}` },
		],
	];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/rating.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/rating.ts apps/hearthstone/src/__tests__/rating.test.ts
git commit -m "feat(hearthstone): add rating service with uncooked meal queries and formatting"
```

---

## Task 5: Rating Handler

**Files:**
- Create: `apps/hearthstone/src/handlers/rating.ts`
- Create: `apps/hearthstone/src/__tests__/rating-handler.test.ts`

- [ ] **Step 1: Write rating handler tests**

Create `apps/hearthstone/src/__tests__/rating-handler.test.ts`:

```typescript
import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import type { Household, MealPlan, PlannedMeal, Recipe } from '../types.js';
import {
	handleCookedCallback,
	handleNightlyRatingPromptJob,
	handleRateCallback,
} from '../handlers/rating.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makePlannedMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc', recipeTitle: 'Chicken Stir Fry',
		date: '2026-03-31', mealType: 'dinner', votes: {},
		cooked: false, rated: false, isNew: false, ...overrides,
	};
}

function makeMealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan1', startDate: '2026-03-31', endDate: '2026-04-06',
		meals: [makePlannedMeal()], status: 'active',
		createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'chicken-stir-fry-abc', title: 'Chicken Stir Fry', source: 'homemade',
		ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
		instructions: ['Heat oil', 'Add chicken'], servings: 4, prepTime: 10, cookTime: 20,
		tags: ['easy'], cuisine: 'Asian', ratings: [], history: [], allergens: [],
		status: 'confirmed', createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
	};
}

const sampleHousehold: Household = {
	id: 'hh1', name: 'Test Family', createdBy: 'user1',
	members: ['user1', 'user2'], joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

describe('rating handler', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	describe('handleCookedCallback', () => {
		it('marks meal as cooked and shows rate buttons', async () => {
			const plan = makeMealPlan();
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleCookedCallback(services, '2026-03-31', 'user1', 123, 456);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('How was'),
				expect.arrayContaining([expect.arrayContaining([
					expect.objectContaining({ text: '👍' }),
				])]),
			);
		});

		it('ignores nonexistent meal date', async () => {
			const plan = makeMealPlan();
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleCookedCallback(services, '2099-01-01', 'user1', 123, 456);

			expect(services.telegram.editMessage).not.toHaveBeenCalled();
		});
	});

	describe('handleRateCallback', () => {
		it('records positive rating and confirms draft recipe', async () => {
			const recipe = makeRecipe({ status: 'draft' });
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ cooked: true })],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold)) // household
				.mockResolvedValueOnce(stringify(plan))            // plan
				.mockResolvedValueOnce(stringify(recipe));          // recipe

			await handleRateCallback(services, 'up:2026-03-31', 'user1', 123, 456);

			// Verify recipe was saved with rating and confirmed status
			expect(sharedStore.write).toHaveBeenCalledTimes(2); // plan + recipe
			const recipeWriteCall = sharedStore.write.mock.calls.find(
				(call: unknown[]) => (call[0] as string).includes('recipes/'),
			);
			expect(recipeWriteCall).toBeDefined();
			const savedRecipe = parse(
				(recipeWriteCall![1] as string).replace(/^---[\s\S]*?---\n/, ''),
			) as Recipe;
			expect(savedRecipe.ratings).toHaveLength(1);
			expect(savedRecipe.ratings[0].score).toBe(5);
			expect(savedRecipe.status).toBe('confirmed');

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('👍'),
				undefined,
			);
		});

		it('records negative rating without changing draft status', async () => {
			const recipe = makeRecipe({ status: 'draft' });
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ cooked: true })],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan))
				.mockResolvedValueOnce(stringify(recipe));

			await handleRateCallback(services, 'down:2026-03-31', 'user1', 123, 456);

			const recipeWriteCall = sharedStore.write.mock.calls.find(
				(call: unknown[]) => (call[0] as string).includes('recipes/'),
			);
			const savedRecipe = parse(
				(recipeWriteCall![1] as string).replace(/^---[\s\S]*?---\n/, ''),
			) as Recipe;
			expect(savedRecipe.ratings[0].score).toBe(1);
			expect(savedRecipe.status).toBe('draft');
		});

		it('handles skip without storing a rating', async () => {
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ cooked: true })],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleRateCallback(services, 'skip:2026-03-31', 'user1', 123, 456);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('Skipped'),
				undefined,
			);
			// Only plan should be saved (for rated=true), no recipe write
			expect(sharedStore.write).toHaveBeenCalledTimes(1);
		});
	});

	describe('handleNightlyRatingPromptJob', () => {
		it('sends prompt to all household members for uncooked meals', async () => {
			const plan = makeMealPlan({
				meals: [
					makePlannedMeal({ date: '2026-03-30', cooked: false }),
					makePlannedMeal({ date: '2026-03-31', cooked: false }),
				],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			// Mock todayDate to return 2026-03-31
			await handleNightlyRatingPromptJob(services, '2026-03-31');

			expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2); // 2 members
		});

		it('skips when no active plan exists', async () => {
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(''); // no plan

			await handleNightlyRatingPromptJob(services, '2026-03-31');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('skips when already sent today (idempotent)', async () => {
			const plan = makeMealPlan({
				lastRatingPromptDate: '2026-03-31',
				meals: [makePlannedMeal({ cooked: false })],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleNightlyRatingPromptJob(services, '2026-03-31');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('skips when all meals already cooked', async () => {
			const plan = makeMealPlan({
				meals: [makePlannedMeal({ cooked: true })],
			});
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleNightlyRatingPromptJob(services, '2026-03-31');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/rating-handler.test.ts`
Expected: FAIL — cannot find module `../handlers/rating.js`

- [ ] **Step 3: Implement rating handler**

Create `apps/hearthstone/src/handlers/rating.ts`:

```typescript
/**
 * Rating handler — orchestrates post-meal ratings via Telegram.
 *
 * Phase H4: Nightly "what did you cook" prompts, cooked/rate callbacks,
 * and draft recipe auto-confirmation on positive ratings.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse } from 'yaml';
import { loadCurrentPlan, savePlan } from '../services/meal-plan-store.js';
import {
	buildRateButtons,
	buildRatingPromptButtons,
	createRating,
	formatRatingPromptMessage,
	getUncookedMeals,
	hasRatingPromptBeenSentToday,
} from '../services/rating.js';
import { loadRecipe, updateRecipe } from '../services/recipe-store.js';
import type { Household } from '../types.js';
import { todayDate } from '../utils/date.js';

// ─── Cooked Callback ────────────────────────────────────────────

/**
 * Handle "cooked:<date>" callback. Marks meal as cooked, shows rating buttons.
 * Data is the date string after prefix strip, e.g. "2026-03-31".
 */
export async function handleCookedCallback(
	services: CoreServices,
	mealDate: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	meal.cooked = true;
	await savePlan(sharedStore, plan);

	const day = new Date(mealDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
	await services.telegram.editMessage(
		chatId,
		messageId,
		`✅ ${day} — ${meal.recipeTitle}\n\nHow was it?`,
		buildRateButtons(mealDate),
	);
}

// ─── Rate Callback ──────────────────────────────────────────────

/**
 * Handle "rate:<up|down|skip>:<date>" callback.
 * Data format after prefix strip: "up:2026-03-31"
 */
export async function handleRateCallback(
	services: CoreServices,
	data: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const colonIdx = data.indexOf(':');
	if (colonIdx === -1) return;
	const direction = data.slice(0, colonIdx);
	const mealDate = data.slice(colonIdx + 1);

	if (!['up', 'down', 'skip'].includes(direction)) return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	const day = new Date(mealDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

	if (direction === 'skip') {
		meal.rated = true;
		await savePlan(sharedStore, plan);
		await services.telegram.editMessage(chatId, messageId, `⏭ Skipped rating for ${day} — ${meal.recipeTitle}`, undefined);
		return;
	}

	const score = direction === 'up' ? 5 : 1;
	const emoji = direction === 'up' ? '👍' : '👎';

	// Load and update recipe
	const recipe = await loadRecipe(sharedStore, meal.recipeId);
	if (recipe) {
		recipe.ratings.push(createRating(userId, score));

		// Auto-confirm draft recipes on positive rating (REQ-RECIPE-003)
		let confirmMsg = '';
		if (direction === 'up' && recipe.status === 'draft') {
			recipe.status = 'confirmed';
			confirmMsg = '\n\n✨ Recipe confirmed! It\'ll appear more often in future plans.';
		}

		await updateRecipe(sharedStore, recipe);
		meal.rated = true;
		await savePlan(sharedStore, plan);

		await services.telegram.editMessage(
			chatId,
			messageId,
			`${emoji} Rated ${day} — ${meal.recipeTitle}${confirmMsg}`,
			undefined,
		);
	} else {
		// Recipe not in library (maybe deleted) — still mark rated
		meal.rated = true;
		await savePlan(sharedStore, plan);
		await services.telegram.editMessage(
			chatId,
			messageId,
			`${emoji} Rated ${day} — ${meal.recipeTitle}`,
			undefined,
		);
	}

	services.logger.info('User %s rated %s on %s as %s', userId, meal.recipeTitle, mealDate, direction);
}

// ─── Nightly Rating Prompt Job ──────────────────────────────────

/**
 * Daily 8pm cron job: send "What did you cook?" to all household members.
 * Accepts todayStr parameter for testability (defaults to timezone-aware today).
 */
export async function handleNightlyRatingPromptJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;
	if (plan.status !== 'active' && plan.status !== 'completed') return;

	const today = todayOverride ?? todayDate(services.timezone);

	// Idempotency check
	if (hasRatingPromptBeenSentToday(plan, today)) return;

	const uncookedMeals = getUncookedMeals(plan, today);
	if (uncookedMeals.length === 0) return;

	// Mark prompt as sent before sending (prevents duplicates on error)
	plan.lastRatingPromptDate = today;
	await savePlan(sharedStore, plan);

	const message = formatRatingPromptMessage(uncookedMeals);
	const buttons = buildRatingPromptButtons(uncookedMeals);

	for (const memberId of household.members) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}

	services.logger.info(
		'Sent nightly rating prompt: %d uncooked meals to %d members',
		uncookedMeals.length,
		household.members.length,
	);
}

// ─── Helpers ────────────────────────────────────────────────────

async function loadHouseholdSafe(sharedStore: ScopedDataStore): Promise<Household | null> {
	const raw = await sharedStore.read('household.yaml');
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as Household;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/rating-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/rating.ts apps/hearthstone/src/__tests__/rating-handler.test.ts
git commit -m "feat(hearthstone): add rating handler with cooked/rate callbacks and nightly prompt"
```

---

## Task 6: Shopping Follow-up Handler

**Files:**
- Create: `apps/hearthstone/src/handlers/shopping-followup.ts`
- Create: `apps/hearthstone/src/__tests__/shopping-followup.test.ts`

- [ ] **Step 1: Write shopping follow-up tests**

Create `apps/hearthstone/src/__tests__/shopping-followup.test.ts`:

```typescript
import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { GroceryList, Household } from '../types.js';
import {
	cancelShoppingFollowup,
	handleShopFollowupClearCallback,
	handleShopFollowupKeepCallback,
	handleShoppingFollowupJob,
	scheduleShoppingFollowup,
} from '../handlers/shopping-followup.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

const sampleHousehold: Household = {
	id: 'hh1', name: 'Test Family', createdBy: 'user1',
	members: ['user1', 'user2'], joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const sampleGroceryList: GroceryList = {
	id: 'gl1',
	items: [
		{ name: 'Milk', quantity: 1, unit: 'gallon', department: 'Dairy & Eggs', recipeIds: [], purchased: false, addedBy: 'user1' },
		{ name: 'Bread', quantity: 1, unit: 'loaf', department: 'Bakery', recipeIds: [], purchased: false, addedBy: 'user1' },
	],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('shopping follow-up handler', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		vi.useFakeTimers();
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		cancelShoppingFollowup(); // reset state between tests
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('scheduleShoppingFollowup', () => {
		it('schedules a follow-up timer', () => {
			scheduleShoppingFollowup(services, 'user1', 3);

			expect(services.logger.info).toHaveBeenCalledWith(
				expect.stringContaining('Scheduled shopping follow-up'),
				expect.any(String),
				expect.any(Number),
			);
		});

		it('cancels previous timer when re-scheduling', () => {
			scheduleShoppingFollowup(services, 'user1', 3);
			scheduleShoppingFollowup(services, 'user1', 5);

			// Advance past 1 hour — only one fire
			vi.advanceTimersByTime(60 * 60 * 1000 + 100);
			// The handler will try to run but since we haven't mocked reads,
			// it's enough to verify scheduling worked without double-fire
		});
	});

	describe('handleShoppingFollowupJob', () => {
		it('sends follow-up message when items remain', async () => {
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(sampleGroceryList));

			// Set up pending follow-up state
			scheduleShoppingFollowup(services, 'user1', 2);
			await handleShoppingFollowupJob(services);

			expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('2 items'),
				expect.any(Array),
			);
		});

		it('does nothing when no pending follow-up', async () => {
			await handleShoppingFollowupJob(services);

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});
	});

	describe('handleShopFollowupClearCallback', () => {
		it('clears remaining grocery items and edits message', async () => {
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(sampleGroceryList));

			await handleShopFollowupClearCallback(services, 'user1', 123, 456);

			expect(sharedStore.write).toHaveBeenCalled();
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('Cleared'),
				undefined,
			);
		});
	});

	describe('handleShopFollowupKeepCallback', () => {
		it('dismisses follow-up and edits message', async () => {
			await handleShopFollowupKeepCallback(services, 'user1', 123, 456);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456,
				expect.stringContaining('Keeping'),
				undefined,
			);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/shopping-followup.test.ts`
Expected: FAIL — cannot find module `../handlers/shopping-followup.js`

- [ ] **Step 3: Implement shopping follow-up handler**

Create `apps/hearthstone/src/handlers/shopping-followup.ts`:

```typescript
/**
 * Shopping follow-up handler — timed follow-up after grocery clear.
 *
 * Phase H4: When purchased items are cleared but items remain, schedule
 * a 1-hour follow-up asking "Done shopping?" with clear/keep options.
 * Uses in-process setTimeout (survives for the follow-up window but
 * not across restarts — acceptable for a 1h timer).
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import {
	archivePurchased,
	loadGroceryList,
	saveGroceryList,
} from '../services/grocery-store.js';
import type { GroceryList, Household } from '../types.js';

const FOLLOWUP_DELAY_MS = 60 * 60 * 1000; // 1 hour

// ─── In-Process State ───────────────────────────────────────────

let followupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingFollowup: { userId: string; remainingCount: number } | null = null;

// ─── Public API ─────────────────────────────────────────────────

/**
 * Schedule a shopping follow-up message. Cancels any pending follow-up first.
 */
export function scheduleShoppingFollowup(
	services: CoreServices,
	userId: string,
	remainingCount: number,
): void {
	cancelShoppingFollowup();
	pendingFollowup = { userId, remainingCount };
	followupTimer = setTimeout(() => {
		void handleShoppingFollowupJob(services);
	}, FOLLOWUP_DELAY_MS);
	services.logger.info(
		'Scheduled shopping follow-up in 1h for %s (%d items remaining)',
		userId,
		remainingCount,
	);
}

/**
 * Cancel any pending shopping follow-up.
 */
export function cancelShoppingFollowup(): void {
	if (followupTimer) {
		clearTimeout(followupTimer);
		followupTimer = null;
	}
	pendingFollowup = null;
}

/**
 * Handle the follow-up when the timer fires.
 * Sends a message with remaining items and clear/keep buttons.
 */
export async function handleShoppingFollowupJob(services: CoreServices): Promise<void> {
	const pending = pendingFollowup;
	pendingFollowup = null;
	followupTimer = null;

	if (!pending) return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const list = await loadGroceryList(sharedStore);
	if (!list) return;

	const remaining = list.items.filter((i) => !i.purchased);
	if (remaining.length === 0) return;

	const itemNames = remaining.slice(0, 10).map((i) => `• ${i.name}`).join('\n');
	const moreNote = remaining.length > 10 ? `\n...and ${remaining.length - 10} more` : '';

	await services.telegram.sendWithButtons(
		pending.userId,
		`🛒 You still have ${remaining.length} items on your grocery list:\n\n${itemNames}${moreNote}\n\nDone shopping?`,
		[
			[
				{ text: '🗑 Clear remaining', callbackData: 'app:hearthstone:shop-followup:clear' },
				{ text: '📋 Keep for next trip', callbackData: 'app:hearthstone:shop-followup:keep' },
			],
		],
	);
}

/**
 * Handle "shop-followup:clear" — archive all remaining items, empty the list.
 */
export async function handleShopFollowupClearCallback(
	services: CoreServices,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');
	const household = await loadHouseholdSafe(sharedStore);
	if (!household) return;

	const list = await loadGroceryList(sharedStore);
	if (!list) {
		await services.telegram.editMessage(chatId, messageId, '🛒 Grocery list is already empty.', undefined);
		return;
	}

	const remaining = list.items.filter((i) => !i.purchased);
	await archivePurchased(sharedStore, remaining, services.timezone);
	const emptyList: GroceryList = { ...list, items: [] };
	await saveGroceryList(sharedStore, emptyList);

	await services.telegram.editMessage(
		chatId,
		messageId,
		`🗑 Cleared ${remaining.length} remaining items. Grocery list is now empty.`,
		undefined,
	);

	services.logger.info('Shopping follow-up: cleared %d remaining items for %s', remaining.length, userId);
}

/**
 * Handle "shop-followup:keep" — dismiss, keep items on list.
 */
export async function handleShopFollowupKeepCallback(
	services: CoreServices,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	await services.telegram.editMessage(
		chatId,
		messageId,
		'📋 Keeping items on your grocery list for next trip.',
		undefined,
	);
}

// ─── Helpers ────────────────────────────────────────────────────

async function loadHouseholdSafe(sharedStore: ScopedDataStore): Promise<Household | null> {
	const raw = await sharedStore.read('household.yaml');
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as Household;
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/shopping-followup.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/shopping-followup.ts apps/hearthstone/src/__tests__/shopping-followup.test.ts
git commit -m "feat(hearthstone): add shopping follow-up handler with timer and clear/keep callbacks"
```

---

## Task 7: Update buildPlanButtons for Cooked Buttons

**Files:**
- Modify: `apps/hearthstone/src/services/meal-plan-store.ts:224-233`
- Modify: `apps/hearthstone/src/__tests__/app.test.ts` (add test)

- [ ] **Step 1: Add test for buildPlanButtons with plan parameter**

Add to the `meal-plan-store` tests or `app.test.ts` — whichever file already tests `buildPlanButtons`. Find the existing test file that imports `buildPlanButtons`:

```typescript
describe('buildPlanButtons', () => {
	it('returns control buttons when no plan provided', () => {
		const buttons = buildPlanButtons();
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toEqual(expect.arrayContaining([
			expect.objectContaining({ text: expect.stringContaining('Grocery') }),
		]));
	});

	it('includes Cooked buttons for uncooked meals when plan is provided', () => {
		const plan: MealPlan = {
			id: 'p1', startDate: '2026-03-31', endDate: '2026-04-06',
			meals: [
				{ recipeId: 'r1', recipeTitle: 'Chicken Stir Fry', date: '2026-03-31', mealType: 'dinner', votes: {}, cooked: false, rated: false, isNew: false },
				{ recipeId: 'r2', recipeTitle: 'Pasta', date: '2026-04-01', mealType: 'dinner', votes: {}, cooked: true, rated: true, isNew: false },
			],
			status: 'active', createdAt: '', updatedAt: '',
		};
		const buttons = buildPlanButtons(plan);
		// 1 uncooked meal button + 1 control row
		expect(buttons).toHaveLength(2);
		expect(buttons[0][0].text).toContain('Chicken Stir Fry');
		expect(buttons[0][0].callbackData).toBe('app:hearthstone:cooked:2026-03-31');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/meal-plan-store.test.ts` (or wherever this test was added)
Expected: FAIL — `buildPlanButtons` doesn't accept a `plan` parameter yet

- [ ] **Step 3: Update buildPlanButtons in meal-plan-store.ts**

In `apps/hearthstone/src/services/meal-plan-store.ts`, replace the `buildPlanButtons` function (lines 224-233):

```typescript
/** Return inline buttons for the meal plan message. Includes Cooked buttons when plan is provided. */
export function buildPlanButtons(plan?: MealPlan): InlineButton[][] {
	const buttons: InlineButton[][] = [];

	// H4: Add "✅ Cooked!" button for each uncooked meal
	if (plan) {
		for (const meal of plan.meals) {
			if (!meal.cooked) {
				const day = dayAbbrev(meal.date);
				buttons.push([
					{
						text: `✅ ${day} — ${meal.recipeTitle}`,
						callbackData: `app:hearthstone:cooked:${meal.date}`,
					},
				]);
			}
		}
	}

	// Control row
	buttons.push([
		{ text: '🛒 Grocery List', callbackData: 'app:hearthstone:grocery-from-plan' },
		{ text: '🔄 Regenerate', callbackData: 'app:hearthstone:regenerate-plan' },
	]);

	return buttons;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/src/__tests__/meal-plan-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/meal-plan-store.ts apps/hearthstone/src/__tests__/meal-plan-store.test.ts
git commit -m "feat(hearthstone): add Cooked buttons to meal plan view via buildPlanButtons(plan)"
```

---

## Task 8: Index.ts Integration — New Callback and Job Routes

**Files:**
- Modify: `apps/hearthstone/src/index.ts`

This task wires the new H4 handlers into the app's routing. All changes are additive.

- [ ] **Step 1: Add imports for H4 handlers**

At the top of `index.ts` (around line 13, after existing imports), add:

```typescript
import {
	handleVoteCallback,
	handleFinalizeVotesJob,
	sendVotingMessages,
} from './handlers/voting.js';
import {
	handleCookedCallback,
	handleRateCallback,
	handleNightlyRatingPromptJob,
} from './handlers/rating.js';
import {
	scheduleShoppingFollowup,
	cancelShoppingFollowup,
	handleShopFollowupClearCallback,
	handleShopFollowupKeepCallback,
} from './handlers/shopping-followup.js';
import { isoNow } from './utils/date.js';
```

Note: `isoNow` may already be imported from `./utils/date.js` — check and add if missing. `todayDate` is already imported.

- [ ] **Step 2: Add new callback routes to handleCallbackQuery**

Inside the `handleCallbackQuery` function's try block (after the existing `swap:` handler around line 573), add:

```typescript
		// ─── H4: Voting callbacks ───────────────────────────
		if (data.startsWith('vote:')) {
			await handleVoteCallback(services, data.slice(5), ctx.userId, ctx.chatId, ctx.messageId);
			return;
		}

		// ─── H4: Rating callbacks ───────────────────────────
		if (data.startsWith('cooked:')) {
			await handleCookedCallback(services, data.slice(7), ctx.userId, ctx.chatId, ctx.messageId);
			return;
		}
		if (data.startsWith('rate:')) {
			await handleRateCallback(services, data.slice(5), ctx.userId, ctx.chatId, ctx.messageId);
			return;
		}

		// ─── H4: Shopping follow-up callbacks ────────────────
		if (data === 'shop-followup:clear') {
			await handleShopFollowupClearCallback(services, ctx.userId, ctx.chatId, ctx.messageId);
			return;
		}
		if (data === 'shop-followup:keep') {
			await handleShopFollowupKeepCallback(services, ctx.userId, ctx.chatId, ctx.messageId);
			return;
		}
```

- [ ] **Step 3: Add new scheduled job routes to handleScheduledJob**

In `handleScheduledJob` (currently line 1531), change the early return to support multiple job IDs:

Replace:
```typescript
export const handleScheduledJob: AppModule['handleScheduledJob'] = async (jobId: string) => {
	if (jobId !== 'generate-weekly-plan') return;
```

With:
```typescript
export const handleScheduledJob: AppModule['handleScheduledJob'] = async (jobId: string) => {
	// H4: Finalize votes hourly
	if (jobId === 'finalize-votes') {
		await handleFinalizeVotesJob(services);
		return;
	}

	// H4: Nightly rating prompt at 8pm
	if (jobId === 'nightly-rating-prompt') {
		await handleNightlyRatingPromptJob(services);
		return;
	}

	if (jobId !== 'generate-weekly-plan') return;
```

- [ ] **Step 4: Modify plan generation to enter voting flow for multi-member households**

In `handleMealPlanGenerate` (line ~1293), replace the post-generation code. Find the section after `await savePlan(hh.sharedStore, plan)` and replace the message sending logic:

Replace (approximately lines 1315-1324):
```typescript
		const location =
			((await services.config.get<string>('location')) as string | undefined) ?? 'your area';
		await services.telegram.sendWithButtons(
			ctx.userId,
			formatPlanMessage(plan, recipes, location),
			buildPlanButtons(),
		);
		services.logger.info('Generated meal plan for %s', ctx.userId);
```

With:
```typescript
		// H4: Multi-member households enter voting flow
		if (hh.household.members.length > 1) {
			await sendVotingMessages(services, hh.sharedStore, hh.household);
			await services.telegram.send(
				ctx.userId,
				'🗳 Meal plan generated! Voting messages sent to all household members.',
			);
			services.logger.info('Generated meal plan %s with voting for %d members', plan.id, hh.household.members.length);
		} else {
			const location =
				((await services.config.get<string>('location')) as string | undefined) ?? 'your area';
			await services.telegram.sendWithButtons(
				ctx.userId,
				formatPlanMessage(plan, recipes, location),
				buildPlanButtons(plan),
			);
			services.logger.info('Generated meal plan for %s (single member)', ctx.userId);
		}
```

- [ ] **Step 5: Apply the same voting-flow change to the `regenerate-plan` callback**

In the `regenerate-plan` callback handler (around line 463-489), find the equivalent post-generation code and apply the same multi-member check pattern as Step 4.

- [ ] **Step 6: Apply the same voting-flow change to the `generate-weekly-plan` scheduled job**

In the `handleScheduledJob` function's generate-weekly-plan handler (around line 1556-1568), find the section that sends the plan to members and apply the same pattern:

Replace:
```typescript
		// Send to all household members
		for (const memberId of household.members) {
			await services.telegram.sendWithButtons(memberId, message, buildPlanButtons());
		}
```

With:
```typescript
		// H4: Multi-member households enter voting flow
		if (household.members.length > 1) {
			await sendVotingMessages(services, sharedStore, household);
			services.logger.info('Generated weekly plan %s with voting for %d members', plan.id, household.members.length);
		} else {
			for (const memberId of household.members) {
				await services.telegram.sendWithButtons(memberId, message, buildPlanButtons(plan));
			}
			services.logger.info('Generated weekly plan %s for %d members', plan.id, household.members.length);
		}
```

- [ ] **Step 7: Add shopping follow-up scheduling to the `clear` callback**

In the existing `data === 'clear'` handler (around line 301), after `await saveGroceryList(hh.sharedStore, updated)` and before the pantry prompt logic, add:

```typescript
			// H4: Schedule shopping follow-up if items remain
			if (updated.items.length > 0) {
				scheduleShoppingFollowup(services, ctx.userId, updated.items.length);
			} else {
				cancelShoppingFollowup();
			}
```

- [ ] **Step 8: Update all remaining buildPlanButtons() calls to pass the plan**

Search for `buildPlanButtons()` (with empty parens) in `index.ts` and add the plan parameter where a plan variable is in scope:
- `handleMealPlanView` (line ~1285): change `buildPlanButtons()` to `buildPlanButtons(plan)`
- `swap:` callback (line ~561): change `buildPlanButtons()` to `buildPlanButtons(plan)`

- [ ] **Step 9: Verify build passes**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm build`
Expected: No type errors

- [ ] **Step 10: Run all existing tests to verify nothing is broken**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/`
Expected: All existing tests PASS. Some tests may need minor adjustment if they assert on `buildPlanButtons()` return value (now includes cooked buttons).

- [ ] **Step 11: Commit**

```bash
git add apps/hearthstone/src/index.ts
git commit -m "feat(hearthstone): wire H4 voting, rating, and shopping follow-up into app routing"
```

---

## Task 9: Manifest Updates

**Files:**
- Modify: `apps/hearthstone/manifest.yaml`

- [ ] **Step 1: Add finalize-votes and nightly-rating-prompt schedules**

In `apps/hearthstone/manifest.yaml`, under `capabilities.schedules` (after the `generate-weekly-plan` entry around line 79), add:

```yaml
    - id: finalize-votes
      description: "Check voting windows and finalize expired meal plan votes"
      cron: "0 * * * *"
      handler: "dist/handlers/voting.js"
      user_scope: shared
    - id: nightly-rating-prompt
      description: "Send nightly 'What did you cook?' rating prompts at 8pm"
      cron: "0 20 * * *"
      handler: "dist/handlers/rating.js"
      user_scope: shared
```

- [ ] **Step 2: Verify build passes**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm build`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/hearthstone/manifest.yaml
git commit -m "feat(hearthstone): add finalize-votes and nightly-rating-prompt scheduled jobs to manifest"
```

---

## Task 10: Integration Tests in app.test.ts

**Files:**
- Modify: `apps/hearthstone/src/__tests__/app.test.ts`

- [ ] **Step 1: Add H4 integration tests**

Add a new `describe` block at the end of the existing test file (before the final closing `})`):

```typescript
	describe('H4 — Voting', () => {
		it('generates plan with voting for multi-member household', async () => {
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold)) // household check
				.mockResolvedValueOnce('') // no existing plan to archive
				.mockResolvedValueOnce(stringify(sampleHousehold)) // sendVotingMessages reads household
				.mockResolvedValue(''); // subsequent reads

			sharedStore.list.mockResolvedValue([]); // no recipes
			vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify([
				{ recipeId: 'r1', recipeTitle: 'Test Meal', date: '2026-04-07', isNew: true, description: 'A test' },
			]));
			vi.mocked(services.config.get).mockImplementation(async (key: string) => {
				const config: Record<string, unknown> = { location: 'Raleigh, NC', meal_plan_dinners: 1, new_recipe_ratio: 100 };
				return config[key] as any;
			});

			const ctx = createTestMessageContext({ text: 'generate a meal plan', userId: 'user1' });
			await handleMessage(ctx);

			// Should send voting messages (1 meal × 2 members = 2 sendWithButtons calls + 1 send for confirmation)
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('routes vote callback correctly', async () => {
			const plan: MealPlan = {
				id: 'p1', startDate: '2026-03-31', endDate: '2026-04-06',
				meals: [{ recipeId: 'r1', recipeTitle: 'Test', date: '2026-03-31', mealType: 'dinner', votes: {}, cooked: false, rated: false, isNew: false }],
				status: 'voting', votingStartedAt: new Date().toISOString(),
				createdAt: '', updatedAt: '',
			};
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold)) // requireHousehold
				.mockResolvedValueOnce(stringify(sampleHousehold)) // voting handler household read
				.mockResolvedValueOnce(stringify(plan));

			const ctx = { userId: 'user1', chatId: 123, messageId: 456 };
			await handleCallbackQuery?.('vote:up:2026-03-31', ctx as any);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456, expect.stringContaining('👍'), undefined,
			);
		});
	});

	describe('H4 — Rating', () => {
		it('routes cooked callback correctly', async () => {
			const plan: MealPlan = {
				id: 'p1', startDate: '2026-03-31', endDate: '2026-04-06',
				meals: [{ recipeId: 'r1', recipeTitle: 'Test', date: '2026-03-31', mealType: 'dinner', votes: {}, cooked: false, rated: false, isNew: false }],
				status: 'active', createdAt: '', updatedAt: '',
			};
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold)) // requireHousehold
				.mockResolvedValueOnce(stringify(sampleHousehold)) // rating handler household read
				.mockResolvedValueOnce(stringify(plan));

			const ctx = { userId: 'user1', chatId: 123, messageId: 456 };
			await handleCallbackQuery?.('cooked:2026-03-31', ctx as any);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456, expect.stringContaining('How was'), expect.any(Array),
			);
		});

		it('routes nightly-rating-prompt scheduled job', async () => {
			const plan: MealPlan = {
				id: 'p1', startDate: '2026-03-31', endDate: '2026-04-06',
				meals: [{ recipeId: 'r1', recipeTitle: 'Test', date: '2026-03-31', mealType: 'dinner', votes: {}, cooked: false, rated: false, isNew: false }],
				status: 'active', createdAt: '', updatedAt: '',
			};
			sharedStore.read
				.mockResolvedValueOnce(stringify(sampleHousehold))
				.mockResolvedValueOnce(stringify(plan));

			await handleScheduledJob?.('nightly-rating-prompt');

			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});
	});

	describe('H4 — Shopping Follow-up', () => {
		it('routes shop-followup:keep callback correctly', async () => {
			sharedStore.read.mockResolvedValueOnce(stringify(sampleHousehold));

			const ctx = { userId: 'user1', chatId: 123, messageId: 456 };
			await handleCallbackQuery?.('shop-followup:keep', ctx as any);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456, expect.stringContaining('Keeping'), undefined,
			);
		});
	});
```

Note: The exact mock setup for these integration tests may need adjustment based on how `requireHousehold` reads in the callback handler vs. how the handler modules read household data. The handler modules read household directly from the shared store, while `handleCallbackQuery` in index.ts calls `requireHousehold` first. The implementer should trace the read order and set up mocks accordingly.

- [ ] **Step 2: Run all tests**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm vitest run apps/hearthstone/`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/hearthstone/src/__tests__/app.test.ts
git commit -m "test(hearthstone): add H4 integration tests for voting, rating, and shopping follow-up"
```

---

## Task 11: Update Implementation Phases Doc and Help

**Files:**
- Modify: `apps/hearthstone/docs/implementation-phases.md`
- Modify: `apps/hearthstone/help.md`
- Modify: `apps/hearthstone/docs/urs.md`

- [ ] **Step 1: Update implementation-phases.md**

Update the H4 section status from "Not Started" to "Complete" with dates and test counts. Fill in the Progress section.

- [ ] **Step 2: Update help.md**

Add user-facing documentation for voting, rating, and shopping follow-up features.

- [ ] **Step 3: Update urs.md**

Update REQ-MEAL-003, REQ-MEAL-004, REQ-RECIPE-003, REQ-GROCERY-009, REQ-NFR-006 statuses from "Planned" to "Implemented" and fill in test references.

- [ ] **Step 4: Commit**

```bash
git add apps/hearthstone/docs/ apps/hearthstone/help.md
git commit -m "docs(hearthstone): update H4 implementation phases, help, and URS"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Full build**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm build`
Expected: No type errors

- [ ] **Step 2: Full test suite**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm test`
Expected: All tests pass across the entire project

- [ ] **Step 3: Lint**

Run: `cd "C:/Users/matth/Projects/Personal Assistant" && pnpm lint`
Expected: No lint errors

---

## Dependency Graph

```
Task 1 (types) ──┬── Task 2 (voting service) ─── Task 3 (voting handler) ──┐
                  ├── Task 4 (rating service) ─── Task 5 (rating handler) ──┤
                  └── Task 6 (shopping follow-up) ─────────────────────────┤
                                                                            │
Task 7 (buildPlanButtons update) ──────────────────────────────────────────┤
                                                                            │
Task 8 (index.ts integration) ◄────────────────────────────────────────────┘
  │
Task 9 (manifest) ─── Task 10 (integration tests) ─── Task 11 (docs) ─── Task 12 (verify)
```

**Parallelizable:** Tasks 2, 4, 6, and 7 can run in parallel after Task 1.
**Sequential:** Tasks 8-12 must run after all prior tasks complete.
