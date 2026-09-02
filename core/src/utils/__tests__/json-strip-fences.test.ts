import { describe, expect, it } from 'vitest';
import {
	RAW_PREVIEW_MAX_CHARS,
	UNPARSEABLE_JSON,
	classifyStructuredOutput,
	formatRawPreview,
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

describe('formatRawPreview', () => {
	it('quotes and escapes so a multi-line reply stays on one line', () => {
		expect(formatRawPreview('{"a":\n1}')).toBe('"{\\"a\\":\\n1}"');
		expect(formatRawPreview('{"a":\n1}')).not.toContain('\n');
	});

	it('caps at RAW_PREVIEW_MAX_CHARS by default', () => {
		// 200 chars of content + the two quotes JSON.stringify adds.
		expect(formatRawPreview('x'.repeat(500))).toHaveLength(RAW_PREVIEW_MAX_CHARS + 2);
	});

	it('honours an explicit cap', () => {
		expect(formatRawPreview('abcdef', 3)).toBe('"abc"');
	});

	it('escapes control characters rather than emitting them raw', () => {
		expect(formatRawPreview('a\u0007b')).toBe('"a\\u0007b"');
	});
});

describe('classifyStructuredOutput', () => {
	const ORDERS = ['check-length-first', 'parse-first'] as const;

	// ── Outcomes that must agree under BOTH orderings ─────────────────────────

	describe.each(ORDERS)('order=%s', (order) => {
		it('parses a complete valid reply', () => {
			expect(
				classifyStructuredOutput({ text: '{"a":1}', finishReason: 'stop' }, { order }),
			).toEqual({ kind: 'ok', value: { a: 1 } });
		});

		it('parses a fenced valid reply', () => {
			expect(
				classifyStructuredOutput(
					{ text: '```json\n{"a":1}\n```', finishReason: 'stop' },
					{ order },
				),
			).toEqual({ kind: 'ok', value: { a: 1 } });
		});

		// The motivating case for the whole helper: the budget ran out, so this is
		// truncation — NOT a model that emitted malformed JSON.
		it('classifies unparseable + finishReason "length" as truncated, not unparseable', () => {
			const raw = '{"score": 2, "explanation": "The reply g';
			expect(
				classifyStructuredOutput({ text: raw, finishReason: 'length' }, { order, maxTokens: 400 }),
			).toEqual({ kind: 'truncated', raw, maxTokens: 400 });
		});

		it('classifies unparseable + finishReason "stop" as unparseable', () => {
			expect(
				classifyStructuredOutput(
					{ text: 'not json at all', finishReason: 'stop' },
					{ order, maxTokens: 400 },
				),
			).toEqual({ kind: 'unparseable', raw: 'not json at all' });
		});

		it.each(['error', 'other'] as const)(
			'classifies unparseable + finishReason "%s" as unparseable',
			(finishReason) => {
				expect(classifyStructuredOutput({ text: '{oops', finishReason }, { order })).toEqual({
					kind: 'unparseable',
					raw: '{oops',
				});
			},
		);

		it('classifies an empty reply as empty', () => {
			expect(classifyStructuredOutput({ text: '', finishReason: 'stop' }, { order })).toEqual({
				kind: 'empty',
				raw: '',
			});
		});

		it('classifies a whitespace-only reply as empty', () => {
			expect(
				classifyStructuredOutput({ text: '  \n\t ', finishReason: 'stop' }, { order }),
			).toEqual({ kind: 'empty', raw: '  \n\t ' });
		});

		// Empty beats truncated under both orderings so the retry-on-empty policy
		// in recall-classifier / shadow-classifier keeps firing untouched.
		it('classifies an empty reply as empty even when finishReason is "length"', () => {
			expect(
				classifyStructuredOutput({ text: '', finishReason: 'length' }, { order, maxTokens: 80 }),
			).toEqual({ kind: 'empty', raw: '' });
		});

		it('omits maxTokens from a truncated result when the caller passed none', () => {
			const result = classifyStructuredOutput({ text: '{oops', finishReason: 'length' }, { order });
			expect(result).toEqual({ kind: 'truncated', raw: '{oops' });
			expect(result).not.toHaveProperty('maxTokens');
		});

		it('treats a fences-only reply as unparseable, not empty (it has content)', () => {
			// stripJsonFences reduces it to '', but the raw text is non-blank, so the
			// empty-retry path must NOT claim it.
			expect(
				classifyStructuredOutput({ text: '```json\n```', finishReason: 'stop' }, { order }),
			).toEqual({ kind: 'unparseable', raw: '```json\n```' });
		});
	});

	// ── The single input the two orderings must disagree on ───────────────────

	describe('a cap-truncated reply whose prefix DOES parse', () => {
		const meta = { text: '{"score": 5, "explanation": "ok"}', finishReason: 'length' as const };

		it("check-length-first distrusts it — a judge's cut-off reply is not a grade", () => {
			expect(
				classifyStructuredOutput(meta, { order: 'check-length-first', maxTokens: 1024 }),
			).toEqual({ kind: 'truncated', raw: meta.text, maxTokens: 1024 });
		});

		it('parse-first accepts it — the closed schema is complete by construction', () => {
			expect(classifyStructuredOutput(meta, { order: 'parse-first', maxTokens: 80 })).toEqual({
				kind: 'ok',
				value: { score: 5, explanation: 'ok' },
			});
		});
	});

	it('check-length-first does not parse at all when the reply was cut at the cap', () => {
		// A shorter-but-valid array is the dangerous case: it parses cleanly while
		// silently dropping the user's trailing request.
		const raw = '{"segments":["book a table","remind me to"]}';
		expect(
			classifyStructuredOutput(
				{ text: raw, finishReason: 'length' },
				{ order: 'check-length-first', maxTokens: 400 },
			),
		).toEqual({ kind: 'truncated', raw, maxTokens: 400 });
	});

	it('tolerates a provider that reports no text at all', () => {
		expect(
			classifyStructuredOutput(
				{ text: undefined as unknown as string, finishReason: 'length' },
				{ order: 'parse-first' },
			),
		).toEqual({ kind: 'empty', raw: '' });
	});
});
