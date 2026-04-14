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
import type { Logger } from 'pino';

const MAX_QUESTION_LENGTH = 500;
const MAX_CONTENT_LENGTH = 6000;

/**
 * Sanitize user-controlled text before injecting into an LLM prompt.
 * Neutralizes triple-backtick sequences that could escape code fences.
 */
function sanitize(text: string, maxLength: number): string {
	const truncated = text.length > maxLength ? text.slice(0, maxLength) : text;
	return truncated.replace(/`{3,}/g, '`');
}

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
	logger: Logger,
): Promise<string | null> {
	if (dataResult.empty) {
		return null;
	}

	// Build a text representation of the retrieved files
	const fileParts: string[] = [];
	for (const file of dataResult.files) {
		const header = [file.appId, file.type, file.title].filter(Boolean).join(' / ');
		fileParts.push(`[${header}]\n${sanitize(file.content, MAX_CONTENT_LENGTH / dataResult.files.length)}`);
	}
	const dataText = fileParts.join('\n\n');

	const prompt = [
		'Based on the following data, answer the user\'s question concisely.',
		'',
		`Question: ${sanitize(question, MAX_QUESTION_LENGTH)}`,
		'',
		'Data:',
		sanitize(dataText, MAX_CONTENT_LENGTH),
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
