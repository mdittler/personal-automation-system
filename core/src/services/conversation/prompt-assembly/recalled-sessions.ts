/**
 * Format recalled session hits for injection into the system prompt as Layer 5
 * (recalled session transcripts from FTS5 search).
 *
 * wrapInRecalledFence — formats hits and wraps in a <memory-context label="recalled-session"> block.
 * formatRecalledSessions — formats raw hits into a human-readable string (no fence).
 */

import type { SearchHit } from '../../chat-transcript-index/index.js';
import { buildMemoryContextBlock } from '../../prompt-assembly/memory-context.js';

const RECALLED_SESSION_LABEL = 'recalled-session';
const BUDGET_CHARS = 4000;
const TRUNCATION_MARKER = '... (recalled session truncated)';

export function formatRecalledSessions(hits: SearchHit[]): string {
	if (hits.length === 0) return '';
	const lines: string[] = [];
	for (const hit of hits) {
		lines.push(
			`### Session ${hit.sessionStartedAt}${hit.title ? ` — ${hit.title}` : ''}`,
		);
		for (const match of hit.matches) {
			const role = match.role === 'user' ? 'You' : 'Assistant';
			lines.push(`**${role}** (turn ${match.turn_index}): ${match.snippet}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

export function wrapInRecalledFence(hits: SearchHit[]): string {
	if (hits.length === 0) return '';
	const content = formatRecalledSessions(hits);
	return buildMemoryContextBlock(content, {
		label: RECALLED_SESSION_LABEL,
		maxChars: BUDGET_CHARS,
		marker: TRUNCATION_MARKER,
	});
}
