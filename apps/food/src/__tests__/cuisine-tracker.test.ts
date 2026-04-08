/**
 * Cuisine Tracker Service Tests
 *
 * Tests for cuisine classification (LLM), repetition detection,
 * and diversity check orchestration.
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type {
	CuisineClassification,
	Household,
	MealPlan,
	PlannedMeal,
} from '../types.js';
import {
	classifyCuisines,
	checkCuisineDiversity,
	findRepetition,
} from '../services/cuisine-tracker.js';
import type { CuisineRepetition } from '../services/cuisine-tracker.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'r1',
		recipeTitle: 'Pasta Bolognese',
		date: '2026-04-03',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
		...overrides,
	};
}

function makePlan(meals: PlannedMeal[], overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-1',
		startDate: '2026-03-31',
		endDate: '2026-04-06',
		meals,
		status: 'active',
		createdAt: '2026-03-31T00:00:00.000Z',
		updatedAt: '2026-03-31T00:00:00.000Z',
		...overrides,
	};
}

function createMockStore() {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

// ─── classifyCuisines ────────────────────────────────────────────────

describe('classifyCuisines', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('calls LLM with recipe titles and returns classifications', async () => {
		const meals: PlannedMeal[] = [
			makeMeal({ recipeTitle: 'Pasta Bolognese' }),
			makeMeal({ recipeTitle: 'Chicken Tikka Masala', recipeId: 'r2' }),
		];

		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
			{ recipe: 'Chicken Tikka Masala', cuisine: 'Indian' },
		];

		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(classifications));

		const result = await classifyCuisines(services, meals);

		expect(result).toEqual(classifications);
		expect(services.llm.complete).toHaveBeenCalledOnce();
		const prompt = vi.mocked(services.llm.complete).mock.calls[0]![0] as string;
		expect(prompt).toContain('Pasta Bolognese');
		expect(prompt).toContain('Chicken Tikka Masala');
	});

	it('returns null when LLM fails', async () => {
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

		const result = await classifyCuisines(services, [makeMeal()]);

		expect(result).toBeNull();
	});

	it('returns null when LLM returns invalid JSON', async () => {
		vi.mocked(services.llm.complete).mockResolvedValue('not valid json at all');

		const result = await classifyCuisines(services, [makeMeal()]);

		expect(result).toBeNull();
	});
});

// ─── findRepetition ──────────────────────────────────────────────────

describe('findRepetition', () => {
	it('flags cuisine appearing 3+ times', () => {
		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
			{ recipe: 'Margherita Pizza', cuisine: 'Italian' },
			{ recipe: 'Risotto', cuisine: 'Italian' },
		];

		const result = findRepetition(classifications);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ cuisine: 'Italian', count: 3 });
	});

	it('returns empty when no cuisine appears 3+ times', () => {
		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
			{ recipe: 'Tacos', cuisine: 'Mexican' },
			{ recipe: 'Sushi', cuisine: 'Japanese' },
		];

		const result = findRepetition(classifications);

		expect(result).toHaveLength(0);
	});

	it('flags multiple cuisines if both appear 3+ times', () => {
		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta', cuisine: 'Italian' },
			{ recipe: 'Pizza', cuisine: 'Italian' },
			{ recipe: 'Risotto', cuisine: 'Italian' },
			{ recipe: 'Tacos', cuisine: 'Mexican' },
			{ recipe: 'Burrito', cuisine: 'Mexican' },
			{ recipe: 'Enchiladas', cuisine: 'Mexican' },
		];

		const result = findRepetition(classifications);

		expect(result).toHaveLength(2);
		const cuisines = result.map((r) => r.cuisine).sort();
		expect(cuisines).toEqual(['Italian', 'Mexican']);
		expect(result.find((r) => r.cuisine === 'Italian')!.count).toBe(3);
		expect(result.find((r) => r.cuisine === 'Mexican')!.count).toBe(3);
	});

	it('handles empty classification list', () => {
		const result = findRepetition([]);

		expect(result).toHaveLength(0);
	});

	it('is case-insensitive when counting cuisines', () => {
		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta', cuisine: 'Italian' },
			{ recipe: 'Pizza', cuisine: 'italian' },
			{ recipe: 'Risotto', cuisine: 'ITALIAN' },
		];

		const result = findRepetition(classifications);

		expect(result).toHaveLength(1);
		// Should preserve first-seen casing
		expect(result[0]!.cuisine).toBe('Italian');
		expect(result[0]!.count).toBe(3);
	});
});

// ─── checkCuisineDiversity ──────────────────────────────────────────

describe('checkCuisineDiversity', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = createMockStore();
	});

	function setupHouseholdAndPlan(
		hh: Household | null,
		plan: MealPlan | null,
	) {
		store.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml' && hh) {
				return `---\ntitle: ${hh.name}\n---\n` + stringify(hh);
			}
			if (path === 'meal-plans/current.yaml' && plan) {
				return `---\ntitle: Meal Plan\n---\n` + stringify(plan);
			}
			return null;
		});
	}

	it('sends message when cuisine is repeated 3+ times', async () => {
		const plan = makePlan([
			makeMeal({ recipeTitle: 'Pasta Bolognese' }),
			makeMeal({ recipeTitle: 'Margherita Pizza', recipeId: 'r2' }),
			makeMeal({ recipeTitle: 'Risotto', recipeId: 'r3' }),
			makeMeal({ recipeTitle: 'Tacos', recipeId: 'r4' }),
		]);
		setupHouseholdAndPlan(household, plan);

		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
			{ recipe: 'Margherita Pizza', cuisine: 'Italian' },
			{ recipe: 'Risotto', cuisine: 'Italian' },
			{ recipe: 'Tacos', cuisine: 'Mexican' },
		];
		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(classifications));

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		expect(services.telegram.send).toHaveBeenCalledTimes(2); // matt and sarah
		const msg = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
		expect(msg).toContain('Cuisine Diversity');
		expect(msg).toContain('Italian');
		expect(msg).toContain('3');
	});

	it('does not send when no repetition detected', async () => {
		const plan = makePlan([
			makeMeal({ recipeTitle: 'Pasta Bolognese' }),
			makeMeal({ recipeTitle: 'Tacos', recipeId: 'r2' }),
			makeMeal({ recipeTitle: 'Sushi', recipeId: 'r3' }),
		]);
		setupHouseholdAndPlan(household, plan);

		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
			{ recipe: 'Tacos', cuisine: 'Mexican' },
			{ recipe: 'Sushi', cuisine: 'Japanese' },
		];
		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(classifications));

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('skips silently when no plan exists', async () => {
		setupHouseholdAndPlan(household, null);

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('skips silently when no household exists', async () => {
		const plan = makePlan([makeMeal()]);
		setupHouseholdAndPlan(null, plan);

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('skips silently when LLM classification fails', async () => {
		const plan = makePlan([makeMeal()]);
		setupHouseholdAndPlan(household, plan);
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM down'));

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('handles single-meal plan without error', async () => {
		const plan = makePlan([
			makeMeal({ recipeTitle: 'Pasta Bolognese' }),
		]);
		setupHouseholdAndPlan(household, plan);

		const classifications: CuisineClassification[] = [
			{ recipe: 'Pasta Bolognese', cuisine: 'Italian' },
		];
		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(classifications));

		await checkCuisineDiversity(services, store as unknown as ScopedDataStore);

		// Single meal can't have 3+ repetitions
		expect(services.telegram.send).not.toHaveBeenCalled();
	});
});
