/**
 * Format /recall search hits as a Telegram Markdown reply.
 *
 * Term-aware FTS5 highlight stripping: replaces `[<term>]` with `<term>`
 * for each query term before escapeMarkdown runs. This removes the FTS5
 * `snippet(... '[', ']' ...)` markers without corrupting user-typed `[brackets]`.
 *
 * REQ-CONV-RECALL-005, REQ-CONV-RECALL-006
 */

import { escapeMarkdown } from '../../../utils/escape-markdown.js';
import type { MatchRow, SearchHit } from '../../chat-transcript-index/types.js';

const MAX_SNIPPET_CHARS = 300;
const MAX_HIT_CHARS = 1500;

/**
 * Strip FTS5 highlight brackets `[term]` → `term` for the given query terms.
 * Only exact matches (case-insensitive) are replaced. User-typed `[other content]`
 * brackets whose content is not a query term are left intact.
 */
function stripFtsHighlights(snippet: string, queryTerms: string[]): string {
	let result = snippet;
	for (const term of queryTerms) {
		// Escape regex special chars in the term itself before using it in a regex
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(`\\[${escaped}\\]`, 'gi'), term);
	}
	return result;
}

function truncateSnippet(text: string): string {
	if (text.length <= MAX_SNIPPET_CHARS) return text;
	return `${text.slice(0, MAX_SNIPPET_CHARS)}…`;
}

function formatDate(isoString: string): string {
	// Extract YYYY-MM-DD from ISO8601 UTC string
	return isoString.slice(0, 10);
}

function formatMatch(match: MatchRow, queryTerms: string[]): string {
	const role = match.role === 'user' ? 'You' : 'Assistant';
	const rawSnippet = stripFtsHighlights(match.snippet, queryTerms);
	const truncated = truncateSnippet(rawSnippet);
	const escapedSnippet = escapeMarkdown(truncated);
	return `> _${role}_ (turn ${match.turn_index}): ${escapedSnippet}`;
}

function formatHit(hit: SearchHit, queryTerms: string[]): string {
	const rawTitle = hit.title ?? '(untitled)';
	const escapedTitle = escapeMarkdown(rawTitle);
	const date = formatDate(hit.sessionStartedAt);
	const escapedDate = escapeMarkdown(date);
	// Session id is displayed in a backtick code span. Backticks inside a code span
	// would break the span in Telegram legacy Markdown, so replace any embedded backtick.
	const safeSessionId = hit.sessionId.replaceAll('`', "'");

	const lines: string[] = [`*${escapedTitle}* — ${escapedDate}`, `Session: \`${safeSessionId}\``];

	for (const match of hit.matches) {
		lines.push(formatMatch(match, queryTerms));
	}

	return lines.join('\n');
}

export function formatRecallReply(hits: SearchHit[], queryTerms: string[]): string {
	const parts: string[] = [];

	for (const hit of hits) {
		const formatted = formatHit(hit, queryTerms);
		// Apply per-hit character cap
		const capped =
			formatted.length > MAX_HIT_CHARS ? `${formatted.slice(0, MAX_HIT_CHARS)}…` : formatted;
		parts.push(capped);
	}

	return parts.join('\n\n');
}
