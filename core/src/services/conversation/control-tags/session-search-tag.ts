/**
 * Parser and stripper for the <session-search .../> pseudo-tool tag.
 *
 * Attribute parser (Chunk H): any-order, reject duplicates/unknowns.
 * Supported attributes:
 *   query  (required) — search terms, ≤200 chars
 *   after  (optional) — ISO calendar date YYYY-MM-DD; filter message timestamps ≥ day start
 *   before (optional) — ISO calendar date YYYY-MM-DD; filter message timestamps < day end
 *
 * Security guarantees:
 *   - Unknown attributes → entire tag rejected (rejectAll)
 *   - Duplicate attributes → entire tag rejected (rejectAll)
 *   - query must be non-empty and ≤200 chars after bidi/zero-width strip
 *   - after/before must be calendar-strict (isCalendarStrict)
 *   - after must be ≤ before when both present
 *   - bidi + zero-width chars stripped from all attr values
 *
 * REQ-CONV-TOOL-SEARCH-002, REQ-CONV-TOOL-SEARCH-003
 */

import { isCalendarStrict } from '../../../utils/temporal.js';

// Outer tag: captures the entire inner attribute string
const TAG_OUTER = /<session-search\s+([^<>]+?)\s*\/>/i;

// Walk individual attributes key="value" pairs
const ATTR_RE = /(\w+)\s*=\s*"([^"<>]*)"/g;

// Allowed attribute names
const ALLOWED_ATTRS = new Set(['query', 'after', 'before']);

// Sweep: catches all tag shapes including invalid ones (for stripSessionSearchTags)
const SESSION_SEARCH_SWEEP_REGEX = /<session-search\b[^<>]*\/>/gi;

// Paired closing tag (not produced by the LLM instruction but must be stripped defensively)
const SESSION_SEARCH_CLOSE_REGEX = /<\/session-search>/gi;

// Also catch opening tags without self-close slash
const SESSION_SEARCH_OPEN_REGEX = /<session-search\b[^<>]*>/gi;

// Bidi + zero-width characters — explicit \u escapes for auditability
// U+200B-U+200F: zero-width space/joiner/non-joiner, LRM, RLM
// U+202A-U+202E: LRE, RLE, PDF, LRO, RLO
// U+2066-U+2069: LRI, RLI, FSI, PDI
// U+FEFF: BOM / zero-width no-break space
const BIDI_ZERO_WIDTH_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

export interface SessionSearchTagResult {
	/** Sanitized query extracted from the tag; null if no valid tag found. */
	query: string | null;
	/** Parsed and validated after date (YYYY-MM-DD); null if not present or no valid tag. */
	after: string | null;
	/** Parsed and validated before date (YYYY-MM-DD); null if not present or no valid tag. */
	before: string | null;
	/** Prose before the matched tag (already tag-stripped via stripSessionSearchTags). */
	beforeTag: string;
	/** Original matched tag text for telemetry; null if no match. */
	raw: string | null;
}

/** Strip bidi/zero-width chars from an attribute value. */
function sanitizeAttrValue(value: string): string {
	return value.replace(BIDI_ZERO_WIDTH_RE, '');
}

/** Return the rejection sentinel: all nulls, beforeTag = full response. */
function rejectAll(response: string): SessionSearchTagResult {
	return { query: null, after: null, before: null, beforeTag: response, raw: null };
}

export function extractSessionSearchTag(response: string): SessionSearchTagResult {
	const m = TAG_OUTER.exec(response);
	if (!m) {
		// No self-closing tag found — strip any straggler shapes from beforeTag
		return {
			query: null,
			after: null,
			before: null,
			beforeTag: stripSessionSearchTags(response),
			raw: null,
		};
	}

	const innerAttrs = m[1] ?? '';

	// Walk all key="value" pairs — collect into a local array to avoid noAssignInExpressions
	ATTR_RE.lastIndex = 0;
	const attrMatches: RegExpExecArray[] = [];
	for (;;) {
		const next = ATTR_RE.exec(innerAttrs);
		if (next === null) break;
		attrMatches.push(next);
	}

	const seen = new Set<string>();
	let query: string | null = null;
	let after: string | null = null;
	let before: string | null = null;
	let rejected = false;

	for (const attrMatch of attrMatches) {
		const key = (attrMatch[1] ?? '').toLowerCase();
		const rawValue = attrMatch[2] ?? '';

		// Unknown attribute → reject entire tag
		if (!ALLOWED_ATTRS.has(key)) {
			rejected = true;
			break;
		}

		// Duplicate attribute → reject entire tag
		if (seen.has(key)) {
			rejected = true;
			break;
		}
		seen.add(key);

		const value = sanitizeAttrValue(rawValue);

		switch (key) {
			case 'query':
				query = value;
				break;
			case 'after':
				after = value;
				break;
			case 'before':
				before = value;
				break;
		}
	}

	if (rejected) return rejectAll(response);

	// query is required and must be non-empty, ≤200 chars
	if (!query) return rejectAll(response);
	const trimmedQuery = query.trim();
	if (trimmedQuery.length === 0 || trimmedQuery.length > 200) return rejectAll(response);

	// after must be calendar-strict if present
	if (after !== null && !isCalendarStrict(after)) return rejectAll(response);

	// before must be calendar-strict if present
	if (before !== null && !isCalendarStrict(before)) return rejectAll(response);

	// after must be <= before when both present
	if (after !== null && before !== null && after > before) return rejectAll(response);

	const matchIndex = m.index;
	const proseBeforeTag = response.slice(0, matchIndex);
	const beforeTag = stripSessionSearchTags(proseBeforeTag);

	return { query: trimmedQuery, after, before, beforeTag, raw: m[0] };
}

/** Remove all session-search tag shapes from a string. Safe to call at any exit path. */
export function stripSessionSearchTags(response: string): string {
	return response
		.replace(SESSION_SEARCH_SWEEP_REGEX, '')
		.replace(SESSION_SEARCH_CLOSE_REGEX, '')
		.replace(SESSION_SEARCH_OPEN_REGEX, '');
}
