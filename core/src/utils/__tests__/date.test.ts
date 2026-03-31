import { describe, expect, it } from 'vitest';
import { toArchiveTimestamp, toDateString, toISO } from '../date.js';

describe('toISO', () => {
	it('returns ISO 8601 string for a given date', () => {
		const date = new Date('2025-06-15T10:30:00.000Z');
		expect(toISO(date)).toBe('2025-06-15T10:30:00.000Z');
	});

	it('defaults to current date when no argument provided', () => {
		const before = new Date();
		const result = toISO();
		const after = new Date();

		const resultDate = new Date(result);
		expect(resultDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
		expect(resultDate.getTime()).toBeLessThanOrEqual(after.getTime());
	});
});

describe('toDateString', () => {
	it('returns YYYY-MM-DD format', () => {
		const date = new Date('2025-06-15T10:30:00.000Z');
		expect(toDateString(date)).toBe('2025-06-15');
	});

	it('defaults to current date when no argument provided', () => {
		const now = new Date();
		const expected = now.toISOString().slice(0, 10);
		expect(toDateString()).toBe(expected);
	});
});

describe('toArchiveTimestamp', () => {
	it('returns YYYY-MM-DD_HH-mm-ss format', () => {
		const date = new Date('2025-06-15T10:30:45.000Z');
		expect(toArchiveTimestamp(date)).toBe('2025-06-15_10-30-45');
	});

	it('replaces colons with hyphens and T with underscore', () => {
		const date = new Date('2024-01-02T03:04:05.000Z');
		const result = toArchiveTimestamp(date);

		expect(result).not.toContain(':');
		expect(result).not.toContain('T');
		expect(result).toContain('_');
		expect(result).toBe('2024-01-02_03-04-05');
	});
});
