/**
 * Builds the continuation prompt passed to the second LLM call in the
 * <session-search> pseudo-tool re-prompt loop.
 *
 * The result wraps search hits in a buildMemoryContextBlock fence so hostile
 * snippet content cannot break the outer structure.
 *
 * Chunk H: surfaces applied after/before filters in the result fence opening tag.
 */

import type { SearchHit } from '../../chat-transcript-index/index.js';
import { buildMemoryContextBlock } from '../../prompt-assembly/memory-context.js';
import { stripSessionSearchTags } from '../control-tags/session-search-tag.js';
import { formatRecalledSessions } from './recalled-sessions.js';

/** Escape a string for safe inclusion in an XML attribute value (double-quoted). */
function escapeAttrValue(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

export function buildToolContinuationPrompt(opts: {
	userMessage: string;
	assistantPreTag: string;
	toolQuery: string;
	toolResult: SearchHit[];
	/** Optional: applied after filter (YYYY-MM-DD). Surfaced in result fence when present. */
	toolAfter?: string | null;
	/** Optional: applied before filter (YYYY-MM-DD). Surfaced in result fence when present. */
	toolBefore?: string | null;
}): string {
	const cleanedPreTag = stripSessionSearchTags(opts.assistantPreTag);

	const rawContent =
		opts.toolResult.length > 0
			? formatRecalledSessions(opts.toolResult)
			: '(No matching conversations found.)';

	// Build a metadata header line (query/after/before) and prepend it to the fenced content.
	// The header MUST NOT be embedded in the label="" attribute — that would produce malformed
	// XML like label="session-search-result query="x" after="y"". Putting it in the body keeps
	// the opening tag well-formed while still surfacing the filter context to the LLM.
	const escapedQuery = escapeAttrValue(opts.toolQuery);
	const after = opts.toolAfter ?? null;
	const before = opts.toolBefore ?? null;

	let metadataHeader = `query="${escapedQuery}"`;
	if (after !== null) metadataHeader += ` after="${escapeAttrValue(after)}"`;
	if (before !== null) metadataHeader += ` before="${escapeAttrValue(before)}"`;
	const contentWithMeta = `${metadataHeader}\n\n${rawContent}`;

	const resultFence = buildMemoryContextBlock(contentWithMeta, {
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
