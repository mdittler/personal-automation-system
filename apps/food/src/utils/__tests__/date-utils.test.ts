import { describe, it, expect } from 'vitest';
import { addDays, getIsoWeekId } from '../date.js';

describe('addDays', () => {
	it('subtracts 1 day across a fall DST boundary safely', () => {
		// 2026-11-01 is DST fall-back in US — UTC arithmetic must not shift the date
		expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
	});

	it('adds 1 day across a spring DST boundary safely', () => {
		// 2026-03-08 is DST spring-forward in US
		expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
	});

	it('returns the same date for zero days', () => {
		expect(addDays('2026-01-01', 0)).toBe('2026-01-01');
	});

	it('adds 30 days correctly', () => {
		expect(addDays('2026-01-01', 30)).toBe('2026-01-31');
	});

	it('subtracts 1 day across a month boundary', () => {
		expect(addDays('2026-02-01', -1)).toBe('2026-01-31');
	});

	it('handles year boundary (subtract 1 from Jan 1)', () => {
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
	});
});

describe('getIsoWeekId', () => {
	it('returns 2026-W01 for 2026-01-01 (Jan 1 2026 is a Thursday — week 1 of 2026)', () => {
		expect(getIsoWeekId('2026-01-01')).toBe('2026-W01');
	});

	it('returns 2026-W15 for 2026-04-06', () => {
		expect(getIsoWeekId('2026-04-06')).toBe('2026-W15');
	});

	it('returns 2026-W01 for 2026-01-04 (Sunday still in same week as Jan 1 Thu)', () => {
		expect(getIsoWeekId('2026-01-04')).toBe('2026-W01');
	});

	it('returns 2026-W02 for 2026-01-05 (Monday of second week)', () => {
		expect(getIsoWeekId('2026-01-05')).toBe('2026-W02');
	});

	it('returns 2026-W01 for 2025-12-29 (last Mon of Dec 2025 is in ISO week 1 of 2026)', () => {
		// 2025-12-29 is Monday. Its Thursday is 2026-01-01, which is in 2026 → week 1 of 2026
		expect(getIsoWeekId('2025-12-29')).toBe('2026-W01');
	});
});
