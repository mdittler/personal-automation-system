import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	EDITABLE_RECIPE_FIELDS,
	findRecipeByTitle,
	formatRecipe,
	formatSearchResults,
	listRecipeIds,
	loadAllRecipes,
	loadRecipe,
	saveRecipe,
	searchRecipes,
	slugify,
	updateRecipe,
} from '../services/recipe-store.js';
import type { ParsedRecipe, Recipe, RecipeSearchResult } from '../types.js';

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

const sampleParsed: ParsedRecipe = {
	title: 'Chicken Stir Fry',
	source: 'homemade',
	ingredients: [
		{ name: 'chicken breast', quantity: 1, unit: 'lb' },
		{ name: 'broccoli', quantity: 2, unit: 'cups' },
		{ name: 'soy sauce', quantity: 3, unit: 'tbsp' },
	],
	instructions: ['Cut chicken', 'Stir fry vegetables', 'Add sauce'],
	servings: 4,
	prepTime: 15,
	cookTime: 10,
	tags: ['easy', 'weeknight', 'healthy'],
	cuisine: 'Chinese',
	macros: { calories: 350, protein: 30, carbs: 15, fat: 12 },
	allergens: ['soy'],
};

function makeSampleRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'chicken-stir-fry-abc123',
		title: 'Chicken Stir Fry',
		source: 'homemade',
		ingredients: sampleParsed.ingredients,
		instructions: sampleParsed.instructions,
		servings: 4,
		prepTime: 15,
		cookTime: 10,
		tags: ['easy', 'weeknight', 'healthy'],
		cuisine: 'Chinese',
		macros: { calories: 350, protein: 30, carbs: 15, fat: 12 },
		ratings: [],
		history: [],
		allergens: ['soy'],
		status: 'confirmed',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('slugify', () => {
	it('converts title to slug', () => {
		expect(slugify('Chicken Stir Fry')).toBe('chicken-stir-fry');
	});

	it('handles special characters', () => {
		expect(slugify("Mom's Best Mac & Cheese!")).toBe('mom-s-best-mac-cheese');
	});

	it('truncates long titles', () => {
		const long = 'a'.repeat(100);
		expect(slugify(long).length).toBeLessThanOrEqual(60);
	});

	it('handles empty string with fallback', () => {
		const result = slugify('');
		expect(result).toMatch(/^recipe-/);
	});

	it('handles path traversal attempt safely', () => {
		const result = slugify('../../etc/passwd');
		// Dots and slashes are stripped, result is a safe slug
		expect(result).not.toContain('..');
		expect(result).not.toContain('/');
	});

	it('handles all-special-chars input', () => {
		const result = slugify('!!!@@@###');
		expect(result).toMatch(/^recipe-/);
	});

	it('handles unicode/emoji input', () => {
		const result = slugify('🍕🍔🌮');
		expect(result).toMatch(/^recipe-/);
	});
});

describe('Recipe Store', () => {
	let store: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		store = createMockScopedStore();
	});

	describe('saveRecipe', () => {
		it('saves a parsed recipe as draft', async () => {
			const recipe = await saveRecipe(store as any, sampleParsed, 'user1');
			expect(recipe.status).toBe('draft');
			expect(recipe.title).toBe('Chicken Stir Fry');
			expect(recipe.id).toMatch(/^chicken-stir-fry-/);
			expect(recipe.ingredients).toHaveLength(3);
			expect(store.write).toHaveBeenCalledWith(
				expect.stringMatching(/^recipes\/chicken-stir-fry-.*\.yaml$/),
				expect.any(String),
			);
		});

		it('generates unique IDs', async () => {
			const r1 = await saveRecipe(store as any, sampleParsed, 'user1');
			const r2 = await saveRecipe(store as any, sampleParsed, 'user1');
			expect(r1.id).not.toBe(r2.id);
		});

		it('preserves all parsed fields', async () => {
			const recipe = await saveRecipe(store as any, sampleParsed, 'user1');
			expect(recipe.cuisine).toBe('Chinese');
			expect(recipe.macros?.calories).toBe(350);
			expect(recipe.allergens).toEqual(['soy']);
			expect(recipe.tags).toEqual(['easy', 'weeknight', 'healthy']);
		});
	});

	describe('loadRecipe', () => {
		it('loads a recipe by ID', async () => {
			const recipe = makeSampleRecipe();
			store.read.mockResolvedValue(stringify(recipe));
			const loaded = await loadRecipe(store as any, recipe.id);
			expect(loaded).toBeDefined();
			expect(loaded?.title).toBe('Chicken Stir Fry');
		});

		it('returns null for missing recipe', async () => {
			store.read.mockResolvedValue('');
			const loaded = await loadRecipe(store as any, 'nonexistent');
			expect(loaded).toBeNull();
		});
	});

	describe('updateRecipe', () => {
		it('writes updated recipe with new updatedAt', async () => {
			const recipe = makeSampleRecipe();
			const before = recipe.updatedAt;
			await updateRecipe(store as any, recipe);
			expect(store.write).toHaveBeenCalledWith(`recipes/${recipe.id}.yaml`, expect.any(String));
			expect(recipe.updatedAt).not.toBe(before);
		});
	});

	describe('listRecipeIds', () => {
		it('lists YAML files as IDs', async () => {
			store.list.mockResolvedValue(['chicken-stir-fry.yaml', 'lasagna.yaml']);
			const ids = await listRecipeIds(store as any);
			expect(ids).toEqual(['chicken-stir-fry', 'lasagna']);
		});

		it('filters non-YAML files', async () => {
			store.list.mockResolvedValue(['recipe.yaml', 'photo.jpg']);
			const ids = await listRecipeIds(store as any);
			expect(ids).toEqual(['recipe']);
		});

		it('returns empty for empty directory', async () => {
			store.list.mockResolvedValue([]);
			const ids = await listRecipeIds(store as any);
			expect(ids).toEqual([]);
		});
	});

	describe('loadAllRecipes', () => {
		it('loads all recipes from directory', async () => {
			const r1 = makeSampleRecipe({ id: 'r1', title: 'Recipe 1' });
			const r2 = makeSampleRecipe({ id: 'r2', title: 'Recipe 2' });
			store.list.mockResolvedValue(['r1.yaml', 'r2.yaml']);
			store.read.mockResolvedValueOnce(stringify(r1)).mockResolvedValueOnce(stringify(r2));
			const recipes = await loadAllRecipes(store as any);
			expect(recipes).toHaveLength(2);
		});

		it('skips recipes that fail to load', async () => {
			store.list.mockResolvedValue(['r1.yaml', 'r2.yaml']);
			store.read
				.mockResolvedValueOnce(stringify(makeSampleRecipe({ id: 'r1' })))
				.mockResolvedValueOnce('');
			const recipes = await loadAllRecipes(store as any);
			expect(recipes).toHaveLength(1);
		});
	});
});

describe('searchRecipes', () => {
	const recipes = [
		makeSampleRecipe({
			id: 'r1',
			title: 'Chicken Stir Fry',
			ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
			tags: ['easy', 'weeknight'],
			cuisine: 'Chinese',
			macros: { calories: 350, protein: 30 },
		}),
		makeSampleRecipe({
			id: 'r2',
			title: 'Beef Lasagna',
			ingredients: [{ name: 'ground beef', quantity: 2, unit: 'lbs' }],
			tags: ['comfort-food', 'italian'],
			cuisine: 'Italian',
			macros: { calories: 500, protein: 25 },
			ratings: [{ userId: 'u1', score: 5, date: '2026-01-01' }],
		}),
		makeSampleRecipe({
			id: 'r3',
			title: 'Veggie Pasta',
			ingredients: [{ name: 'pasta', quantity: 1, unit: 'lb' }],
			tags: ['healthy', 'quick'],
			cuisine: 'Italian',
			macros: { calories: 300, protein: 12 },
			ratings: [{ userId: 'u1', score: 3, date: '2026-01-01' }],
			status: 'draft',
		}),
		makeSampleRecipe({
			id: 'r4',
			title: 'Old Recipe',
			ingredients: [{ name: 'old stuff', quantity: 1, unit: 'cup' }],
			status: 'archived',
		}),
	];

	it('searches by text in title', () => {
		const results = searchRecipes(recipes, { text: 'chicken' });
		expect(results).toHaveLength(1);
		expect(results[0].recipe.title).toBe('Chicken Stir Fry');
	});

	it('searches by ingredient', () => {
		const results = searchRecipes(recipes, { text: 'beef' });
		expect(results).toHaveLength(1);
		expect(results[0]?.recipe.title).toBe('Beef Lasagna');
	});

	it('searches by cuisine', () => {
		const results = searchRecipes(recipes, { cuisine: 'Italian' });
		expect(results).toHaveLength(2); // Lasagna and Veggie Pasta
	});

	it('filters by tag', () => {
		const results = searchRecipes(recipes, { tags: ['easy'] });
		expect(results).toHaveLength(1);
		expect(results[0].recipe.title).toBe('Chicken Stir Fry');
	});

	it('filters by minimum rating', () => {
		const results = searchRecipes(recipes, { minRating: 4 });
		expect(results).toHaveLength(1);
		expect(results[0].recipe.title).toBe('Beef Lasagna');
	});

	it('filters by protein', () => {
		const results = searchRecipes(recipes, { minProtein: 28 });
		expect(results).toHaveLength(1);
		expect(results[0].recipe.title).toBe('Chicken Stir Fry');
	});

	it('excludes archived recipes', () => {
		const results = searchRecipes(recipes, { text: 'Old' });
		expect(results).toHaveLength(0);
	});

	it('respects limit', () => {
		const results = searchRecipes(recipes, { text: 'a', limit: 1 });
		expect(results.length).toBeLessThanOrEqual(1);
	});

	it('returns empty for no matches', () => {
		const results = searchRecipes(recipes, { text: 'sushi' });
		expect(results).toHaveLength(0);
	});

	it('filters by maxDaysSinceCooked', () => {
		const recentlyCooked = makeSampleRecipe({
			id: 'r5',
			title: 'Recent Dish',
			history: [{ date: new Date().toISOString(), cookedBy: 'u1', servings: 4 }],
		});
		const neverCooked = makeSampleRecipe({
			id: 'r6',
			title: 'Never Cooked Dish',
			history: [],
		});
		const results = searchRecipes([recentlyCooked, neverCooked], { maxDaysSinceCooked: 30 });
		// Only neverCooked should pass (daysSince = Infinity > 30)
		expect(results).toHaveLength(1);
		expect(results[0].recipe.title).toBe('Never Cooked Dish');
	});

	it('combines text and tag filters', () => {
		const results = searchRecipes(recipes, { text: 'stir', tags: ['easy'] });
		expect(results).toHaveLength(1);
	});
});

describe('formatRecipe', () => {
	it('formats brief view', () => {
		const recipe = makeSampleRecipe();
		const text = formatRecipe(recipe, true);
		expect(text).toContain('Chicken Stir Fry');
		expect(text).toContain('Chinese');
		expect(text).toContain('Servings: 4');
		expect(text).not.toContain('Ingredients:');
	});

	it('formats full view with ingredients and instructions', () => {
		const recipe = makeSampleRecipe();
		const text = formatRecipe(recipe);
		expect(text).toContain('Ingredients:');
		expect(text).toContain('chicken breast');
		expect(text).toContain('Instructions:');
		expect(text).toContain('Cut chicken');
	});

	it('shows draft status', () => {
		const recipe = makeSampleRecipe({ status: 'draft' });
		const text = formatRecipe(recipe, true);
		expect(text).toContain('(draft)');
	});

	it('shows ratings', () => {
		const recipe = makeSampleRecipe({
			ratings: [
				{ userId: 'u1', score: 4, date: '2026-01-01' },
				{ userId: 'u2', score: 5, date: '2026-01-01' },
			],
		});
		const text = formatRecipe(recipe, true);
		expect(text).toContain('4.5/5');
		expect(text).toContain('2 ratings');
	});

	it('shows macros in full view', () => {
		const recipe = makeSampleRecipe();
		const text = formatRecipe(recipe);
		expect(text).toContain('350 cal');
		expect(text).toContain('30g protein');
	});

	it('handles recipe without macros', () => {
		const recipe = makeSampleRecipe({ macros: undefined });
		const text = formatRecipe(recipe);
		expect(text).not.toContain('Macros');
	});

	it('handles recipe without timing', () => {
		const recipe = makeSampleRecipe({ prepTime: undefined, cookTime: undefined });
		const text = formatRecipe(recipe, true);
		expect(text).not.toContain('Time:');
	});

	it('escapes Markdown control characters in dynamic fields', () => {
		const recipe = makeSampleRecipe({
			title: "Mom's *Best* Recipe",
			cuisine: 'Thai_fusion',
			tags: ['kid_friendly', 'quick*easy'],
			ingredients: [
				{
					name: 'sugar [brown]',
					quantity: 1,
					unit: 'cup',
					notes: 'use `raw` if possible',
				},
			],
			instructions: ['Stir *vigorously* for _5 min_'],
		});

		const text = formatRecipe(recipe);

		// Data fields should be escaped
		expect(text).toContain("\\*Best\\*");
		expect(text).toContain('Thai\\_fusion');
		expect(text).toContain('kid\\_friendly');
		expect(text).toContain('quick\\*easy');
		expect(text).toContain('sugar \\[brown\\]');
		expect(text).toContain('use \\`raw\\` if possible');
		expect(text).toContain('Stir \\*vigorously\\*');
		expect(text).toContain('\\_5 min\\_');
		// Intentional formatting markers should still be present
		// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
		// mismatch deferred to Finding 21. Only assert data-field escaping here.
	});
});

describe('formatSearchResults', () => {
	it('formats empty results', () => {
		expect(formatSearchResults([])).toBe('No recipes found.');
	});

	it('formats results with count', () => {
		const results: RecipeSearchResult[] = [
			{ recipe: makeSampleRecipe(), relevance: 'title match' },
		];
		const text = formatSearchResults(results);
		expect(text).toContain('Found 1 recipe(s)');
		expect(text).toContain('Chicken Stir Fry');
	});

	it('shows draft status in results', () => {
		const results: RecipeSearchResult[] = [
			{ recipe: makeSampleRecipe({ status: 'draft' }), relevance: 'match' },
		];
		const text = formatSearchResults(results);
		expect(text).toContain('[draft]');
	});

	it('shows rating in results', () => {
		const results: RecipeSearchResult[] = [
			{
				recipe: makeSampleRecipe({
					ratings: [{ userId: 'u1', score: 4, date: '2026-01-01' }],
				}),
				relevance: 'match',
			},
		];
		const text = formatSearchResults(results);
		expect(text).toContain('★4.0');
	});
});

describe('findRecipeByTitle', () => {
	const recipes = [
		makeSampleRecipe({ title: 'Chicken Stir Fry' }),
		makeSampleRecipe({ title: 'Beef Lasagna' }),
	];

	it('finds by exact match (case-insensitive)', () => {
		const found = findRecipeByTitle(recipes, 'chicken stir fry');
		expect(found).toBeDefined();
		expect(found?.title).toBe('Chicken Stir Fry');
	});

	it('finds by partial match', () => {
		const found = findRecipeByTitle(recipes, 'lasagna');
		expect(found).toBeDefined();
		expect(found?.title).toBe('Beef Lasagna');
	});

	it('returns undefined for no match', () => {
		const found = findRecipeByTitle(recipes, 'sushi');
		expect(found).toBeUndefined();
	});

	it('prefers exact match over partial', () => {
		const extended = [...recipes, makeSampleRecipe({ title: 'Chicken' })];
		const found = findRecipeByTitle(extended, 'Chicken');
		expect(found?.title).toBe('Chicken');
	});
});

describe('EDITABLE_RECIPE_FIELDS whitelist', () => {
	it('includes standard editable fields', () => {
		expect(EDITABLE_RECIPE_FIELDS).toContain('title');
		expect(EDITABLE_RECIPE_FIELDS).toContain('ingredients');
		expect(EDITABLE_RECIPE_FIELDS).toContain('tags');
	});

	it('excludes id, status, createdAt, updatedAt, ratings, history', () => {
		const fields = EDITABLE_RECIPE_FIELDS as readonly string[];
		expect(fields).not.toContain('id');
		expect(fields).not.toContain('status');
		expect(fields).not.toContain('createdAt');
		expect(fields).not.toContain('updatedAt');
		expect(fields).not.toContain('ratings');
		expect(fields).not.toContain('history');
	});
});

describe('loadRecipe — error handling', () => {
	it('returns null for malformed YAML', async () => {
		const store = createMockScopedStore();
		store.read.mockResolvedValue('{{{{not yaml!!! [[[');
		const result = await loadRecipe(store as any, 'bad-recipe');
		expect(result).toBeNull();
	});
});

describe('saveRecipe — frontmatter', () => {
	it('saves recipe with frontmatter header', async () => {
		const store = createMockScopedStore();
		await saveRecipe(store as any, sampleParsed, 'user1');
		const written = store.write.mock.calls[0][1] as string;
		expect(written).toMatch(/^---\n/);
		expect(written).toContain('title: Chicken Stir Fry');
	});
});

describe('loadRecipe — frontmatter handling', () => {
	it('strips frontmatter before parsing', async () => {
		const store = createMockScopedStore();
		const recipe = makeSampleRecipe();
		store.read.mockResolvedValue(
			'---\ntitle: Chicken Stir Fry\ndate: 2026-01-01\n---\n' + stringify(recipe),
		);
		const loaded = await loadRecipe(store as any, recipe.id);
		expect(loaded).toBeDefined();
		expect(loaded?.title).toBe('Chicken Stir Fry');
	});
});

describe('formatSearchResults — numbered', () => {
	it('uses numbered list instead of bullets', () => {
		const results: RecipeSearchResult[] = [
			{ recipe: makeSampleRecipe({ title: 'First' }), relevance: 'match' },
			{ recipe: makeSampleRecipe({ title: 'Second' }), relevance: 'match' },
		];
		const text = formatSearchResults(results);
		expect(text).toContain('1. **First**');
		expect(text).toContain('2. **Second**');
		expect(text).not.toContain('•');
	});

	it('includes footer prompt', () => {
		const results: RecipeSearchResult[] = [
			{ recipe: makeSampleRecipe(), relevance: 'match' },
		];
		const text = formatSearchResults(results);
		expect(text).toContain('Reply with a number');
	});

	it('escapes Markdown control characters in search result titles', () => {
		const results: RecipeSearchResult[] = [
			{
				recipe: makeSampleRecipe({ title: "Mom's *Best* Recipe" }),
				relevance: 'exact_match',
			},
		];

		const text = formatSearchResults(results);

		expect(text).toContain("\\*Best\\*");
		// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
		// mismatch deferred to Finding 21. Only assert data-field escaping here.
	});
});
