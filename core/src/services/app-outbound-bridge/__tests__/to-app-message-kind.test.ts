import { describe, expect, it } from 'vitest';
import { toAppMessageKind } from '../index.js';

describe('toAppMessageKind', () => {
	it('lowercases', () => expect(toAppMessageKind('Weekly Spend')).toBe('weekly-spend'));
	it('strips punctuation', () =>
		expect(toAppMessageKind('Expiry Warning!')).toBe('expiry-warning'));
	it('collapses underscores and spaces to single dash', () => {
		expect(toAppMessageKind('foo  bar__baz')).toBe('foo-bar-baz');
	});
	it('strips leading/trailing dashes', () => expect(toAppMessageKind('-foo-')).toBe('foo'));
	it('preserves digits, colons, and existing dashes', () => {
		expect(toAppMessageKind('report:2024-week-15')).toBe('report:2024-week-15');
	});
	it('truncates at 64 chars', () => {
		const long = 'a'.repeat(80);
		expect(toAppMessageKind(long).length).toBe(64);
	});
	it('returns "untitled" for empty/all-stripped input', () => {
		expect(toAppMessageKind('')).toBe('untitled');
		expect(toAppMessageKind('!!!')).toBe('untitled');
	});
});
