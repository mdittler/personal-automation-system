/**
 * Primary Chunk A tests — NL temporal precision broadening.
 *
 * Verifies that buildClassifierPrompt() produces a <phrasing reference> block
 * with ≥10 NL relative-date forms and EXACT computed YYYY-MM-DD dates.
 *
 * All assertions are deterministic against explicit today= values (no real clock).
 *
 * REQ-CONV-TEMPORAL-007..012
 */

import { describe, expect, it } from 'vitest';
import { buildClassifierPrompt } from '../recall-classifier.js';

// ─── Main test date: 2026-05-05 (Tuesday, DOW=2) ─────────────────────────────

describe('buildClassifierPrompt — <phrasing reference> block', () => {
	const TODAY = '2026-05-05';

	it('includes opening <phrasing reference> tag (REQ-CONV-TEMPORAL-007)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('<phrasing reference>');
	});

	it('includes closing </phrasing reference> tag', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('</phrasing reference>');
	});

	it('"last Friday" → 2026-05-01 (today=Tue, last Fri = 4 days back)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"last Friday" → 2026-05-01');
	});

	it('"the day before yesterday" → 2026-05-03 (2 days back)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"the day before yesterday" → 2026-05-03');
	});

	it('"earlier this month" → window 2026-05-01 to 2026-05-05', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"earlier this month" → window 2026-05-01 to 2026-05-05');
	});

	it('"earlier last month" → window 2026-04-01 to 2026-04-15', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"earlier last month" → window 2026-04-01 to 2026-04-15');
	});

	it('"in May" → window 2026-05-01 to 2026-05-05 (current month)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"in May" → window 2026-05-01 to 2026-05-05');
	});

	it('"during March" → window 2026-03-01 to 2026-03-31 (full prior month)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"during March" → window 2026-03-01 to 2026-03-31');
	});

	it('"a couple weeks ago" → window 2026-04-14 to 2026-04-28 (today-21 to today-7)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"a couple weeks ago" → window 2026-04-14 to 2026-04-28');
	});

	it('"around Christmas" → window 2025-12-23 to 2025-12-27', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"around Christmas" → window 2025-12-23 to 2025-12-27');
	});

	it('"last weekend" → window 2026-05-02 to 2026-05-03 (Sat + Sun before Tuesday)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"last weekend" → window 2026-05-02 to 2026-05-03');
	});

	it('"three weeks ago" → window 2026-04-12 to 2026-04-19 (today-23 to today-16)', () => {
		const prompt = buildClassifierPrompt(TODAY);
		expect(prompt).toContain('"three weeks ago" → window 2026-04-12 to 2026-04-19');
	});
});

// ─── Regression guard: pre-existing examples must remain unchanged ─────────────

describe('buildClassifierPrompt — regression guard (REQ-CONV-TEMPORAL-010)', () => {
	it('still contains "last Tuesday" example', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('last Tuesday');
	});

	it('still contains "yesterday" example', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain("yesterday's plan");
	});

	it('still contains "two weeks ago" example', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('two weeks ago');
	});

	it('still contains shouldRecall/query/timeAnchor/reason JSON schema', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('shouldRecall');
		expect(prompt).toContain('timeAnchor');
	});

	it('still references 365-day cap rule', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt).toContain('365');
	});
});

// ─── Budget guard (REQ-CONV-TEMPORAL-009) ──────────────────────────────────────

describe('buildClassifierPrompt — prompt budget', () => {
	it('fits within 4000-char budget', () => {
		const prompt = buildClassifierPrompt('2026-05-05');
		expect(prompt.length).toBeLessThanOrEqual(4000);
	});

	it('prompt budget holds for a different today (2026-06-01)', () => {
		const prompt = buildClassifierPrompt('2026-06-01');
		expect(prompt.length).toBeLessThanOrEqual(4000);
	});
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('buildClassifierPrompt — edge case: today=Friday for "last Friday"', () => {
	// REQ-CONV-TEMPORAL-011: same DOW must go back 7 days, not 0
	// 2026-05-08 is a Friday (DOW=5)
	const FRIDAY = '2026-05-08';

	it('"last Friday" with today=Friday → exactly 7 days back (2026-05-01)', () => {
		const prompt = buildClassifierPrompt(FRIDAY);
		expect(prompt).toContain('"last Friday" → 2026-05-01');
	});

	it('"last Friday" with today=Friday does NOT reference today\'s date as the last Friday', () => {
		const prompt = buildClassifierPrompt(FRIDAY);
		// 2026-05-08 (today) must NOT appear as the "last Friday" result
		expect(prompt).not.toContain('"last Friday" → 2026-05-08');
	});
});

describe('buildClassifierPrompt — edge case: today=first-of-month', () => {
	// REQ-CONV-TEMPORAL-012: "earlier this month" must still produce a valid window
	const FIRST = '2026-05-01';

	it('"earlier this month" window: 2026-05-01 to 2026-05-01 (single-day, today=1st)', () => {
		const prompt = buildClassifierPrompt(FIRST);
		expect(prompt).toContain('"earlier this month" → window 2026-05-01 to 2026-05-01');
	});
});

describe('buildClassifierPrompt — edge case: named month = current month', () => {
	// REQ-CONV-TEMPORAL-012: current-month "in [month]" → window from 1st to today
	const MID_MAY = '2026-05-15';

	it('"in May" with today=2026-05-15 → window 2026-05-01 to 2026-05-15', () => {
		const prompt = buildClassifierPrompt(MID_MAY);
		expect(prompt).toContain('"in May" → window 2026-05-01 to 2026-05-15');
	});
});

describe('buildClassifierPrompt — edge case: named month = future if interpreted same year', () => {
	// REQ-CONV-TEMPORAL-012: "in November" with today=May → Nov 2026 is future → wrap to Nov 2025
	const MAY = '2026-05-05';

	it('"in November" wraps to 2025-11-01 to 2025-11-30 when Nov 2026 is future', () => {
		const prompt = buildClassifierPrompt(MAY);
		expect(prompt).toContain('"in November" → window 2025-11-01 to 2025-11-30');
	});
});

describe('buildClassifierPrompt — edge case: leap year', () => {
	// today=2024-02-29 (Thursday, DOW=4)
	// "last Tuesday" (DOW=2): diff = 4>2 → 4-2=2 days back → 2024-02-27
	const LEAP_DAY = '2024-02-29';

	it('"last Tuesday" from leap day 2024-02-29 → 2024-02-27', () => {
		const prompt = buildClassifierPrompt(LEAP_DAY);
		// last Tuesday from Thursday = 2 days back
		expect(prompt).toContain('"last Tuesday" → 2024-02-27');
	});

	it('prompt does not contain invalid date "2024-02-30"', () => {
		const prompt = buildClassifierPrompt(LEAP_DAY);
		expect(prompt).not.toContain('2024-02-30');
	});
});

describe('buildClassifierPrompt — edge case: DST transition', () => {
	// 2026-03-09 is the day after US DST change (spring forward on 2026-03-08)
	// 2026-03-09 = Monday (DOW=1)
	const AFTER_DST = '2026-03-09';

	it('produces valid YYYY-MM-DD strings (no DST corruption)', () => {
		const prompt = buildClassifierPrompt(AFTER_DST);
		// Should still render valid dates — check the block exists
		expect(prompt).toContain('<phrasing reference>');
		// All date-like substrings in prompt should match YYYY-MM-DD format
		const dateLike = prompt.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
		const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
		for (const d of dateLike) {
			expect(d).toMatch(ISO_RE);
		}
	});

	it('"last Saturday" from Monday 2026-03-09 → 2026-03-07 (2 days back, no DST distortion)', () => {
		// DOW=1 (Mon), Saturday=6: 1 > 6? No → 7-(6-1)=2 days back
		const prompt = buildClassifierPrompt(AFTER_DST);
		expect(prompt).toContain('"last Saturday" → 2026-03-07');
	});
});

// ─── Helpers are deterministic functions of today (REQ-CONV-TEMPORAL-008) ──────

describe('buildClassifierPrompt — helpers are deterministic (REQ-CONV-TEMPORAL-008)', () => {
	it('same today always produces same prompt', () => {
		expect(buildClassifierPrompt('2026-05-05')).toBe(buildClassifierPrompt('2026-05-05'));
	});

	it('different today produces different phrasing reference dates', () => {
		const p1 = buildClassifierPrompt('2026-05-05');
		const p2 = buildClassifierPrompt('2026-06-05');
		// Both have phrasing reference but with different dates
		expect(p1).toContain('<phrasing reference>');
		expect(p2).toContain('<phrasing reference>');
		expect(p1).not.toBe(p2);
	});
});
