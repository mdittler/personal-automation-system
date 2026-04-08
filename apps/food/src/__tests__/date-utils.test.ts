import { describe, expect, it } from 'vitest';
import { currentTime, generateId, isoNow, todayDate } from '../utils/date.js';

describe('Date Utilities', () => {
	describe('todayDate', () => {
		it('returns YYYY-MM-DD format for valid timezone', () => {
			const result = todayDate('America/New_York');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('returns valid date for UTC', () => {
			const result = todayDate('UTC');
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('throws on invalid timezone', () => {
			expect(() => todayDate('Invalid/Zone')).toThrow();
		});
	});

	describe('currentTime', () => {
		it('returns HH:MM format for valid timezone', () => {
			const result = currentTime('UTC');
			expect(result).toMatch(/^\d{2}:\d{2}$/);
		});

		it('throws on invalid timezone', () => {
			expect(() => currentTime('Not/A/Zone')).toThrow();
		});
	});

	describe('isoNow', () => {
		it('returns a valid ISO 8601 string', () => {
			const result = isoNow();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(new Date(result).toISOString()).toBe(result);
		});
	});

	describe('generateId', () => {
		it('returns a non-empty string', () => {
			expect(generateId()).toBeTruthy();
		});

		it('generates unique IDs across many calls', () => {
			const ids = new Set(Array.from({ length: 100 }, () => generateId()));
			expect(ids.size).toBe(100);
		});
	});
});
