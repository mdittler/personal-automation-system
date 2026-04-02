/**
 * Recipe scaling — parse serving counts, scale ingredients, generate LLM notes.
 */

import type { CoreServices } from '@pas/core/types';
import type { Ingredient, Recipe, ScaledIngredient } from '../types.js';
import { sanitizeInput } from '../utils/sanitize.js';

/**
 * Parse user input for target servings.
 * Accepts: bare numbers, "double", "half", "triple", "quarter", "N servings".
 * Returns null for invalid/zero/negative input.
 */
export function parseServingsInput(input: string, originalServings: number): number | null {
	const trimmed = input.trim().toLowerCase();
	if (!trimmed) return null;

	if (trimmed === 'double') return originalServings * 2;
	if (trimmed === 'triple') return originalServings * 3;
	if (trimmed === 'half') return originalServings * 0.5;
	if (trimmed === 'quarter') return originalServings * 0.25;

	// "3 servings" or "3 serving"
	const servingsMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*servings?$/);
	if (servingsMatch?.[1]) {
		const n = Number.parseFloat(servingsMatch[1]);
		return n > 0 ? n : null;
	}

	// Bare number
	const n = Number.parseFloat(trimmed);
	if (!Number.isNaN(n) && n > 0 && /^\d+(?:\.\d+)?$/.test(trimmed)) return n;

	return null;
}

/**
 * Scale ingredients linearly by the ratio target/original.
 * Null quantities pass through unchanged. Rounded to 2dp.
 */
export function scaleIngredients(
	ingredients: Ingredient[],
	originalServings: number,
	targetServings: number,
): ScaledIngredient[] {
	const ratio = targetServings / originalServings;
	return ingredients.map((ing) => ({
		...ing,
		originalQuantity: ing.quantity,
		scaledQuantity: ing.quantity != null ? Math.round(ing.quantity * ratio * 100) / 100 : null,
	}));
}

/**
 * Format scaled ingredients as a Telegram-friendly bullet list.
 */
export function formatScaledIngredients(
	ingredients: ScaledIngredient[],
	targetServings: number,
	originalServings: number,
	scalingNotes: string | null,
): string {
	const isScaled = targetServings !== originalServings;
	const header = isScaled
		? `Scaled to ${targetServings} servings (originally ${originalServings}):\n`
		: `Ingredients (${targetServings} servings):\n`;

	const lines = ingredients.map((ing) => {
		const qty = ing.scaledQuantity != null ? `${ing.scaledQuantity}` : '';
		const unit = ing.unit ?? '';
		const original =
			isScaled && ing.originalQuantity != null && ing.scaledQuantity !== ing.originalQuantity
				? ` (originally ${ing.originalQuantity} ${unit})`
				: '';
		const notes = ing.notes ? ` — ${ing.notes}` : '';
		return `• ${qty} ${unit} ${ing.name}${original}${notes}`.replace(/\s+/g, ' ').trim();
	});

	let result = header + lines.join('\n');

	if (scalingNotes) {
		result += `\n\nScaling notes:\n${scalingNotes}`;
	}

	return result;
}

/**
 * Generate LLM-powered non-linear scaling notes for a recipe.
 * Covers spice adjustment, baking time, pan size, chemistry.
 */
export async function generateScalingNotes(
	services: CoreServices,
	recipe: Recipe,
	targetServings: number,
): Promise<string> {
	const ratio = targetServings / recipe.servings;
	const ingredientList = recipe.ingredients
		.map((i) => `${i.quantity ?? ''} ${i.unit ?? ''} ${sanitizeInput(i.name)}`.trim())
		.join(', ');

	const prompt = `Recipe: "${sanitizeInput(recipe.title)}" (originally ${recipe.servings} servings, scaling to ${targetServings} servings, ${ratio.toFixed(1)}x).
Ingredients: ${ingredientList}

Provide brief practical notes about non-linear scaling concerns:
- Spices/seasonings that don't scale linearly
- Baking time or temperature adjustments
- Pan size considerations
- Any cooking chemistry notes

Keep it concise (2-4 bullet points). No JSON, just plain text.`;

	return services.llm.complete(prompt, { tier: 'standard', maxTokens: 300 });
}
