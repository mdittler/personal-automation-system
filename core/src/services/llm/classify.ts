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

const normalizeText = (t: string): string => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Resolve the model's `category` value to a known category, `'none'`, or
 * undefined (unresolvable). The prompt lists categories numbered, and some
 * models (e.g. Haiku) answer with the index (`"4"`, `4`) or `"5. <text>"`
 * instead of the text. Accepts: exact text, trimmed/case-insensitive text,
 * an in-range 1-based index, or `N.`/`N)` prefixed text only when the
 * trailing text matches `categories[N-1]` (trimmed, case-insensitive).
 * Index `categories.length + 1` with trailing text `none` is the prompt's
 * "none" slot. A prefix whose index and label disagree, or an out-of-range
 * index whose label matches some category, is unresolved. Out-of-range
 * indexes are NOT mapped.
 */
function resolveCategory(value: unknown, categories: string[]): string | undefined {
	if (typeof value !== 'string' && typeof value !== 'number') return undefined;
	const raw = String(value).trim();
	if (raw === '') return undefined;

	if (categories.includes(raw)) return raw;

	const matchText = (text: string): string | undefined => {
		const norm = normalizeText(text);
		if (norm === 'none') return 'none';
		return categories.find((c) => normalizeText(c) === norm);
	};

	const direct = matchText(raw);
	if (direct !== undefined) return direct;

	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		if (n >= 1 && n <= categories.length) return categories[n - 1];
		if (n === categories.length + 1) return 'none';
		return undefined;
	}

	const prefixed = raw.match(/^(\d+)\s*[.)]\s*(.+)$/);
	if (prefixed?.[1] && prefixed[2]) {
		const n = Number(prefixed[1]);
		const label = prefixed[2];
		if (n >= 1 && n <= categories.length) {
			const expected = categories[n - 1];
			if (expected !== undefined && normalizeText(label) === normalizeText(expected)) {
				return expected;
			}
			// Index and label contradict, or the label is not that category.
			return undefined;
		}
		if (n === categories.length + 1 && normalizeText(label) === 'none') {
			return 'none';
		}
		// Out of range, including when the trailing text names a real category.
		return undefined;
	}

	return undefined;
}

/**
 * Confidence from model output. Absent keeps the historical default (0.8).
 * Present but not a finite number fails safe to 0 so `NaN`/`Infinity` cannot
 * satisfy a `confidence >= threshold` routing gate.
 */
function coerceConfidence(value: unknown): number {
	if (value === undefined) return 0.8;
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
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
			const parsed = JSON.parse(jsonMatch[0]) as { category?: unknown; confidence?: unknown };
			const resolved = resolveCategory(parsed.category, categories);
			if (resolved === 'none') {
				return { category: 'none', confidence: 0.0 };
			}
			if (resolved !== undefined) {
				return {
					category: resolved,
					confidence: coerceConfidence(parsed.confidence),
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
