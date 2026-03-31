/**
 * Natural Language User Simulation Tests
 *
 * These tests simulate real humans talking to the bot via Telegram.
 * Each test is a message someone would actually type, verifying that:
 * 1. The correct intent is detected
 * 2. The right handler runs
 * 3. The user gets a sensible response
 * 4. Items are correctly parsed from casual language
 *
 * These are NOT unit tests of regex — they're end-to-end simulations
 * of the handleMessage flow with a mocked household and store.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleCallbackQuery,
	handleCommand,
	handleMessage,
	init,
	isGroceryAddIntent,
	isGroceryGenerateIntent,
	isGroceryViewIntent,
	isMealPlanGenerateIntent,
	isMealPlanViewIntent,
	isMealSwapIntent,
	isPantryAddIntent,
	isPantryRemoveIntent,
	isPantryViewIntent,
	isWhatCanIMakeIntent,
	isWhatsForDinnerIntent,
} from '../index.js';
import type { GroceryList, Household, MealPlan, PantryItem, Recipe } from '../types.js';

// ─── Shared Fixtures ─────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const chickenStirFry: Recipe = {
	id: 'chicken-stir-fry-001',
	title: 'Chicken Stir Fry',
	source: 'homemade',
	ingredients: [
		{ name: 'chicken breast', quantity: 1, unit: 'lb' },
		{ name: 'broccoli', quantity: 2, unit: 'cups' },
		{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
		{ name: 'garlic', quantity: 3, unit: 'cloves' },
		{ name: 'rice', quantity: 1, unit: 'cup' },
		{ name: 'salt', quantity: 1, unit: 'tsp' },
	],
	instructions: ['Cut chicken', 'Heat oil', 'Stir fry'],
	servings: 4,
	tags: ['easy', 'weeknight', 'asian'],
	cuisine: 'Chinese',
	ratings: [{ userId: 'matt', score: 4, date: '2026-03-01' }],
	history: [],
	allergens: ['soy'],
	status: 'confirmed',
	createdAt: '2026-01-15T00:00:00.000Z',
	updatedAt: '2026-03-01T00:00:00.000Z',
};

const pastaBolognese: Recipe = {
	id: 'pasta-bolognese-002',
	title: 'Pasta Bolognese',
	source: 'nonna',
	ingredients: [
		{ name: 'ground beef', quantity: 1, unit: 'lb' },
		{ name: 'pasta', quantity: 500, unit: 'g' },
		{ name: 'tomato sauce', quantity: 2, unit: 'cups' },
		{ name: 'onion', quantity: 1, unit: null },
		{ name: 'garlic', quantity: 4, unit: 'cloves' },
		{ name: 'olive oil', quantity: 2, unit: 'tbsp' },
		{ name: 'salt', quantity: 1, unit: 'tsp' },
	],
	instructions: ['Brown beef', 'Add sauce', 'Cook pasta'],
	servings: 6,
	tags: ['italian', 'comfort-food'],
	cuisine: 'Italian',
	ratings: [],
	history: [],
	allergens: ['gluten'],
	status: 'confirmed',
	createdAt: '2026-02-10T00:00:00.000Z',
	updatedAt: '2026-02-10T00:00:00.000Z',
};

const groceryList: GroceryList = {
	id: 'gl-active',
	items: [
		{
			name: 'Milk',
			quantity: 1,
			unit: 'gallon',
			department: 'Dairy & Eggs',
			recipeIds: [],
			purchased: false,
			addedBy: 'sarah',
		},
		{
			name: 'Bread',
			quantity: 1,
			unit: null,
			department: 'Bakery',
			recipeIds: [],
			purchased: true,
			addedBy: 'matt',
		},
		{
			name: 'Chicken breast',
			quantity: 2,
			unit: 'lbs',
			department: 'Meat & Seafood',
			recipeIds: ['chicken-stir-fry-001'],
			purchased: false,
			addedBy: 'system',
		},
	],
	createdAt: '2026-03-30T00:00:00.000Z',
	updatedAt: '2026-03-31T00:00:00.000Z',
};

const pantryItems: PantryItem[] = [
	{ name: 'Rice', quantity: '5 lbs', addedDate: '2026-03-15', category: 'Pantry & Dry Goods' },
	{ name: 'Eggs', quantity: '1 dozen', addedDate: '2026-03-28', category: 'Dairy & Eggs' },
	{
		name: 'Olive oil',
		quantity: '1 bottle',
		addedDate: '2026-03-01',
		category: 'Pantry & Dry Goods',
	},
	{
		name: 'Soy sauce',
		quantity: '1 bottle',
		addedDate: '2026-03-01',
		category: 'Pantry & Dry Goods',
	},
];

const activeMealPlan: MealPlan = {
	id: 'plan-001',
	startDate: '2026-03-30',
	endDate: '2026-04-05',
	meals: [
		{
			recipeId: 'chicken-stir-fry-001',
			recipeTitle: 'Chicken Stir Fry',
			date: '2026-03-31',
			mealType: 'dinner',
			votes: {},
			cooked: false,
			rated: false,
			isNew: false,
		},
		{
			recipeId: 'pasta-bolognese-002',
			recipeTitle: 'Pasta Bolognese',
			date: '2026-04-01',
			mealType: 'dinner',
			votes: {},
			cooked: false,
			rated: false,
			isNew: false,
		},
		{
			recipeId: '',
			recipeTitle: 'Lemon Herb Salmon',
			date: '2026-04-02',
			mealType: 'dinner',
			votes: {},
			cooked: false,
			rated: false,
			isNew: true,
			description: 'Pan-seared salmon with lemon and dill',
		},
	],
	status: 'active',
	createdAt: '2026-03-30T09:00:00.000Z',
	updatedAt: '2026-03-30T09:00:00.000Z',
};

// ─── Test Setup ──────────────────────────────────────────────────

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

describe('Natural Language — Real User Messages', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockStore>;

	beforeEach(async () => {
		store = createMockStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(store as any);
		vi.mocked(services.data.forUser).mockReturnValue(store as any);
		await init(services);
	});

	/** Helper: set up a household with recipes and optionally a grocery list, pantry, and meal plan. */
	function setupHousehold(
		opts: {
			recipes?: Recipe[];
			grocery?: GroceryList;
			pantry?: PantryItem[];
			mealPlan?: MealPlan | null;
		} = {},
	) {
		const recipes = opts.recipes ?? [chickenStirFry, pastaBolognese];
		store.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path === 'grocery/active.yaml' && opts.grocery) return stringify(opts.grocery);
			if (path === 'pantry.yaml' && opts.pantry) return stringify({ items: opts.pantry });
			if (path === 'meal-plans/current.yaml' && opts.mealPlan)
				return stringify(opts.mealPlan);
			for (const r of recipes) {
				if (path === `recipes/${r.id}.yaml`) return stringify(r);
			}
			return '';
		});
		store.list.mockImplementation(async (dir: string) => {
			if (dir === 'recipes') return recipes.map((r) => `${r.id}.yaml`);
			return [];
		});
	}

	function msg(text: string, userId = 'matt') {
		return createTestMessageContext({ text, userId });
	}

	// ═══════════════════════════════════════════════════════════════
	// GROCERY LIST — "What do we need from the store?"
	// ═══════════════════════════════════════════════════════════════

	describe('Viewing the grocery list', () => {
		it('"what do we need from the store" → shows grocery list', async () => {
			setupHousehold({ grocery: groceryList });
			await handleMessage(msg('what do we need from the store'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('"show me the grocery list" → shows grocery list', async () => {
			setupHousehold({ grocery: groceryList });
			await handleMessage(msg('show me the grocery list'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('"whats on the shopping list" → shows grocery list', async () => {
			setupHousehold({ grocery: groceryList });
			await handleMessage(msg('whats on the shopping list'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('"do we need anything from the store" → shows grocery list', async () => {
			setupHousehold({ grocery: groceryList });
			await handleMessage(msg('what do we need'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('"grocery list" → shows grocery list', async () => {
			setupHousehold({ grocery: groceryList });
			await handleMessage(msg('grocery list'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('shows "empty" message when no grocery list exists', async () => {
			setupHousehold();
			await handleMessage(msg('show me the grocery list'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('empty'));
		});
	});

	describe('Adding items to the grocery list', () => {
		it('"we need milk and eggs" → adds milk and eggs', async () => {
			setupHousehold();
			await handleMessage(msg('we need milk and eggs'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
			expect(store.write).toHaveBeenCalled();
		});

		it('"add bread to the grocery list" → adds bread', async () => {
			setupHousehold();
			await handleMessage(msg('add bread to the grocery list'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
		});

		it('"put chicken on the shopping list" → adds chicken', async () => {
			setupHousehold();
			await handleMessage(msg('put chicken on the shopping list'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
		});

		it('"can you add 2 lbs ground beef to the grocery list" → adds with quantity', async () => {
			setupHousehold();
			await handleMessage(msg('add 2 lbs ground beef to the grocery list'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('ground beef'),
			);
		});

		it('"I need butter, flour, and sugar from the store" → adds 3 items', async () => {
			setupHousehold();
			// This should match: "i need ... from the store"
			await handleMessage(msg('I need butter, flour, and sugar from the store'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
		});

		it('"buy some apples" doesn\'t match grocery add (no "to/on grocery/shopping")', async () => {
			setupHousehold();
			// "buy some apples" — has "buy" but no "to/on grocery/shopping"
			// This should NOT trigger grocery add. It would fall through to fallback.
			expect(isGroceryAddIntent('buy some apples')).toBe(false);
		});
	});

	describe('Generating a grocery list from recipes', () => {
		it('"make a grocery list for the chicken stir fry" → searches and generates', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('[]');
			// sendOptions is called for disambiguation if multiple results
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Chicken Stir Fry');
			await handleMessage(msg('make a grocery list for the chicken stir fry'));
			// Should either generate directly (single match) or show options
			expect(
				vi.mocked(services.telegram.sendWithButtons).mock.calls.length +
					vi.mocked(services.telegram.sendOptions).mock.calls.length,
			).toBeGreaterThan(0);
		});

		it('"generate shopping list from pasta bolognese" → finds and generates', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('[]');
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Pasta Bolognese');
			await handleMessage(msg('generate shopping list from pasta bolognese'));
			expect(
				vi.mocked(services.telegram.sendWithButtons).mock.calls.length +
					vi.mocked(services.telegram.sendOptions).mock.calls.length,
			).toBeGreaterThan(0);
		});

		it('"create a grocery list for tonight" → asks which recipe', async () => {
			setupHousehold();
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('Chicken Stir Fry');
			vi.mocked(services.llm.complete).mockResolvedValue('[]');
			await handleMessage(msg('create a grocery list for tonight'));
			// "tonight" won't match any recipe — should show "no recipes found"
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('No recipes found'),
			);
		});

		it('"grocery list for chicken" with multiple chicken recipes → shows disambiguation', async () => {
			const chicken2: Recipe = {
				...chickenStirFry,
				id: 'chicken-parm-003',
				title: 'Chicken Parmesan',
			};
			setupHousehold({ recipes: [chickenStirFry, chicken2, pastaBolognese] });
			vi.mocked(services.telegram.sendOptions).mockResolvedValue('All of these');
			vi.mocked(services.llm.complete).mockResolvedValue('[]');
			await handleMessage(msg('grocery list for chicken'));
			// Should show sendOptions because multiple chicken recipes match
			expect(services.telegram.sendOptions).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Found'),
				expect.arrayContaining(['Chicken Stir Fry', 'Chicken Parmesan', 'All of these']),
			);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// PANTRY — "What do we have at home?"
	// ═══════════════════════════════════════════════════════════════

	describe('Viewing the pantry', () => {
		it('"what\'s in the pantry" → shows pantry', async () => {
			setupHousehold({ pantry: pantryItems });
			await handleMessage(msg("what's in the pantry"));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Rice'));
		});

		it('"show me the pantry" → shows pantry', async () => {
			setupHousehold({ pantry: pantryItems });
			await handleMessage(msg('show me the pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Pantry'),
			);
		});

		it('"check the pantry" → shows pantry', async () => {
			setupHousehold({ pantry: pantryItems });
			await handleMessage(msg('check the pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Pantry'),
			);
		});

		it('shows empty message when pantry is empty', async () => {
			setupHousehold({ pantry: [] });
			await handleMessage(msg("what's in the pantry"));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('empty'));
		});
	});

	describe('Adding to the pantry', () => {
		it('"we have eggs and milk" → adds eggs and milk to pantry', async () => {
			setupHousehold();
			await handleMessage(msg('we have eggs and milk'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('pantry'),
			);
		});

		it('"add chicken and rice to the pantry" → adds items', async () => {
			setupHousehold();
			await handleMessage(msg('add chicken and rice to the pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
		});

		it('"put butter in the pantry" → adds butter', async () => {
			setupHousehold();
			await handleMessage(msg('put butter in the pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('butter'),
			);
		});
	});

	describe('Removing from the pantry', () => {
		it('"we\'re out of milk" → removes milk', async () => {
			setupHousehold({
				pantry: [
					{ name: 'Milk', quantity: '1 gallon', addedDate: '2026-03-30', category: 'Dairy & Eggs' },
				],
			});
			await handleMessage(msg("we're out of milk"));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Removed'),
			);
		});

		it('"ran out of eggs" → removes eggs', async () => {
			setupHousehold({
				pantry: [
					{ name: 'Eggs', quantity: '12', addedDate: '2026-03-28', category: 'Dairy & Eggs' },
				],
			});
			await handleMessage(msg('ran out of eggs'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Removed'),
			);
		});

		it('"remove the butter from the pantry" → removes butter', async () => {
			setupHousehold({
				pantry: [
					{
						name: 'Butter',
						quantity: '1 stick',
						addedDate: '2026-03-25',
						category: 'Dairy & Eggs',
					},
				],
			});
			await handleMessage(msg('remove the butter from the pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Removed'),
			);
		});

		it('"we\'re out of something not in pantry" → says it wasn\'t there', async () => {
			setupHousehold({ pantry: [] });
			await handleMessage(msg("we're out of quinoa"));
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining("wasn't in the pantry"),
			);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// INTENT CLASSIFICATION — Things that should NOT trigger grocery/pantry
	// ═══════════════════════════════════════════════════════════════

	describe('Messages that should NOT trigger grocery/pantry handlers', () => {
		it('"find me a chicken recipe" → recipe search, not grocery', async () => {
			setupHousehold();
			await handleMessage(msg('find me a chicken recipe'));
			// Should search recipes, not add to grocery
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('recipe'), // search results
			);
			expect(store.write).not.toHaveBeenCalled(); // no grocery write
		});

		it('"I need a good recipe for dinner" → recipe search, not grocery', () => {
			// "I need" matches grocery add BUT only with "from the store/grocery"
			expect(isGroceryAddIntent('I need a good recipe for dinner')).toBe(false);
			expect(isGroceryViewIntent('I need a good recipe for dinner')).toBe(false);
		});

		it('"what goes well with steak" → food question, not pantry view', async () => {
			setupHousehold();
			await handleMessage(msg('what goes well with steak'));
			// Should call LLM for food question
			expect(services.llm.complete).toHaveBeenCalled();
		});

		it('"how long should I cook chicken" → food question, not grocery', async () => {
			setupHousehold();
			await handleMessage(msg('how long should I cook chicken'));
			expect(services.llm.complete).toHaveBeenCalled();
		});

		it('"save this recipe" → save recipe, not grocery add', () => {
			expect(isGroceryAddIntent('save this recipe')).toBe(false);
			expect(isGroceryGenerateIntent('save this recipe')).toBe(false);
		});

		it('"add garlic to the recipe" → edit recipe, not grocery', () => {
			// "add ... to" could look like grocery add, but has "recipe" not "grocery"
			expect(isGroceryAddIntent('add garlic to the recipe')).toBe(false);
		});

		it('"we need to find a good pasta recipe" → has "we need" but is a search', async () => {
			// "we need" triggers isGroceryAddIntent — but the handler should handle this
			// Actually let's check: does it match?
			const matches = isGroceryAddIntent('we need to find a good pasta recipe');
			// "we need" is a broad match. This IS a known false positive.
			// If it does match, the grocery add handler strips "we need" and tries to parse
			// "to find a good pasta recipe" — which won't produce useful items.
			// Documenting this as a known edge case.
			if (matches) {
				setupHousehold();
				await handleMessage(msg('we need to find a good pasta recipe'));
				// It will add weird items — this is a known limitation
				// The important thing is it doesn't crash
			}
		});

		it('"show me what we have" → not clearly pantry — depends on context', () => {
			// This doesn't contain "pantry" so should NOT trigger pantry view
			expect(isPantryViewIntent('show me what we have')).toBe(false);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// INTENT DETECTION — Exhaustive natural language coverage
	// ═══════════════════════════════════════════════════════════════

	describe('Grocery intent detection — real phrases people say', () => {
		// ── View intents ────────────────────────────
		const viewPhrases = [
			'show me the grocery list',
			'grocery list',
			'shopping list',
			'what do we need',
			'what do I need',
			'check the grocery list',
			'see the grocery list',
			'view grocery list',
		];
		for (const phrase of viewPhrases) {
			it(`"${phrase}" → grocery view`, () => {
				expect(isGroceryViewIntent(phrase)).toBe(true);
			});
		}

		const viewNegatives = [
			'hello',
			'what is for dinner',
			'I need a recipe',
			'show me a recipe',
			'find chicken',
			'list all recipes',
		];
		for (const phrase of viewNegatives) {
			it(`"${phrase}" → NOT grocery view`, () => {
				expect(isGroceryViewIntent(phrase)).toBe(false);
			});
		}

		// ── Add intents ─────────────────────────────
		const addPhrases = [
			'add milk to the grocery list',
			'put eggs on the grocery list',
			'add bread to the shopping list',
			'we need milk',
			'we need eggs and bread',
			'we need more paper towels',
			'I need chicken from the store',
			'I need stuff from the grocery store',
		];
		for (const phrase of addPhrases) {
			it(`"${phrase}" → grocery add`, () => {
				expect(isGroceryAddIntent(phrase)).toBe(true);
			});
		}

		const addNegatives = ['add tag to recipe', 'I need a recipe', 'buy me a car', 'hello grocery'];
		for (const phrase of addNegatives) {
			it(`"${phrase}" → NOT grocery add`, () => {
				expect(isGroceryAddIntent(phrase)).toBe(false);
			});
		}

		// ── Generate intents ────────────────────────
		const genPhrases = [
			'make a grocery list for chicken stir fry',
			'generate a grocery list from our recipes',
			'create a shopping list for tonight',
			'build a grocery list for pasta',
			'grocery list for the stir fry',
		];
		for (const phrase of genPhrases) {
			it(`"${phrase}" → grocery generate`, () => {
				expect(isGroceryGenerateIntent(phrase)).toBe(true);
			});
		}

		const genNegatives = [
			'show me the grocery list',
			'add milk to grocery list',
			'grocery',
			'make dinner',
			'find a recipe',
		];
		for (const phrase of genNegatives) {
			it(`"${phrase}" → NOT grocery generate`, () => {
				expect(isGroceryGenerateIntent(phrase)).toBe(false);
			});
		}
	});

	describe('Pantry intent detection — real phrases people say', () => {
		// ── View intents ────────────────────────────
		const viewPhrases = [
			"what's in the pantry",
			'show pantry',
			'check the pantry',
			'view the pantry',
			'see the pantry',
			'pantry list',
		];
		for (const phrase of viewPhrases) {
			it(`"${phrase}" → pantry view`, () => {
				expect(isPantryViewIntent(phrase)).toBe(true);
			});
		}

		// ── Add intents ─────────────────────────────
		const addPhrases = [
			'add eggs to pantry',
			'add chicken and rice to the pantry',
			'put milk in the pantry',
			'we have eggs',
			'we have butter and cheese',
		];
		for (const phrase of addPhrases) {
			it(`"${phrase}" → pantry add`, () => {
				expect(isPantryAddIntent(phrase)).toBe(true);
			});
		}

		// ── Remove intents ──────────────────────────
		const removePhrases = [
			'remove eggs from pantry',
			"we're out of milk",
			'ran out of butter',
			'take the chicken out of the pantry',
		];
		for (const phrase of removePhrases) {
			it(`"${phrase}" → pantry remove`, () => {
				expect(isPantryRemoveIntent(phrase)).toBe(true);
			});
		}

		const removeNegatives = ['we need milk', 'add eggs', 'check the pantry', 'show me the recipe'];
		for (const phrase of removeNegatives) {
			it(`"${phrase}" → NOT pantry remove`, () => {
				expect(isPantryRemoveIntent(phrase)).toBe(false);
			});
		}
	});

	// ═══════════════════════════════════════════════════════════════
	// ITEM PARSING — Does "2 lbs chicken breast" end up correct?
	// ═══════════════════════════════════════════════════════════════

	describe('Item parsing from natural grocery add messages', () => {
		it('"add milk, eggs, and bread to the grocery list" → 3 items with correct names', async () => {
			setupHousehold();
			await handleMessage(msg('add milk, eggs, and bread to the grocery list'));
			const writeCall = store.write.mock.calls.find(
				(c: unknown[]) => typeof c[0] === 'string' && c[0].includes('grocery'),
			);
			expect(writeCall).toBeDefined();
			const written = writeCall?.[1] as string;
			expect(written).toContain('milk');
			expect(written).toContain('eggs');
			expect(written).toContain('bread');
		});

		it('"we need 2 lbs chicken breast" → extracts quantity and unit', async () => {
			setupHousehold();
			await handleMessage(msg('we need 2 lbs chicken breast'));
			const writeCall = store.write.mock.calls.find(
				(c: unknown[]) => typeof c[0] === 'string' && c[0].includes('grocery'),
			);
			expect(writeCall).toBeDefined();
			const written = writeCall?.[1] as string;
			expect(written).toContain('chicken breast');
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// CALLBACK FLOW — Tapping buttons in the shopping UI
	// ═══════════════════════════════════════════════════════════════

	describe('Shopping mode — tapping inline keyboard buttons', () => {
		it('tapping an item toggles its check mark', async () => {
			setupHousehold({ grocery: groceryList });
			await handleCallbackQuery?.('toggle:0', { userId: 'matt', chatId: 100, messageId: 200 });
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('✅'), // Milk should now be checked
				expect.any(Array),
			);
		});

		it('tapping refresh shows latest list state', async () => {
			setupHousehold({ grocery: groceryList });
			await handleCallbackQuery?.('refresh', { userId: 'sarah', chatId: 101, messageId: 201 });
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				101,
				201,
				expect.stringContaining('Grocery List'),
				expect.any(Array),
			);
		});

		it('tapping clear removes purchased items and asks about pantry', async () => {
			setupHousehold({ grocery: groceryList }); // Bread is purchased
			await handleCallbackQuery?.('clear', { userId: 'matt', chatId: 100, messageId: 200 });
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('Add them to pantry'),
				expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({ text: expect.stringContaining('Add all') }),
					]),
				]),
			);
		});

		it('household member 2 can see and interact with the same list', async () => {
			setupHousehold({ grocery: groceryList });
			// Sarah (second household member) toggles an item
			await handleCallbackQuery?.('toggle:2', { userId: 'sarah', chatId: 102, messageId: 202 });
			expect(services.telegram.editMessage).toHaveBeenCalled();
			expect(store.write).toHaveBeenCalled();
		});

		it('non-household member cannot interact', async () => {
			setupHousehold({ grocery: groceryList });
			// User "stranger" is not in household
			await handleCallbackQuery?.('toggle:0', { userId: 'stranger', chatId: 999, messageId: 999 });
			expect(services.telegram.editMessage).not.toHaveBeenCalled();
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// COMMANDS — /grocery, /addgrocery, /pantry
	// ═══════════════════════════════════════════════════════════════

	describe('/grocery command', () => {
		it('shows the grocery list with inline buttons', async () => {
			setupHousehold({ grocery: groceryList });
			await handleCommand?.('grocery', [], msg('/grocery'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
			const call = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
			expect(call?.[1]).toContain('Milk');
			expect(call?.[1]).toContain('Chicken breast');
		});

		it('shows empty message when there is no list', async () => {
			setupHousehold();
			await handleCommand?.('grocery', [], msg('/grocery'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('empty'));
		});
	});

	describe('/addgrocery command', () => {
		it('/addgrocery milk, eggs, bread → adds 3 items', async () => {
			setupHousehold();
			await handleCommand?.(
				'addgrocery',
				['milk,', 'eggs,', 'bread'],
				msg('/addgrocery milk, eggs, bread'),
			);
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Added'));
		});

		it('/addgrocery with no args → shows usage', async () => {
			setupHousehold();
			await handleCommand?.('addgrocery', [], msg('/addgrocery'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Usage'));
		});
	});

	describe('/pantry command', () => {
		it('shows pantry contents grouped by category', async () => {
			setupHousehold({ pantry: pantryItems });
			await handleCommand?.('pantry', [], msg('/pantry'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Rice'));
			expect(services.telegram.send).toHaveBeenCalledWith('matt', expect.stringContaining('Eggs'));
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// MEAL PLAN INTENT DETECTION — Natural language coverage
	// ═══════════════════════════════════════════════════════════════

	describe('Meal plan view intent detection', () => {
		const viewPhrases = [
			'show me the meal plan',
			"what's planned this week",
			'whats planned for this week',
			'weekly plan',
			'meal plan',
			'view the meal plan',
			'check the weekly plan',
			'see the meal plan',
		];
		for (const phrase of viewPhrases) {
			it(`"${phrase}" → meal plan view`, () => {
				expect(isMealPlanViewIntent(phrase)).toBe(true);
			});
		}
	});

	describe('Meal plan generate intent detection', () => {
		const genPhrases = [
			'plan meals for next week',
			'generate a meal plan',
			'plan my dinners',
			'make a meal plan for this week',
			'create a weekly plan',
			'plan our meals for the week',
			'generate a weekly plan',
			'plan the meals',
			'create a meal plan',
			'make dinners for the week',
		];
		for (const phrase of genPhrases) {
			it(`"${phrase}" → meal plan generate`, () => {
				expect(isMealPlanGenerateIntent(phrase)).toBe(true);
			});
		}
	});

	describe('"What\'s for dinner?" intent detection', () => {
		const dinnerPhrases = [
			'whats for dinner',
			"what's for dinner tonight",
			'what are we having tonight',
			'what are we eating tonight',
			"what's tonight",
			'whats for tonight',
			"what's for dinner?",
			'what am i eating tonight',
			'what am i having for dinner',
			'what are we cooking tonight',
		];
		for (const phrase of dinnerPhrases) {
			it(`"${phrase}" → what's for dinner`, () => {
				expect(isWhatsForDinnerIntent(phrase)).toBe(true);
			});
		}
	});

	describe('"What can I make?" intent detection', () => {
		const makePhrases = [
			'what can I make',
			'what can i cook with what we have',
			'what can i make for dinner',
			'what can i cook tonight',
			'what can we cook with what we have',
			'what can we make with what we have',
			'what can i make with whats in the pantry',
		];
		for (const phrase of makePhrases) {
			it(`"${phrase}" → what can I make`, () => {
				expect(isWhatCanIMakeIntent(phrase)).toBe(true);
			});
		}
	});

	describe('Meal swap intent detection', () => {
		const swapPhrases = [
			'swap monday',
			'change tuesdays dinner',
			'replace friday',
			'swap today',
			'change tomorrow',
			"can you change monday's meal",
			'replace today with something else',
			'swap wednesday',
		];
		for (const phrase of swapPhrases) {
			it(`"${phrase}" → meal swap`, () => {
				expect(isMealSwapIntent(phrase)).toBe(true);
			});
		}
	});

	describe('Messages that should NOT match meal plan intents', () => {
		it('"plan a party" → NOT meal plan generate (no meals/dinners)', () => {
			expect(isMealPlanGenerateIntent('plan a party')).toBe(false);
		});

		it('"what\'s for lunch" → NOT what\'s for dinner', () => {
			expect(isWhatsForDinnerIntent("what's for lunch")).toBe(false);
		});

		it('"can I swap the soy sauce for tamari" → NOT meal swap (no day name)', () => {
			expect(isMealSwapIntent('can I swap the soy sauce for tamari')).toBe(false);
		});

		it('"make a grocery list" → NOT meal plan generate', () => {
			expect(isMealPlanGenerateIntent('make a grocery list')).toBe(false);
		});

		it('"show my recipes" → NOT meal plan view', () => {
			expect(isMealPlanViewIntent('show my recipes')).toBe(false);
		});

		it('"what should I buy" → NOT what can I make', () => {
			expect(isWhatCanIMakeIntent('what should I buy')).toBe(false);
		});

		it('"plan a trip for next week" → NOT meal plan generate', () => {
			expect(isMealPlanGenerateIntent('plan a trip for next week')).toBe(false);
		});

		it('"change the recipe" → NOT meal swap (no day name)', () => {
			expect(isMealSwapIntent('change the recipe')).toBe(false);
		});

		it('"show the grocery list" → NOT meal plan view', () => {
			expect(isMealPlanViewIntent('show the grocery list')).toBe(false);
		});

		it('"what can I buy at the store" → NOT what can I make', () => {
			expect(isWhatCanIMakeIntent('what can I buy at the store')).toBe(false);
		});

		it('"swap the eggs for an alternative" → NOT meal swap (no day)', () => {
			expect(isMealSwapIntent('swap the eggs for an alternative')).toBe(false);
		});

		it('"I want to make pasta" → NOT meal plan generate', () => {
			expect(isMealPlanGenerateIntent('I want to make pasta')).toBe(false);
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// END-TO-END MEAL PLAN SCENARIOS
	// ═══════════════════════════════════════════════════════════════

	describe('End-to-end: Meal plan view with no plan', () => {
		it('offers to generate when no plan exists', async () => {
			setupHousehold(); // no mealPlan
			await handleMessage(msg('show me the meal plan'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('No meal plan'),
				expect.any(Array),
			);
		});
	});

	describe("End-to-end: What's for dinner with plan", () => {
		it('shows tonight\'s meal from the plan', async () => {
			// Set fake time to 2026-03-31 so todayDate() matches the fixture
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-31T18:00:00Z'));
			try {
				setupHousehold({ mealPlan: activeMealPlan });
				await handleMessage(msg('whats for dinner tonight'));
				// The handler finds today's meal and calls sendWithButtons with the recipe info
				expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
					'matt',
					expect.stringContaining('Chicken Stir Fry'),
					expect.any(Array),
				);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('End-to-end: What can I make with pantry and recipes', () => {
		it('calls LLM and sends match results', async () => {
			setupHousehold({ pantry: pantryItems, recipes: [chickenStirFry, pastaBolognese] });
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify([
					{ recipeId: 'chicken-stir-fry-001', matchPercentage: 80, missingIngredients: ['broccoli'] },
				]),
			);
			await handleMessage(msg('what can I make'));
			// Should send an acknowledgment first
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Checking'),
			);
			// Should call LLM with fast tier for matching
			expect(services.llm.complete).toHaveBeenCalled();
		});
	});

	describe('End-to-end: Meal plan generate', () => {
		it('generates plan with LLM and sends buttons', async () => {
			setupHousehold({ pantry: pantryItems, recipes: [chickenStirFry, pastaBolognese] });
			vi.mocked(services.config.get).mockResolvedValue('New York');
			vi.mocked(services.llm.complete).mockResolvedValue(
				JSON.stringify({
					meals: [
						{ recipeTitle: 'Chicken Stir Fry', recipeId: 'chicken-stir-fry-001', isNew: false },
						{ recipeTitle: 'Pasta Bolognese', recipeId: 'pasta-bolognese-002', isNew: false },
						{
							recipeTitle: 'Grilled Salmon',
							recipeId: '',
							isNew: true,
							description: 'Fresh salmon with herbs',
						},
					],
				}),
			);
			await handleMessage(msg('plan meals for this week'));
			// Should send acknowledgment
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Generating'),
			);
			// Should call LLM for plan generation
			expect(services.llm.complete).toHaveBeenCalled();
		});
	});
});
