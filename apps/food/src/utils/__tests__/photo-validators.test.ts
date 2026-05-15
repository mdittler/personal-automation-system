/**
 * Unit tests for receipt line-item validators (REQ-FOOD-RECEIPT-INTEGRITY-009, -010).
 */

import { describe, expect, it } from 'vitest';
import {
	isValidReceiptAmount,
	isValidReceiptLineItem,
	normalizeReceiptLineItem,
} from '../photo-validators.js';

describe('isValidReceiptLineItem — negative totals allowed for discount/coupon/return lines', () => {
	it('accepts negative totalPrice (coupon line)', () => {
		expect(isValidReceiptLineItem({ name: 'Coupon BOGO', quantity: 1, unitPrice: -2.0, totalPrice: -2.0 })).toBe(true);
	});

	it('accepts negative totalPrice with positive unitPrice (deposit return)', () => {
		expect(isValidReceiptLineItem({ name: 'Bottle Deposit Return', quantity: 1, unitPrice: 0.05, totalPrice: -0.50 })).toBe(true);
	});

	it('still rejects non-finite totalPrice (NaN)', () => {
		expect(isValidReceiptLineItem({ name: 'X', quantity: 1, unitPrice: 1, totalPrice: Number.NaN })).toBe(false);
	});

	it('still rejects non-finite totalPrice (Infinity)', () => {
		expect(isValidReceiptLineItem({ name: 'X', quantity: 1, unitPrice: 1, totalPrice: Number.POSITIVE_INFINITY })).toBe(false);
	});

	it('still rejects missing name', () => {
		expect(isValidReceiptLineItem({ name: '', quantity: 1, unitPrice: 1, totalPrice: 1 })).toBe(false);
	});

	it('still rejects whitespace-only name', () => {
		expect(isValidReceiptLineItem({ name: '   ', quantity: 1, unitPrice: 1, totalPrice: 1 })).toBe(false);
	});

	it('still rejects non-object input', () => {
		expect(isValidReceiptLineItem(null)).toBe(false);
		expect(isValidReceiptLineItem(undefined)).toBe(false);
		expect(isValidReceiptLineItem('item')).toBe(false);
		expect(isValidReceiptLineItem(42)).toBe(false);
	});

	it('accepts a zero totalPrice (e.g. free with purchase)', () => {
		expect(isValidReceiptLineItem({ name: 'Free Sample', quantity: 1, unitPrice: 0, totalPrice: 0 })).toBe(true);
	});
});

describe('normalizeReceiptLineItem — defaults for missing fields', () => {
	it('defaults missing quantity to 1', () => {
		const li = normalizeReceiptLineItem({ name: 'A', totalPrice: 5.0 } as never);
		expect(li.quantity).toBe(1);
	});

	it('normalizes non-finite quantity (NaN) to 1', () => {
		const li = normalizeReceiptLineItem({ name: 'A', quantity: Number.NaN, totalPrice: 5.0 } as never);
		expect(li.quantity).toBe(1);
	});

	it('normalizes non-number quantity (string) to 1', () => {
		const li = normalizeReceiptLineItem({ name: 'A', quantity: '2' as never, totalPrice: 5.0 });
		expect(li.quantity).toBe(1);
	});

	it('preserves a valid positive quantity', () => {
		const li = normalizeReceiptLineItem({ name: 'A', quantity: 2, unitPrice: 2.5, totalPrice: 5.0 });
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
		const li = normalizeReceiptLineItem({ name: 'A', quantity: 2, unitPrice: 2.5, totalPrice: 5.0 });
		expect(li.unitPrice).toBe(2.5);
	});

	it('preserves a negative unitPrice (discount line)', () => {
		const li = normalizeReceiptLineItem({ name: 'Coupon', quantity: 1, unitPrice: -2.0, totalPrice: -2.0 });
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
		const li = normalizeReceiptLineItem({ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5, packageSize: '' });
		expect(li.packageSize).toBeNull();
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
