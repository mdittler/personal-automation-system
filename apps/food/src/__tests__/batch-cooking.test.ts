/**
 * Batch Cooking Service Tests
 *
 * Tests for batch prep analysis (LLM), defrost reminders,
 * freezer-to-recipe matching, and message formatting.
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	BatchAnalysis,
	FreezerItem,
	Household,
	MealPlan,
	PlannedMeal,
	Recipe,
} from '../types.js';
import {
	analyzeBatchPrep,
	buildBatchFreezeButtons,
	checkDefrostNeeded,
	formatBatchPrepMessage,
	formatDefrostMessage,
	matchFreezerToRecipes,
} from '../services/batch-cooking.js';
import type { DefrostMatch } from '../services/batch-cooking.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'r1',
		title: 'Pasta Bolognese',
		source: 'homemade',
		ingredients: [
			{ name: 'ground beef', quantity: 1, unit: 'lb' },
			{ name: 'pasta', quantity: 500, unit: 'g' },
			{ name: 'onion', quantity: 2, unit: null },
		],
		instructions: ['Brown the beef', 'Add sauce', 'Cook pasta'],
		servings: 4,
		tags: ['italian'],
		cuisine: 'Italian',
		ratings: [],
		history: [],
		allergens: ['gluten'],
		status: 'confirmed',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

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

const sampleAnalysis: BatchAnalysis = {
	sharedTasks: [
		{ task: 'Dice onions', recipes: ['Pasta Bolognese', 'Stir Fry'], estimatedMinutes: 10 },
		{ task: 'Cook rice', recipes: ['Stir Fry', 'Curry'], estimatedMinutes: 20 },
	],
	totalPrepMinutes: 60,
	estimatedSavingsMinutes: 15,
	freezerFriendlyRecipes: ['Pasta Bolognese'],
};

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

// ─── analyzeBatchPrep ────────────────────────────────────────────────

describe('analyzeBatchPrep', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('calls LLM with recipe details and returns parsed analysis', async () => {
		const recipes = [
			makeRecipe({ id: 'r1', title: 'Pasta Bolognese' }),
			makeRecipe({
				id: 'r2',
				title: 'Stir Fry',
				ingredients: [
					{ name: 'chicken', quantity: 1, unit: 'lb' },
					{ name: 'onion', quantity: 1, unit: null },
				],
			}),
		];
		const plan = makePlan([
			makeMeal({ recipeId: 'r1', recipeTitle: 'Pasta Bolognese' }),
			makeMeal({ recipeId: 'r2', recipeTitle: 'Stir Fry', date: '2026-04-04' }),
		]);

		const analysis: BatchAnalysis = {
			sharedTasks: [
				{ task: 'Dice onions', recipes: ['Pasta Bolognese', 'Stir Fry'], estimatedMinutes: 10 },
			],
			totalPrepMinutes: 40,
			estimatedSavingsMinutes: 10,
			freezerFriendlyRecipes: ['Pasta Bolognese'],
		};

		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(analysis));

		const result = await analyzeBatchPrep(services, plan, recipes);

		expect(result).toEqual(analysis);
		expect(services.llm.complete).toHaveBeenCalledOnce();
		// Verify prompt includes recipe titles
		const prompt = vi.mocked(services.llm.complete).mock.calls[0]![0] as string;
		expect(prompt).toContain('Pasta Bolognese');
		expect(prompt).toContain('Stir Fry');
	});

	it('returns null when LLM fails', async () => {
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

		const result = await analyzeBatchPrep(
			services,
			makePlan([makeMeal()]),
			[makeRecipe()],
		);

		expect(result).toBeNull();
	});

	it('returns null when LLM returns invalid JSON', async () => {
		vi.mocked(services.llm.complete).mockResolvedValue('not valid json at all');

		const result = await analyzeBatchPrep(
			services,
			makePlan([makeMeal()]),
			[makeRecipe()],
		);

		expect(result).toBeNull();
	});

	it('includes new/external suggestions with just title, no ingredients', async () => {
		// Only the new suggestion — no library recipes — so we can verify
		// that the prompt does NOT contain any ingredient detail for it
		const recipes: Recipe[] = [];
		const plan = makePlan([
			makeMeal({
				recipeId: 'new-1',
				recipeTitle: 'Grilled Salmon',
				isNew: true,
				description: 'A light salmon dish',
			}),
		]);

		const analysis: BatchAnalysis = {
			sharedTasks: [],
			totalPrepMinutes: 30,
			estimatedSavingsMinutes: 0,
			freezerFriendlyRecipes: [],
		};

		vi.mocked(services.llm.complete).mockResolvedValue(JSON.stringify(analysis));

		const result = await analyzeBatchPrep(services, plan, recipes);

		expect(result).toEqual(analysis);
		const prompt = vi.mocked(services.llm.complete).mock.calls[0]![0] as string;
		expect(prompt).toContain('Grilled Salmon');
		expect(prompt).toContain('external suggestion');
		// New suggestions should not have ingredient/instruction detail
		expect(prompt).not.toContain('Ingredients:');
	});
});

// ─── formatBatchPrepMessage ──────────────────────────────────────────

describe('formatBatchPrepMessage', () => {
	it('formats shared tasks with recipes and time savings', () => {
		const msg = formatBatchPrepMessage(sampleAnalysis);

		expect(msg).toContain('🔪 Batch Prep Plan');
		expect(msg).toContain('Dice onions');
		expect(msg).toContain('10 min');
		expect(msg).toContain('Pasta Bolognese');
		expect(msg).toContain('Stir Fry');
		expect(msg).toContain('Cook rice');
		expect(msg).toContain('60');
		expect(msg).toContain('15');
	});

	it('includes freezer-friendly suggestions when present', () => {
		const msg = formatBatchPrepMessage(sampleAnalysis);

		expect(msg).toContain('🧊');
		expect(msg).toContain('Pasta Bolognese');
	});

	it('omits freezer-friendly section when empty', () => {
		const analysis: BatchAnalysis = {
			...sampleAnalysis,
			freezerFriendlyRecipes: [],
		};

		const msg = formatBatchPrepMessage(analysis);

		expect(msg).not.toContain('🧊');
	});

	it('handles empty shared tasks gracefully', () => {
		const analysis: BatchAnalysis = {
			sharedTasks: [],
			totalPrepMinutes: 30,
			estimatedSavingsMinutes: 0,
			freezerFriendlyRecipes: [],
		};

		const msg = formatBatchPrepMessage(analysis);

		expect(msg).toContain('🔪 Batch Prep Plan');
		expect(msg).toContain('No shared prep tasks');
	});
});

// ─── matchFreezerToRecipes ───────────────────────────────────────────

describe('matchFreezerToRecipes', () => {
	it('matches freezer items to recipe ingredients (case-insensitive)', () => {
		const freezer: FreezerItem[] = [
			{ name: 'Ground Beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal({ recipeId: 'r1', recipeTitle: 'Pasta Bolognese' })];
		const recipes = [makeRecipe()];

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(1);
		expect(matches[0]!.freezerItem.name).toBe('Ground Beef');
		expect(matches[0]!.meal.recipeTitle).toBe('Pasta Bolognese');
	});

	it('returns empty when no matches', () => {
		const freezer: FreezerItem[] = [
			{ name: 'chicken breast', quantity: '2 lbs', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal({ recipeId: 'r1', recipeTitle: 'Pasta Bolognese' })];
		const recipes = [makeRecipe()];

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(0);
	});

	it('returns empty when freezer is empty', () => {
		const meals = [makeMeal()];
		const recipes = [makeRecipe()];

		const matches = matchFreezerToRecipes([], meals, recipes);

		expect(matches).toHaveLength(0);
	});

	it('matches substring (ingredient name contains freezer item name)', () => {
		const freezer: FreezerItem[] = [
			{ name: 'beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal()];
		const recipes = [makeRecipe()]; // has 'ground beef'

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(1);
		expect(matches[0]!.freezerItem.name).toBe('beef');
	});

	it('matches when freezer item name contains ingredient name', () => {
		const freezer: FreezerItem[] = [
			{ name: 'diced onion mix', quantity: '1 bag', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal()];
		const recipes = [makeRecipe()]; // has 'onion'

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(1);
	});

	it('skips meals with no matching recipe in library', () => {
		const freezer: FreezerItem[] = [
			{ name: 'Ground Beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal({ recipeId: 'nonexistent', recipeTitle: 'Unknown Dish' })];
		const recipes = [makeRecipe()]; // recipe id is 'r1', not 'nonexistent'

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(0);
	});

	it('handles multiple matches across meals', () => {
		const freezer: FreezerItem[] = [
			{ name: 'beef', quantity: '1 lb', frozenDate: '2026-03-20' },
			{ name: 'chicken', quantity: '2 lbs', frozenDate: '2026-03-18' },
		];
		const meals = [
			makeMeal({ recipeId: 'r1', recipeTitle: 'Pasta Bolognese' }),
			makeMeal({
				recipeId: 'r2',
				recipeTitle: 'Chicken Stir Fry',
				date: '2026-04-03',
			}),
		];
		const recipes = [
			makeRecipe(),
			makeRecipe({
				id: 'r2',
				title: 'Chicken Stir Fry',
				ingredients: [
					{ name: 'chicken breast', quantity: 1, unit: 'lb' },
					{ name: 'broccoli', quantity: 2, unit: 'cups' },
				],
			}),
		];

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(2);
	});

	it('does not match when term appears mid-word (no word boundary)', () => {
		// "ice" should NOT match "rice" — "ice" is not at a word boundary in "rice"
		const freezer: FreezerItem[] = [
			{ name: 'ice', quantity: '1 bag', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal()];
		const recipes = [makeRecipe({
			ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }],
		})];

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(0);
	});

	it('matches when term is at a word boundary', () => {
		// "ham" should match "smoked ham" — "ham" is at a word boundary
		const freezer: FreezerItem[] = [
			{ name: 'ham', quantity: '1 lb', frozenDate: '2026-03-20' },
		];
		const meals = [makeMeal()];
		const recipes = [makeRecipe({
			ingredients: [{ name: 'smoked ham', quantity: 1, unit: 'lb' }],
		})];

		const matches = matchFreezerToRecipes(freezer, meals, recipes);

		expect(matches).toHaveLength(1);
	});
});

// ─── formatDefrostMessage ────────────────────────────────────────────

describe('formatDefrostMessage', () => {
	it('formats single defrost item', () => {
		const matches: DefrostMatch[] = [
			{
				freezerItem: { name: 'Ground Beef', quantity: '1 lb', frozenDate: '2026-03-20' },
				meal: makeMeal({ recipeTitle: 'Pasta Bolognese' }),
			},
		];

		const msg = formatDefrostMessage(matches);

		expect(msg).toContain('🧊 Defrost Reminder');
		expect(msg).toContain('Ground Beef');
		expect(msg).toContain('Pasta Bolognese');
	});

	it('formats multiple defrost items', () => {
		const matches: DefrostMatch[] = [
			{
				freezerItem: { name: 'Ground Beef', quantity: '1 lb', frozenDate: '2026-03-20' },
				meal: makeMeal({ recipeTitle: 'Pasta Bolognese' }),
			},
			{
				freezerItem: { name: 'Chicken', quantity: '2 lbs', frozenDate: '2026-03-18' },
				meal: makeMeal({ recipeTitle: 'Chicken Stir Fry' }),
			},
		];

		const msg = formatDefrostMessage(matches);

		expect(msg).toContain('Ground Beef');
		expect(msg).toContain('Pasta Bolognese');
		expect(msg).toContain('Chicken');
		expect(msg).toContain('Chicken Stir Fry');
		// Check for bullet format
		expect(msg).toContain('•');
	});
});

// ─── checkDefrostNeeded ──────────────────────────────────────────────

describe('checkDefrostNeeded', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = createMockStore();
	});

	function setupHouseholdAndFreezer(
		hh: Household | null,
		freezerItems: FreezerItem[],
	) {
		store.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml' && hh) {
				return `---\ntitle: ${hh.name}\n---\n` + (await import('yaml')).stringify(hh);
			}
			if (path === 'freezer.yaml' && freezerItems.length > 0) {
				return `---\ntitle: Freezer\n---\n` + (await import('yaml')).stringify(freezerItems);
			}
			return null;
		});
	}

	it('sends reminder when tomorrow\'s meal uses frozen ingredient', async () => {
		setupHouseholdAndFreezer(household, [
			{ name: 'ground beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		]);

		const plan = makePlan([
			makeMeal({
				recipeId: 'r1',
				recipeTitle: 'Pasta Bolognese',
				date: '2026-04-04', // tomorrow relative to todayOverride
			}),
		]);
		const recipes = [makeRecipe()];

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		expect(services.telegram.send).toHaveBeenCalledTimes(2); // matt and sarah
		const msg = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
		expect(msg).toContain('🧊 Defrost Reminder');
		expect(msg).toContain('ground beef');
	});

	it('does not send when no frozen ingredients match', async () => {
		setupHouseholdAndFreezer(household, [
			{ name: 'chicken', quantity: '2 lbs', frozenDate: '2026-03-20' },
		]);

		const plan = makePlan([
			makeMeal({
				recipeId: 'r1',
				recipeTitle: 'Pasta Bolognese',
				date: '2026-04-04',
			}),
		]);
		const recipes = [makeRecipe()]; // no chicken ingredient

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('does not send when freezer is empty', async () => {
		setupHouseholdAndFreezer(household, []);

		const plan = makePlan([
			makeMeal({ date: '2026-04-04' }),
		]);
		const recipes = [makeRecipe()];

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('does not send when no meals planned for tomorrow', async () => {
		setupHouseholdAndFreezer(household, [
			{ name: 'ground beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		]);

		const plan = makePlan([
			makeMeal({ date: '2026-04-05' }), // day after tomorrow
		]);
		const recipes = [makeRecipe()];

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('consolidates multiple frozen items into one message', async () => {
		setupHouseholdAndFreezer(household, [
			{ name: 'beef', quantity: '1 lb', frozenDate: '2026-03-20' },
			{ name: 'onion', quantity: '1 bag', frozenDate: '2026-03-15' },
		]);

		const plan = makePlan([
			makeMeal({
				recipeId: 'r1',
				recipeTitle: 'Pasta Bolognese',
				date: '2026-04-04',
			}),
		]);
		const recipes = [makeRecipe()]; // has ground beef and onion

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		// Should send ONE message per member (not one per item)
		expect(services.telegram.send).toHaveBeenCalledTimes(2); // matt and sarah
		const msg = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
		expect(msg).toContain('beef');
		expect(msg).toContain('onion');
	});

	it('does not send when household is null', async () => {
		setupHouseholdAndFreezer(null, [
			{ name: 'beef', quantity: '1 lb', frozenDate: '2026-03-20' },
		]);

		const plan = makePlan([makeMeal({ date: '2026-04-04' })]);
		const recipes = [makeRecipe()];

		await checkDefrostNeeded(services, store as unknown as ScopedDataStore, plan, recipes, '2026-04-03');

		expect(services.telegram.send).not.toHaveBeenCalled();
	});
});

// ─── buildBatchFreezeButtons ─────────────────────────────────────────────────

describe('buildBatchFreezeButtons', () => {
	it('builds one button row per freezer-friendly recipe using numeric index', () => {
		const buttons = buildBatchFreezeButtons(['Bolognese', 'Chili']);

		expect(buttons).toHaveLength(2);
		expect(buttons[0]![0]!.text).toContain('Bolognese');
		expect(buttons[0]![0]!.callbackData).toBe('app:food:batch:freeze:0');
		expect(buttons[1]![0]!.text).toContain('Chili');
		expect(buttons[1]![0]!.callbackData).toBe('app:food:batch:freeze:1');
	});

	it('returns empty array when no recipes', () => {
		const buttons = buildBatchFreezeButtons([]);
		expect(buttons).toHaveLength(0);
	});

	it('callback data stays within Telegram 64-byte limit even with long recipe names', () => {
		const longName = 'Grandma\'s Famous Southern Fried Chicken with Buttermilk Biscuits and Honey Drizzle';
		const buttons = buildBatchFreezeButtons([longName]);
		// Callback data uses index, not name — always fits in 64 bytes
		expect(Buffer.byteLength(buttons[0]![0]!.callbackData, 'utf8')).toBeLessThanOrEqual(64);
		expect(buttons[0]![0]!.callbackData).toBe('app:food:batch:freeze:0');
		// Display text still shows the full name
		expect(buttons[0]![0]!.text).toContain(longName);
	});
});
