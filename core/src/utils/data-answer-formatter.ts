/**
 * Shared utility for formatting a DataQueryResult into a natural-language answer.
 *
 * Used by the food app fallback (and potentially other apps) to synthesize
 * a brief answer from file content returned by DataQueryService.
 *
 * Note: DataQueryService sanitizes metadata fields (title, tags, entities)
 * but NOT file body content. This utility sanitizes all user-supplied data
 * before injecting it into the LLM prompt.
 */

import type { DataQueryResult } from '../types/data-query.js';
import type { LLMService } from '../types/llm.js';
import type { AppLogger } from '../types/app-module.js';
import { sanitizeInput } from '../services/llm/prompt-templates.js';

const MAX_QUESTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 6000;

/**
 * Format a DataQueryResult into a natural language answer using an LLM.
 *
 * @returns The synthesized answer string, or null when:
 *   - dataResult.empty is true (no files found — skip silently)
 *   - the LLM call fails (fail gracefully, let caller use its fallback)
 */
export async function formatDataAnswer(
	question: string,
	dataResult: DataQueryResult,
	llm: LLMService,
	logger: AppLogger,
): Promise<string | null> {
	if (dataResult.empty) {
		return null;
	}

	// Build a text representation of the retrieved files
	const fileParts: string[] = [];
	for (const file of dataResult.files) {
		const safeAppId = sanitizeInput(file.appId, 50);
		const safeType = sanitizeInput(file.type ?? '', 50);
		const safeTitle = sanitizeInput(file.title ?? '', 100);
		const header = [safeAppId, safeType, safeTitle].filter(Boolean).join(' / ');
		const safeContent = sanitizeInput(file.content, Math.floor(MAX_CONTENT_LENGTH / dataResult.files.length));
		fileParts.push(`[${header}]\n${safeContent}`);
	}
	const dataText = fileParts.join('\n\n');

	const prompt = [
		'Based on the following data, answer the user\'s question concisely.',
		'',
		`Question: ${sanitizeInput(question, MAX_QUESTION_LENGTH)}`,
		'',
		'Data:',
		dataText,
		'',
		'Provide a direct, concise answer based only on the data provided. If you cannot answer from the data, say so briefly.',
	].join('\n');

	try {
		return await llm.complete(prompt, { tier: 'standard' });
	} catch (error) {
		logger.warn('formatDataAnswer: LLM call failed: %s', error);
		return null;
	}
}
