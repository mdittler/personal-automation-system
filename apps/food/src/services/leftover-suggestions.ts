import type { Leftover, Recipe } from '../types.js';

const IGNORED_TOKENS = new Set([
	'leftover',
	'leftovers',
	'the',
	'for',
	'and',
	'with',
	'its',
	'are',
	'has',
	'was',
	'not',
	'but',
]);

export interface LeftoverRecipeSuggestion {
	recipe: Recipe;
	score: number;
	matchedTokens: string[];
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length >= 3 && !IGNORED_TOKENS.has(token));
}

function buildRecipeSearchText(recipe: Recipe): string {
	const ingredientTerms = recipe.ingredients.map((ingredient) =>
		(ingredient.canonicalName ?? ingredient.name).toLowerCase(),
	);
	return [recipe.title.toLowerCase(), ...ingredientTerms].join(' ');
}

export function collectLeftoverSuggestionTokens(leftovers: Leftover[]): string[] {
	return Array.from(
		new Set(
			leftovers
				.filter((leftover) => leftover.status === 'active')
				.flatMap((leftover) => tokenize(leftover.name)),
		),
	);
}

export function findLeftoverRecipeSuggestions(
	leftovers: Leftover[],
	recipes: Recipe[],
	limit = 3,
): LeftoverRecipeSuggestion[] {
	const tokens = collectLeftoverSuggestionTokens(leftovers);
	if (tokens.length === 0) return [];

	return recipes
		.filter((recipe) => recipe.status !== 'archived')
		.map((recipe) => {
			const recipeText = buildRecipeSearchText(recipe);
			const matchedTokens = tokens.filter((token) => recipeText.includes(token));
			return {
				recipe,
				score: matchedTokens.length,
				matchedTokens,
			};
		})
		.filter((suggestion) => suggestion.score > 0)
		.sort((a, b) => b.score - a.score || a.recipe.title.localeCompare(b.recipe.title))
		.slice(0, limit);
}
