/**
 * Tests for buildToolContinuationPrompt — verifies that the result fence
 * opening tag is well-formed XML (no embedded quotes in label attribute).
 */

import { describe, expect, it } from 'vitest';
import { buildToolContinuationPrompt } from '../tool-continuation-prompt.js';

describe('buildToolContinuationPrompt — result fence is well-formed', () => {
	it('produces a well-formed <memory-context label="session-search-result"> opening tag (no embedded quotes)', () => {
		const output = buildToolContinuationPrompt({
			userMessage: 'what did we say about pasta',
			assistantPreTag: '',
			toolQuery: 'pasta',
			toolResult: [],
		});
		// The opening tag must be exactly this form — no query/after/before embedded in label
		expect(output).toContain('<memory-context label="session-search-result">');
		// Must NOT produce a broken label like label="session-search-result query="pasta""
		expect(output).not.toMatch(/label="session-search-result\s+query=/);
	});

	it('puts query in the fenced body, not the label attribute', () => {
		const output = buildToolContinuationPrompt({
			userMessage: 'what did we say about pasta',
			assistantPreTag: '',
			toolQuery: 'pasta',
			toolResult: [],
		});
		// metadata header with query is inside the fence body
		expect(output).toContain('query="pasta"');
		// The result fence opening tag uses the plain label — find it specifically
		expect(output).toContain('<memory-context label="session-search-result">');
		// Make sure it's not embedded in the label like label="session-search-result query="pasta""
		const resultFenceTagMatch = output.match(/<memory-context label="(session-search-result)">/);
		expect(resultFenceTagMatch?.[1]).toBe('session-search-result');
	});

	it('surfaces after/before in the fenced body when provided', () => {
		const output = buildToolContinuationPrompt({
			userMessage: 'what did we say last Tuesday about pizza',
			assistantPreTag: '',
			toolQuery: 'pizza',
			toolResult: [],
			toolAfter: '2026-04-28',
			toolBefore: '2026-04-28',
		});
		// after/before in body, not label
		expect(output).toContain('after="2026-04-28"');
		expect(output).toContain('before="2026-04-28"');
		// Still a clean label
		expect(output).toContain('<memory-context label="session-search-result">');
	});

	it('escapes special characters in query for the body header', () => {
		const output = buildToolContinuationPrompt({
			userMessage: 'search',
			assistantPreTag: '',
			toolQuery: 'a "quoted" term',
			toolResult: [],
		});
		// query value is HTML-escaped in the metadata header
		expect(output).toContain('query="a &quot;quoted&quot; term"');
		// The label attribute remains clean
		expect(output).toContain('<memory-context label="session-search-result">');
	});
});
