import { describe, expect, it } from 'vitest';
import {
	allMembersVoted,
	buildVoteButtons,
	formatVotingMealMessage,
	getMealsNeedingReplacement,
	isVotingExpired,
	netScore,
	recordVote,
} from '../services/voting.js';
import type { MealPlan, PlannedMeal } from '../types.js';

// ─── Factory helpers ────────────────────────────────────────────────

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
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

function makePlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-001',
		startDate: '2026-03-31',
		endDate: '2026-04-06',
		meals: [],
		status: 'voting',
		createdAt: '2026-03-31T10:00:00.000Z',
		updatedAt: '2026-03-31T10:00:00.000Z',
		...overrides,
	};
}

// ─── recordVote ─────────────────────────────────────────────────────

describe('recordVote', () => {
	it('returns true and records vote when no prior vote exists', () => {
		const meal = makeMeal();
		const result = recordVote(meal, 'u1', 'up');
		expect(result).toBe(true);
		expect(meal.votes['u1']).toBe('up');
	});

	it('returns true and updates vote when prior vote is different', () => {
		const meal = makeMeal({ votes: { u1: 'up' } });
		const result = recordVote(meal, 'u1', 'down');
		expect(result).toBe(true);
		expect(meal.votes['u1']).toBe('down');
	});

	it('returns false when vote is unchanged', () => {
		const meal = makeMeal({ votes: { u1: 'up' } });
		const result = recordVote(meal, 'u1', 'up');
		expect(result).toBe(false);
		expect(meal.votes['u1']).toBe('up');
	});

	it('mutates the meal object in place', () => {
		const meal = makeMeal();
		recordVote(meal, 'u2', 'neutral');
		expect(meal.votes['u2']).toBe('neutral');
	});

	it('handles multiple users voting independently', () => {
		const meal = makeMeal();
		recordVote(meal, 'u1', 'up');
		recordVote(meal, 'u2', 'down');
		recordVote(meal, 'u3', 'neutral');
		expect(meal.votes['u1']).toBe('up');
		expect(meal.votes['u2']).toBe('down');
		expect(meal.votes['u3']).toBe('neutral');
	});

	it('changing to neutral from up returns true', () => {
		const meal = makeMeal({ votes: { u1: 'up' } });
		const result = recordVote(meal, 'u1', 'neutral');
		expect(result).toBe(true);
		expect(meal.votes['u1']).toBe('neutral');
	});
});

// ─── netScore ───────────────────────────────────────────────────────

describe('netScore', () => {
	it('returns 0 for no votes', () => {
		expect(netScore(makeMeal())).toBe(0);
	});

	it('counts each up vote as +1', () => {
		const meal = makeMeal({ votes: { u1: 'up', u2: 'up' } });
		expect(netScore(meal)).toBe(2);
	});

	it('counts each down vote as -1', () => {
		const meal = makeMeal({ votes: { u1: 'down', u2: 'down' } });
		expect(netScore(meal)).toBe(-2);
	});

	it('counts neutral votes as 0', () => {
		const meal = makeMeal({ votes: { u1: 'neutral', u2: 'neutral' } });
		expect(netScore(meal)).toBe(0);
	});

	it('combines up, down, and neutral correctly', () => {
		const meal = makeMeal({ votes: { u1: 'up', u2: 'down', u3: 'up', u4: 'neutral' } });
		expect(netScore(meal)).toBe(1); // 2 up - 1 down
	});

	it('returns negative score when more downs than ups', () => {
		const meal = makeMeal({ votes: { u1: 'down', u2: 'down', u3: 'up' } });
		expect(netScore(meal)).toBe(-1);
	});
});

// ─── isVotingExpired ────────────────────────────────────────────────

describe('isVotingExpired', () => {
	it('returns false when votingStartedAt is not set', () => {
		const plan = makePlan({ votingStartedAt: undefined });
		expect(isVotingExpired(plan, 24)).toBe(false);
	});

	it('returns false when within the voting window', () => {
		// 1 hour ago, window is 24 hours
		const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
		const plan = makePlan({ votingStartedAt: oneHourAgo });
		expect(isVotingExpired(plan, 24)).toBe(false);
	});

	it('returns true when outside the voting window', () => {
		// 25 hours ago, window is 24 hours
		const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		const plan = makePlan({ votingStartedAt: twentyFiveHoursAgo });
		expect(isVotingExpired(plan, 24)).toBe(true);
	});

	it('returns true when exactly at the boundary (expired)', () => {
		// Exactly 24 hours ago
		const exactlyExpired = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1).toISOString();
		const plan = makePlan({ votingStartedAt: exactlyExpired });
		expect(isVotingExpired(plan, 24)).toBe(true);
	});

	it('works with a 1-hour window', () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		const plan = makePlan({ votingStartedAt: twoHoursAgo });
		expect(isVotingExpired(plan, 1)).toBe(true);
	});
});

// ─── allMembersVoted ─────────────────────────────────────────────────

describe('allMembersVoted', () => {
	it('returns true when all members have voted on all meals', () => {
		const plan = makePlan({
			meals: [
				makeMeal({ votes: { u1: 'up', u2: 'down' } }),
				makeMeal({ date: '2026-04-01', votes: { u1: 'neutral', u2: 'up' } }),
			],
		});
		expect(allMembersVoted(plan, ['u1', 'u2'])).toBe(true);
	});

	it('returns false when a member has not voted on a meal', () => {
		const plan = makePlan({
			meals: [
				makeMeal({ votes: { u1: 'up' } }), // u2 has not voted
				makeMeal({ date: '2026-04-01', votes: { u1: 'neutral', u2: 'up' } }),
			],
		});
		expect(allMembersVoted(plan, ['u1', 'u2'])).toBe(false);
	});

	it('returns true when memberIds list is empty', () => {
		const plan = makePlan({ meals: [makeMeal()] });
		expect(allMembersVoted(plan, [])).toBe(true);
	});

	it('returns true when there are no meals', () => {
		const plan = makePlan({ meals: [] });
		expect(allMembersVoted(plan, ['u1', 'u2'])).toBe(true);
	});

	it('returns false when no one has voted on any meal', () => {
		const plan = makePlan({ meals: [makeMeal({ votes: {} })] });
		expect(allMembersVoted(plan, ['u1'])).toBe(false);
	});

	it('works with a single member and single meal', () => {
		const plan = makePlan({ meals: [makeMeal({ votes: { u1: 'up' } })] });
		expect(allMembersVoted(plan, ['u1'])).toBe(true);
	});
});

// ─── getMealsNeedingReplacement ──────────────────────────────────────

describe('getMealsNeedingReplacement', () => {
	it('returns meals with net-negative scores', () => {
		const badMeal = makeMeal({ votes: { u1: 'down', u2: 'down' } });
		const goodMeal = makeMeal({ date: '2026-04-01', votes: { u1: 'up' } });
		const plan = makePlan({ meals: [badMeal, goodMeal] });
		const result = getMealsNeedingReplacement(plan);
		expect(result).toHaveLength(1);
		expect(result[0].date).toBe('2026-03-31');
	});

	it('returns empty array when no meals have negative scores', () => {
		const plan = makePlan({
			meals: [
				makeMeal({ votes: { u1: 'up' } }),
				makeMeal({ date: '2026-04-01', votes: { u1: 'neutral' } }),
			],
		});
		expect(getMealsNeedingReplacement(plan)).toHaveLength(0);
	});

	it('excludes meals with score of exactly 0', () => {
		const meal = makeMeal({ votes: { u1: 'up', u2: 'down' } }); // score = 0
		const plan = makePlan({ meals: [meal] });
		expect(getMealsNeedingReplacement(plan)).toHaveLength(0);
	});

	it('returns empty array when there are no meals', () => {
		const plan = makePlan({ meals: [] });
		expect(getMealsNeedingReplacement(plan)).toHaveLength(0);
	});

	it('returns all meals when all have negative scores', () => {
		const plan = makePlan({
			meals: [
				makeMeal({ votes: { u1: 'down' } }),
				makeMeal({ date: '2026-04-01', votes: { u1: 'down', u2: 'down' } }),
			],
		});
		expect(getMealsNeedingReplacement(plan)).toHaveLength(2);
	});
});

// ─── formatVotingMealMessage ─────────────────────────────────────────

describe('formatVotingMealMessage', () => {
	it('includes the day abbreviation for the meal date', () => {
		const meal = makeMeal({ date: '2026-03-31' }); // Tuesday
		const msg = formatVotingMealMessage(meal);
		expect(msg).toContain('Tue');
	});

	it('includes the recipe title', () => {
		const meal = makeMeal({ recipeTitle: 'Chicken Stir Fry' });
		const msg = formatVotingMealMessage(meal);
		expect(msg).toContain('Chicken Stir Fry');
	});

	it('includes a "New" tag for new recipes', () => {
		const meal = makeMeal({ isNew: true });
		const msg = formatVotingMealMessage(meal);
		expect(msg.toLowerCase()).toContain('new');
	});

	it('does not include a "New" tag for library recipes', () => {
		const meal = makeMeal({ isNew: false });
		const msg = formatVotingMealMessage(meal);
		// "new" should not appear as a tag/marker — may appear in other words like "renewed"
		// but should not have the New marker; check it doesn't have the bracketed/capitalised form
		expect(msg).not.toContain('🆕');
		// at minimum it shouldn't label it new when it isn't
		const hasNewMarker = /\[new\]/i.test(msg) || msg.includes('(New)') || msg.includes('⭐') || msg.includes('🆕');
		expect(hasNewMarker).toBe(false);
	});

	it('handles a Monday date correctly', () => {
		const meal = makeMeal({ date: '2026-03-30' }); // Monday
		const msg = formatVotingMealMessage(meal);
		expect(msg).toContain('Mon');
	});

	it('handles a Friday date correctly', () => {
		const meal = makeMeal({ date: '2026-04-03' }); // Friday
		const msg = formatVotingMealMessage(meal);
		expect(msg).toContain('Fri');
	});
});

// ─── buildVoteButtons ────────────────────────────────────────────────

describe('buildVoteButtons', () => {
	it('returns a 2D array of buttons', () => {
		const buttons = buildVoteButtons('2026-03-31');
		expect(Array.isArray(buttons)).toBe(true);
		expect(buttons.length).toBeGreaterThan(0);
		expect(Array.isArray(buttons[0])).toBe(true);
	});

	it('includes thumbs up button', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const upBtn = flat.find((b) => b.text.includes('👍'));
		expect(upBtn).toBeDefined();
	});

	it('includes thumbs down button', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const downBtn = flat.find((b) => b.text.includes('👎'));
		expect(downBtn).toBeDefined();
	});

	it('includes neutral button', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const neutralBtn = flat.find((b) => b.text.includes('😐'));
		expect(neutralBtn).toBeDefined();
	});

	it('encodes up callback data correctly', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const upBtn = flat.find((b) => b.text.includes('👍'));
		expect(upBtn?.callbackData).toBe('app:food:vote:up:2026-03-31');
	});

	it('encodes down callback data correctly', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const downBtn = flat.find((b) => b.text.includes('👎'));
		expect(downBtn?.callbackData).toBe('app:food:vote:down:2026-03-31');
	});

	it('encodes neutral callback data correctly', () => {
		const buttons = buildVoteButtons('2026-03-31');
		const flat = buttons.flat();
		const neutralBtn = flat.find((b) => b.text.includes('😐'));
		expect(neutralBtn?.callbackData).toBe('app:food:vote:neutral:2026-03-31');
	});

	it('uses the provided meal date in callback data', () => {
		const buttons = buildVoteButtons('2026-04-07');
		const flat = buttons.flat();
		const upBtn = flat.find((b) => b.text.includes('👍'));
		expect(upBtn?.callbackData).toContain('2026-04-07');
	});

	it('all callback data values fit within 64 bytes (Telegram limit)', () => {
		const buttons = buildVoteButtons('2026-03-31');
		for (const row of buttons) {
			for (const btn of row) {
				expect(Buffer.byteLength(btn.callbackData, 'utf8')).toBeLessThanOrEqual(64);
			}
		}
	});
});
