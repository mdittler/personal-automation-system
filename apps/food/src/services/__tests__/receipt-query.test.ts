/**
 * TDD Batch 6 — Codex polish: receipt-query service in isolation.
 * TDD Batch 4 — formatCheapestPriceAnswer wording (REQ-FOOD-PRICE-002).
 */

import { describe, expect, it } from 'vitest';
import type { Receipt, StorePriceData } from '../../types.js';
import {
	extractPriceItem,
	formatCheapestPriceAnswer,
	formatReceiptDetails,
} from '../receipt-query.js';

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

// ---------------------------------------------------------------------------
// REQ-FOOD-PRICE-003 — formatCheapestPriceAnswer unit-price comparison
// ---------------------------------------------------------------------------

import { parseSizeString } from '../unit-normalizer.js';

function makeStoreWithUnit(
	store: string,
	slug: string,
	items: Array<{ name: string; price: number; unit: string; updatedAt?: string }>,
): StorePriceData {
	return {
		store,
		slug,
		lastUpdated: '2026-05-01',
		items: items.map((i) => ({
			name: i.name,
			price: i.price,
			unit: i.unit,
			department: 'Produce',
			updatedAt: i.updatedAt ?? '2026-05-01',
		})),
	};
}

describe('formatCheapestPriceAnswer — unit-price comparison (REQ-FOOD-PRICE-003)', () => {
	// U12 — Smaller package wins on package price but larger package wins on unit price.
	it('U12: returns larger-package entry by unit price when smaller has lower package price', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('Trader Joes', 'trader-joes', [
				{ name: 'Flour A', price: 4.99, unit: '6 oz' },
			]),
			makeStoreWithUnit('Costco', 'costco', [
				{ name: 'Flour B', price: 7.99, unit: '12 oz' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'flour');
		// 6 oz @ $4.99 = ~$2.93/100g; 12 oz @ $7.99 = ~$2.35/100g
		// 12 oz wins on unit price.
		expect(result).toContain('Lowest saved unit price for flour');
		expect(result).toContain('Flour B');
		expect(result).toContain('Costco');
		expect(result).toContain('/100g');
		expect(result).not.toContain('Lowest saved package price');
	});

	// U13 — Three entries same base; lowest unit price wins.
	it('U13: picks lowest-unit-price entry among three same-base entries', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [{ name: 'Rice 8oz', price: 3.0, unit: '8 oz' }]),
			makeStoreWithUnit('B', 'b', [{ name: 'Rice 16oz', price: 4.5, unit: '16 oz' }]),
			makeStoreWithUnit('C', 'c', [{ name: 'Rice 32oz', price: 7.0, unit: '32 oz' }]),
		];
		// 8oz @ $3 → $1.32/100g
		// 16oz @ $4.50 → $0.99/100g
		// 32oz @ $7 → $0.77/100g — winner
		const result = formatCheapestPriceAnswer(data, 'rice');
		expect(result).toContain('Lowest saved unit price for rice');
		expect(result).toContain('Rice 32oz');
		expect(result).toContain('/100g');
	});

	// U14 — Mixed bases: mass + volume → not all same base → package mode.
	it('U14: mixed mass+volume entries fall back to package-price mode', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [
				{ name: 'Item 12oz', price: 4.0, unit: '12 oz' },
				{ name: 'Item 16oz', price: 5.0, unit: '16 oz' },
			]),
			makeStoreWithUnit('B', 'b', [
				{ name: 'Item 1L', price: 3.0, unit: '1 L' },
				{ name: 'Item 750ml', price: 2.5, unit: '750 ml' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'item');
		expect(result).toContain('Lowest saved package price');
		expect(result).not.toMatch(/\/100g|\/100ml/);
	});

	// U15 — One unparseable unit → not all entries parse → package mode.
	it('U15: presence of unparseable unit forces package-price mode', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [{ name: 'Item 12oz', price: 4.0, unit: '12 oz' }]),
			makeStoreWithUnit('B', 'b', [{ name: 'Item 16oz', price: 5.0, unit: '16 oz' }]),
			makeStoreWithUnit('C', 'c', [{ name: 'Item large', price: 3.0, unit: 'large' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'item');
		expect(result).toContain('Lowest saved package price');
		expect(result).not.toMatch(/\/100g|\/100ml/);
	});

	// U16 — Two same-base + one different-base → not all same base → package mode.
	it('U16: parseable but mixed-base entries fall back to package-price mode', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [{ name: 'Item 12oz', price: 4.0, unit: '12 oz' }]),
			makeStoreWithUnit('B', 'b', [{ name: 'Item 16oz', price: 5.0, unit: '16 oz' }]),
			makeStoreWithUnit('C', 'c', [{ name: 'Item 12ct', price: 3.0, unit: '12 ct' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'item');
		expect(result).toContain('Lowest saved package price');
		expect(result).not.toMatch(/\/100g|\/100ml|\/ct\b/);
	});

	// U17 — All entries unparseable → package mode.
	it('U17: all unparseable entries fall back to package-price mode', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [{ name: 'Item large', price: 4.0, unit: 'large' }]),
			makeStoreWithUnit('B', 'b', [{ name: 'Item small', price: 3.0, unit: 'small' }]),
		];
		const result = formatCheapestPriceAnswer(data, 'item');
		expect(result).toContain('Lowest saved package price');
		expect(result).not.toMatch(/\/100g|\/100ml/);
	});

	// U18 — Tied unit prices: alphabetical tiebreak by name.
	it('U18: ties on unit price break alphabetically by store name', () => {
		// Two 12oz @ same price → identical unit price.
		const data: StorePriceData[] = [
			makeStoreWithUnit('Zebra Mart', 'zebra-mart', [
				{ name: 'Sugar 12oz', price: 4.0, unit: '12 oz' },
			]),
			makeStoreWithUnit('Acme', 'acme', [
				{ name: 'Sugar 12oz', price: 4.0, unit: '12 oz' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'sugar');
		expect(result).toContain('Lowest saved unit price for sugar');
		expect(result).toContain('Acme');
		expect(result).not.toMatch(/Zebra/);
	});

	// U19 — No entries → "no saved prices" wording.
	it('U19: zero entries returns no-saved-prices wording', () => {
		expect(formatCheapestPriceAnswer([], 'flour')).toBe(
			'I do not have saved prices for flour yet.',
		);
	});

	// U20 — Single parseable entry → package mode (need ≥2 for unit-price).
	it('U20: a single parseable entry falls back to package-price mode', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('Aldi', 'aldi', [
				{ name: 'Flour 5lb', price: 4.99, unit: '5 lb' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'flour');
		expect(result).toContain('Lowest saved package price for flour');
		expect(result).not.toMatch(/\/100g|\/100ml/);
	});

	// U21 — All malformed prices filtered → no-saved-prices wording.
	it('U21: all entries with invalid price fields fall through to no-saved-prices', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [
				{ name: 'Bad NaN', price: Number.NaN, unit: '12 oz' },
				{ name: 'Bad Inf', price: Number.POSITIVE_INFINITY, unit: '12 oz' },
				{ name: 'Bad Neg', price: -1, unit: '12 oz' },
				{ name: 'Bad Zero', price: 0, unit: '12 oz' },
			]),
		];
		// Note: lookupPriceMatches matches by tokens; ensure the query matches "bad"
		const result = formatCheapestPriceAnswer(data, 'bad');
		expect(result).toBe('I do not have saved prices for bad yet.');
	});

	// U22 — Bad prices excluded; valid entries still compete in their mode.
	it('U22: invalid-price entries are excluded; valid entries compete normally', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('A', 'a', [
				{ name: 'Apple Bad', price: Number.NaN, unit: '6 oz' },
				{ name: 'Apple Good A', price: 4.99, unit: '6 oz' },
			]),
			makeStoreWithUnit('B', 'b', [
				{ name: 'Apple Good B', price: 7.99, unit: '12 oz' },
			]),
		];
		// After filter: 6 oz @ $4.99 vs 12 oz @ $7.99 → unit-price mode; 12 oz wins
		const result = formatCheapestPriceAnswer(data, 'apple');
		expect(result).toContain('Lowest saved unit price for apple');
		expect(result).toContain('Apple Good B');
		expect(result).toContain('/100g');
	});

	// U23 — Idempotency / normalization-at-comparison-time test.
	it('U23: pre-populating sizeValue/sizeBase yields the same winner as auto-derivation', () => {
		const dataA: StorePriceData[] = [
			makeStoreWithUnit('Trader Joes', 'tj', [
				{ name: 'Flour A', price: 4.99, unit: '6 oz' },
			]),
			makeStoreWithUnit('Costco', 'costco', [
				{ name: 'Flour B', price: 7.99, unit: '12 oz' },
			]),
		];
		// Pre-populated copy
		const dataB: StorePriceData[] = dataA.map((store) => ({
			...store,
			items: store.items.map((it) => {
				const parsed = parseSizeString(it.unit);
				return parsed ? { ...it, sizeValue: parsed.value, sizeBase: parsed.base } : { ...it };
			}),
		}));

		const resultA = formatCheapestPriceAnswer(dataA, 'flour');
		const resultB = formatCheapestPriceAnswer(dataB, 'flour');
		expect(resultA).toBe(resultB);
	});

	// U24 — Contract test: one (and only one) of the two reply forms.
	it('U24: every reply with ≥1 valid entry is exactly one of unit-price or package-price wording', () => {
		const cases: StorePriceData[][] = [
			[makeStoreWithUnit('A', 'a', [{ name: 'Apple 6oz', price: 4.99, unit: '6 oz' }, { name: 'Apple 12oz', price: 7.99, unit: '12 oz' }])],
			[makeStoreWithUnit('A', 'a', [{ name: 'Apple', price: 4.99, unit: 'large' }])],
			[makeStoreWithUnit('A', 'a', [{ name: 'Apple', price: 4.99, unit: '5 lb' }, { name: 'Bread', price: 3.0, unit: '1 L' }])],
		];
		for (const data of cases) {
			const r = formatCheapestPriceAnswer(data, 'apple');
			const isUnit = r.includes('Lowest saved unit price for');
			const isPkg = r.includes('Lowest saved package price for');
			expect(isUnit !== isPkg).toBe(true);
		}
	});

	// U25 — $4.99 / 5 lb flour single entry → package mode (single entry).
	it('U25: a single 5 lb flour entry uses package-price wording (no unit token)', () => {
		const data: StorePriceData[] = [
			makeStoreWithUnit('Aldi', 'aldi', [
				{ name: 'Flour 5lb', price: 4.99, unit: '5 lb' },
			]),
		];
		const result = formatCheapestPriceAnswer(data, 'flour');
		expect(result).toContain('Lowest saved package price');
		expect(result).not.toContain('/100g');
		expect(result).not.toContain('/100ml');
		expect(result).not.toContain('/ct');
	});
});

// Batch 3 — Food "cheapest X" NL intent gap (Chunk C evidence).
// The cached failing prompt from `chatbot-cheapest-blueberries`:
//   "Where can I get the cheapest blueberries among the stores I have saved prices for?"
// The old regex required `\bbuy\s+` after `cheapest`, missing this phrasing.
describe('extractPriceItem — cheapest-X NL broadening (Batch 3)', () => {
	it('extracts item from EXACT cached failing prompt: "cheapest blueberries among the stores..."', () => {
		expect(
			extractPriceItem(
				'Where can I get the cheapest blueberries among the stores I have saved prices for?',
			),
		).toBe('blueberry');
	});

	it('extracts item from "cheapest place to buy blueberries"', () => {
		expect(extractPriceItem("what's the cheapest place to buy blueberries?")).toBe('blueberry');
	});

	it('extracts item from "cheapest place to get blueberries"', () => {
		expect(extractPriceItem('cheapest place to get blueberries')).toBe('blueberry');
	});

	it('extracts item from "cheapest milk at Costco"', () => {
		expect(extractPriceItem('cheapest milk at Costco')).toBe('milk');
	});

	it('extracts item from bare "cheapest blueberries"', () => {
		expect(extractPriceItem('cheapest blueberries')).toBe('blueberry');
	});

	// Negative — non-item prose may produce a token, but it should NOT match a
	// real grocery item. The regex's job is to extract a candidate; the
	// downstream `findPriceMatches` returns null for unknown items. Contract
	// here: the regex broadening doesn't return a known grocery item like
	// "blueberry" or "milk" on non-grocery prose.
	it('does NOT return a known grocery item for "the cheapest option was great"', () => {
		const r = extractPriceItem('the cheapest option was great');
		expect(r).not.toBe('blueberry');
		expect(r).not.toBe('milk');
		expect(r).not.toBe('bread');
	});
});
