import { describe, expect, it, vi } from 'vitest';
import {
	estimateRecipeCost,
	estimatePlanCost,
	estimateGroceryListCost,
	formatMealCostLine,
} from '../services/cost-estimator.js';
import type { Recipe, MealPlan, PlannedMeal, PriceEntry, GroceryItem } from '../types.js';
import type { CoreServices } from '@pas/core/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockServices(llmResponse: string): CoreServices {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue(llmResponse),
		},
		logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
	} as unknown as CoreServices;
}

const MOCK_INGREDIENT_COSTS = JSON.stringify([
	{
		ingredientName: '2 cups AP flour',
		matchedItem: 'AP Flour (25 lb)',
		portionCost: 0.2,
		isEstimate: false,
	},
	{
		ingredientName: '3 large eggs',
		matchedItem: 'Eggs (60ct)',
		portionCost: 0.42,
		isEstimate: false,
	},
	{
		ingredientName: '1 cup milk',
		matchedItem: 'Milk (1 gal)',
		portionCost: 0.24,
		isEstimate: false,
	},
]);

const mockRecipe: Recipe = {
	id: 'recipe-1',
	title: 'Pancakes',
	source: 'homemade',
	ingredients: [
		{ name: 'AP flour', quantity: 2, unit: 'cups' },
		{ name: 'large eggs', quantity: 3, unit: null },
		{ name: 'milk', quantity: 1, unit: 'cup' },
	],
	instructions: ['Mix ingredients', 'Cook on griddle'],
	servings: 4,
	tags: [],
	ratings: [],
	history: [],
	allergens: [],
	status: 'confirmed',
	createdAt: '2026-04-01',
	updatedAt: '2026-04-01',
};

const priceItems: PriceEntry[] = [
	{
		name: 'AP Flour (25 lb)',
		price: 8.99,
		unit: '25 lb',
		department: 'Pantry',
		updatedAt: '2026-04-01',
	},
	{ name: 'Eggs (60ct)', price: 8.49, unit: '60ct', department: 'Dairy', updatedAt: '2026-04-01' },
	{
		name: 'Milk (1 gal)',
		price: 3.89,
		unit: '1 gal',
		department: 'Dairy',
		updatedAt: '2026-04-01',
	},
];

// ─── estimateRecipeCost ───────────────────────────────────────────────────────

describe('estimateRecipeCost', () => {
	it('returns ingredient costs and total for recipe', async () => {
		const services = createMockServices(MOCK_INGREDIENT_COSTS);
		const result = await estimateRecipeCost(services, mockRecipe, priceItems, 'Costco');

		expect(result.recipeId).toBe('recipe-1');
		expect(result.recipeTitle).toBe('Pancakes');
		expect(result.store).toBe('Costco');
		expect(result.servings).toBe(4);
		expect(result.ingredientCosts).toHaveLength(3);
		expect(result.totalCost).toBeCloseTo(0.86, 2);
		expect(result.perServingCost).toBeCloseTo(0.86 / 4, 5);
		expect(services.llm.complete).toHaveBeenCalledOnce();
	});

	it('handles empty ingredients (returns 0 cost)', async () => {
		const services = createMockServices('[]');
		const emptyRecipe: Recipe = { ...mockRecipe, ingredients: [] };
		const result = await estimateRecipeCost(services, emptyRecipe, priceItems, 'Costco');

		expect(result.totalCost).toBe(0);
		expect(result.perServingCost).toBe(0);
		expect(result.ingredientCosts).toEqual([]);
		// Should not call LLM for empty ingredients
		expect(services.llm.complete).not.toHaveBeenCalled();
	});

	it('handles LLM returning malformed JSON gracefully', async () => {
		const services = createMockServices('not valid json');
		const result = await estimateRecipeCost(services, mockRecipe, priceItems, 'TestStore');
		expect(result.totalCost).toBe(0);
		expect(result.ingredientCosts).toHaveLength(0);
	});

	it('handles LLM failure gracefully (returns 0 cost)', async () => {
		const services = createMockServices('');
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));
		const result = await estimateRecipeCost(services, mockRecipe, priceItems, 'Costco');

		expect(result.totalCost).toBe(0);
		expect(result.perServingCost).toBe(0);
		expect(result.ingredientCosts).toEqual([]);
	});
});

// ─── estimatePlanCost ─────────────────────────────────────────────────────────

describe('estimatePlanCost', () => {
	const plannedMeal1: PlannedMeal = {
		recipeId: 'recipe-1',
		recipeTitle: 'Pancakes',
		date: '2026-04-07',
		mealType: 'breakfast',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
	};

	const newSuggestionMeal: PlannedMeal = {
		recipeId: 'new-suggestion-abc',
		recipeTitle: 'Exotic Stew',
		date: '2026-04-08',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: true,
		description: 'A brand new suggestion',
	};

	const mockPlan: MealPlan = {
		id: 'plan-1',
		startDate: '2026-04-07',
		endDate: '2026-04-13',
		meals: [plannedMeal1, newSuggestionMeal],
		status: 'active',
		createdAt: '2026-04-07',
		updatedAt: '2026-04-07',
	};

	it('estimates cost for all meals in plan using recipe map', async () => {
		const services = createMockServices(MOCK_INGREDIENT_COSTS);
		const recipes = [mockRecipe];
		const results = await estimatePlanCost(services, mockPlan, recipes, priceItems, 'Costco');

		// Should estimate cost for the matched recipe-1 meal
		expect(results).toHaveLength(1);
		expect(results[0]?.recipeId).toBe('recipe-1');
		expect(results[0]?.totalCost).toBeCloseTo(0.86, 2);
	});

	it('skips meals with no matching recipe (isNew suggestions)', async () => {
		const services = createMockServices(MOCK_INGREDIENT_COSTS);
		const recipes: Recipe[] = []; // no recipes in library
		const results = await estimatePlanCost(services, mockPlan, recipes, priceItems, 'Costco');

		// No matching recipes → no results
		expect(results).toHaveLength(0);
		expect(services.llm.complete).not.toHaveBeenCalled();
	});
});

// ─── estimateGroceryListCost ──────────────────────────────────────────────────

describe('estimateGroceryListCost', () => {
	const groceryItems: GroceryItem[] = [
		{
			name: 'AP Flour',
			quantity: 1,
			unit: 'bag',
			department: 'Pantry',
			recipeIds: ['recipe-1'],
			purchased: false,
			addedBy: 'system',
		},
		{
			name: 'Eggs',
			quantity: 1,
			unit: 'carton',
			department: 'Dairy',
			recipeIds: ['recipe-1'],
			purchased: false,
			addedBy: 'system',
		},
	];

	const MOCK_GROCERY_COSTS = JSON.stringify([
		{ name: 'AP Flour', matchedItem: 'AP Flour (25 lb)', estimatedCost: 8.99 },
		{ name: 'Eggs', matchedItem: 'Eggs (60ct)', estimatedCost: 8.49 },
	]);

	it('returns zero total when no grocery items match prices', async () => {
		const services = createMockServices(JSON.stringify([]));
		const items: GroceryItem[] = [
			{
				name: 'Exotic Fruit',
				quantity: 1,
				unit: '',
				department: 'Produce',
				recipeIds: [],
				purchased: false,
				addedBy: 'user1',
			},
		];
		const result = await estimateGroceryListCost(services, items, priceItems, 'TestStore');
		expect(result.total).toBe(0);
	});

	it('handles empty price database gracefully', async () => {
		const services = createMockServices(JSON.stringify([]));
		const items: GroceryItem[] = [
			{
				name: 'Milk',
				quantity: 1,
				unit: 'gal',
				department: 'Dairy',
				recipeIds: [],
				purchased: false,
				addedBy: 'user1',
			},
		];
		const result = await estimateGroceryListCost(services, items, [], 'TestStore');
		expect(result.total).toBe(0);
	});

	it('matches grocery items to price entries and totals them', async () => {
		const services = createMockServices(MOCK_GROCERY_COSTS);
		const result = await estimateGroceryListCost(services, groceryItems, priceItems, 'Costco');

		expect(result.items).toHaveLength(2);
		expect(result.items[0]?.name).toBe('AP Flour');
		expect(result.items[0]?.matchedItem).toBe('AP Flour (25 lb)');
		expect(result.items[0]?.estimatedCost).toBe(8.99);
		expect(result.total).toBeCloseTo(8.99 + 8.49, 2);
		expect(result.store).toBe('Costco');
	});
});

// ─── formatMealCostLine ───────────────────────────────────────────────────────

describe('formatMealCostLine', () => {
	it('formats "Title — $X.XX ($Y.YY/serving)" for non-zero cost', () => {
		const result = formatMealCostLine('Pancakes', 0.86, 4);
		expect(result).toBe('Pancakes — $0.86 ($0.22/serving)');
	});

	it('formats "Title — price unknown" for zero cost', () => {
		const result = formatMealCostLine('Mystery Meal', 0, 4);
		expect(result).toBe('Mystery Meal — price unknown');
	});
});
