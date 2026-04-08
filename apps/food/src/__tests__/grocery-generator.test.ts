import { createMockCoreServices } from '@pas/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { generateGroceryFromRecipes } from '../services/grocery-generator.js';
import type { GroceryList, PantryItem, Recipe } from '../types.js';

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

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'chicken-stir-fry-abc',
		title: 'Chicken Stir Fry',
		source: 'homemade',
		ingredients: [
			{ name: 'chicken breast', quantity: 1, unit: 'lb' },
			{ name: 'broccoli', quantity: 2, unit: 'cups' },
			{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
			{ name: 'salt', quantity: 1, unit: 'tsp' },
		],
		instructions: ['Cut chicken', 'Stir fry', 'Season'],
		servings: 4,
		tags: ['easy'],
		ratings: [],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

/**
 * Build store.read mock for pantry and existing grocery list.
 */
function buildReadMock(opts: {
	pantry?: PantryItem[];
	existingList?: GroceryList;
}) {
	return vi.fn().mockImplementation(async (path: string) => {
		if (path === 'pantry.yaml' && opts.pantry) {
			return stringify({ items: opts.pantry });
		}
		if (path === 'grocery/active.yaml' && opts.existingList) {
			return stringify(opts.existingList);
		}
		return '';
	});
}

/**
 * Build an LLM complete mock that returns the items unchanged (pass-through dedup).
 */
function buildLlmPassthroughMock() {
	return vi.fn().mockImplementation(async (prompt: string) => {
		const match = prompt.match(/```\n([\s\S]*?)\n```/);
		if (match?.[1]) {
			try {
				const items = JSON.parse(match[1]);
				return JSON.stringify(items);
			} catch {
				return '[]';
			}
		}
		return '[]';
	});
}

describe('generateGroceryFromRecipes', () => {
	let services: ReturnType<typeof createMockCoreServices>;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockResolvedValue('salt,pepper,olive oil,butter,garlic');
	});

	it('generates a grocery list from recipes, excluding staples', async () => {
		const recipe = makeRecipe();
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.recipeTitles).toEqual(['Chicken Stir Fry']);
		expect(result.excludedStaples).toContain('salt');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('chicken breast');
		expect(itemNames).toContain('broccoli');
		expect(itemNames).toContain('soy sauce');
		expect(itemNames).not.toContain('salt');
		expect(store.write).toHaveBeenCalled();
		expect(result.list.id).toBeTruthy();
	});

	it('throws error when no recipes provided', async () => {
		const store = createMockScopedStore();
		await expect(generateGroceryFromRecipes(services, [], store as never)).rejects.toThrow(
			'No recipes provided',
		);
	});

	it('respects custom staple items from config', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
				{ name: 'rice', quantity: 1, unit: 'cup' },
			],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.config.get).mockResolvedValue('rice,soy sauce');
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.excludedStaples).toContain('soy sauce');
		expect(result.excludedStaples).toContain('rice');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('chicken breast');
		expect(itemNames).not.toContain('rice');
	});

	it('excludes pantry items and lists them in excludedPantry', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'broccoli', quantity: 2, unit: 'cups' },
				{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
			],
		});
		const pantry: PantryItem[] = [
			{ name: 'soy sauce', quantity: '1 bottle', addedDate: '2026-01-01', category: 'Pantry & Dry Goods' },
		];
		const store = createMockScopedStore({
			read: buildReadMock({ pantry }),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.excludedPantry).toContain('soy sauce');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).not.toContain('soy sauce');
		expect(itemNames).toContain('chicken breast');
	});

	it('adds items to an existing grocery list', async () => {
		const recipe = makeRecipe({
			ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
		});
		const existingList: GroceryList = {
			id: 'existing-list-001',
			items: [
				{
					name: 'milk',
					quantity: 1,
					unit: 'gal',
					department: 'Dairy & Eggs',
					recipeIds: [],
					purchased: false,
					addedBy: 'user1',
				},
			],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
		const store = createMockScopedStore({
			read: buildReadMock({ existingList }),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.list.id).toBe('existing-list-001');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('milk');
		expect(itemNames).toContain('chicken breast');
	});

	it('aggregates and merges ingredients from multiple recipes', async () => {
		const recipe1 = makeRecipe({
			id: 'recipe-a',
			title: 'Recipe A',
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'onion', quantity: 1, unit: null },
			],
		});
		const recipe2 = makeRecipe({
			id: 'recipe-b',
			title: 'Recipe B',
			ingredients: [
				{ name: 'chicken breast', quantity: 2, unit: 'lb' },
				{ name: 'tomato sauce', quantity: 1, unit: 'cup' },
			],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe1, recipe2], store as never);

		expect(result.recipeTitles).toContain('Recipe A');
		expect(result.recipeTitles).toContain('Recipe B');

		const chickenItem = result.list.items.find((i) => i.name.toLowerCase() === 'chicken breast');
		expect(chickenItem).toBeDefined();
		expect(chickenItem?.quantity).toBe(3);
		expect(chickenItem?.recipeIds).toContain('recipe-a');
		expect(chickenItem?.recipeIds).toContain('recipe-b');
	});

	it('uses default staples when config returns undefined', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'butter', quantity: 2, unit: 'tbsp' },
				{ name: 'pepper', quantity: 1, unit: 'tsp' },
			],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.config.get).mockResolvedValue(undefined);
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.excludedStaples).toContain('butter');
		expect(result.excludedStaples).toContain('pepper');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('chicken breast');
	});

	it('handles empty pantry gracefully', async () => {
		const recipe = makeRecipe({
			ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.excludedPantry).toEqual([]);
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('chicken breast');
	});

	it('gracefully degrades when LLM dedup fails', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'broccoli', quantity: 2, unit: 'cups' },
			],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).toContain('chicken breast');
		expect(itemNames).toContain('broccoli');
	});

	it('both staples and pantry items are excluded simultaneously', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'salt', quantity: 1, unit: 'tsp' },
				{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
				{ name: 'rice', quantity: 1, unit: 'cup' },
			],
		});
		const pantry: PantryItem[] = [
			{ name: 'rice', quantity: '5 lbs', addedDate: '2026-01-01', category: 'Pantry & Dry Goods' },
		];
		const store = createMockScopedStore({
			read: buildReadMock({ pantry }),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		expect(result.excludedStaples).toContain('salt');
		expect(result.excludedPantry).toContain('rice');
		const itemNames = result.list.items.map((i) => i.name.toLowerCase());
		expect(itemNames).not.toContain('salt');
		expect(itemNames).not.toContain('rice');
		expect(itemNames).toContain('chicken breast');
		expect(itemNames).toContain('soy sauce');
	});

	it('assigns departments to generated grocery items', async () => {
		const recipe = makeRecipe({
			ingredients: [
				{ name: 'chicken breast', quantity: 1, unit: 'lb' },
				{ name: 'milk', quantity: 1, unit: 'cup' },
			],
		});
		const store = createMockScopedStore({
			read: buildReadMock({}),
			write: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(services.llm.complete).mockImplementation(buildLlmPassthroughMock());

		const result = await generateGroceryFromRecipes(services, [recipe], store as never);

		const chicken = result.list.items.find((i) => i.name.toLowerCase() === 'chicken breast');
		expect(chicken?.department).toBe('Meat & Seafood');
		const milk = result.list.items.find((i) => i.name.toLowerCase() === 'milk');
		expect(milk?.department).toBe('Dairy & Eggs');
	});
});
