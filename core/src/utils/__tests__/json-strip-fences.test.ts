import { describe, expect, it } from 'vitest';
import {
	UNPARSEABLE_JSON,
	stripJsonFences,
	tryParseJsonStripFences,
} from '../json-strip-fences.js';

describe('stripJsonFences', () => {
	it('strips ```json ... ``` fences', () => {
		expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
	});

	it('strips bare ``` fences without language tag', () => {
		expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
	});

	it('is case-insensitive on the json tag', () => {
		expect(stripJsonFences('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
	});

	it('returns the trimmed input when no fences are present', () => {
		expect(stripJsonFences('  {"a":1}  ')).toBe('{"a":1}');
	});

	it('handles an opening fence with no closing fence', () => {
		expect(stripJsonFences('```json\n{"a":1}')).toBe('{"a":1}');
	});

	it('handles a closing fence with no opening fence', () => {
		expect(stripJsonFences('{"a":1}\n```')).toBe('{"a":1}');
	});

	it('returns empty string for empty input', () => {
		expect(stripJsonFences('')).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(stripJsonFences('   \n  ')).toBe('');
	});

	it('returns empty string for fences-only input', () => {
		expect(stripJsonFences('```json\n```')).toBe('');
	});
});

describe('tryParseJsonStripFences', () => {
	it('parses fenced JSON object', () => {
		expect(tryParseJsonStripFences('```json\n{"verdict":"continue"}\n```')).toEqual({
			verdict: 'continue',
		});
	});

	it('parses unfenced JSON object', () => {
		expect(tryParseJsonStripFences('{"verdict":"reset"}')).toEqual({ verdict: 'reset' });
	});

	it('parses JSON array', () => {
		expect(tryParseJsonStripFences('[1, 2, 3]')).toEqual([1, 2, 3]);
	});

	it('parses JSON scalar number', () => {
		expect(tryParseJsonStripFences('42')).toBe(42);
	});

	it('parses JSON scalar string', () => {
		expect(tryParseJsonStripFences('"hello"')).toBe('hello');
	});

	it('parses JSON null', () => {
		expect(tryParseJsonStripFences('null')).toBeNull();
	});

	it('parses JSON boolean', () => {
		expect(tryParseJsonStripFences('true')).toBe(true);
	});

	it('returns UNPARSEABLE_JSON for empty input', () => {
		expect(tryParseJsonStripFences('')).toBe(UNPARSEABLE_JSON);
	});

	it('returns UNPARSEABLE_JSON for whitespace-only input', () => {
		expect(tryParseJsonStripFences('   \n  ')).toBe(UNPARSEABLE_JSON);
	});

	it('returns UNPARSEABLE_JSON for fences-only input', () => {
		expect(tryParseJsonStripFences('```json\n```')).toBe(UNPARSEABLE_JSON);
	});

	it('returns UNPARSEABLE_JSON for malformed JSON', () => {
		expect(tryParseJsonStripFences('{not valid json')).toBe(UNPARSEABLE_JSON);
	});

	it('returns UNPARSEABLE_JSON when trailing prose follows valid JSON', () => {
		// JSON.parse rejects trailing content; we do not attempt salvage.
		expect(tryParseJsonStripFences('{"a":1} and then prose')).toBe(UNPARSEABLE_JSON);
	});

	it('returns UNPARSEABLE_JSON for a degenerate Gemma token-repetition tail', () => {
		// Real-world failure mode: Gemma 26b emits opening {"score":N,"explanation":...
		// then loops on whitespace/words. Without a closing brace, JSON.parse fails.
		const broken = '{"score": 0, "score_explanation":  \n\n\n\n\n\n\n\n  \n\n  1.0  \n\n  \n\n  ';
		expect(tryParseJsonStripFences(broken)).toBe(UNPARSEABLE_JSON);
	});
});
