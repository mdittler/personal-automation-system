/**
 * Unit tests for session-search tag parser and stripper.
 *
 * Tests:
 *   - extractSessionSearchTag: parse self-closing tag, return query/beforeTag/raw
 *   - stripSessionSearchTags: always-safe sweeper removing all tag shapes
 *
 * REQ-CONV-TOOL-SEARCH-002, REQ-CONV-TOOL-SEARCH-003, REQ-CONV-TOOL-SEARCH-004,
 * REQ-CONV-TOOL-SEARCH-012
 */

import { describe, expect, it } from 'vitest';
import { extractSessionSearchTag, stripSessionSearchTags } from '../session-search-tag.js';

// ---------------------------------------------------------------------------
// extractSessionSearchTag — happy path
// ---------------------------------------------------------------------------

describe('extractSessionSearchTag — happy path', () => {
	it('extracts simple self-closing tag <session-search query="pasta"/>', () => {
		const result = extractSessionSearchTag('Let me search. <session-search query="pasta"/>');
		expect(result.query).toBe('pasta');
	});

	it('returns beforeTag as the prose before the tag', () => {
		const result = extractSessionSearchTag(
			'Here is some prose. <session-search query="groceries"/>',
		);
		expect(result.beforeTag).toBe('Here is some prose. ');
	});

	it('returns raw as the original matched tag text', () => {
		const result = extractSessionSearchTag('Text before. <session-search query="dinner"/>');
		expect(result.raw).toBe('<session-search query="dinner"/>');
	});

	it('accepts case variation: <SESSION-SEARCH query="x"/> is matched', () => {
		const result = extractSessionSearchTag('Text. <SESSION-SEARCH query="x"/>');
		expect(result.query).toBe('x');
		expect(result.raw).toBe('<SESSION-SEARCH query="x"/>');
	});

	it('accepts whitespace variation: extra spaces around attributes', () => {
		const result = extractSessionSearchTag('Text. <session-search   query="x"  />');
		expect(result.query).toBe('x');
	});

	it('strips FTS highlight and leading/trailing whitespace from query', () => {
		const result = extractSessionSearchTag('<session-search query="  pasta  "/>');
		expect(result.query).toBe('pasta');
	});

	it('query with multiple words preserved', () => {
		const result = extractSessionSearchTag('<session-search query="pasta carbonara"/>');
		expect(result.query).toBe('pasta carbonara');
	});

	it('beforeTag has any trailing tag shapes stripped via stripSessionSearchTags', () => {
		// If there were a straggler tag in the beforeTag region, it would be stripped
		const result = extractSessionSearchTag('Normal prose. <session-search query="x"/>');
		expect(result.beforeTag).not.toContain('<session-search');
	});
});

// ---------------------------------------------------------------------------
// extractSessionSearchTag — edge cases
// ---------------------------------------------------------------------------

describe('extractSessionSearchTag — edge cases', () => {
	it('no tag in response → query: null, beforeTag: full response, raw: null', () => {
		const response = 'This response has no search tag in it at all.';
		const result = extractSessionSearchTag(response);
		expect(result.query).toBeNull();
		expect(result.beforeTag).toBe(response);
		expect(result.raw).toBeNull();
	});

	it('empty response → query: null, beforeTag: empty string', () => {
		const result = extractSessionSearchTag('');
		expect(result.query).toBeNull();
		expect(result.beforeTag).toBe('');
		expect(result.raw).toBeNull();
	});

	it('multiple tags → first match wins, subsequent shapes stripped from beforeTag', () => {
		const response =
			'Before. <session-search query="first"/> Middle. <session-search query="second"/>';
		const result = extractSessionSearchTag(response);
		expect(result.query).toBe('first');
		// beforeTag is text before the FIRST tag; "second" tag shape should be gone
		expect(result.beforeTag).not.toContain('<session-search');
	});

	it('paired form <session-search query="x"></session-search> → query: null (not supported)', () => {
		const result = extractSessionSearchTag('<session-search query="x"></session-search>');
		expect(result.query).toBeNull();
	});

	it('paired form stripped: no session-search tag remains in beforeTag after extraction', () => {
		const result = extractSessionSearchTag(
			'<session-search query="x"></session-search> trailing text',
		);
		expect(result.beforeTag).not.toContain('session-search');
	});

	it('tag at beginning: beforeTag is empty string', () => {
		const result = extractSessionSearchTag('<session-search query="pasta"/>');
		expect(result.query).toBe('pasta');
		expect(result.beforeTag).toBe('');
	});

	it('tag at end: beforeTag is text before it', () => {
		const response = 'I will search for that now.\n<session-search query="pasta"/>';
		const result = extractSessionSearchTag(response);
		expect(result.query).toBe('pasta');
		expect(result.beforeTag.trim()).toBe('I will search for that now.');
	});
});

// ---------------------------------------------------------------------------
// extractSessionSearchTag — security / rejection
// ---------------------------------------------------------------------------

describe('extractSessionSearchTag — security', () => {
	it('query containing " character — ATTR_RE stops at first ", content before " is extracted', () => {
		// Double quote ends the attribute value. The attribute parser (Chunk H) reads key="value"
		// where ATTR_RE stops at the first unescaped ". For query="break "here"", the extracted
		// value is "break" — the embedded " acts as a terminator, not a security bypass.
		// The outer TAG_OUTER regex still matches the self-closing form.
		const result = extractSessionSearchTag('<session-search query="break "here""/>');
		// The query up to the first " is extracted: "break" (after trim)
		expect(result.query).toBe('break');
	});

	it('query containing < character → null (regex rejects via [^<>] class)', () => {
		const result = extractSessionSearchTag('<session-search query="bad<injection"/>');
		expect(result.query).toBeNull();
	});

	it('query containing > character → null (regex rejects via [^<>] class)', () => {
		const result = extractSessionSearchTag('<session-search query="bad>injection"/>');
		expect(result.query).toBeNull();
	});

	it('query > 200 chars → null (regex {1,200} enforces)', () => {
		const longQuery = 'a'.repeat(201);
		const result = extractSessionSearchTag(`<session-search query="${longQuery}"/>`);
		expect(result.query).toBeNull();
	});

	it('query exactly 200 chars → accepted', () => {
		const query200 = 'a'.repeat(200);
		const result = extractSessionSearchTag(`<session-search query="${query200}"/>`);
		expect(result.query).toBe(query200);
	});

	it('query empty string (after regex match) → null', () => {
		// Empty string in query attr — regex {1,200} requires at least 1 char
		const result = extractSessionSearchTag('<session-search query=""/>');
		expect(result.query).toBeNull();
	});

	it('query with only zero-width chars → null after sanitize', () => {
		// U+200B zero-width space, U+FEFF BOM — stripped by sanitizer → empty → null
		const zwsp = '​﻿';
		const result = extractSessionSearchTag(`<session-search query="${zwsp}"/>`);
		// The regex won't match these chars through [^"<>]{1,200} only if they ARE matched
		// by the regex but then sanitized away → null
		expect(result.query).toBeNull();
	});

	it('malformed tag (missing query attribute) → null, shape removed from beforeTag', () => {
		const result = extractSessionSearchTag('Text. <session-search/> more text.');
		expect(result.query).toBeNull();
		expect(result.beforeTag).not.toContain('<session-search');
	});

	it('malformed tag with unknown attribute → null, shape NOT pre-stripped from beforeTag', () => {
		// Chunk H: rejectAll() returns beforeTag: response (full response) so callers can
		// use stripSessionSearchTags() on the final working response via the else-path.
		const result = extractSessionSearchTag('<session-search foo="bar"/> text');
		expect(result.query).toBeNull();
		expect(result.raw).toBeNull();
		// beforeTag is the full response (including the tag shape); the caller strips via stripSessionSearchTags
		expect(result.beforeTag).toBe('<session-search foo="bar"/> text');
	});

	it('query containing ONLY bidi override (U+202E) → null after sanitize', () => {
		// RTL override char is stripped by sanitizer → empty string → null
		const result = extractSessionSearchTag('<session-search query="‮"/>');
		expect(result.query).toBeNull();
	});

	it('query with bidi prefix mixed with real content → bidi stripped, content kept', () => {
		// Bidi stripped but "pasta" remains → non-null query
		const result = extractSessionSearchTag('<session-search query="‮pasta"/>');
		expect(result.query).toBe('pasta');
	});
});

// ---------------------------------------------------------------------------
// stripSessionSearchTags — invariants
// ---------------------------------------------------------------------------

describe('stripSessionSearchTags — invariants', () => {
	it('removes a well-formed self-closing tag', () => {
		const result = stripSessionSearchTags(
			'Text before. <session-search query="pasta"/> Text after.',
		);
		expect(result).not.toContain('<session-search');
		expect(result).toContain('Text before.');
		expect(result).toContain('Text after.');
	});

	it('removes malformed shape (<session-search foo />)', () => {
		const result = stripSessionSearchTags('Text. <session-search foo="bar" /> More.');
		expect(result).not.toContain('<session-search');
	});

	it('removes paired form opening tag (<session-search>...)', () => {
		const result = stripSessionSearchTags('Text. <session-search query="x"></session-search> End.');
		expect(result).not.toContain('<session-search');
		expect(result).not.toContain('</session-search>');
	});

	it('removes tag without closing slash (<session-search query="x">)', () => {
		const result = stripSessionSearchTags('Pre. <session-search query="x"> Post.');
		expect(result).not.toContain('<session-search');
	});

	it('is idempotent: applying twice gives same result as once', () => {
		const text = 'Text. <session-search query="pasta"/> More.';
		const once = stripSessionSearchTags(text);
		const twice = stripSessionSearchTags(once);
		expect(twice).toBe(once);
	});

	it('preserves surrounding text when removing tag', () => {
		const result = stripSessionSearchTags('Hello world. <session-search query="test"/> Goodbye.');
		expect(result).toContain('Hello world.');
		expect(result).toContain('Goodbye.');
	});

	it('no-op on text with no session-search tag', () => {
		const text = 'Normal response with no tags.';
		expect(stripSessionSearchTags(text)).toBe(text);
	});

	it('removes multiple tags in one pass', () => {
		const text = '<session-search query="a"/> Middle. <session-search query="b"/>';
		const result = stripSessionSearchTags(text);
		expect(result).not.toContain('<session-search');
		expect(result).toContain('Middle.');
	});

	it('handles empty string without throwing', () => {
		expect(() => stripSessionSearchTags('')).not.toThrow();
		expect(stripSessionSearchTags('')).toBe('');
	});

	it('case-insensitive: strips <SESSION-SEARCH .../>', () => {
		const result = stripSessionSearchTags('Text. <SESSION-SEARCH query="x"/> More.');
		expect(result).not.toContain('SESSION-SEARCH');
	});
});
