import { describe, expect, it, vi } from 'vitest';
import {
	computeFoodVariety,
	computeAllergenHistory,
	computeReactionSummary,
	computeApprovalSummary,
	computeMacroBalance,
	formatPediatricianReport,
	generatePediatricianReport,
} from '../services/pediatrician-report.js';
import type { ChildFoodLog, ChildProfile, DailyMacroEntry, FoodIntroduction, Recipe } from '../types.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeIntroduction(overrides: Partial<FoodIntroduction> = {}): FoodIntroduction {
	return {
		food: 'scrambled eggs',
		allergenCategory: 'eggs',
		date: '2026-03-20',
		reaction: 'none',
		accepted: true,
		notes: '',
		...overrides,
	};
}

function makeProfile(overrides: Partial<ChildProfile> = {}): ChildProfile {
	return {
		name: 'Margot',
		slug: 'margot',
		birthDate: '2024-06-15',
		allergenStage: 'early-introduction',
		knownAllergens: ['milk', 'eggs'],
		avoidAllergens: [],
		dietaryNotes: '',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeChildLog(
	profileOverrides: Partial<ChildProfile> = {},
	introductions: FoodIntroduction[] = [],
): ChildFoodLog {
	return {
		profile: makeProfile(profileOverrides),
		introductions,
	};
}

describe('pediatrician-report', () => {
	// ─── computeFoodVariety ───────────────────────────────────
	describe('computeFoodVariety', () => {
		// DST regression: 2026-11-02 is the day after fall DST in the US.
		// The old `new Date(today) + setDate() + toISOString()` pattern would
		// produce a cutoff of '2026-10-18' instead of '2026-10-19' because local
		// timezone arithmetic shifts midnight UTC around DST transitions (F23).
		it('uses DST-safe cutoff for 14-day period across fall DST boundary (F23)', () => {
			const intros = [
				makeIntroduction({ food: 'on-the-boundary', date: '2026-10-19' }), // exactly at cutoff
				makeIntroduction({ food: 'one-day-before', date: '2026-10-18' }), // must be excluded
			];
			// today = 2026-11-02, period = 14 → correct cutoff = addDays('2026-11-02', -14) = '2026-10-19'
			const result = computeFoodVariety(intros, 14, '2026-11-02');
			expect(result.foods).toContain('on-the-boundary');
			expect(result.foods).not.toContain('one-day-before');
		});

		it('counts unique foods within period', () => {
			const intros = [
				makeIntroduction({ food: 'scrambled eggs', date: '2026-03-20' }),
				makeIntroduction({ food: 'banana', date: '2026-03-22', allergenCategory: null }),
				makeIntroduction({ food: 'scrambled eggs', date: '2026-03-25' }), // duplicate
				makeIntroduction({ food: 'yogurt', date: '2026-04-01', allergenCategory: 'milk' }),
			];
			const result = computeFoodVariety(intros, 30, '2026-04-08');
			expect(result.count).toBe(3); // eggs, banana, yogurt
			expect(result.foods).toContain('scrambled eggs');
			expect(result.foods).toContain('banana');
			expect(result.foods).toContain('yogurt');
		});

		it('respects period filter', () => {
			const intros = [
				makeIntroduction({ food: 'old food', date: '2026-01-01' }),
				makeIntroduction({ food: 'recent food', date: '2026-04-05' }),
			];
			const result = computeFoodVariety(intros, 30, '2026-04-08');
			expect(result.count).toBe(1);
			expect(result.foods).toContain('recent food');
		});

		it('handles empty introductions', () => {
			const result = computeFoodVariety([], 30, '2026-04-08');
			expect(result.count).toBe(0);
			expect(result.foods).toEqual([]);
		});
	});

	// ─── computeAllergenHistory ───────────────────────────────
	describe('computeAllergenHistory', () => {
		it('groups introductions by allergen category', () => {
			const intros = [
				makeIntroduction({ food: 'scrambled eggs', allergenCategory: 'eggs', date: '2026-03-01' }),
				makeIntroduction({ food: 'omelette', allergenCategory: 'eggs', date: '2026-03-15' }),
				makeIntroduction({ food: 'yogurt', allergenCategory: 'milk', date: '2026-03-10' }),
			];
			const result = computeAllergenHistory(intros);
			expect(result).toHaveLength(2);

			const eggs = result.find(a => a.category === 'eggs');
			expect(eggs).toBeDefined();
			expect(eggs!.firstIntroduced).toBe('2026-03-01');
			expect(eggs!.foods).toContain('scrambled eggs');
			expect(eggs!.foods).toContain('omelette');
		});

		it('skips non-allergen foods', () => {
			const intros = [
				makeIntroduction({ food: 'banana', allergenCategory: null }),
			];
			const result = computeAllergenHistory(intros);
			expect(result).toHaveLength(0);
		});

		it('sorts by first introduction date', () => {
			const intros = [
				makeIntroduction({ food: 'yogurt', allergenCategory: 'milk', date: '2026-03-10' }),
				makeIntroduction({ food: 'eggs', allergenCategory: 'eggs', date: '2026-03-01' }),
			];
			const result = computeAllergenHistory(intros);
			expect(result[0]!.category).toBe('eggs');
			expect(result[1]!.category).toBe('milk');
		});
	});

	// ─── computeReactionSummary ───────────────────────────────
	describe('computeReactionSummary', () => {
		it('lists reactions excluding none', () => {
			const intros = [
				makeIntroduction({ food: 'eggs', reaction: 'none' }),
				makeIntroduction({ food: 'peanuts', reaction: 'mild', allergenCategory: 'peanuts', notes: 'slight rash' }),
				makeIntroduction({ food: 'shrimp', reaction: 'moderate', allergenCategory: 'shellfish', notes: 'hives' }),
			];
			const result = computeReactionSummary(intros);
			expect(result).toHaveLength(2);
			expect(result[0]!.food).toBe('peanuts');
			expect(result[0]!.severity).toBe('mild');
			expect(result[1]!.food).toBe('shrimp');
		});

		it('returns empty when no reactions', () => {
			const intros = [
				makeIntroduction({ reaction: 'none' }),
			];
			expect(computeReactionSummary(intros)).toEqual([]);
		});
	});

	// ─── computeApprovalSummary ───────────────────────────────
	describe('computeApprovalSummary', () => {
		it('counts approved and rejected from recipes', () => {
			const recipes: Partial<Recipe>[] = [
				{ id: 'r1', title: 'Mac and Cheese', childApprovals: { margot: 'approved' } },
				{ id: 'r2', title: 'Broccoli Soup', childApprovals: { margot: 'rejected' } },
				{ id: 'r3', title: 'Pasta', childApprovals: { margot: 'approved' } },
				{ id: 'r4', title: 'Salad', childApprovals: { other: 'approved' } },
			];
			const result = computeApprovalSummary(recipes as Recipe[], 'margot');
			expect(result.approved).toEqual(['Mac and Cheese', 'Pasta']);
			expect(result.rejected).toEqual(['Broccoli Soup']);
		});

		it('handles no approvals', () => {
			const result = computeApprovalSummary([], 'margot');
			expect(result.approved).toEqual([]);
			expect(result.rejected).toEqual([]);
		});
	});

	// ─── computeMacroBalance ──────────────────────────────────
	describe('computeMacroBalance', () => {
		it('computes average macros over entries', () => {
			const entries: DailyMacroEntry[] = [
				{ date: '2026-04-01', meals: [], totals: { calories: 800, protein: 30 } },
				{ date: '2026-04-02', meals: [], totals: { calories: 1000, protein: 40 } },
			];
			const result = computeMacroBalance(entries);
			expect(result.calories).toBe(900);
			expect(result.protein).toBe(35);
		});

		it('returns zeroes for empty entries', () => {
			const result = computeMacroBalance([]);
			expect(result.calories).toBe(0);
		});
	});

	// ─── formatPediatricianReport ─────────────────────────────
	describe('formatPediatricianReport', () => {
		it('formats a complete report', () => {
			const result = formatPediatricianReport({
				childName: 'Margot',
				age: '22 months',
				periodDays: 30,
				foodVariety: { count: 15, foods: ['eggs', 'banana', 'yogurt'] },
				allergenHistory: [
					{ category: 'eggs', firstIntroduced: '2026-03-01', foods: ['scrambled eggs', 'omelette'], reactions: [] },
					{ category: 'milk', firstIntroduced: '2026-03-10', foods: ['yogurt'], reactions: [] },
				],
				reactions: [
					{ food: 'peanut butter', severity: 'mild', date: '2026-03-25', notes: 'slight rash' },
				],
				macroBalance: { calories: 900, protein: 35, carbs: 100, fat: 30 },
				approvals: { approved: ['Mac and Cheese', 'Pasta'], rejected: ['Broccoli Soup'] },
			});

			expect(result).toContain('Margot');
			expect(result).toContain('22 months');
			expect(result).toContain('15 unique foods');
			expect(result).toContain('eggs');
			expect(result).toContain('milk');
			expect(result).toContain('peanut butter');
			expect(result).toContain('mild');
			expect(result).toContain('900');
			expect(result).toContain('Mac and Cheese');
			expect(result).toContain('Broccoli Soup');
		});

		it('handles empty sections gracefully', () => {
			const result = formatPediatricianReport({
				childName: 'Margot',
				age: '22 months',
				periodDays: 30,
				foodVariety: { count: 0, foods: [] },
				allergenHistory: [],
				reactions: [],
				macroBalance: { calories: 0, protein: 0 },
				approvals: { approved: [], rejected: [] },
			});

			expect(result).toContain('Margot');
			expect(result).toContain('0 unique foods');
		});
	});

	// ─── generatePediatricianReport ───────────────────────────
	describe('generatePediatricianReport', () => {
		it('orchestrates full report generation', async () => {
			const childLog = makeChildLog({}, [
				makeIntroduction({ food: 'eggs', allergenCategory: 'eggs', date: '2026-03-20', accepted: true }),
				makeIntroduction({ food: 'banana', allergenCategory: null, date: '2026-03-22', accepted: true }),
			]);

			const sharedStore = createMockScopedStore({
				list: vi.fn().mockResolvedValue([]),
			});
			const userStore = createMockScopedStore({
				read: vi.fn().mockResolvedValue(null),
			});

			const result = await generatePediatricianReport(
				sharedStore as never,
				userStore as never,
				childLog,
				[] as Recipe[],
				30,
				'2026-04-08',
			);

			expect(result).toContain('Margot');
			expect(result).toContain('eggs');
		});

		it('handles child with no data', async () => {
			const childLog = makeChildLog();
			const sharedStore = createMockScopedStore();
			const userStore = createMockScopedStore();

			const result = await generatePediatricianReport(
				sharedStore as never,
				userStore as never,
				childLog,
				[],
				30,
				'2026-04-08',
			);

			expect(result).toContain('Margot');
			expect(result).toContain('0 unique foods');
		});
	});
});
