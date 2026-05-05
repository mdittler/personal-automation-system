/**
 * Tests for core/src/utils/temporal.ts
 *
 * isCalendarStrict: validates YYYY-MM-DD strings against the Gregorian calendar.
 * localDayToUtcRange: maps a local calendar day to a UTC half-open interval.
 */

import { describe, expect, it } from 'vitest';
import { isCalendarStrict, localDayToUtcRange } from '../temporal.js';

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

// ─── localDayToUtcRange ──────────────────────────────────────────────────────

describe('localDayToUtcRange', () => {
	it('UTC: 2026-05-05 → [00:00Z, 2026-05-06T00:00Z)', () => {
		expect(localDayToUtcRange('2026-05-05', 'UTC')).toEqual({
			startUtc: '2026-05-05T00:00:00.000Z',
			endUtcExclusive: '2026-05-06T00:00:00.000Z',
		});
	});

	it('America/New_York EDT (UTC-4): 2026-05-05 → [04:00Z, 2026-05-06T04:00Z)', () => {
		// May is EDT: UTC-4 → local midnight = 04:00 UTC
		expect(localDayToUtcRange('2026-05-05', 'America/New_York')).toEqual({
			startUtc: '2026-05-05T04:00:00.000Z',
			endUtcExclusive: '2026-05-06T04:00:00.000Z',
		});
	});

	it('America/New_York spring-forward day 2026-03-08: 23-hour day → [05:00Z, 2026-03-09T04:00Z)', () => {
		// Clocks spring forward at 2:00 AM → 3:00 AM (EST→EDT).
		// Local midnight on 2026-03-08 starts in EST (UTC-5): 05:00Z
		// Local midnight on 2026-03-09 starts in EDT (UTC-4): 04:00Z
		expect(localDayToUtcRange('2026-03-08', 'America/New_York')).toEqual({
			startUtc: '2026-03-08T05:00:00.000Z',
			endUtcExclusive: '2026-03-09T04:00:00.000Z',
		});
	});

	it('America/New_York fall-back day 2026-11-01: 25-hour day → [04:00Z, 2026-11-02T05:00Z)', () => {
		// Clocks fall back at 2:00 AM → 1:00 AM (EDT→EST).
		// Local midnight on 2026-11-01 starts in EDT (UTC-4): 04:00Z
		// Local midnight on 2026-11-02 starts in EST (UTC-5): 05:00Z
		expect(localDayToUtcRange('2026-11-01', 'America/New_York')).toEqual({
			startUtc: '2026-11-01T04:00:00.000Z',
			endUtcExclusive: '2026-11-02T05:00:00.000Z',
		});
	});

	it('UTC: leap day 2024-02-29 works correctly', () => {
		expect(localDayToUtcRange('2024-02-29', 'UTC')).toEqual({
			startUtc: '2024-02-29T00:00:00.000Z',
			endUtcExclusive: '2024-03-01T00:00:00.000Z',
		});
	});
});
