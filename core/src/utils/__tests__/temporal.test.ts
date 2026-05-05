/**
 * Tests for core/src/utils/temporal.ts
 *
 * isCalendarStrict: validates YYYY-MM-DD strings against the Gregorian calendar.
 */

import { describe, expect, it } from 'vitest';
import { isCalendarStrict } from '../temporal.js';

describe('isCalendarStrict', () => {
	// ── Valid dates ─────────────────────────────────────────────────────────────

	it('accepts a normal date: 2026-05-05', () => {
		expect(isCalendarStrict('2026-05-05')).toBe(true);
	});

	it('accepts a leap-year date: 2024-02-29', () => {
		expect(isCalendarStrict('2024-02-29')).toBe(true);
	});

	it('accepts end-of-year date: 2026-12-31', () => {
		expect(isCalendarStrict('2026-12-31')).toBe(true);
	});

	// ── Invalid calendar dates ──────────────────────────────────────────────────

	it('rejects Feb 30: 2026-02-30', () => {
		expect(isCalendarStrict('2026-02-30')).toBe(false);
	});

	it('rejects Feb 29 on a non-leap year: 2025-02-29', () => {
		expect(isCalendarStrict('2025-02-29')).toBe(false);
	});

	it('rejects Apr 31 (April has 30 days): 2026-04-31', () => {
		expect(isCalendarStrict('2026-04-31')).toBe(false);
	});

	it('rejects out-of-range month/day: 2026-13-40', () => {
		expect(isCalendarStrict('2026-13-40')).toBe(false);
	});

	// ── Non-ISO strings ─────────────────────────────────────────────────────────

	it('rejects natural-language string: "yesterday"', () => {
		expect(isCalendarStrict('yesterday')).toBe(false);
	});

	it('rejects non-zero-padded date: 2026-1-5', () => {
		expect(isCalendarStrict('2026-1-5')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isCalendarStrict('')).toBe(false);
	});
});
