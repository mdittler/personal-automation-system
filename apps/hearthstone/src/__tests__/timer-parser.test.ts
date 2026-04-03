import { describe, expect, it } from 'vitest';
import { formatDuration, parseStepTimer } from '../services/timer-parser.js';

describe('parseStepTimer', () => {
	it('parses "bake for 25 minutes"', () => {
		const result = parseStepTimer('Bake for 25 minutes at 375°F.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(25);
		expect(result!.originalText).toBe('25 minutes');
	});

	it('parses "cook 10 min"', () => {
		const result = parseStepTimer('Cook 10 min until golden.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(10);
		expect(result!.originalText).toBe('10 min');
	});

	it('parses "simmer for 1 hour"', () => {
		const result = parseStepTimer('Simmer for 1 hour on low heat.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(60);
		expect(result!.originalText).toBe('1 hour');
	});

	it('parses "2 hrs" shorthand', () => {
		const result = parseStepTimer('Slow cook for 2 hrs.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(120);
		expect(result!.originalText).toBe('2 hrs');
	});

	it('parses range "5-7 minutes" as midpoint', () => {
		const result = parseStepTimer('Cook for 5-7 minutes.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(6);
		expect(result!.originalText).toBe('5-7 minutes');
	});

	it('parses range "10 to 15 min" as midpoint', () => {
		const result = parseStepTimer('Bake for 10 to 15 min.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(12.5);
		expect(result!.originalText).toBe('10 to 15 min');
	});

	it('parses "about 20 minutes"', () => {
		const result = parseStepTimer('Cook for about 20 minutes.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(20);
		expect(result!.originalText).toBe('about 20 minutes');
	});

	it('parses compound "1 hour 30 minutes"', () => {
		const result = parseStepTimer('Bake for 1 hour 30 minutes.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(90);
		expect(result!.originalText).toBe('1 hour 30 minutes');
	});

	it('parses "30 sec" as fractional minutes', () => {
		const result = parseStepTimer('Sear for 30 sec on each side.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(0.5);
		expect(result!.originalText).toBe('30 sec');
	});

	it('parses "45 seconds"', () => {
		const result = parseStepTimer('Microwave for 45 seconds.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(0.75);
		expect(result!.originalText).toBe('45 seconds');
	});

	it('parses "1 hour and 15 minutes"', () => {
		const result = parseStepTimer('Roast for 1 hour and 15 minutes.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(75);
		expect(result!.originalText).toBe('1 hour and 15 minutes');
	});

	it('returns null for step without timing', () => {
		const result = parseStepTimer('Mix eggs and parmesan in a bowl.');
		expect(result).toBeNull();
	});

	it('returns null for empty string', () => {
		const result = parseStepTimer('');
		expect(result).toBeNull();
	});

	it('returns first timing if multiple present', () => {
		const result = parseStepTimer('Bake for 25 minutes, then broil for 5 minutes.');
		expect(result).not.toBeNull();
		expect(result!.durationMinutes).toBe(25);
	});

	it('ignores temperature references like "375°F"', () => {
		const result = parseStepTimer('Preheat oven to 375°F.');
		expect(result).toBeNull();
	});
});

describe('formatDuration', () => {
	it('formats minutes under 60', () => {
		expect(formatDuration(25)).toBe('25 min');
	});

	it('formats exactly 60 as 1 hr', () => {
		expect(formatDuration(60)).toBe('1 hr');
	});

	it('formats 90 as 1 hr 30 min', () => {
		expect(formatDuration(90)).toBe('1 hr 30 min');
	});

	it('formats 120 as 2 hr', () => {
		expect(formatDuration(120)).toBe('2 hr');
	});

	it('formats fractional minutes under 1 as seconds', () => {
		expect(formatDuration(0.5)).toBe('30 sec');
	});

	it('formats 0.75 as 45 sec', () => {
		expect(formatDuration(0.75)).toBe('45 sec');
	});

	it('formats 1.5 as 1 min 30 sec', () => {
		expect(formatDuration(1.5)).toBe('1 min 30 sec');
	});
});
