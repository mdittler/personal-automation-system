/**
 * Format /recall search hits as a Telegram Markdown reply.
 *
 * Term-aware FTS5 highlight stripping: replaces `[<term>]` with `<term>`
 * for each query term before escapeMarkdown runs. This removes the FTS5
 * `snippet(... '[', ']' ...)` markers without corrupting user-typed `[brackets]`.
 *
 * Chunk H: formatTurnTimestamp added — per-turn lines now display
 * "EEE YYYY-MM-DD HH:MM UTC" instead of turn index only.
 *
 * REQ-CONV-RECALL-005, REQ-CONV-RECALL-006
 */

import { escapeMarkdown } from '../../../utils/escape-markdown.js';
import type { MatchRow, SearchHit } from '../../chat-transcript-index/types.js';

const MAX_SNIPPET_CHARS = 300;
const MAX_HIT_CHARS = 1500;

// Day-of-week abbreviations in English (Sunday = 0 … Saturday = 6)
const DOW_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Format an ISO 8601 UTC timestamp as "EEE YYYY-MM-DD HH:MM UTC".
 * Returns "unknown time" for malformed or non-UTC input.
 *
 * Example: '2026-04-28T14:32:00.000Z' → 'Tue 2026-04-28 14:32 UTC'
 */
// Strict UTC datetime: must end with Z or +00:00 and contain a T separator.
const UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/;

export function formatTurnTimestamp(iso: string): string {
	// Reject anything that is not a strict UTC datetime — e.g. '2026-04-28T14:32:00' (missing Z)
	// or '2026-04-28T14:32:00+05:30' (non-UTC offset) would be silently wrong without this check.
	if (!UTC_DATETIME_RE.test(iso.trim())) return 'unknown time';

	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'unknown time';

	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	const hour = String(d.getUTCHours()).padStart(2, '0');
	const minute = String(d.getUTCMinutes()).padStart(2, '0');
	const dow = DOW_ABBR[d.getUTCDay()];

	return `${dow} ${year}-${month}-${day} ${hour}:${minute} UTC`;
}

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
	const ts = formatTurnTimestamp(match.timestamp);
	return `> _${ts} — ${role}_: ${escapedSnippet}`;
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
