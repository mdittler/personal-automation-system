/**
 * Tests for parseRecallVerdict (Hermes P6 Chunk F).
 *
 * All tests use today = '2026-05-05'.
 *
 * Covers: TimeAnchor validation, calendar-strict enforcement, window bounds,
 * legacy timeWindow clean break, top-level extra fields, edge cases.
 */

import { describe, expect, it } from 'vitest';
import { parseRecallVerdict, RECALL_SAFE_DEFAULT } from '../recall-classifier.js';

const TODAY = '2026-05-05';

function parse(obj: unknown) {
	return parseRecallVerdict(obj, { today: TODAY });
}

// ── Happy-path accepted cases ────────────────────────────────────────────────

describe('parseRecallVerdict — accepted cases', () => {
	it('accepts shouldRecall=true, query, timeAnchor: null', () => {
		const result = parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: null,
			reason: 'ok',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('food');
		expect(result.timeAnchor).toBeNull();
		expect(result.reason).toBe('ok');
	});

	it('accepts absolute anchor on a valid past date', () => {
		const result = parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-04-28' },
			reason: 'ok',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({ type: 'absolute', on: '2026-04-28' });
	});

	it('accepts window anchor with both after and before', () => {
		const result = parse({
			shouldRecall: true,
			query: 'trip',
			timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22' },
			reason: 'ok',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({ type: 'window', after: '2026-04-14', before: '2026-04-22' });
	});

	it('accepts window anchor with only after', () => {
		const result = parse({
			shouldRecall: true,
			query: 'plan',
			timeAnchor: { type: 'window', after: '2026-04-01' },
			reason: 'ok',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({ type: 'window', after: '2026-04-01' });
	});

	it('accepts window anchor with only before (in the past)', () => {
		const result = parse({
			shouldRecall: true,
			query: 'plan',
			timeAnchor: { type: 'window', before: '2026-04-30' },
			reason: 'ok',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({ type: 'window', before: '2026-04-30' });
	});

	it('accepts absolute anchor on a real leap-year date: 2024-02-29 (with large maxWindowDays to isolate calendar check)', () => {
		// 2024-02-29 is ~796 days before today=2026-05-05, which exceeds the default 365-day window.
		// Use maxWindowDays=1000 to isolate the calendar-strict check from the temporal-boundary check.
		const result = parseRecallVerdict(
			{ shouldRecall: true, query: 'food', timeAnchor: { type: 'absolute', on: '2024-02-29' }, reason: 'leap year' },
			{ today: TODAY, maxWindowDays: 1000 },
		);
		expect(result.shouldRecall).toBe(true);
		expect(result.timeAnchor).toEqual({ type: 'absolute', on: '2024-02-29' });
	});

	it('accepts top-level extra field (tolerated, not rejected)', () => {
		const result = parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: null,
			reason: 'ok',
			foo: 'bar',
		});
		expect(result.shouldRecall).toBe(true);
		expect(result.query).toBe('food');
	});

	it('accepts shouldRecall=false with null query and null timeAnchor', () => {
		const result = parse({
			shouldRecall: false,
			query: null,
			timeAnchor: null,
			reason: 'no recall intent',
		});
		expect(result.shouldRecall).toBe(false);
		expect(result.query).toBeNull();
		expect(result.timeAnchor).toBeNull();
	});
});

// ── Absolute anchor rejections ───────────────────────────────────────────────

describe('parseRecallVerdict — absolute anchor rejections', () => {
	it('rejects calendar-invalid date: 2026-13-40', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-13-40' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects calendar-invalid date: 2026-02-30 (Feb has no 30th)', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-02-30' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects non-leap-year Feb 29: 2025-02-29', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2025-02-29' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects Apr 31: 2026-04-31', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-04-31' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects natural-language "yesterday"', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: 'yesterday' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects missing "on" field', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects future date: 2026-05-06 (today is 2026-05-05)', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-05-06' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects date >365d before today: 2025-04-28', () => {
		// 2025-04-28 is 372 days before 2026-05-05
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2025-04-28' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects extra field in absolute anchor object', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'absolute', on: '2026-04-28', foo: 'bar' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});
});

// ── Window anchor rejections ─────────────────────────────────────────────────

describe('parseRecallVerdict — window anchor rejections', () => {
	it('rejects before-only window where before is in the future', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'window', before: '2027-01-01' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects after-only window where after is in the future', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'window', after: '2027-01-01' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects window span >365 days: after=2024-01-01, before=2026-01-01', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'window', after: '2024-01-01', before: '2026-01-01' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects after > before: after=2026-04-28, before=2026-04-21', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'window', after: '2026-04-28', before: '2026-04-21' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects extra field in window anchor object', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22', extra: 1 },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});
});

// ── Legacy clean break ───────────────────────────────────────────────────────

describe('parseRecallVerdict — legacy timeWindow clean break', () => {
	it('rejects legacy timeAnchor: "recent" string (P5 format)', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: 'recent',
			reason: 'legacy',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects legacy timeAnchor: "older" string', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: 'older',
			reason: 'legacy',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects unknown type: { type: "unknown", on: "2026-04-30" }', () => {
		expect(parse({
			shouldRecall: true,
			query: 'food',
			timeAnchor: { type: 'unknown', on: '2026-04-30' },
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});
});

// ── Top-level field validation ───────────────────────────────────────────────

describe('parseRecallVerdict — top-level field validation', () => {
	it('rejects empty query string', () => {
		expect(parse({
			shouldRecall: true,
			query: '',
			timeAnchor: null,
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects 201-char query string', () => {
		expect(parse({
			shouldRecall: true,
			query: 'a'.repeat(201),
			timeAnchor: null,
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects non-JSON raw value (string)', () => {
		expect(parseRecallVerdict('not json', { today: TODAY })).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects shouldRecall as string "true"', () => {
		expect(parse({
			shouldRecall: 'true',
			query: 'food',
			timeAnchor: null,
			reason: 'bad',
		})).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects null input', () => {
		expect(parse(null)).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('rejects array input', () => {
		expect(parse([{ shouldRecall: false }])).toEqual(RECALL_SAFE_DEFAULT);
	});
});
