import { describe, expect, it } from 'vitest';
import { type FrequencyConfig, cronToFrequency, frequencyToCron } from '../frequency-picker.js';

describe('frequencyToCron', () => {
	it('converts hourly', () => {
		expect(frequencyToCron({ frequency: 'hourly', minute: 0 })).toBe('0 * * * *');
	});

	it('converts hourly with minute offset', () => {
		expect(frequencyToCron({ frequency: 'hourly', minute: 30 })).toBe('30 * * * *');
	});

	it('converts daily', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 9, minute: 0 })).toBe('0 9 * * *');
	});

	it('converts daily at midnight', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 0, minute: 0 })).toBe('0 0 * * *');
	});

	it('converts daily at 11pm', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 23, minute: 45 })).toBe('45 23 * * *');
	});

	it('converts weekly on Monday', () => {
		expect(frequencyToCron({ frequency: 'weekly', hour: 9, minute: 0, dayOfWeek: 1 })).toBe(
			'0 9 * * 1',
		);
	});

	it('converts weekly on Sunday', () => {
		expect(frequencyToCron({ frequency: 'weekly', hour: 8, minute: 30, dayOfWeek: 0 })).toBe(
			'30 8 * * 0',
		);
	});

	it('converts monthly on the 15th', () => {
		expect(frequencyToCron({ frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 15 })).toBe(
			'0 9 15 * *',
		);
	});

	it('converts monthly defaults to 1st', () => {
		expect(frequencyToCron({ frequency: 'monthly', hour: 9, minute: 0 })).toBe('0 9 1 * *');
	});

	it('converts quarterly', () => {
		expect(frequencyToCron({ frequency: 'quarterly', hour: 9, minute: 0 })).toBe(
			'0 9 1 1,4,7,10 *',
		);
	});

	it('converts yearly', () => {
		expect(frequencyToCron({ frequency: 'yearly', hour: 9, minute: 0 })).toBe('0 9 1 1 *');
	});

	it('returns * * * * * for custom', () => {
		expect(frequencyToCron({ frequency: 'custom' })).toBe('* * * * *');
	});

	it('defaults hour to 9 when not provided', () => {
		expect(frequencyToCron({ frequency: 'daily' })).toBe('0 9 * * *');
	});

	it('defaults minute to 0 when not provided', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 14 })).toBe('0 14 * * *');
	});

	// --- Input validation (C2) ---

	it('clamps negative hour to 0', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: -1 })).toBe('0 0 * * *');
	});

	it('clamps hour above 23 to 23', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 25 })).toBe('0 23 * * *');
	});

	it('clamps negative minute to 0', () => {
		expect(frequencyToCron({ frequency: 'hourly', minute: -5 })).toBe('0 * * * *');
	});

	it('clamps minute above 59 to 59', () => {
		expect(frequencyToCron({ frequency: 'hourly', minute: 60 })).toBe('59 * * * *');
	});

	it('clamps dayOfMonth above 28 to 28', () => {
		expect(frequencyToCron({ frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 32 })).toBe(
			'0 9 28 * *',
		);
	});

	it('clamps dayOfMonth below 1 to 1', () => {
		expect(frequencyToCron({ frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 0 })).toBe(
			'0 9 1 * *',
		);
	});

	it('clamps negative dayOfWeek to 0', () => {
		expect(frequencyToCron({ frequency: 'weekly', hour: 9, minute: 0, dayOfWeek: -1 })).toBe(
			'0 9 * * 0',
		);
	});

	it('clamps dayOfWeek above 6 to 6', () => {
		expect(frequencyToCron({ frequency: 'weekly', hour: 9, minute: 0, dayOfWeek: 7 })).toBe(
			'0 9 * * 6',
		);
	});

	it('floors fractional values', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: 9.7, minute: 30.9 })).toBe('30 9 * * *');
	});

	it('falls back to defaults for NaN values', () => {
		expect(frequencyToCron({ frequency: 'daily', hour: Number.NaN, minute: Number.NaN })).toBe(
			'0 9 * * *',
		);
	});
});

describe('cronToFrequency', () => {
	it('recognizes hourly', () => {
		expect(cronToFrequency('0 * * * *')).toEqual({ frequency: 'hourly', minute: 0 });
	});

	it('recognizes hourly with minute', () => {
		expect(cronToFrequency('30 * * * *')).toEqual({ frequency: 'hourly', minute: 30 });
	});

	it('recognizes daily', () => {
		expect(cronToFrequency('0 9 * * *')).toEqual({ frequency: 'daily', hour: 9, minute: 0 });
	});

	it('recognizes daily at midnight', () => {
		expect(cronToFrequency('0 0 * * *')).toEqual({ frequency: 'daily', hour: 0, minute: 0 });
	});

	it('recognizes weekly', () => {
		expect(cronToFrequency('0 9 * * 1')).toEqual({
			frequency: 'weekly',
			hour: 9,
			minute: 0,
			dayOfWeek: 1,
		});
	});

	it('recognizes weekly Sunday', () => {
		expect(cronToFrequency('30 8 * * 0')).toEqual({
			frequency: 'weekly',
			hour: 8,
			minute: 30,
			dayOfWeek: 0,
		});
	});

	it('recognizes monthly', () => {
		expect(cronToFrequency('0 9 15 * *')).toEqual({
			frequency: 'monthly',
			hour: 9,
			minute: 0,
			dayOfMonth: 15,
		});
	});

	it('recognizes quarterly', () => {
		expect(cronToFrequency('0 9 1 1,4,7,10 *')).toEqual({
			frequency: 'quarterly',
			hour: 9,
			minute: 0,
		});
	});

	it('recognizes yearly', () => {
		expect(cronToFrequency('0 9 1 1 *')).toEqual({ frequency: 'yearly', hour: 9, minute: 0 });
	});

	it('returns custom for complex cron', () => {
		expect(cronToFrequency('*/5 * * * *')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for empty string', () => {
		expect(cronToFrequency('')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for invalid input', () => {
		expect(cronToFrequency('not a cron')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for 6-field cron', () => {
		expect(cronToFrequency('0 0 9 * * 1')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for day-of-month > 28', () => {
		// We limit to 28 to avoid month-length issues
		expect(cronToFrequency('0 9 31 * *')).toEqual({ frequency: 'custom' });
	});

	// --- Leading-zero handling (C1) ---

	it('recognizes daily with leading-zero hour', () => {
		expect(cronToFrequency('0 09 * * *')).toEqual({ frequency: 'daily', hour: 9, minute: 0 });
	});

	it('recognizes hourly with leading-zero minute', () => {
		expect(cronToFrequency('05 * * * *')).toEqual({ frequency: 'hourly', minute: 5 });
	});

	it('recognizes weekly with leading zeros', () => {
		expect(cronToFrequency('05 08 * * 1')).toEqual({
			frequency: 'weekly',
			hour: 8,
			minute: 5,
			dayOfWeek: 1,
		});
	});

	it('recognizes monthly with leading zeros', () => {
		expect(cronToFrequency('05 08 01 * *')).toEqual({
			frequency: 'monthly',
			hour: 8,
			minute: 5,
			dayOfMonth: 1,
		});
	});

	it('recognizes quarterly with leading zeros', () => {
		expect(cronToFrequency('05 08 1 1,4,7,10 *')).toEqual({
			frequency: 'quarterly',
			hour: 8,
			minute: 5,
		});
	});

	it('recognizes yearly with leading zeros', () => {
		expect(cronToFrequency('05 08 1 1 *')).toEqual({ frequency: 'yearly', hour: 8, minute: 5 });
	});

	// --- Step/range/list patterns → custom ---

	it('returns custom for step pattern', () => {
		expect(cronToFrequency('*/5 9 * * *')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for range pattern', () => {
		expect(cronToFrequency('0 9-17 * * *')).toEqual({ frequency: 'custom' });
	});

	it('returns custom for list pattern in DOW', () => {
		expect(cronToFrequency('0 9 * * 1,3,5')).toEqual({ frequency: 'custom' });
	});

	// --- Null / undefined / non-string safety ---

	it('returns custom for null', () => {
		expect(cronToFrequency(null as any)).toEqual({ frequency: 'custom' });
	});

	it('returns custom for undefined', () => {
		expect(cronToFrequency(undefined as any)).toEqual({ frequency: 'custom' });
	});

	it('returns custom for non-string', () => {
		expect(cronToFrequency(42 as any)).toEqual({ frequency: 'custom' });
	});

	it('roundtrips hourly', () => {
		const config: FrequencyConfig = { frequency: 'hourly', minute: 15 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});

	it('roundtrips daily', () => {
		const config: FrequencyConfig = { frequency: 'daily', hour: 14, minute: 30 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});

	it('roundtrips weekly', () => {
		const config: FrequencyConfig = { frequency: 'weekly', hour: 9, minute: 0, dayOfWeek: 3 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});

	it('roundtrips monthly', () => {
		const config: FrequencyConfig = { frequency: 'monthly', hour: 9, minute: 0, dayOfMonth: 15 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});

	it('roundtrips quarterly', () => {
		const config: FrequencyConfig = { frequency: 'quarterly', hour: 8, minute: 0 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});

	it('roundtrips yearly', () => {
		const config: FrequencyConfig = { frequency: 'yearly', hour: 10, minute: 30 };
		expect(cronToFrequency(frequencyToCron(config))).toEqual(config);
	});
});
