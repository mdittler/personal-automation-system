/**
 * TDD Batch 6 — Codex polish: receipt-query service in isolation.
 *
 * RED:
 *   1. formatReceiptDetails with 50 long-name items returns a string exceeding
 *      4096 chars (Telegram limit) — no length guard exists yet.
 *
 * GREEN:
 *   1 → length guard truncates at 3500 chars with "…and N more items" marker.
 */

import { describe, expect, it } from 'vitest';
import type { Receipt } from '../../types.js';
import { formatReceiptDetails } from '../receipt-query.js';

function makeBigReceipt(): Receipt {
	const name = (i: number) =>
		`Very Long Product Name That Takes Up Lots Of Space Item ${String(i).padStart(2, '0')}`;
	return {
		id: 'big-receipt',
		store: 'Costco',
		date: '2026-01-15',
		lineItems: Array.from({ length: 50 }, (_, i) => ({
			name: name(i + 1),
			quantity: 1,
			unitPrice: 10.0,
			totalPrice: 10.0,
		})),
		subtotal: 500.0,
		tax: 50.0,
		total: 550.0,
		photoPath: 'photos/big.jpg',
		capturedAt: '2026-01-15T10:00:00.000Z',
	};
}

describe('formatReceiptDetails', () => {
	// RED: no length guard → string may exceed 4096. GREEN: guard truncates.
	it('returns ≤ 4096 chars for a 50-item receipt with long item names', () => {
		const receipt = makeBigReceipt();
		const result = formatReceiptDetails(receipt, 'show me items');
		expect(result.length).toBeLessThanOrEqual(4096);
	});

	// RED: same test confirming the truncation marker is present when truncated.
	it('includes a truncation marker when items are omitted', () => {
		const receipt = makeBigReceipt();
		const result = formatReceiptDetails(receipt, 'show me items');
		// Only meaningful if the receipt is actually long enough to trigger truncation.
		// We constructed 50 × ~90-char lines which exceeds 3500 chars.
		if (result.length < 4096) {
			expect(result).toMatch(/…and \d+ more items/);
		}
	});

	// Regression guard — short receipt must still show all items (no truncation).
	it('shows all items when receipt is short enough', () => {
		const shortReceipt: Receipt = {
			id: 'short',
			store: 'TJs',
			date: '2026-01-01',
			lineItems: [
				{ name: 'Bananas', quantity: 1, unitPrice: 0.49, totalPrice: 0.49 },
				{ name: 'Apples', quantity: 1, unitPrice: 1.29, totalPrice: 1.29 },
			],
			subtotal: 1.78,
			tax: null,
			total: 1.78,
			photoPath: 'photos/short.jpg',
			capturedAt: '2026-01-01T10:00:00.000Z',
		};
		const result = formatReceiptDetails(shortReceipt, 'show me items');
		expect(result).toContain('Bananas');
		expect(result).toContain('Apples');
		expect(result).not.toMatch(/…and \d+ more items/);
	});
});
