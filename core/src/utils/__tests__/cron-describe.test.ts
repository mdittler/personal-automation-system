import { describe, expect, it } from 'vitest';
import { describeCron, formatDateTime, formatRelativeTime, getNextRun } from '../cron-describe.js';

describe('describeCron', () => {
	it('describes daily at 2am', () => {
		expect(describeCron('0 2 * * *')).toBe('At 02:00 AM, every day');
	});

	it('describes every 5 minutes', () => {
		expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes, every hour, every day');
	});

	it('describes weekly on Sunday at 3am', () => {
		expect(describeCron('0 3 * * 0')).toBe('At 03:00 AM, only on Sunday');
	});

	it('describes monthly on the 1st at 9am', () => {
		expect(describeCron('0 9 1 * *')).toBe('At 09:00 AM, on day 1 of the month');
	});

	it('describes hourly', () => {
		expect(describeCron('0 * * * *')).toBe('Every hour, every day');
	});

	it('returns raw expression for invalid cron', () => {
		expect(describeCron('not a cron')).toBe('not a cron');
	});

	it('returns raw expression for empty string', () => {
		expect(describeCron('')).toBe('');
	});
});

describe('getNextRun', () => {
	it('returns a future date for valid expression', () => {
		const next = getNextRun('0 2 * * *', 'America/New_York');
		expect(next).toBeInstanceOf(Date);
		expect(next?.getTime()).toBeGreaterThan(Date.now());
	});

	it('respects timezone parameter', () => {
		const nyNext = getNextRun('0 12 * * *', 'America/New_York');
		const tokyoNext = getNextRun('0 12 * * *', 'Asia/Tokyo');
		expect(nyNext).toBeInstanceOf(Date);
		expect(tokyoNext).toBeInstanceOf(Date);
		// Same cron in different timezones should produce different UTC times
		expect(nyNext?.getTime()).not.toBe(tokyoNext?.getTime());
	});

	it('returns null for invalid expression', () => {
		expect(getNextRun('invalid', 'America/New_York')).toBeNull();
	});

	it('returns null for malformed expression', () => {
		expect(getNextRun('x y z', 'UTC')).toBeNull();
	});

	it('returns null for invalid timezone', () => {
		expect(getNextRun('0 2 * * *', 'Invalid/Zone')).toBeNull();
	});
});

describe('formatRelativeTime', () => {
	const base = new Date('2026-03-14T12:00:00Z');

	it('shows "now" for same time', () => {
		expect(formatRelativeTime(base, base)).toBe('now');
	});

	it('shows minutes in future', () => {
		const future = new Date('2026-03-14T12:30:00Z');
		expect(formatRelativeTime(future, base)).toBe('in 30m');
	});

	it('shows hours and minutes in future', () => {
		const future = new Date('2026-03-14T14:15:00Z');
		expect(formatRelativeTime(future, base)).toBe('in 2h 15m');
	});

	it('shows hours without minutes when exact', () => {
		const future = new Date('2026-03-14T15:00:00Z');
		expect(formatRelativeTime(future, base)).toBe('in 3h');
	});

	it('shows days and hours in future', () => {
		const future = new Date('2026-03-16T18:00:00Z');
		expect(formatRelativeTime(future, base)).toBe('in 2d 6h');
	});

	it('shows days without hours when exact', () => {
		const future = new Date('2026-03-17T12:00:00Z');
		expect(formatRelativeTime(future, base)).toBe('in 3d');
	});

	it('shows minutes in past', () => {
		const past = new Date('2026-03-14T11:45:00Z');
		expect(formatRelativeTime(past, base)).toBe('15m ago');
	});

	it('shows hours in past', () => {
		const past = new Date('2026-03-14T09:00:00Z');
		expect(formatRelativeTime(past, base)).toBe('3h ago');
	});

	it('shows days in past', () => {
		const past = new Date('2026-03-12T12:00:00Z');
		expect(formatRelativeTime(past, base)).toBe('2d ago');
	});

	it('shows less than a minute as "now"', () => {
		const almostNow = new Date('2026-03-14T12:00:30Z');
		expect(formatRelativeTime(almostNow, base)).toBe('now');
	});

	it('returns "unknown" for NaN date', () => {
		expect(formatRelativeTime(new Date(Number.NaN), base)).toBe('unknown');
	});

	it('handles very large time differences', () => {
		const farFuture = new Date('2028-03-14T12:00:00Z');
		const result = formatRelativeTime(farFuture, base);
		expect(result).toMatch(/^in \d+d/);
	});
});

describe('formatDateTime', () => {
	it('formats date with timezone', () => {
		const date = new Date('2026-03-14T18:30:00Z');
		const result = formatDateTime(date, 'America/New_York');
		// 18:30 UTC = 2:30 PM EDT
		expect(result).toContain('Mar');
		expect(result).toContain('14');
		expect(result).toContain('2:30');
		expect(result).toContain('PM');
	});

	it('formats date in different timezone', () => {
		const date = new Date('2026-03-14T18:30:00Z');
		const result = formatDateTime(date, 'Asia/Tokyo');
		// 18:30 UTC = 3:30 AM JST (next day)
		expect(result).toContain('Mar');
		expect(result).toContain('15');
		expect(result).toContain('3:30');
		expect(result).toContain('AM');
	});

	it('returns ISO fallback for invalid timezone', () => {
		const date = new Date('2026-03-14T18:30:00Z');
		const result = formatDateTime(date, 'Invalid/Zone');
		expect(result).toBe('2026-03-14T18:30:00.000Z');
	});

	it('returns "Invalid date" for NaN date', () => {
		const result = formatDateTime(new Date(Number.NaN), 'America/New_York');
		expect(result).toBe('Invalid date');
	});
});
