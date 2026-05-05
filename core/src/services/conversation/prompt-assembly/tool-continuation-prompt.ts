/**
 * Builds the continuation prompt passed to the second LLM call in the
 * <session-search> pseudo-tool re-prompt loop.
 *
 * The result wraps search hits in a buildMemoryContextBlock fence so hostile
 * snippet content cannot break the outer structure.
 */

import type { SearchHit } from '../../chat-transcript-index/index.js';
import { buildMemoryContextBlock } from '../../prompt-assembly/memory-context.js';
import { stripSessionSearchTags } from '../control-tags/session-search-tag.js';
import { formatRecalledSessions } from './recalled-sessions.js';

export function buildToolContinuationPrompt(opts: {
	userMessage: string;
	assistantPreTag: string;
	toolQuery: string;
	toolResult: SearchHit[];
}): string {
	const cleanedPreTag = stripSessionSearchTags(opts.assistantPreTag);

	const rawContent =
		opts.toolResult.length > 0
			? formatRecalledSessions(opts.toolResult)
			: '(No matching conversations found.)';

	const resultFence = buildMemoryContextBlock(rawContent, {
		label: 'session-search-result',
		maxChars: 4000,
		marker: '... (search results truncated)',
	});

	const userFence = buildMemoryContextBlock(opts.userMessage, {
		label: 'user-request',
		maxChars: 2000,
		marker: '... (truncated)',
	});

	const parts: string[] = [];
	if (userFence) parts.push(userFence);
	if (cleanedPreTag.trim()) {
		const partialFence = buildMemoryContextBlock(cleanedPreTag, {
			label: 'assistant-partial',
			maxChars: 2000,
			marker: '... (truncated)',
		});
		if (partialFence) parts.push(partialFence);
	}
	parts.push(resultFence);
	parts.push('Continue your reply using these results. Do not search again.');

	return parts.join('\n\n');
}
