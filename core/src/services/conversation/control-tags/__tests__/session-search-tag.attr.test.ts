/**
 * Unit tests for session-search tag attribute parser (Chunk H).
 *
 * Tests the new any-order attribute parser with:
 *   - query, after, before attributes (any order)
 *   - unknown attribute rejection
 *   - duplicate attribute rejection
 *   - calendar-invalid after/before rejection
 *   - after > before rejection
 *   - bidi sanitization
 *   - length constraints
 *
 * REQ-CONV-TOOL-SEARCH-002, REQ-CONV-TOOL-SEARCH-003
 */

import { describe, expect, it } from 'vitest';
import { extractSessionSearchTag, stripSessionSearchTags } from '../session-search-tag.js';

// ---------------------------------------------------------------------------
// Happy path: query-only
// ---------------------------------------------------------------------------

describe('attribute parser — query only', () => {
	it('<session-search query="x"/> → query x, after null, before null', () => {
		const result = extractSessionSearchTag('<session-search query="x"/>');
		expect(result.query).toBe('x');
		expect(result.after).toBeNull();
		expect(result.before).toBeNull();
	});

	it('beforeTag is empty when tag is at start', () => {
		const result = extractSessionSearchTag('<session-search query="x"/>');
		expect(result.beforeTag).toBe('');
	});

	it('raw is the exact matched text', () => {
		const result = extractSessionSearchTag('<session-search query="pasta"/>');
		expect(result.raw).toBe('<session-search query="pasta"/>');
	});

	it('beforeTag is text before the tag', () => {
		const result = extractSessionSearchTag('Let me check. <session-search query="pasta"/>');
		expect(result.beforeTag).toBe('Let me check. ');
	});
});

// ---------------------------------------------------------------------------
// Happy path: with after or before
// ---------------------------------------------------------------------------

describe('attribute parser — after/before attributes', () => {
	it('<session-search query="x" after="2026-04-28"/> → after="2026-04-28"', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="2026-04-28"/>');
		expect(result.query).toBe('x');
		expect(result.after).toBe('2026-04-28');
		expect(result.before).toBeNull();
	});

	it('<session-search query="x" before="2026-04-28"/> → before="2026-04-28"', () => {
		const result = extractSessionSearchTag('<session-search query="x" before="2026-04-28"/>');
		expect(result.query).toBe('x');
		expect(result.after).toBeNull();
		expect(result.before).toBe('2026-04-28');
	});

	it('before and after in any order: <session-search query="x" before="2026-04-28" after="2026-04-21"/>', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" before="2026-04-28" after="2026-04-21"/>',
		);
		expect(result.query).toBe('x');
		expect(result.after).toBe('2026-04-21');
		expect(result.before).toBe('2026-04-28');
	});

	it('all three attrs in mixed order: after, query, before', () => {
		const result = extractSessionSearchTag(
			'<session-search after="2026-04-28" query="trip" before="2026-04-29"/>',
		);
		expect(result.query).toBe('trip');
		expect(result.after).toBe('2026-04-28');
		expect(result.before).toBe('2026-04-29');
	});

	it('both after and before present: same day → after == before start, valid since they are equal', () => {
		// after="2026-04-28" before="2026-04-28" — equal dates (not after > before)
		const result = extractSessionSearchTag(
			'<session-search query="x" after="2026-04-28" before="2026-04-28"/>',
		);
		expect(result.query).toBe('x');
		expect(result.after).toBe('2026-04-28');
		expect(result.before).toBe('2026-04-28');
	});

	it('case-insensitive tag name: <SESSION-SEARCH query="x" after="2026-04-21" before="2026-04-28"/>', () => {
		const result = extractSessionSearchTag(
			'<SESSION-SEARCH query="x" after="2026-04-21" before="2026-04-28"/>',
		);
		expect(result.query).toBe('x');
		expect(result.after).toBe('2026-04-21');
		expect(result.before).toBe('2026-04-28');
	});

	it('extra whitespace around attributes is handled', () => {
		const result = extractSessionSearchTag(
			'<session-search   query="x"  after="2026-04-21"   before="2026-04-28"  />',
		);
		expect(result.query).toBe('x');
		expect(result.after).toBe('2026-04-21');
		expect(result.before).toBe('2026-04-28');
	});
});

// ---------------------------------------------------------------------------
// Rejection: unknown attributes
// ---------------------------------------------------------------------------

describe('attribute parser — unknown attribute rejection', () => {
	it('<session-search query="x" foo="bar"/> → REJECTED (unknown attr)', () => {
		const result = extractSessionSearchTag('<session-search query="x" foo="bar"/>');
		expect(result.query).toBeNull();
		expect(result.after).toBeNull();
		expect(result.before).toBeNull();
		// entire response returned as beforeTag in rejectAll
		expect(result.beforeTag).toBe('<session-search query="x" foo="bar"/>');
		expect(result.raw).toBeNull();
	});

	it('unknown attr mixed with valid: query + unknown → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="pasta" unknown="value"/>');
		expect(result.query).toBeNull();
	});

	it('only unknown attrs → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search foo="bar" baz="qux"/>');
		expect(result.query).toBeNull();
	});

	it('stray unquoted text mixed with known attrs → REJECTED (full-coverage check)', () => {
		// "garbage" is unquoted text that ATTR_RE does not match → remainder is non-empty → reject
		const result = extractSessionSearchTag('<session-search query="pasta" garbage/>');
		expect(result.query).toBeNull();
	});

	it('unquoted attribute value → REJECTED (ATTR_RE requires quoted values)', () => {
		const result = extractSessionSearchTag('<session-search query="x" after=2026-04-28/>');
		expect(result.query).toBeNull();
	});

	it('attribute with no value → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="x" novalue/>');
		expect(result.query).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Rejection: duplicate attributes
// ---------------------------------------------------------------------------

describe('attribute parser — duplicate attribute rejection', () => {
	it('<session-search query="x" query="y"/> → REJECTED (duplicate query)', () => {
		const result = extractSessionSearchTag('<session-search query="x" query="y"/>');
		expect(result.query).toBeNull();
		expect(result.raw).toBeNull();
	});

	it('duplicate after attr → REJECTED', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" after="2026-04-21" after="2026-04-28"/>',
		);
		expect(result.query).toBeNull();
	});

	it('duplicate before attr → REJECTED', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" before="2026-04-21" before="2026-04-28"/>',
		);
		expect(result.query).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Rejection: calendar-invalid dates
// ---------------------------------------------------------------------------

describe('attribute parser — calendar-invalid date rejection', () => {
	it('<session-search query="x" after="2026-13-40"/> → REJECTED (invalid month/day)', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="2026-13-40"/>');
		expect(result.query).toBeNull();
	});

	it('invalid month in before: 2026-00-01 → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="x" before="2026-00-01"/>');
		expect(result.query).toBeNull();
	});

	it('Feb 30 does not exist: 2026-02-30 → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="2026-02-30"/>');
		expect(result.query).toBeNull();
	});

	it('non-ISO date string "yesterday" in after → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="yesterday"/>');
		expect(result.query).toBeNull();
	});

	it('valid leap year date 2024-02-29 → accepted', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="2024-02-29"/>');
		expect(result.query).toBe('x');
		expect(result.after).toBe('2024-02-29');
	});

	it('non-leap year 2025-02-29 → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query="x" after="2025-02-29"/>');
		expect(result.query).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Rejection: after > before constraint
// ---------------------------------------------------------------------------

describe('attribute parser — after > before rejection', () => {
	it('after > before: <session-search query="x" after="2026-04-29" before="2026-04-21"/> → REJECTED', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" after="2026-04-29" before="2026-04-21"/>',
		);
		expect(result.query).toBeNull();
	});

	it('after == before → accepted (same day window)', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" after="2026-04-28" before="2026-04-28"/>',
		);
		expect(result.query).toBe('x');
	});

	it('after < before → accepted', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x" after="2026-04-21" before="2026-04-28"/>',
		);
		expect(result.query).toBe('x');
	});
});

// ---------------------------------------------------------------------------
// Bidi / zero-width sanitization
// ---------------------------------------------------------------------------

describe('attribute parser — bidi/zero-width sanitization', () => {
	it('bidi override (U+202E) in query → stripped; if content remains, accepted', () => {
		const result = extractSessionSearchTag('<session-search query="‮hostile"/>');
		// After stripping bidi, "hostile" remains → accepted
		expect(result.query).toBe('hostile');
	});

	it('bidi-only query → null after sanitize', () => {
		const result = extractSessionSearchTag('<session-search query="‮"/>');
		expect(result.query).toBeNull();
	});

	it('zero-width space (U+200B) in query → stripped; content remains → accepted', () => {
		const result = extractSessionSearchTag('<session-search query="​pasta"/>');
		expect(result.query).toBe('pasta');
	});

	it('BOM (U+FEFF) in query → stripped', () => {
		const result = extractSessionSearchTag('<session-search query="﻿pasta"/>');
		expect(result.query).toBe('pasta');
	});
});

// ---------------------------------------------------------------------------
// Query length constraints
// ---------------------------------------------------------------------------

describe('attribute parser — query length constraints', () => {
	it('query exactly 200 chars → accepted', () => {
		const q200 = 'a'.repeat(200);
		const result = extractSessionSearchTag(`<session-search query="${q200}"/>`);
		expect(result.query).toBe(q200);
	});

	it('query > 200 chars → REJECTED', () => {
		const q201 = 'a'.repeat(201);
		const result = extractSessionSearchTag(`<session-search query="${q201}"/>`);
		expect(result.query).toBeNull();
	});

	it('empty query string → REJECTED', () => {
		const result = extractSessionSearchTag('<session-search query=""/>');
		expect(result.query).toBeNull();
	});

	it('query with only whitespace → REJECTED (trimmed to empty)', () => {
		const result = extractSessionSearchTag('<session-search query="   "/>');
		expect(result.query).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// No tag cases
// ---------------------------------------------------------------------------

describe('attribute parser — no tag cases', () => {
	it('no tag → query null, beforeTag is full response', () => {
		const text = 'This is a normal response.';
		const result = extractSessionSearchTag(text);
		expect(result.query).toBeNull();
		expect(result.after).toBeNull();
		expect(result.before).toBeNull();
		expect(result.beforeTag).toBe(text);
		expect(result.raw).toBeNull();
	});

	it('empty string → nulls', () => {
		const result = extractSessionSearchTag('');
		expect(result.query).toBeNull();
		expect(result.beforeTag).toBe('');
	});
});

// ---------------------------------------------------------------------------
// stripSessionSearchTags — backward-compat: still strips all shapes
// ---------------------------------------------------------------------------

describe('stripSessionSearchTags — still removes all shapes (Chunk H)', () => {
	it('strips well-formed tag with query only', () => {
		const result = stripSessionSearchTags('Text. <session-search query="pasta"/> More.');
		expect(result).not.toContain('<session-search');
	});

	it('strips tag with after+before attrs', () => {
		const result = stripSessionSearchTags(
			'Text. <session-search query="x" after="2026-04-28" before="2026-04-29"/> End.',
		);
		expect(result).not.toContain('<session-search');
		expect(result).toContain('Text.');
		expect(result).toContain('End.');
	});

	it('strips unknown-attr tag (rejected by parser but still stripped)', () => {
		const result = stripSessionSearchTags('<session-search query="x" foo="bar"/> text');
		expect(result).not.toContain('<session-search');
	});

	it('strips duplicate-attr tag', () => {
		const result = stripSessionSearchTags('<session-search query="x" query="y"/> text');
		expect(result).not.toContain('<session-search');
	});

	it('strips invalid-date tag', () => {
		const result = stripSessionSearchTags('<session-search query="x" after="bad-date"/> text');
		expect(result).not.toContain('<session-search');
	});

	it('is idempotent', () => {
		const text = 'Text. <session-search query="pasta" after="2026-04-28"/> More.';
		const once = stripSessionSearchTags(text);
		expect(stripSessionSearchTags(once)).toBe(once);
	});
});
