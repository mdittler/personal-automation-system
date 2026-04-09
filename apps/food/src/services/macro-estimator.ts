/**
 * LLM macro estimator for smart nutrition logging (Phase H11.w).
 *
 * Takes a meal label + ingredient list + kind and asks the fast-tier
 * LLM to estimate macros. User inputs are sanitized (backtick-
 * neutralized + length-capped) before prompt interpolation. The LLM
 * JSON response is Zod-validated before return.
 */

import { z } from 'zod';
import type { LLMService } from '@pas/core/types';
import type { MacroData } from '../types.js';
import { sanitizeInput } from '../utils/sanitize.js';

const SCHEMA = z.object({
	calories: z.number().min(0).max(10000),
	protein: z.number().min(0).max(500),
	carbs: z.number().min(0).max(1500),
	fat: z.number().min(0).max(500),
	fiber: z.number().min(0).max(200),
	confidence: z.number().min(0).max(1),
	reasoning: z.string().max(500).optional(),
});

export interface EstimateInput {
	label: string;
	ingredients: string[];
	kind: 'home' | 'restaurant' | 'other';
	notes?: string;
}

export type EstimateResult =
	| {
			ok: true;
			macros: MacroData;
			confidence: number;
			reasoning?: string;
			model: string;
	  }
	| { ok: false; error: string };

export async function estimateMacros(
	input: EstimateInput,
	llm: LLMService,
): Promise<EstimateResult> {
	const safeLabel = sanitizeInput(input.label);
	const safeIngredients = input.ingredients.map((i) => sanitizeInput(i)).join('\n- ');
	const safeNotes = input.notes ? sanitizeInput(input.notes) : '';

	const prompt = [
		'You are a nutrition estimator. Given a meal description, return ONLY a JSON object',
		'(no prose, no code fences) with this shape:',
		'{"calories": number, "protein": number, "carbs": number, "fat": number,',
		' "fiber": number, "confidence": number, "reasoning": string}',
		'',
		'- calories in kcal, macros in grams',
		'- confidence 0-1 (0.9+ if ingredients are precise and standard;',
		'  0.3-0.5 if portions unspecified or restaurant estimates)',
		'- reasoning: one short sentence',
		'',
		`Meal label: ${safeLabel}`,
		`Kind: ${input.kind}`,
		'Ingredients:',
		`- ${safeIngredients}`,
		safeNotes ? `Notes: ${safeNotes}` : '',
	]
		.filter((line) => line !== '')
		.join('\n');

	let responseText: string;
	try {
		responseText = await llm.complete(prompt, { tier: 'fast', maxTokens: 400 });
	} catch (err) {
		return { ok: false, error: `llm call failed: ${(err as Error).message}` };
	}

	let parsed: unknown;
	try {
		// strip code fences if the model wraps JSON anyway
		const cleaned = responseText
			.replace(/^```(?:json)?\s*/gim, '')
			.replace(/\s*```$/gim, '')
			.trim();
		parsed = JSON.parse(cleaned);
	} catch {
		return { ok: false, error: 'llm returned non-JSON' };
	}

	const result = SCHEMA.safeParse(parsed);
	if (!result.success) {
		return { ok: false, error: `validation failed: ${result.error.message}` };
	}

	const model = llm.getModelForTier?.('fast') ?? 'unknown';

	return {
		ok: true,
		macros: {
			calories: result.data.calories,
			protein: result.data.protein,
			carbs: result.data.carbs,
			fat: result.data.fat,
			fiber: result.data.fiber,
		},
		confidence: result.data.confidence,
		reasoning: result.data.reasoning,
		model,
	};
}
