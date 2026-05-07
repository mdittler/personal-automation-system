/**
 * TDD Batch 6 — Codex polish: receipt-query service in isolation.
 * TDD Batch 4 — formatCheapestPriceAnswer wording (REQ-FOOD-PRICE-002).
 */

import { describe, expect, it } from 'vitest';
import type { Receipt, StorePriceData } from '../../types.js';
import { formatCheapestPriceAnswer, formatReceiptDetails } from '../receipt-query.js';

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
	it('returns ≤ 4096 chars for a 50-item receipt with long item names', () => {
		const receipt = makeBigReceipt();
		const result = formatReceiptDetails(receipt, 'show me items');
		expect(result.length).toBeLessThanOrEqual(4096);
	});

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

// ---------------------------------------------------------------------------
// REQ-FOOD-PRICE-002 — formatCheapestPriceAnswer wording
// ---------------------------------------------------------------------------

function makeStore(
	store: string,
	slug: string,
	items: Array<{ name: string; price: number; updatedAt?: string }>,
): StorePriceData {
	return {
		store,
		slug,
		lastUpdated: '2026-05-01',
		items: items.map((i) => ({
			name: i.name,
			price: i.price,
			unit: '1 unit',
			department: 'Produce',
			updatedAt: i.updatedAt ?? '2026-05-01',
		})),
	};
}

describe('formatCheapestPriceAnswer (REQ-FOOD-PRICE-002)', () => {
	// U1 — exact one-line output, multi-store happy path
	it('returns exact wording for cheapest item across stores', () => {
		const data: StorePriceData[] = [
			makeStore('Trader Joes', 'trader-joes', [
				{ name: 'Wild Blueberries', price: 6.49, updatedAt: '2026-04-15' },
			]),
			makeStore('Costco', 'costco', [
				{ name: 'KS Blueberry', price: 9.29, updatedAt: '2026-04-15' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'blueberries');
		expect(result).toBe(
			'Lowest saved package price for blueberries: Wild Blueberries at $6.49 at Trader Joes (updated 2026-04-15).',
		);
		// REQ-FOOD-PRICE-002: single-line answer
		expect(result).not.toContain('\n');
	});

	// U2 — lowest price wins regardless of array order
	it('selects lowest-price entry regardless of input order', () => {
		const data: StorePriceData[] = [
			makeStore('Costco', 'costco', [
				{ name: 'KS Blueberry', price: 9.29, updatedAt: '2026-04-15' },
			]),
			makeStore('Trader Joes', 'trader-joes', [
				{ name: 'Wild Blueberries', price: 6.49, updatedAt: '2026-04-15' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'blueberries');
		expect(result).toContain('Wild Blueberries');
		expect(result).toContain('$6.49');
		expect(result).toContain('Trader Joes');
	});

	// U3 — single store
	it('formats correctly for a single store', () => {
		const data: StorePriceData[] = [
			makeStore('Aldi', 'aldi', [
				{ name: 'Aldi Blueberries', price: 5.99, updatedAt: '2026-05-01' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'blueberries');
		expect(result).toBe(
			'Lowest saved package price for blueberries: Aldi Blueberries at $5.99 at Aldi (updated 2026-05-01).',
		);
	});

	// U4 — empty updatedAt omits the "(updated …)" suffix
	it('omits (updated ...) suffix when updatedAt is empty string', () => {
		const data: StorePriceData[] = [
			makeStore('Aldi', 'aldi', [{ name: 'Aldi Blueberries', price: 5.99, updatedAt: '' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'blueberries');
		expect(result).toContain('Aldi Blueberries at $5.99 at Aldi.');
		expect(result).not.toMatch(/\(updated\b/);
	});

	// U5 — old wording must be absent (regression guard)
	it('does not use the old "is cheapest for" phrasing', () => {
		const data: StorePriceData[] = [
			makeStore('Trader Joes', 'trader-joes', [
				{ name: 'Wild Blueberries', price: 6.49, updatedAt: '2026-04-15' },
			]),
		];
		expect(formatCheapestPriceAnswer(data, 'blueberries')).not.toContain('is cheapest for');
	});

	// U6 — output must not contain a newline
	it('returns a single-line string (no newline)', () => {
		const data: StorePriceData[] = [
			makeStore('Trader Joes', 'trader-joes', [
				{ name: 'Wild Blueberries', price: 6.49, updatedAt: '2026-04-15' },
			]),
		];
		expect(formatCheapestPriceAnswer(data, 'blueberries')).not.toContain('\n');
	});

	// U7 — no price data
	it('returns no-saved-prices message when priceData is empty', () => {
		expect(formatCheapestPriceAnswer([], 'blueberries')).toBe(
			'I do not have saved prices for blueberries yet.',
		);
	});

	// U8 — query has no matching item
	it('returns no-saved-prices message when no items match the query', () => {
		const data: StorePriceData[] = [
			makeStore('Costco', 'costco', [{ name: 'Apples', price: 3.99, updatedAt: '2026-05-01' }]),
		];
		expect(formatCheapestPriceAnswer(data, 'blueberries')).toBe(
			'I do not have saved prices for blueberries yet.',
		);
	});

	// U9 — markdown escape: store name with *
	it('escapes * in store name', () => {
		const data: StorePriceData[] = [
			makeStore("Joe*s Market", 'joes', [{ name: 'Plain Blueberries', price: 4.99, updatedAt: '2026-05-01' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'blueberries');
		expect(result).toContain('Joe\\*s Market');
		// no unescaped * in output
		expect(result).not.toMatch(/(?<!\\)\*/);
	});

	// U10 — markdown escape: item query and entry name with _
	it('escapes _ in item query and entry name', () => {
		const data: StorePriceData[] = [
			makeStore('Costco', 'costco', [
				{ name: 'Frozen_Beans', price: 2.99, updatedAt: '2026-05-01' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'green_beans');
		expect(result).toContain('green\\_beans');
		expect(result).toContain('Frozen\\_Beans');
		// no unescaped _ in output
		expect(result).not.toMatch(/(?<!\\)_/);
	});

	// U11 — markdown escape in the no-match (empty-state) branch
	it('escapes _ in item query for the no-saved-prices response', () => {
		const data: StorePriceData[] = [
			makeStore('Costco', 'costco', [{ name: 'Apples', price: 3.99, updatedAt: '2026-05-01' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'green_beans');
		expect(result).toBe('I do not have saved prices for green\\_beans yet.');
	});
});
