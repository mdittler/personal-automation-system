import { describe, expect, it } from 'vitest';
import {
	ALLERGEN_CATEGORIES,
	addFoodIntroduction,
	checkAllergenWaitWindow,
	formatAllergenWarning,
	formatFoodLog,
	getAllergenHistory,
	getRecentIntroductions,
	matchAllergenCategory,
} from '../services/child-tracker.js';
import type { ChildFoodLog, FoodIntroduction } from '../types.js';

function makeLog(introductions: FoodIntroduction[] = []): ChildFoodLog {
	return {
		profile: {
			name: 'Margot',
			slug: 'margot',
			birthDate: '2024-06-15',
			allergenStage: 'early-introduction',
			knownAllergens: ['milk'],
			avoidAllergens: [],
			dietaryNotes: '',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		introductions,
	};
}

function makeIntro(overrides: Partial<FoodIntroduction> = {}): FoodIntroduction {
	return {
		food: 'scrambled eggs',
		allergenCategory: 'eggs',
		date: '2026-04-01',
		reaction: 'none',
		accepted: true,
		notes: '',
		...overrides,
	};
}

describe('child-tracker', () => {
	// ─── ALLERGEN_CATEGORIES ─────────────────────────────────────
	describe('ALLERGEN_CATEGORIES', () => {
		it('contains the FDA Big 9', () => {
			expect(ALLERGEN_CATEGORIES).toContain('milk');
			expect(ALLERGEN_CATEGORIES).toContain('eggs');
			expect(ALLERGEN_CATEGORIES).toContain('peanuts');
			expect(ALLERGEN_CATEGORIES).toContain('tree_nuts');
			expect(ALLERGEN_CATEGORIES).toContain('wheat');
			expect(ALLERGEN_CATEGORIES).toContain('soy');
			expect(ALLERGEN_CATEGORIES).toContain('fish');
			expect(ALLERGEN_CATEGORIES).toContain('shellfish');
			expect(ALLERGEN_CATEGORIES).toContain('sesame');
			expect(ALLERGEN_CATEGORIES).toHaveLength(9);
		});
	});

	// ─── matchAllergenCategory ──────────────────────────────────
	describe('matchAllergenCategory', () => {
		it('matches common dairy foods', () => {
			expect(matchAllergenCategory('yogurt')).toBe('milk');
			expect(matchAllergenCategory('cheese')).toBe('milk');
			expect(matchAllergenCategory('butter')).toBe('milk');
		});

		it('matches egg products', () => {
			expect(matchAllergenCategory('scrambled eggs')).toBe('eggs');
			expect(matchAllergenCategory('omelette')).toBe('eggs');
		});

		it('matches peanut products', () => {
			expect(matchAllergenCategory('peanut butter')).toBe('peanuts');
		});

		it('matches tree nuts', () => {
			expect(matchAllergenCategory('almond')).toBe('tree_nuts');
			expect(matchAllergenCategory('cashew')).toBe('tree_nuts');
			expect(matchAllergenCategory('walnut')).toBe('tree_nuts');
		});

		it('matches wheat products', () => {
			expect(matchAllergenCategory('bread')).toBe('wheat');
			expect(matchAllergenCategory('pasta')).toBe('wheat');
		});

		it('matches soy products', () => {
			expect(matchAllergenCategory('tofu')).toBe('soy');
			expect(matchAllergenCategory('edamame')).toBe('soy');
		});

		it('matches fish', () => {
			expect(matchAllergenCategory('salmon')).toBe('fish');
			expect(matchAllergenCategory('tuna')).toBe('fish');
		});

		it('matches shellfish', () => {
			expect(matchAllergenCategory('shrimp')).toBe('shellfish');
			expect(matchAllergenCategory('lobster')).toBe('shellfish');
		});

		it('matches sesame', () => {
			expect(matchAllergenCategory('tahini')).toBe('sesame');
			expect(matchAllergenCategory('hummus')).toBe('sesame');
		});

		it('returns null for non-allergenic food', () => {
			expect(matchAllergenCategory('banana')).toBeNull();
			expect(matchAllergenCategory('carrot')).toBeNull();
			expect(matchAllergenCategory('sweet potato')).toBeNull();
		});

		it('is case-insensitive', () => {
			expect(matchAllergenCategory('PEANUT BUTTER')).toBe('peanuts');
			expect(matchAllergenCategory('Yogurt')).toBe('milk');
		});

		it('matches direct category names', () => {
			expect(matchAllergenCategory('tree nuts')).toBe('tree_nuts');
		});
	});

	// ─── addFoodIntroduction ─────────────────────────────────────
	describe('addFoodIntroduction', () => {
		it('appends an entry to the introductions list', () => {
			const log = makeLog();
			const entry = makeIntro();
			const updated = addFoodIntroduction(log, entry);
			expect(updated.introductions).toHaveLength(1);
			expect(updated.introductions[0].food).toBe('scrambled eggs');
		});

		it('preserves existing introductions', () => {
			const log = makeLog([makeIntro({ food: 'banana', allergenCategory: null })]);
			const updated = addFoodIntroduction(
				log,
				makeIntro({ food: 'yogurt', allergenCategory: 'milk' }),
			);
			expect(updated.introductions).toHaveLength(2);
			expect(updated.introductions[0].food).toBe('banana');
			expect(updated.introductions[1].food).toBe('yogurt');
		});

		it('does not mutate the original log', () => {
			const log = makeLog();
			addFoodIntroduction(log, makeIntro());
			expect(log.introductions).toHaveLength(0);
		});
	});

	// ─── checkAllergenWaitWindow ─────────────────────────────────
	describe('checkAllergenWaitWindow', () => {
		it('returns safe when no previous allergen introductions', () => {
			const log = makeLog();
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 3);
			expect(result.safe).toBe(true);
		});

		it('returns safe when wait period has elapsed', () => {
			const log = makeLog([makeIntro({ allergenCategory: 'milk', date: '2026-04-01' })]);
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-05', 3);
			expect(result.safe).toBe(true);
			expect(result.daysSince).toBe(4);
		});

		it('returns unsafe when too soon after a different allergen', () => {
			const log = makeLog([
				makeIntro({ allergenCategory: 'milk', date: '2026-04-05' }),
			]);
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 3);
			expect(result.safe).toBe(false);
			expect(result.daysSince).toBe(2);
			expect(result.lastIntroDate).toBe('2026-04-05');
		});

		it('ignores re-introductions of the same allergen category', () => {
			const log = makeLog([
				makeIntro({ allergenCategory: 'eggs', date: '2026-04-06' }),
			]);
			// Introducing eggs again — same category, should be safe
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 3);
			expect(result.safe).toBe(true);
		});

		it('ignores non-allergenic food introductions', () => {
			const log = makeLog([
				makeIntro({ food: 'banana', allergenCategory: null, date: '2026-04-06' }),
			]);
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 3);
			expect(result.safe).toBe(true);
		});

		it('works with custom wait days', () => {
			const log = makeLog([
				makeIntro({ allergenCategory: 'milk', date: '2026-04-01' }),
			]);
			// 6 days later with 7-day wait
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 7);
			expect(result.safe).toBe(false);
			expect(result.daysSince).toBe(6);
		});

		it('checks against most recent different-category allergen', () => {
			const log = makeLog([
				makeIntro({ allergenCategory: 'milk', date: '2026-03-20' }),
				makeIntro({ allergenCategory: 'wheat', date: '2026-04-05' }),
			]);
			const result = checkAllergenWaitWindow(log, 'eggs', '2026-04-07', 3);
			expect(result.safe).toBe(false);
			expect(result.lastIntroDate).toBe('2026-04-05');
		});
	});

	// ─── getRecentIntroductions ──────────────────────────────────
	describe('getRecentIntroductions', () => {
		it('returns introductions within the given day range', () => {
			const log = makeLog([
				makeIntro({ food: 'old food', date: '2026-03-01' }),
				makeIntro({ food: 'recent food', date: '2026-04-05' }),
			]);
			const recent = getRecentIntroductions(log, 7, '2026-04-07');
			expect(recent).toHaveLength(1);
			expect(recent[0].food).toBe('recent food');
		});

		it('returns empty array when no recent introductions', () => {
			const log = makeLog([
				makeIntro({ date: '2026-01-01' }),
			]);
			const recent = getRecentIntroductions(log, 7, '2026-04-07');
			expect(recent).toEqual([]);
		});

		// DST regression: 2026-11-02 is the day after fall DST in the US.
		// The old `new Date(today) + setDate()` pattern would compute the wrong
		// cutoff date around DST transitions (F23). With 14 days subtracted from
		// '2026-11-02', the correct cutoff is '2026-10-19'; the buggy version
		// would produce '2026-10-18', wrongly excluding '2026-10-19'.
		it('uses DST-safe cutoff across fall DST boundary (F23)', () => {
			const log = makeLog([
				makeIntro({ food: 'boundary food', date: '2026-10-19' }), // at correct cutoff — must be included
				makeIntro({ food: 'day before cutoff', date: '2026-10-18' }), // must be excluded
			]);
			const recent = getRecentIntroductions(log, 14, '2026-11-02');
			expect(recent.map(i => i.food)).toContain('boundary food');
			expect(recent.map(i => i.food)).not.toContain('day before cutoff');
		});
	});

	// ─── getAllergenHistory ───────────────────────────────────────
	describe('getAllergenHistory', () => {
		it('filters by allergen category', () => {
			const log = makeLog([
				makeIntro({ food: 'scrambled eggs', allergenCategory: 'eggs' }),
				makeIntro({ food: 'yogurt', allergenCategory: 'milk' }),
				makeIntro({ food: 'omelette', allergenCategory: 'eggs' }),
			]);
			const history = getAllergenHistory(log, 'eggs');
			expect(history).toHaveLength(2);
			expect(history[0].food).toBe('scrambled eggs');
			expect(history[1].food).toBe('omelette');
		});

		it('returns empty for unknown category', () => {
			const log = makeLog([makeIntro()]);
			const history = getAllergenHistory(log, 'shellfish');
			expect(history).toEqual([]);
		});
	});

	// ─── formatFoodLog ───────────────────────────────────────────
	describe('formatFoodLog', () => {
		it('formats introductions as readable text', () => {
			const intros = [
				makeIntro({ food: 'scrambled eggs', accepted: true, reaction: 'none' }),
				makeIntro({ food: 'peanut butter', allergenCategory: 'peanuts', accepted: false, reaction: 'mild' }),
			];
			const output = formatFoodLog(intros);
			expect(output).toContain('scrambled eggs');
			expect(output).toContain('peanut butter');
			expect(output).toContain('peanuts');
		});

		it('respects limit parameter', () => {
			const intros = Array.from({ length: 10 }, (_, i) =>
				makeIntro({ food: `food-${i}` }),
			);
			const output = formatFoodLog(intros, 3);
			expect(output).toContain('food-7');
			expect(output).toContain('food-8');
			expect(output).toContain('food-9');
			expect(output).not.toContain('food-0');
		});

		it('returns placeholder for empty list', () => {
			const output = formatFoodLog([]);
			expect(output).toContain('No foods introduced');
		});
	});

	// ─── formatAllergenWarning ───────────────────────────────────
	describe('formatAllergenWarning', () => {
		it('produces a clear warning message', () => {
			const output = formatAllergenWarning('2026-04-05', 2, 3);
			expect(output).toContain('2');
			expect(output).toContain('3');
			expect(output).toContain('2026-04-05');
		});
	});
});
