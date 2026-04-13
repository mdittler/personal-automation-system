import { describe, it, expect } from 'vitest';
import { parseStrictInt } from '../parse-int-strict.js';

describe('parseStrictInt', () => {
	describe('rejects non-pure-digit strings', () => {
		it('rejects trailing letters: "600abc"', () => {
			expect(parseStrictInt('600abc')).toBeNull();
		});

		it('rejects unit suffix: "2000cal"', () => {
			expect(parseStrictInt('2000cal')).toBeNull();
		});

		it('rejects unit suffix: "150g"', () => {
			expect(parseStrictInt('150g')).toBeNull();
		});

		it('rejects scientific notation: "1e3"', () => {
			expect(parseStrictInt('1e3')).toBeNull();
		});

		it('rejects decimal: "3.5"', () => {
			expect(parseStrictInt('3.5')).toBeNull();
		});

		it('rejects empty string', () => {
			expect(parseStrictInt('')).toBeNull();
		});

		it('rejects whitespace-only string', () => {
			expect(parseStrictInt('  ')).toBeNull();
		});

		it('rejects negative numbers (leading minus)', () => {
			expect(parseStrictInt('-1')).toBeNull();
		});
	});

	describe('accepts pure digit strings', () => {
		it('accepts "0" → 0', () => {
			expect(parseStrictInt('0')).toBe(0);
		});

		it('accepts "600" → 600', () => {
			expect(parseStrictInt('600')).toBe(600);
		});

		it('accepts "99999" → 99999', () => {
			expect(parseStrictInt('99999')).toBe(99999);
		});

		it('accepts trimmed "  42  " → 42', () => {
			expect(parseStrictInt('  42  ')).toBe(42);
		});
	});
});
