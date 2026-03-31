/**
 * Recipe store — CRUD operations and search for the recipe library.
 *
 * Recipes are stored as individual YAML files in shared scope:
 * data/users/shared/hearthstone/recipes/<id>.yaml
 */

import type { ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { ParsedRecipe, Recipe, RecipeSearchQuery, RecipeSearchResult } from '../types.js';
import { generateId, isoNow } from '../utils/date.js';

const RECIPES_DIR = 'recipes';

/** Fields that can be updated via recipe edit. Excludes id, status, createdAt, updatedAt, ratings, history. */
export const EDITABLE_RECIPE_FIELDS = [
	'title', 'source', 'ingredients', 'instructions', 'servings',
	'prepTime', 'cookTime', 'tags', 'cuisine', 'macros', 'allergens',
	'householdNotes', 'kidAdaptation', 'scalingNotes', 'costEstimate',
] as const;

/** Create a slug from a recipe title for the filename. */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60);

	// Reject path traversal or empty results
	if (!slug || slug.includes('..')) {
		return `recipe-${generateId()}`;
	}
	return slug;
}

/** Build the file path for a recipe. */
function recipePath(id: string): string {
	return `${RECIPES_DIR}/${id}.yaml`;
}

/** Save a new recipe from parsed LLM output. Returns the saved recipe. */
export async function saveRecipe(
	store: ScopedDataStore,
	parsed: ParsedRecipe,
	_userId: string,
): Promise<Recipe> {
	const id = `${slugify(parsed.title)}-${generateId()}`;
	const now = isoNow();

	const recipe: Recipe = {
		id,
		title: parsed.title,
		source: parsed.source,
		ingredients: parsed.ingredients,
		instructions: parsed.instructions,
		servings: parsed.servings,
		prepTime: parsed.prepTime,
		cookTime: parsed.cookTime,
		tags: parsed.tags,
		cuisine: parsed.cuisine,
		macros: parsed.macros,
		ratings: [],
		history: [],
		allergens: parsed.allergens,
		status: 'draft',
		createdAt: now,
		updatedAt: now,
	};

	const fm = generateFrontmatter({
		title: recipe.title,
		date: recipe.createdAt,
		tags: buildAppTags('hearthstone', 'recipe', recipe.tags),
		app: 'hearthstone',
	});
	await store.write(recipePath(id), fm + stringify(recipe));
	return recipe;
}

/** Load a single recipe by ID. */
export async function loadRecipe(store: ScopedDataStore, id: string): Promise<Recipe | null> {
	const raw = await store.read(recipePath(id));
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as Recipe;
	} catch {
		return null;
	}
}

/** Update an existing recipe. */
export async function updateRecipe(store: ScopedDataStore, recipe: Recipe): Promise<void> {
	recipe.updatedAt = isoNow();
	const fm = generateFrontmatter({
		title: recipe.title,
		date: recipe.createdAt,
		tags: buildAppTags('hearthstone', 'recipe', recipe.tags),
		app: 'hearthstone',
	});
	await store.write(recipePath(recipe.id), fm + stringify(recipe));
}

/** List all recipe IDs by reading the recipes directory. */
export async function listRecipeIds(store: ScopedDataStore): Promise<string[]> {
	const entries = await store.list(RECIPES_DIR);
	return entries
		.filter((e: string) => e.endsWith('.yaml'))
		.map((e: string) => e.replace('.yaml', ''));
}

/** Load all recipes. */
export async function loadAllRecipes(store: ScopedDataStore): Promise<Recipe[]> {
	const ids = await listRecipeIds(store);
	const recipes: Recipe[] = [];
	for (const id of ids) {
		const recipe = await loadRecipe(store, id);
		if (recipe) recipes.push(recipe);
	}
	return recipes;
}

/**
 * Search recipes by various criteria.
 * This is the local (non-LLM) search — fast and free.
 */
export function searchRecipes(recipes: Recipe[], query: RecipeSearchQuery): RecipeSearchResult[] {
	const results: RecipeSearchResult[] = [];
	const limit = query.limit ?? 10;

	for (const recipe of recipes) {
		if (recipe.status === 'archived') continue;

		const reasons: string[] = [];

		// Text search (title, ingredients, cuisine, tags)
		if (query.text) {
			const q = query.text.toLowerCase();
			const titleMatch = recipe.title.toLowerCase().includes(q);
			const ingredientMatch = recipe.ingredients.some((i) => i.name.toLowerCase().includes(q));
			const cuisineMatch = recipe.cuisine?.toLowerCase().includes(q);
			const tagMatch = recipe.tags.some((t) => t.toLowerCase().includes(q));

			if (titleMatch) reasons.push('title match');
			else if (ingredientMatch) reasons.push('ingredient match');
			else if (cuisineMatch) reasons.push('cuisine match');
			else if (tagMatch) reasons.push('tag match');
			else continue; // no match
		}

		// Tag filter
		if (query.tags?.length) {
			const hasAllTags = query.tags.every((t) =>
				recipe.tags.some((rt) => rt.toLowerCase() === t.toLowerCase()),
			);
			if (!hasAllTags) continue;
			reasons.push('tags match');
		}

		// Cuisine filter
		if (query.cuisine) {
			if (!recipe.cuisine || !recipe.cuisine.toLowerCase().includes(query.cuisine.toLowerCase())) {
				continue;
			}
			reasons.push('cuisine match');
		}

		// Rating filter
		if (query.minRating) {
			const avgRating = recipe.ratings.length
				? recipe.ratings.reduce((sum, r) => sum + r.score, 0) / recipe.ratings.length
				: 0;
			if (avgRating < query.minRating) continue;
			reasons.push(`avg rating ${avgRating.toFixed(1)}`);
		}

		// History filter (not cooked recently)
		if (query.maxDaysSinceCooked) {
			const lastEntry = recipe.history[recipe.history.length - 1];
			const lastCooked = lastEntry ? new Date(lastEntry.date).getTime() : 0;
			const daysSince = lastCooked
				? (Date.now() - lastCooked) / (1000 * 60 * 60 * 24)
				: Number.POSITIVE_INFINITY;
			if (daysSince < query.maxDaysSinceCooked) continue;
			reasons.push(
				lastCooked === 0 ? 'never cooked' : `not cooked in ${Math.floor(daysSince)} days`,
			);
		}

		// Protein filter
		if (query.minProtein) {
			if (!recipe.macros?.protein || recipe.macros.protein < query.minProtein) {
				continue;
			}
			reasons.push(`${recipe.macros.protein}g protein`);
		}

		results.push({
			recipe,
			relevance: reasons.join(', ') || 'match',
		});

		if (results.length >= limit) break;
	}

	return results;
}

/**
 * Format a recipe for display in Telegram.
 */
export function formatRecipe(recipe: Recipe, brief?: boolean): string {
	const lines: string[] = [];
	const status = recipe.status === 'draft' ? ' (draft)' : '';
	lines.push(`**${recipe.title}**${status}`);

	if (recipe.cuisine) lines.push(`Cuisine: ${recipe.cuisine}`);

	const time: string[] = [];
	if (recipe.prepTime) time.push(`prep ${recipe.prepTime}min`);
	if (recipe.cookTime) time.push(`cook ${recipe.cookTime}min`);
	if (time.length) lines.push(`Time: ${time.join(', ')}`);

	lines.push(`Servings: ${recipe.servings}`);

	if (recipe.tags.length) lines.push(`Tags: ${recipe.tags.join(', ')}`);

	if (recipe.ratings.length) {
		const avg = recipe.ratings.reduce((s, r) => s + r.score, 0) / recipe.ratings.length;
		lines.push(`Rating: ${avg.toFixed(1)}/5 (${recipe.ratings.length} ratings)`);
	}

	if (brief) return lines.join('\n');

	// Full format
	lines.push('');
	lines.push('**Ingredients:**');
	for (const ing of recipe.ingredients) {
		const qty = ing.quantity != null ? `${ing.quantity}` : '';
		const unit = ing.unit ?? '';
		const prefix = [qty, unit].filter(Boolean).join(' ');
		const note = ing.notes ? ` (${ing.notes})` : '';
		lines.push(`• ${prefix ? `${prefix} ` : ''}${ing.name}${note}`);
	}

	lines.push('');
	lines.push('**Instructions:**');
	recipe.instructions.forEach((step, i) => {
		lines.push(`${i + 1}. ${step}`);
	});

	if (recipe.macros) {
		lines.push('');
		const m = recipe.macros;
		const parts: string[] = [];
		if (m.calories) parts.push(`${m.calories} cal`);
		if (m.protein) parts.push(`${m.protein}g protein`);
		if (m.carbs) parts.push(`${m.carbs}g carbs`);
		if (m.fat) parts.push(`${m.fat}g fat`);
		if (m.fiber) parts.push(`${m.fiber}g fiber`);
		if (parts.length) lines.push(`Macros (per serving): ${parts.join(', ')}`);
	}

	return lines.join('\n');
}

/**
 * Format a list of search results for display.
 */
export function formatSearchResults(results: RecipeSearchResult[]): string {
	if (!results.length) return 'No recipes found.';

	const lines = [`Found ${results.length} recipe(s):\n`];
	for (let i = 0; i < results.length; i++) {
		const entry = results[i];
		if (!entry) continue;
		const { recipe, relevance } = entry;
		const status = recipe.status === 'draft' ? ' [draft]' : '';
		const rating = recipe.ratings.length
			? ` ★${(recipe.ratings.reduce((s: number, r: { score: number }) => s + r.score, 0) / recipe.ratings.length).toFixed(1)}`
			: '';
		lines.push(`${i + 1}. **${recipe.title}**${status}${rating} — ${relevance}`);
	}
	lines.push('\nReply with a number to see the full recipe.');
	return lines.join('\n');
}

/**
 * Find a recipe by fuzzy title match.
 */
export function findRecipeByTitle(recipes: Recipe[], query: string): Recipe | undefined {
	const q = query.toLowerCase().trim();
	// Exact match first
	const exact = recipes.find((r) => r.title.toLowerCase() === q);
	if (exact) return exact;
	// Partial match
	return recipes.find((r) => r.title.toLowerCase().includes(q));
}
