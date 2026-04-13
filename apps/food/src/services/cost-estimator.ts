/**
 * Cost Estimator — LLM-powered ingredient → price matching and cost calculation.
 *
 * Uses the price database to semantically match recipe ingredients to price
 * entries and calculate per-recipe and per-serving costs.
 */

import type { CoreServices } from '@pas/core/types';
import type {
	GroceryItem,
	IngredientCost,
	MealCostEstimate,
	MealPlan,
	PriceEntry,
	Recipe,
} from '../types.js';
import { isoNow } from '../utils/date.js';
import { sanitizeInput } from '../utils/sanitize.js';

// ─── Exported Types ───────────────────────────────────────────────────────────

export interface GroceryListCostResult {
	items: Array<{ name: string; matchedItem: string | null; estimatedCost: number }>;
	total: number;
	store: string;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const ESTIMATE_PROMPT = `You are a grocery cost estimator. Given a list of recipe ingredients and a price database, calculate the cost for each ingredient's portion used in the recipe.

Return ONLY a JSON array with this structure (no markdown, no explanation):
[
  { "ingredientName": "2 cups AP flour", "matchedItem": "AP Flour (25 lb)", "portionCost": 0.20, "isEstimate": false }
]

Rules:
- ingredientName: the original ingredient string from the recipe
- matchedItem: the matched item name from the price list, or null if no match
- portionCost: the dollar cost for the quantity used in this recipe (not the full package price)
- isEstimate: false if matched from the price list, true if estimated without a match
- If no price match exists, estimate a reasonable portionCost and set isEstimate: true
- Always return one entry per ingredient`;

const GROCERY_COST_PROMPT = `You are a grocery cost estimator. Given a grocery list and a price database, match each item to the best price entry and return the full package cost.

Return ONLY a JSON array with this structure (no markdown, no explanation):
[
  { "name": "AP Flour", "matchedItem": "AP Flour (25 lb)", "estimatedCost": 8.99 }
]

Rules:
- name: the original grocery item name
- matchedItem: the matched item from the price list, or null if no match
- estimatedCost: the full package price for this item (0 if no match found)
- Always return one entry per grocery item`;

// ─── estimateRecipeCost ───────────────────────────────────────────────────────

/**
 * Estimate the cost of a single recipe using the provided price database.
 * Returns a MealCostEstimate with per-ingredient breakdown.
 */
export async function estimateRecipeCost(
	services: CoreServices,
	recipe: Recipe,
	priceItems: PriceEntry[],
	storeName: string,
): Promise<MealCostEstimate> {
	const emptyResult: MealCostEstimate = {
		recipeId: recipe.id,
		recipeTitle: recipe.title,
		store: storeName,
		ingredientCosts: [],
		totalCost: 0,
		perServingCost: 0,
		servings: recipe.servings,
		estimatedAt: isoNow(),
	};

	if (recipe.ingredients.length === 0) {
		return emptyResult;
	}

	const ingredientList = recipe.ingredients
		.map((ing) => {
			const qty = ing.quantity !== null ? `${ing.quantity} ` : '';
			const unit = ing.unit ? `${ing.unit} ` : '';
			return sanitizeInput(`${qty}${unit}${ing.name}`, 100);
		})
		.join('\n');

	const priceList = priceItems
		.map((p) => `- ${sanitizeInput(p.name, 100)}: $${p.price.toFixed(2)} (${p.unit})`)
		.join('\n');

	const prompt = `${ESTIMATE_PROMPT}\n\nIngredients:\n${ingredientList}\n\nPrice list:\n${priceList}`;

	try {
		const result = await services.llm.complete(prompt, { tier: 'standard' });
		const cleaned = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
		const parsed: unknown = JSON.parse(cleaned);

		if (!Array.isArray(parsed)) {
			services.logger.warn('estimateRecipeCost: LLM returned non-array JSON for %s', recipe.title);
			return emptyResult;
		}

		const validCosts = (parsed as IngredientCost[]).filter((c) => {
			const cost = c?.portionCost;
			return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 500;
		});

		const dropped = parsed.length - validCosts.length;
		if (dropped > 0) {
			services.logger.warn(
				'estimateRecipeCost: dropped %d invalid cost entries for %s',
				dropped,
				recipe.title,
			);
		}

		const totalCost = validCosts.reduce((sum, c) => sum + c.portionCost, 0);
		const perServingCost = recipe.servings > 0 ? totalCost / recipe.servings : 0;

		return {
			recipeId: recipe.id,
			recipeTitle: recipe.title,
			store: storeName,
			ingredientCosts: validCosts,
			totalCost,
			perServingCost,
			servings: recipe.servings,
			estimatedAt: isoNow(),
		};
	} catch (err) {
		services.logger.error('estimateRecipeCost failed for %s: %s', recipe.title, err);
		return emptyResult;
	}
}

// ─── estimatePlanCost ─────────────────────────────────────────────────────────

/**
 * Estimate costs for all meals in a meal plan that have matching recipes.
 * Skips meals with isNew=true (LLM suggestions not in recipe library).
 */
export async function estimatePlanCost(
	services: CoreServices,
	plan: MealPlan,
	recipes: Recipe[],
	priceItems: PriceEntry[],
	storeName: string,
): Promise<MealCostEstimate[]> {
	const recipeMap = new Map(recipes.map((r) => [r.id, r]));
	const results: MealCostEstimate[] = [];

	for (const meal of plan.meals) {
		const recipe = recipeMap.get(meal.recipeId);
		if (!recipe) continue;

		const estimate = await estimateRecipeCost(services, recipe, priceItems, storeName);
		results.push(estimate);
	}

	return results;
}

// ─── estimateGroceryListCost ──────────────────────────────────────────────────

/**
 * Estimate the total cost of a grocery list by matching items to the price database.
 * Returns full package prices (not portion costs).
 */
export async function estimateGroceryListCost(
	services: CoreServices,
	groceryItems: GroceryItem[],
	priceItems: PriceEntry[],
	storeName: string,
): Promise<GroceryListCostResult> {
	const emptyResult: GroceryListCostResult = { items: [], total: 0, store: storeName };

	if (groceryItems.length === 0) {
		return emptyResult;
	}

	const itemList = groceryItems
		.map((gi) => {
			const qty = gi.quantity !== null ? `${gi.quantity} ` : '';
			const unit = gi.unit ? `${gi.unit} ` : '';
			return sanitizeInput(`${qty}${unit}${gi.name}`, 100);
		})
		.join('\n');

	const priceList = priceItems
		.map((p) => `- ${sanitizeInput(p.name, 100)}: $${p.price.toFixed(2)} (${p.unit})`)
		.join('\n');

	const prompt = `${GROCERY_COST_PROMPT}\n\nGrocery items:\n${itemList}\n\nPrice list:\n${priceList}`;

	try {
		const result = await services.llm.complete(prompt, { tier: 'standard' });
		const cleaned = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
		const parsed: unknown = JSON.parse(cleaned);

		if (!Array.isArray(parsed)) {
			services.logger.warn('estimateGroceryListCost: LLM returned non-array JSON');
			return emptyResult;
		}

		type RawItem = { name: string; matchedItem: string | null; estimatedCost: number };
		const validItems = (parsed as RawItem[]).filter((item) => {
			const cost = item?.estimatedCost;
			return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 500;
		});

		const dropped = parsed.length - validItems.length;
		if (dropped > 0) {
			services.logger.warn('estimateGroceryListCost: dropped %d invalid cost entries', dropped);
		}

		const total = validItems.reduce((sum, item) => sum + item.estimatedCost, 0);

		return { items: validItems, total, store: storeName };
	} catch (err) {
		services.logger.error('estimateGroceryListCost failed: %s', err);
		return emptyResult;
	}
}

// ─── formatMealCostLine ───────────────────────────────────────────────────────

/**
 * Format a single meal cost line for display.
 * "Pancakes — $0.86 ($0.22/person)" or "Pancakes — price unknown"
 */
export function formatMealCostLine(title: string, cost: number, servings: number): string {
	if (cost === 0) {
		return `${title} — price unknown`;
	}

	const perServing = servings > 0 ? cost / servings : 0;
	// Use Math.round for consistent half-up rounding (toFixed uses banker's rounding)
	const perServingRounded = Math.round(perServing * 100) / 100;
	return `${title} — $${cost.toFixed(2)} ($${perServingRounded.toFixed(2)}/serving)`;
}
