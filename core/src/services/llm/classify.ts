/**
 * Text classification using the local LLM.
 *
 * Always uses Ollama (URS-LLM-003). Never falls back to Claude.
 */

import type { Logger } from 'pino';
import type { ClassifyResult, LLMClient } from '../../types/llm.js';
import { buildClassifyPrompt } from './prompt-templates.js';

/**
 * Classify text into one of the given categories using an LLM client.
 *
 * @param text - The text to classify
 * @param categories - The list of valid categories
 * @param client - LLM client (Ollama or Claude)
 * @param logger - Logger instance
 * @returns Classification result with category and confidence
 */
export async function classify(
	text: string,
	categories: string[],
	client: LLMClient,
	logger: Logger,
): Promise<ClassifyResult> {
	if (categories.length === 0) {
		throw new Error('classify() requires at least one category');
	}

	const prompt = buildClassifyPrompt(text, categories);

	const response = await client.complete(prompt, { temperature: 0.1 });

	return parseClassifyResponse(response, categories, logger);
}

/**
 * Parse the LLM's classification response.
 *
 * Attempts to extract JSON from the response. Falls back to
 * matching the response text against known categories.
 */
export function parseClassifyResponse(
	response: string,
	categories: string[],
	logger: Logger,
): ClassifyResult {
	// Try to parse as JSON first
	try {
		const jsonMatch = response.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]) as { category?: string; confidence?: number };
			if (parsed.category === 'none') {
				return { category: 'none', confidence: 0.0 };
			}
			if (parsed.category && categories.includes(parsed.category)) {
				return {
					category: parsed.category,
					confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.8)),
				};
			}
		}
	} catch {
		// JSON parsing failed, try text matching
	}

	// Fallback: check if response contains any category name
	const lower = response.toLowerCase();
	for (const category of categories) {
		if (lower.includes(category.toLowerCase())) {
			logger.debug(
				{ response, matchedCategory: category },
				'Classification fell back to text matching',
			);
			return { category, confidence: 0.3 };
		}
	}

	// No match found — return first category with low confidence
	logger.warn({ response, categories }, 'Classification could not match any category');
	return { category: categories[0] ?? 'unknown', confidence: 0.1 };
}
