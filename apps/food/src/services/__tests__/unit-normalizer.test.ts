/**
 * Tests for unit-normalizer (REQ-FOOD-PRICE-003.2).
 *
 * Validates parseSizeString, calculateUnitPrice, and formatUnitPriceToken.
 */

import { describe, expect, it } from 'vitest';
import { calculateUnitPrice, formatUnitPriceToken, parseSizeString } from '../unit-normalizer.js';

describe('parseSizeString — happy path', () => {
	it('parses 12 oz to ~340.194 g', () => {
		const result = parseSizeString('12 oz');
		expect(result?.base).toBe('g');
		expect(result?.value).toBeCloseTo(340.194, 2);
	});

	it('parses 5 lb to ~2267.96 g', () => {
		const result = parseSizeString('5 lb');
		expect(result?.base).toBe('g');
		expect(result?.value).toBeCloseTo(2267.96, 2);
	});

	it('parses 1 gal to ~3785.41 ml', () => {
		const result = parseSizeString('1 gal');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(3785.41, 2);
	});

	it('parses 60ct to 60 count (compact)', () => {
		const result = parseSizeString('60ct');
		expect(result).toEqual({ value: 60, base: 'ct' });
	});

	it('parses 1.5L to 1500 ml', () => {
		const result = parseSizeString('1.5L');
		expect(result).toEqual({ value: 1500, base: 'ml' });
	});

	it('parses 750ml to 750 ml', () => {
		const result = parseSizeString('750ml');
		expect(result).toEqual({ value: 750, base: 'ml' });
	});

	it('parses 1 fl oz to ~29.5735 ml', () => {
		const result = parseSizeString('1 fl oz');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(29.5735, 3);
	});

	it('parses 2 dozen to 24 ct', () => {
		const result = parseSizeString('2 dozen');
		expect(result).toEqual({ value: 24, base: 'ct' });
	});

	it('parses 1 kg to 1000 g exactly', () => {
		const result = parseSizeString('1 kg');
		expect(result).toEqual({ value: 1000, base: 'g' });
	});

	it('parses 100 g to 100 g', () => {
		const result = parseSizeString('100 g');
		expect(result).toEqual({ value: 100, base: 'g' });
	});

	it('parses 1 pack to 1 ct', () => {
		const result = parseSizeString('1 pack');
		expect(result).toEqual({ value: 1, base: 'ct' });
	});

	it('parses 24 count to 24 ct', () => {
		const result = parseSizeString('24 count');
		expect(result).toEqual({ value: 24, base: 'ct' });
	});
});

describe('parseSizeString — case insensitivity', () => {
	it('parses 12 OZ (uppercase)', () => {
		const result = parseSizeString('12 OZ');
		expect(result?.base).toBe('g');
		expect(result?.value).toBeCloseTo(340.194, 2);
	});

	it('parses 1 Gal (mixed case)', () => {
		const result = parseSizeString('1 Gal');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(3785.41, 2);
	});

	it('parses 5 LB (uppercase)', () => {
		const result = parseSizeString('5 LB');
		expect(result?.base).toBe('g');
		expect(result?.value).toBeCloseTo(2267.96, 2);
	});
});

describe('parseSizeString — whitespace tolerance', () => {
	it('parses 1gal with no space between number and unit', () => {
		const result = parseSizeString('1gal');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(3785.41, 2);
	});

	it('parses 1  gal with two spaces', () => {
		const result = parseSizeString('1  gal');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(3785.41, 2);
	});

	it('parses "  12 oz  " with leading and trailing whitespace', () => {
		const result = parseSizeString('  12 oz  ');
		expect(result?.base).toBe('g');
		expect(result?.value).toBeCloseTo(340.194, 2);
	});

	it('parses 12fl oz (compact fl) correctly', () => {
		const result = parseSizeString('12fl oz');
		expect(result?.base).toBe('ml');
		expect(result?.value).toBeCloseTo(29.5735 * 12, 2);
	});
});

describe('parseSizeString — conversion exactness', () => {
	it('1 kg → 1000 g exactly', () => {
		expect(parseSizeString('1 kg')?.value).toBe(1000);
	});

	it('1 lb → ~453.592 g', () => {
		expect(parseSizeString('1 lb')?.value).toBeCloseTo(453.592, 3);
	});

	it('1 gal → ~3785.41 ml', () => {
		expect(parseSizeString('1 gal')?.value).toBeCloseTo(3785.41, 2);
	});

	it('1 dozen → 12 ct exactly', () => {
		expect(parseSizeString('1 dozen')?.value).toBe(12);
	});
});

describe('parseSizeString — null cases', () => {
	it('returns null for empty string', () => {
		expect(parseSizeString('')).toBeNull();
	});

	it('returns null for whitespace-only', () => {
		expect(parseSizeString('   ')).toBeNull();
	});

	it('returns null for unknown unit "unknown"', () => {
		expect(parseSizeString('unknown')).toBeNull();
	});

	it('returns null for "large"', () => {
		expect(parseSizeString('large')).toBeNull();
	});

	it('returns null for "12" (no unit)', () => {
		expect(parseSizeString('12')).toBeNull();
	});

	it('returns null for "oz" (no value)', () => {
		expect(parseSizeString('oz')).toBeNull();
	});
});

describe('parseSizeString — partial parses (must be null)', () => {
	it('returns null for "12 ounces of premium" (extra text after recognized unit prefix)', () => {
		// "ounces" is not a recognized unit (we only accept "oz"), but even if it were,
		// trailing words must reject the whole string.
		expect(parseSizeString('12 ounces of premium')).toBeNull();
	});

	it('returns null for "12oz pack of cookies" (extra text after unit)', () => {
		expect(parseSizeString('12oz pack of cookies')).toBeNull();
	});
});

describe('parseSizeString — numeric edges', () => {
	it('returns null for "NaN oz"', () => {
		expect(parseSizeString('NaN oz')).toBeNull();
	});

	it('returns null for "Infinity oz"', () => {
		expect(parseSizeString('Infinity oz')).toBeNull();
	});

	it('returns null for "-5 lb" (negative)', () => {
		expect(parseSizeString('-5 lb')).toBeNull();
	});

	it('returns null for "0 oz" (zero)', () => {
		expect(parseSizeString('0 oz')).toBeNull();
	});

	it('returns null for "1e3 g" (scientific notation rejected)', () => {
		expect(parseSizeString('1e3 g')).toBeNull();
	});
});

describe('parseSizeString — max bounds', () => {
	it('returns null for 60000 g (exceeds 50000 g cap)', () => {
		expect(parseSizeString('60000 g')).toBeNull();
	});

	it('returns null for 51 kg (51000 g > 50000)', () => {
		expect(parseSizeString('51 kg')).toBeNull();
	});

	it('returns non-null for 50 kg (exactly at 50000 g cap)', () => {
		const result = parseSizeString('50 kg');
		expect(result).not.toBeNull();
		expect(result?.value).toBe(50000);
		expect(result?.base).toBe('g');
	});

	it('returns null for 1000 gal (3.7M ml > 50000)', () => {
		expect(parseSizeString('1000 gal')).toBeNull();
	});

	it('returns null for 15000 ct (> 10000 cap)', () => {
		expect(parseSizeString('15000 ct')).toBeNull();
	});

	it('returns non-null for 10000 ct (exactly at cap)', () => {
		const result = parseSizeString('10000 ct');
		expect(result).toEqual({ value: 10000, base: 'ct' });
	});
});

describe('parseSizeString — purity', () => {
	it('returns deeply equal results when called twice with the same input', () => {
		const a = parseSizeString('12 oz');
		const b = parseSizeString('12 oz');
		expect(a).toEqual(b);
	});
});

describe('calculateUnitPrice', () => {
	it('returns price / value for valid input', () => {
		const parsed = { value: 100, base: 'g' as const };
		expect(calculateUnitPrice(5.0, parsed)).toBe(0.05);
	});

	it('returns Infinity when value is zero', () => {
		const parsed = { value: 0, base: 'g' as const };
		expect(calculateUnitPrice(5.0, parsed)).toBe(Number.POSITIVE_INFINITY);
	});

	it('returns Infinity when value is non-finite', () => {
		const parsed = { value: Number.NaN, base: 'g' as const };
		expect(calculateUnitPrice(5.0, parsed)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('formatUnitPriceToken', () => {
	it('formats mass as $X.XX/100g', () => {
		expect(formatUnitPriceToken(0.05, 'g')).toBe('$5.00/100g');
	});

	it('formats volume as $X.XX/100ml', () => {
		expect(formatUnitPriceToken(0.02, 'ml')).toBe('$2.00/100ml');
	});

	it('formats count as $X.XX/ct (no x100)', () => {
		expect(formatUnitPriceToken(1.5, 'ct')).toBe('$1.50/ct');
	});
});

describe('precision — flour example', () => {
	it('does not round 5 lb @ $4.99 to $0.00/100g (regression for /g vs /100g scaling)', () => {
		const parsed = parseSizeString('5 lb');
		expect(parsed).not.toBeNull();
		if (parsed === null) throw new Error('unreachable: parsed is non-null per assertion above');
		const unit = calculateUnitPrice(4.99, parsed);
		const token = formatUnitPriceToken(unit, 'g');
		expect(token).not.toBe('$0.00/100g');
		expect(token).toMatch(/^\$0\.\d{2}\/100g$/);
	});
});
