import { describe, expect, it } from 'vitest';
import {
	buildRateButtons,
	buildRatingPromptButtons,
	createRating,
	formatRatingPromptMessage,
	getUncookedMeals,
	hasRatingPromptBeenSentToday,
} from '../services/rating.js';
import type { MealPlan, PlannedMeal } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'pasta-abc',
		recipeTitle: 'Pasta',
		date: '2026-03-31',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
		...overrides,
	};
}

function makePlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-1',
		startDate: '2026-03-30',
		endDate: '2026-04-05',
		meals: [],
		status: 'active',
		createdAt: '2026-03-30T00:00:00.000Z',
		updatedAt: '2026-03-30T00:00:00.000Z',
		...overrides,
	};
}

// ─── getUncookedMeals ─────────────────────────────────────────────

describe('getUncookedMeals', () => {
	it('returns meals on or before today that are not cooked', () => {
		const meals = [
			makeMeal({ date: '2026-03-29', cooked: false }),
			makeMeal({ date: '2026-03-30', cooked: false }),
			makeMeal({ date: '2026-03-31', cooked: false }),
		];
		const plan = makePlan({ meals });
		const result = getUncookedMeals(plan, '2026-03-31');
		expect(result).toHaveLength(3);
	});

	it('excludes meals scheduled after today', () => {
		const meals = [
			makeMeal({ date: '2026-03-31', cooked: false }),
			makeMeal({ date: '2026-04-01', cooked: false }),
		];
		const plan = makePlan({ meals });
		const result = getUncookedMeals(plan, '2026-03-31');
		expect(result).toHaveLength(1);
		expect(result[0].date).toBe('2026-03-31');
	});

	it('excludes meals that are already cooked', () => {
		const meals = [
			makeMeal({ date: '2026-03-30', cooked: true }),
			makeMeal({ date: '2026-03-31', cooked: false }),
		];
		const plan = makePlan({ meals });
		const result = getUncookedMeals(plan, '2026-03-31');
		expect(result).toHaveLength(1);
		expect(result[0].date).toBe('2026-03-31');
	});

	it('returns empty array when all past meals are cooked', () => {
		const meals = [
			makeMeal({ date: '2026-03-29', cooked: true }),
			makeMeal({ date: '2026-03-30', cooked: true }),
		];
		const plan = makePlan({ meals });
		const result = getUncookedMeals(plan, '2026-03-31');
		expect(result).toHaveLength(0);
	});

	it('returns empty array when plan has no meals', () => {
		const plan = makePlan({ meals: [] });
		const result = getUncookedMeals(plan, '2026-03-31');
		expect(result).toHaveLength(0);
	});
});

// ─── hasRatingPromptBeenSentToday ────────────────────────────────

describe('hasRatingPromptBeenSentToday', () => {
	it('returns true when lastRatingPromptDate matches today', () => {
		const plan = makePlan({ lastRatingPromptDate: '2026-03-31' });
		expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(true);
	});

	it('returns false when lastRatingPromptDate is a different day', () => {
		const plan = makePlan({ lastRatingPromptDate: '2026-03-30' });
		expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(false);
	});

	it('returns false when lastRatingPromptDate is not set', () => {
		const plan = makePlan({ lastRatingPromptDate: undefined });
		expect(hasRatingPromptBeenSentToday(plan, '2026-03-31')).toBe(false);
	});
});

// ─── createRating ─────────────────────────────────────────────────

describe('createRating', () => {
	it('creates a Rating with userId and score', () => {
		const rating = createRating('user-123', 4);
		expect(rating.userId).toBe('user-123');
		expect(rating.score).toBe(4);
	});

	it('sets date as an ISO date string', () => {
		const rating = createRating('user-123', 3);
		// date should be a valid ISO timestamp
		expect(() => new Date(rating.date)).not.toThrow();
		expect(new Date(rating.date).toISOString()).toBe(rating.date);
	});

	it('does not set notes by default', () => {
		const rating = createRating('user-123', 5);
		expect(rating.notes).toBeUndefined();
	});
});

// ─── formatRatingPromptMessage ────────────────────────────────────

describe('formatRatingPromptMessage', () => {
	it('includes each meal title and date abbreviation', () => {
		const meals = [
			makeMeal({ date: '2026-03-31', recipeTitle: 'Pasta' }), // Tuesday
			makeMeal({ date: '2026-03-30', recipeTitle: 'Tacos' }), // Monday
		];
		const msg = formatRatingPromptMessage(meals);
		expect(msg).toContain('Pasta');
		expect(msg).toContain('Tacos');
		// Tuesday short = "Tue", Monday short = "Mon"
		expect(msg).toContain('Tue');
		expect(msg).toContain('Mon');
	});

	it('includes a prompt header', () => {
		const meals = [makeMeal({ recipeTitle: 'Soup', date: '2026-03-31' })];
		const msg = formatRatingPromptMessage(meals);
		// should have some introductory text
		expect(msg.length).toBeGreaterThan(10);
	});
});

// ─── buildRatingPromptButtons ─────────────────────────────────────

describe('buildRatingPromptButtons', () => {
	it('returns one row per meal', () => {
		const meals = [
			makeMeal({ date: '2026-03-29', recipeTitle: 'Soup' }),
			makeMeal({ date: '2026-03-31', recipeTitle: 'Pasta' }),
		];
		const buttons = buildRatingPromptButtons(meals);
		expect(buttons).toHaveLength(2);
	});

	it('each row has one button with correct callback data', () => {
		const meals = [makeMeal({ date: '2026-03-31', recipeTitle: 'Pasta' })];
		const buttons = buildRatingPromptButtons(meals);
		expect(buttons[0]).toHaveLength(1);
		expect(buttons[0][0].callbackData).toBe('app:food:cooked:2026-03-31');
	});

	it('button text includes recipe title', () => {
		const meals = [makeMeal({ date: '2026-03-31', recipeTitle: 'Lemon Chicken' })];
		const buttons = buildRatingPromptButtons(meals);
		expect(buttons[0][0].text).toContain('Lemon Chicken');
	});

	it('returns empty array for empty meals list', () => {
		const buttons = buildRatingPromptButtons([]);
		expect(buttons).toHaveLength(0);
	});
});

// ─── buildRateButtons ─────────────────────────────────────────────

describe('buildRateButtons', () => {
	it('returns exactly two rows', () => {
		const buttons = buildRateButtons('2026-03-31');
		expect(buttons).toHaveLength(2);
	});

	it('first row contains thumbs up and thumbs down buttons', () => {
		const buttons = buildRateButtons('2026-03-31');
		const row = buttons[0];
		expect(row).toHaveLength(2);
		const callbacks = row.map((b) => b.callbackData);
		expect(callbacks).toContain('app:food:rate:up:2026-03-31');
		expect(callbacks).toContain('app:food:rate:down:2026-03-31');
	});

	it('second row contains skip button', () => {
		const buttons = buildRateButtons('2026-03-31');
		const row = buttons[1];
		expect(row).toHaveLength(1);
		expect(row[0].callbackData).toBe('app:food:rate:skip:2026-03-31');
	});

	it('thumbs up button text contains 👍', () => {
		const buttons = buildRateButtons('2026-03-31');
		const upBtn = buttons[0].find((b) => b.callbackData.includes(':up:'));
		expect(upBtn?.text).toContain('👍');
	});

	it('thumbs down button text contains 👎', () => {
		const buttons = buildRateButtons('2026-03-31');
		const downBtn = buttons[0].find((b) => b.callbackData.includes(':down:'));
		expect(downBtn?.text).toContain('👎');
	});

	it('skip button text contains ⏭', () => {
		const buttons = buildRateButtons('2026-03-31');
		const skipBtn = buttons[1][0];
		expect(skipBtn.text).toContain('⏭');
	});
});
