/**
 * Parser and stripper for the <session-search query="..."/> pseudo-tool tag.
 *
 * Self-closing only. Paired form is explicitly not supported.
 *
 * Regex security:
 *   - `[^"<>]{1,200}` rejects queries containing quotes or angle brackets
 *   - Query is post-processed: trimmed, bidi/zero-width stripped
 *   - null returned if query is empty after sanitize, or > 200 chars
 *
 * REQ-CONV-TOOL-SEARCH-002, REQ-CONV-TOOL-SEARCH-003
 */

// Self-closing only. [^"<>]{1,200} rejects hostile query content.
const SESSION_SEARCH_TAG_REGEX = /<session-search\s+query="([^"<>]{1,200})"\s*\/>/i;

// Sweep: catches malformed shapes and paired opening tags
const SESSION_SEARCH_SWEEP_REGEX = /<session-search\b[^>]*\/?>/gi;

// Paired closing tag (not produced by the LLM instruction but must be stripped defensively)
const SESSION_SEARCH_CLOSE_REGEX = /<\/session-search>/gi;

// Bidi + zero-width characters (matches session-summarizer.ts pattern)
const BIDI_ZERO_WIDTH_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

export interface SessionSearchTagResult {
	/** Sanitized query extracted from the tag; null if no valid tag found. */
	query: string | null;
	/** Prose before the matched tag (already tag-stripped via stripSessionSearchTags). */
	beforeTag: string;
	/** Original matched tag text for telemetry; null if no match. */
	raw: string | null;
}

function sanitizeQuery(raw: string): string | null {
	const trimmed = raw.trim().replace(BIDI_ZERO_WIDTH_RE, '');
	return trimmed.length > 0 ? trimmed : null;
}

export function extractSessionSearchTag(response: string): SessionSearchTagResult {
	const match = SESSION_SEARCH_TAG_REGEX.exec(response);

	if (!match) {
		return {
			query: null,
			beforeTag: stripSessionSearchTags(response),
			raw: null,
		};
	}

	const rawQuery = match[1] ?? '';
	const query = sanitizeQuery(rawQuery);
	const rawTag = match[0];
	const matchIndex = match.index;

	const proseBeforeTag = response.slice(0, matchIndex);
	const beforeTag = stripSessionSearchTags(proseBeforeTag);

	return { query, beforeTag, raw: rawTag };
}

/** Remove all session-search tag shapes from a string. Safe to call at any exit path. */
export function stripSessionSearchTags(response: string): string {
	return response
		.replace(SESSION_SEARCH_TAG_REGEX, '')
		.replace(SESSION_SEARCH_SWEEP_REGEX, '')
		.replace(SESSION_SEARCH_CLOSE_REGEX, '');
}
