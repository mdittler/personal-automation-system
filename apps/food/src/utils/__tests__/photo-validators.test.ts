/**
 * Unit tests for receipt line-item validators (REQ-FOOD-RECEIPT-INTEGRITY-009, -010).
 */

import { describe, expect, it } from 'vitest';
import {
	isValidReceiptAmount,
	isValidReceiptLineItem,
	normalizeReceiptLineItem,
	validateReceiptIntegrity,
} from '../photo-validators.js';

describe('isValidReceiptLineItem — negative totals allowed for discount/coupon/return lines', () => {
	it('accepts negative totalPrice (coupon line)', () => {
		expect(
			isValidReceiptLineItem({
				name: 'Coupon BOGO',
				quantity: 1,
				unitPrice: -2.0,
				totalPrice: -2.0,
			}),
		).toBe(true);
	});

	it('accepts negative totalPrice with positive unitPrice (deposit return)', () => {
		expect(
			isValidReceiptLineItem({
				name: 'Bottle Deposit Return',
				quantity: 1,
				unitPrice: 0.05,
				totalPrice: -0.5,
			}),
		).toBe(true);
	});

	it('still rejects non-finite totalPrice (NaN)', () => {
		expect(
			isValidReceiptLineItem({ name: 'X', quantity: 1, unitPrice: 1, totalPrice: Number.NaN }),
		).toBe(false);
	});

	it('still rejects non-finite totalPrice (Infinity)', () => {
		expect(
			isValidReceiptLineItem({
				name: 'X',
				quantity: 1,
				unitPrice: 1,
				totalPrice: Number.POSITIVE_INFINITY,
			}),
		).toBe(false);
	});

	it('still rejects missing name', () => {
		expect(isValidReceiptLineItem({ name: '', quantity: 1, unitPrice: 1, totalPrice: 1 })).toBe(
			false,
		);
	});

	it('still rejects whitespace-only name', () => {
		expect(isValidReceiptLineItem({ name: '   ', quantity: 1, unitPrice: 1, totalPrice: 1 })).toBe(
			false,
		);
	});

	it('still rejects non-object input', () => {
		expect(isValidReceiptLineItem(null)).toBe(false);
		expect(isValidReceiptLineItem(undefined)).toBe(false);
		expect(isValidReceiptLineItem('item')).toBe(false);
		expect(isValidReceiptLineItem(42)).toBe(false);
	});

	it('accepts a zero totalPrice (e.g. free with purchase)', () => {
		expect(
			isValidReceiptLineItem({ name: 'Free Sample', quantity: 1, unitPrice: 0, totalPrice: 0 }),
		).toBe(true);
	});
});

describe('normalizeReceiptLineItem — defaults for missing fields', () => {
	it('defaults missing quantity to 1', () => {
		const li = normalizeReceiptLineItem({ name: 'A', totalPrice: 5.0 } as never);
		expect(li.quantity).toBe(1);
	});

	it('normalizes non-finite quantity (NaN) to 1', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: Number.NaN,
			totalPrice: 5.0,
		} as never);
		expect(li.quantity).toBe(1);
	});

	it('normalizes non-number quantity (string) to 1', () => {
		const li = normalizeReceiptLineItem({ name: 'A', quantity: '2' as never, totalPrice: 5.0 });
		expect(li.quantity).toBe(1);
	});

	it('preserves a valid positive quantity', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: 2,
			unitPrice: 2.5,
			totalPrice: 5.0,
		});
		expect(li.quantity).toBe(2);
	});

	it('defaults missing unitPrice to null', () => {
		const li = normalizeReceiptLineItem({ name: 'A', quantity: 1, totalPrice: 5.0 } as never);
		expect(li.unitPrice).toBeNull();
	});

	it('normalizes non-finite unitPrice (Infinity) to null', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: 1,
			unitPrice: Number.POSITIVE_INFINITY,
			totalPrice: 5.0,
		} as never);
		expect(li.unitPrice).toBeNull();
	});

	it('preserves a valid unitPrice', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: 2,
			unitPrice: 2.5,
			totalPrice: 5.0,
		});
		expect(li.unitPrice).toBe(2.5);
	});

	it('preserves a negative unitPrice (discount line)', () => {
		const li = normalizeReceiptLineItem({
			name: 'Coupon',
			quantity: 1,
			unitPrice: -2.0,
			totalPrice: -2.0,
		});
		expect(li.unitPrice).toBe(-2.0);
	});

	it('preserves zero unitPrice (free with purchase)', () => {
		const li = normalizeReceiptLineItem({ name: 'Free', quantity: 1, unitPrice: 0, totalPrice: 0 });
		expect(li.unitPrice).toBe(0);
	});

	it('still normalizes packageSize (existing behavior preserved)', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: 1,
			unitPrice: 5,
			totalPrice: 5,
			packageSize: '  12 oz  ',
		});
		expect(li.packageSize).toBe('12 oz');
	});

	it('coerces empty packageSize to null', () => {
		const li = normalizeReceiptLineItem({
			name: 'A',
			quantity: 1,
			unitPrice: 5,
			totalPrice: 5,
			packageSize: '',
		});
		expect(li.packageSize).toBeNull();
	});
});

describe('validateReceiptIntegrity (REQ-FOOD-RECEIPT-INTEGRITY-004 .. -006)', () => {
	const clean = {
		lineItems: [
			{ name: 'A', quantity: 1, unitPrice: 5.0, totalPrice: 5.0 },
			{ name: 'B', quantity: 2, unitPrice: 3.0, totalPrice: 6.0 },
		],
		subtotal: 11.0,
		tax: 0.88,
		total: 11.88,
	};

	it('clean receipt → no warnings', () => {
		expect(validateReceiptIntegrity(clean, 'stop')).toEqual([]);
	});

	it('flags output_truncated when finishReason is length', () => {
		expect(validateReceiptIntegrity(clean, 'length')).toContain('output_truncated');
	});

	it('does NOT flag output_truncated for finishReason=stop|error|other', () => {
		expect(validateReceiptIntegrity(clean, 'stop')).not.toContain('output_truncated');
		expect(validateReceiptIntegrity(clean, 'error')).not.toContain('output_truncated');
		expect(validateReceiptIntegrity(clean, 'other')).not.toContain('output_truncated');
	});

	describe('sum_mismatch — primary reference is subtotal', () => {
		it('flags when delta > $1 AND > 1%', () => {
			const r = { ...clean, subtotal: 100.0 };
			expect(validateReceiptIntegrity(r, 'stop')).toContain('sum_mismatch');
		});

		it('does NOT flag at exactly $1.00 delta on a small receipt (gate requires strictly > $1)', () => {
			// sum=11, subtotal=12 → delta=1.00, ~9% — over relative threshold but not strictly > $1 absolute
			const r = { ...clean, subtotal: 12.0 };
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('sum_mismatch');
		});

		it('flags at $1.01 delta on a small receipt (just over both thresholds)', () => {
			// sum=11, subtotal=12.01 → delta=1.01, 8.4%
			const r = { ...clean, subtotal: 12.01 };
			expect(validateReceiptIntegrity(r, 'stop')).toContain('sum_mismatch');
		});

		it('does NOT flag a $2 delta on a $1000 receipt (>$1 absolute but only 0.2% relative)', () => {
			const r = {
				lineItems: [{ name: 'X', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
				subtotal: 1002.0,
				tax: 0,
				total: 1002.0,
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('sum_mismatch');
		});

		it('flags a $20 delta on a $1000 receipt (2% relative AND >$1 absolute)', () => {
			const r = {
				lineItems: [{ name: 'X', quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
				subtotal: 1020.0,
				tax: 0,
				total: 1020.0,
			};
			expect(validateReceiptIntegrity(r, 'stop')).toContain('sum_mismatch');
		});
	});

	describe('reference fallback chain (REQ-FOOD-RECEIPT-INTEGRITY-004)', () => {
		it('falls back to total-tax when subtotal is null', () => {
			// sum=11, subtotal=null, tax=0.88, total=11.88 → reference = 11.00 → clean
			const r = { ...clean, subtotal: null };
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('sum_mismatch');
		});

		it('flags via total-tax fallback when sum diverges', () => {
			const r = { ...clean, subtotal: null, total: 30.88 }; // reference = 30.00, delta = 19
			expect(validateReceiptIntegrity(r, 'stop')).toContain('sum_mismatch');
		});

		it('falls back to total with loose 2% tolerance when subtotal AND tax are null', () => {
			// sum=11, total=11.20 → 1.8% < 2% loose → no flag
			const r = { ...clean, subtotal: null, tax: null, total: 11.2 };
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('sum_mismatch');
		});

		it('flags via total fallback when sum is way off', () => {
			const r = { ...clean, subtotal: null, tax: null, total: 50.0 };
			expect(validateReceiptIntegrity(r, 'stop')).toContain('sum_mismatch');
		});
	});

	describe('line_arithmetic_mismatch (REQ-FOOD-RECEIPT-INTEGRITY-005)', () => {
		it('flags when any |q*u - total| > $0.50', () => {
			const r = {
				...clean,
				lineItems: [{ name: 'A', quantity: 2, unitPrice: 5.0, totalPrice: 99.0 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).toContain('line_arithmetic_mismatch');
		});

		it('does NOT flag when unitPrice is null (cannot verify)', () => {
			const r = {
				...clean,
				lineItems: [{ name: 'A', quantity: 1, unitPrice: null, totalPrice: 5.0 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('line_arithmetic_mismatch');
		});

		it('tolerates penny rounding within $0.50', () => {
			const r = {
				...clean,
				lineItems: [{ name: 'A', quantity: 3, unitPrice: 1.33, totalPrice: 3.99 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('line_arithmetic_mismatch');
		});

		it('handles negative totals (discount lines) correctly — q*u==total still holds', () => {
			const r = {
				...clean,
				lineItems: [{ name: 'Coupon', quantity: 1, unitPrice: -2.0, totalPrice: -2.0 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('line_arithmetic_mismatch');
		});

		it('skips the check when sign disagrees (positive q*u + negative totalPrice — Codex P2)', () => {
			// Real-world bottle-deposit return: receipt prints unitPrice=0.05
			// (the deposit value per bottle), quantity=1, totalPrice=-0.50
			// (the credit). The sign convention is not recoverable from the
			// parsed fields alone, so the arithmetic check is skipped rather
			// than producing a false-positive warning.
			const r = {
				...clean,
				lineItems: [{ name: 'Deposit Return', quantity: 1, unitPrice: 0.05, totalPrice: -0.5 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('line_arithmetic_mismatch');
		});

		it('also skips when sign disagrees in the other direction (negative q*u + positive totalPrice)', () => {
			// Synthetic — guards against the model emitting a negative unitPrice
			// with a positive totalPrice. Cannot verify; skip.
			const r = {
				...clean,
				lineItems: [{ name: 'Weird', quantity: 1, unitPrice: -5.0, totalPrice: 5.0 }],
			};
			expect(validateReceiptIntegrity(r, 'stop')).not.toContain('line_arithmetic_mismatch');
		});
	});

	describe('empty lineItems — sum check is a no-op', () => {
		it('does not flag sum_mismatch when lineItems is empty', () => {
			const r = { lineItems: [], subtotal: 50, tax: 0, total: 50 };
			expect(validateReceiptIntegrity(r, 'stop')).toEqual([]);
		});
	});

	describe('documented limitation: self-consistent fudging cannot be detected', () => {
		it('a receipt where the model fudged BOTH subtotal AND lineItems to be self-consistent passes', () => {
			// Reality was 3 items totaling $21. Model dropped item C and reported
			// subtotal=$16 with two items summing to $16. From the parser's
			// perspective, the math ties — only the regression suite's
			// transcription oracle catches this. Test confirms we do NOT
			// false-positive on a self-consistent (but real-world wrong) receipt.
			const r = {
				lineItems: [
					{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
					{ name: 'B', quantity: 1, unitPrice: 11, totalPrice: 11 },
				],
				subtotal: 16,
				tax: 0,
				total: 16,
			};
			expect(validateReceiptIntegrity(r, 'stop')).toEqual([]);
		});
	});
});

describe('isValidReceiptAmount — unchanged semantics', () => {
	it('accepts non-negative finite numbers', () => {
		expect(isValidReceiptAmount(0)).toBe(true);
		expect(isValidReceiptAmount(1.5)).toBe(true);
	});

	it('rejects negative numbers (aggregate totals are non-negative even when individual lines are not)', () => {
		expect(isValidReceiptAmount(-1)).toBe(false);
	});

	it('rejects non-numbers and non-finite values', () => {
		expect(isValidReceiptAmount('5')).toBe(false);
		expect(isValidReceiptAmount(Number.NaN)).toBe(false);
		expect(isValidReceiptAmount(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isValidReceiptAmount(null)).toBe(false);
		expect(isValidReceiptAmount(undefined)).toBe(false);
	});
});
