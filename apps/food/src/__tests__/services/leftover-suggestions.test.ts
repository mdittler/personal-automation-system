import { describe, expect, it } from 'vitest';
import {
	collectLeftoverSuggestionTokens,
	findLeftoverRecipeSuggestions,
} from '../../services/leftover-suggestions.js';
import type { Leftover, Recipe } from '../../types.js';

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'Leftover chili rice',
		quantity: '2 servings',
		fromRecipe: 'Chili Night',
		storedDate: '2026-04-20',
		expiryEstimate: '2026-04-23',
		status: 'active',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'recipe-1',
		title: 'Chili Rice Bowl',
		source: 'family',
		ingredients: [
			{ name: 'chili', quantity: 1, unit: 'cup' },
			{ name: 'rice', quantity: 2, unit: 'cups' },
		],
		instructions: ['Mix', 'Heat'],
		servings: 4,
		prepTime: 10,
		cookTime: 20,
		tags: [],
		ratings: [],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-04-01T00:00:00.000Z',
		updatedAt: '2026-04-01T00:00:00.000Z',
		...overrides,
	};
}

describe('leftover suggestions', () => {
	it('collects distinct active leftover tokens and drops generic words', () => {
		const tokens = collectLeftoverSuggestionTokens([
			makeLeftover(),
			makeLeftover({ name: 'leftovers rice rice', status: 'active' }),
			makeLeftover({ name: 'old stew', status: 'used' }),
		]);

		expect(tokens).toEqual(['chili', 'rice']);
	});

	it('drops common stop words from leftover suggestion tokens', () => {
		const tokens = collectLeftoverSuggestionTokens([
			makeLeftover({ name: 'the chili and rice with beans' }),
		]);

		expect(tokens).toEqual(['chili', 'rice', 'beans']);
	});

	it('sorts by score descending then title ascending and ignores archived recipes', () => {
		const suggestions = findLeftoverRecipeSuggestions(
			[
				makeLeftover({ name: 'leftover chili rice' }),
				makeLeftover({ name: 'leftover chicken' }),
			],
			[
				makeRecipe({
					id: 'triple-match',
					title: 'Ultimate Chicken Chili Rice',
					ingredients: [{ name: 'chicken', quantity: 1, unit: 'lb' }],
				}),
				makeRecipe({
					id: 'alpha-two',
					title: 'Alpha Chicken Rice',
					ingredients: [{ name: 'rice', quantity: 2, unit: 'cups' }],
				}),
				makeRecipe({
					id: 'zeta-two',
					title: 'Zeta Chicken Rice',
					ingredients: [{ name: 'rice', quantity: 2, unit: 'cups' }],
				}),
				makeRecipe({
					id: 'canonical-match',
					title: 'Roasted Chickpea Salad',
					ingredients: [{ name: 'garbanzo beans', canonicalName: 'chickpeas', quantity: 1, unit: 'can' }],
				}),
				makeRecipe({
					id: 'archived',
					title: 'Archived Chili Rice',
					status: 'archived',
				}),
			],
		);

		expect(suggestions.map((suggestion) => suggestion.recipe.id)).toEqual([
			'triple-match',
			'alpha-two',
			'zeta-two',
		]);
		expect(suggestions[0]?.matchedTokens).toEqual(['chili', 'rice', 'chicken']);
	});

	it('matches ingredient canonicalName when present', () => {
		const suggestions = findLeftoverRecipeSuggestions(
			[makeLeftover({ name: 'leftover chickpeas curry' })],
			[
				makeRecipe({
					id: 'chickpea-curry',
					title: 'Golden Curry',
					ingredients: [{ name: 'garbanzo beans', canonicalName: 'chickpeas', quantity: 1, unit: 'can' }],
				}),
			],
		);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.matchedTokens).toContain('chickpeas');
	});
});
