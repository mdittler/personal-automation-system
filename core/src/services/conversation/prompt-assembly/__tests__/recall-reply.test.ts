/**
 * Tests for recall-reply.ts (Chunk H).
 *
 * Covers:
 *  - formatTurnTimestamp: happy path, edge cases, malformed input
 *  - formatRecallReply: per-turn line includes formatted timestamp
 *
 * REQ-CONV-RECALL-005, REQ-CONV-RECALL-006
 */

import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../../chat-transcript-index/index.js';
import { formatRecallReply, formatTurnTimestamp } from '../recall-reply.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
	return {
		sessionId: 'sess-001',
		sessionStartedAt: '2026-04-28T10:00:00.000Z',
		sessionEndedAt: null,
		title: null,
		matches: [
			{
				turn_index: 1,
				role: 'user',
				timestamp: '2026-04-28T14:32:00.000Z',
				snippet: 'Test snippet content',
				bm25: -0.5,
			},
		],
		...overrides,
	};
}

// ─── formatTurnTimestamp ──────────────────────────────────────────────────────

describe('formatTurnTimestamp', () => {
	it('formats 2026-04-28T14:32:00.000Z → "Tue 2026-04-28 14:32 UTC"', () => {
		expect(formatTurnTimestamp('2026-04-28T14:32:00.000Z')).toBe('Tue 2026-04-28 14:32 UTC');
	});

	it('formats 2026-12-31T23:59:00.000Z → "Thu 2026-12-31 23:59 UTC"', () => {
		expect(formatTurnTimestamp('2026-12-31T23:59:00.000Z')).toBe('Thu 2026-12-31 23:59 UTC');
	});

	it('formats 2026-01-01T00:00:00.000Z → "Thu 2026-01-01 00:00 UTC"', () => {
		expect(formatTurnTimestamp('2026-01-01T00:00:00.000Z')).toBe('Thu 2026-01-01 00:00 UTC');
	});

	it('formats 2026-03-23T09:05:00.000Z (Monday) → "Mon 2026-03-23 09:05 UTC"', () => {
		expect(formatTurnTimestamp('2026-03-23T09:05:00.000Z')).toBe('Mon 2026-03-23 09:05 UTC');
	});

	it('formats a Saturday correctly', () => {
		// 2026-05-02 is a Saturday
		expect(formatTurnTimestamp('2026-05-02T08:00:00.000Z')).toBe('Sat 2026-05-02 08:00 UTC');
	});

	it('formats a Sunday correctly', () => {
		// 2026-05-03 is a Sunday
		expect(formatTurnTimestamp('2026-05-03T12:30:00.000Z')).toBe('Sun 2026-05-03 12:30 UTC');
	});

	it('handles midnight edge: 2026-04-28T00:00:00.000Z', () => {
		expect(formatTurnTimestamp('2026-04-28T00:00:00.000Z')).toBe('Tue 2026-04-28 00:00 UTC');
	});

	it('returns "unknown time" for malformed input', () => {
		expect(formatTurnTimestamp('not-a-date')).toBe('unknown time');
	});

	it('returns "unknown time" for empty string', () => {
		expect(formatTurnTimestamp('')).toBe('unknown time');
	});

	it('returns "unknown time" for partial ISO string "2026-04-28"', () => {
		// A date-only string without time — NaN or invalid in strict ISO parsing
		expect(formatTurnTimestamp('2026-04-28')).toBe('unknown time');
	});

	it('returns "unknown time" for completely wrong input like "yesterday"', () => {
		expect(formatTurnTimestamp('yesterday')).toBe('unknown time');
	});

	it('returns "unknown time" for datetime without Z suffix: "2026-04-28T14:32:00"', () => {
		expect(formatTurnTimestamp('2026-04-28T14:32:00')).toBe('unknown time');
	});

	it('returns "unknown time" for non-UTC offset: "2026-04-28T14:32:00+05:30"', () => {
		expect(formatTurnTimestamp('2026-04-28T14:32:00+05:30')).toBe('unknown time');
	});

	it('all day-of-week abbreviations are 3 letters', () => {
		const dates = [
			'2026-04-27T00:00:00.000Z', // Mon
			'2026-04-28T00:00:00.000Z', // Tue
			'2026-04-29T00:00:00.000Z', // Wed
			'2026-04-30T00:00:00.000Z', // Thu
			'2026-05-01T00:00:00.000Z', // Fri
			'2026-05-02T00:00:00.000Z', // Sat
			'2026-05-03T00:00:00.000Z', // Sun
		];
		const expectedDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
		for (const [i, date] of dates.entries()) {
			const ts = formatTurnTimestamp(date);
			expect(ts.slice(0, 3)).toBe(expectedDays[i]);
		}
	});
});

// ─── formatRecallReply — per-turn timestamp ────────────────────────────────────

describe('formatRecallReply — per-turn timestamp format', () => {
	it('renders turn line with formatTurnTimestamp format "Tue 2026-04-28 14:32 UTC"', () => {
		const hits = [makeHit()];
		const result = formatRecallReply(hits, ['test']);
		expect(result).toContain('Tue 2026-04-28 14:32 UTC');
	});

	it('includes timestamp in italic format: > _<timestamp> — <Role>_: <snippet>', () => {
		const hits = [makeHit()];
		const result = formatRecallReply(hits, ['test']);
		// Should match the pattern: "> _Tue 2026-04-28 14:32 UTC — You_: ..."
		expect(result).toMatch(/> _Tue 2026-04-28 14:32 UTC — You_:/);
	});

	it('handles assistant role correctly in timestamp line', () => {
		const hits = [
			makeHit({
				matches: [
					{
						turn_index: 2,
						role: 'assistant',
						timestamp: '2026-04-28T14:32:00.000Z',
						snippet: 'Assistant reply here',
						bm25: -0.4,
					},
				],
			}),
		];
		const result = formatRecallReply(hits, ['test']);
		expect(result).toContain('Tue 2026-04-28 14:32 UTC — Assistant');
	});

	it('handles empty timestamp gracefully: renders "unknown time"', () => {
		const hits = [
			makeHit({
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: '',
						snippet: 'Some content',
						bm25: -0.5,
					},
				],
			}),
		];
		const result = formatRecallReply(hits, ['test']);
		expect(result).toContain('unknown time');
	});

	it('handles malformed timestamp gracefully: renders "unknown time"', () => {
		const hits = [
			makeHit({
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: 'not-a-timestamp',
						snippet: 'Some content',
						bm25: -0.5,
					},
				],
			}),
		];
		const result = formatRecallReply(hits, ['test']);
		expect(result).toContain('unknown time');
	});

	it('session header still shows date (YYYY-MM-DD format)', () => {
		const hits = [makeHit()];
		const result = formatRecallReply(hits, ['test']);
		// Session header should contain the date from sessionStartedAt
		expect(result).toContain('2026-04-28');
	});

	it('strip FTS highlights: [test] in snippet → test in output', () => {
		const hits = [
			makeHit({
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: '2026-04-28T14:32:00.000Z',
						snippet: 'I am looking for [test] content',
						bm25: -0.5,
					},
				],
			}),
		];
		const result = formatRecallReply(hits, ['test']);
		// FTS highlight brackets should be stripped
		expect(result).not.toContain('[test]');
		expect(result).toContain('test');
	});

	it('multiple turns each get timestamp line', () => {
		const hits = [
			makeHit({
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: '2026-04-28T14:32:00.000Z',
						snippet: 'First turn',
						bm25: -0.5,
					},
					{
						turn_index: 2,
						role: 'assistant',
						timestamp: '2026-04-29T09:00:00.000Z',
						snippet: 'Second turn',
						bm25: -0.4,
					},
				],
			}),
		];
		const result = formatRecallReply(hits, ['turn']);
		expect(result).toContain('Tue 2026-04-28 14:32 UTC');
		expect(result).toContain('Wed 2026-04-29 09:00 UTC');
	});
});
