import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import {
	loadStorePrices,
	saveStorePrices,
	getStoreSlug,
	addOrUpdatePrice,
	lookupPrice,
	listStores,
	formatPriceFile,
	parsePriceFile,
	updatePricesFromReceipt,
	isPriceUpdateIntent,
	parsePriceUpdateText,
} from '../services/price-store.js';
import type { PriceEntry, StorePriceData, Receipt } from '../types.js';
import type { CoreServices } from '@pas/core/types';

function createMockStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeEntry(overrides: Partial<PriceEntry> = {}): PriceEntry {
	return {
		name: 'Eggs (60ct)',
		price: 7.99,
		unit: '60ct',
		department: 'Dairy',
		updatedAt: '2026-04-05',
		...overrides,
	};
}

describe('price-store', () => {
	describe('getStoreSlug', () => {
		it('lowercases and replaces spaces with hyphens', () => {
			expect(getStoreSlug('Whole Foods Market')).toBe('whole-foods-market');
		});
		it('strips special characters', () => {
			expect(getStoreSlug("Trader Joe's")).toBe('trader-joes');
		});
		it('collapses multiple hyphens', () => {
			expect(getStoreSlug('Sam\'s  Club!')).toBe('sams-club');
		});
		it('returns "unknown-store" for all-special-character names', () => {
			expect(getStoreSlug('!!!')).toBe('unknown-store');
			expect(getStoreSlug('')).toBe('unknown-store');
		});
		it('strips path traversal attempts', () => {
			expect(getStoreSlug('../../etc/passwd')).toBe('etcpasswd');
			expect(getStoreSlug('../malicious')).toBe('malicious');
		});
	});

	// ─── D2a: Price-list frontmatter enrichment ───────────────────
	describe('formatPriceFile frontmatter enrichment (D2a)', () => {
		it('includes type: price-list in frontmatter', () => {
			const data: StorePriceData = {
				store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07', items: [],
			};
			const result = formatPriceFile(data);
			expect(result).toContain('type: price-list');
		});

		it('includes entity_keys with lowercased store name', () => {
			const data: StorePriceData = {
				store: 'Whole Foods', slug: 'whole-foods', lastUpdated: '2026-04-07', items: [],
			};
			const result = formatPriceFile(data);
			expect(result).toContain('entity_keys:');
			expect(result).toContain('whole foods');
		});

		it('includes entity_keys with slug', () => {
			const data: StorePriceData = {
				store: 'Whole Foods', slug: 'whole-foods', lastUpdated: '2026-04-07', items: [],
			};
			const result = formatPriceFile(data);
			expect(result).toContain('whole-foods');
		});
	});

	describe('formatPriceFile', () => {
		it('formats items grouped by department', () => {
			const data: StorePriceData = {
				store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07',
				items: [
					makeEntry({ name: 'Eggs (60ct)', price: 7.99, department: 'Dairy' }),
					makeEntry({ name: 'Milk (1 gal)', price: 3.89, department: 'Dairy' }),
					makeEntry({ name: 'Bananas (3 lb)', price: 1.49, department: 'Produce' }),
				],
			};
			const result = formatPriceFile(data);
			expect(result).toContain('store: Costco');
			expect(result).toContain('## Dairy');
			expect(result).toContain('## Produce');
			expect(result).toContain('- Eggs (60ct): $7.99');
			expect(result).toContain('- Milk (1 gal): $3.89');
			expect(result).toContain('- Bananas (3 lb): $1.49');
		});
		it('includes update dates as HTML comments', () => {
			const data: StorePriceData = {
				store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07',
				items: [makeEntry({ updatedAt: '2026-04-05' })],
			};
			const result = formatPriceFile(data);
			expect(result).toContain('<!-- updated: 2026-04-05 -->');
		});
	});

	describe('parsePriceFile', () => {
		it('parses a formatted price file back to StorePriceData', () => {
			const input = [
				'---', 'store: Costco', 'slug: costco', 'last_updated: "2026-04-07"', 'item_count: 2', '---', '',
				'## Dairy',
				'- Eggs (60ct): $7.99 <!-- updated: 2026-04-05 -->',
				'- Milk (1 gal): $3.89 <!-- updated: 2026-04-01 -->',
			].join('\n');
			const result = parsePriceFile(input, 'costco');
			expect(result.store).toBe('Costco');
			expect(result.slug).toBe('costco');
			expect(result.items).toHaveLength(2);
			expect(result.items[0]).toEqual({
				name: 'Eggs (60ct)', price: 7.99, unit: '60ct', department: 'Dairy', updatedAt: '2026-04-05',
			});
		});
		it('returns empty items for empty file', () => {
			const result = parsePriceFile('', 'costco');
			expect(result.items).toEqual([]);
			expect(result.store).toBe('costco');
		});
		it('handles malformed frontmatter gracefully', () => {
			const raw = '## Dairy\n- Eggs (60ct): $7.99 <!-- updated: 2026-04-05 -->';
			const result = parsePriceFile(raw, 'test');
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.name).toBe('Eggs (60ct)');
		});
		it('skips lines with non-numeric prices', () => {
			const raw = '## Dairy\n- Eggs (60ct): $abc <!-- updated: 2026-04-05 -->\n- Milk (1 gal): $3.89 <!-- updated: 2026-04-01 -->';
			const result = parsePriceFile(raw, 'test');
			// $abc should be parsed as NaN and filtered or handled
			const validItems = result.items.filter(i => !isNaN(i.price));
			expect(validItems).toHaveLength(1);
		});
		it('extracts unit from parenthetical in name', () => {
			const input = [
				'---', 'store: Test', 'slug: test', 'last_updated: "2026-04-07"', 'item_count: 1', '---', '',
				'## Pantry', '- AP Flour (25 lb): $8.99 <!-- updated: 2026-04-07 -->',
			].join('\n');
			const result = parsePriceFile(input, 'test');
			expect(result.items[0]?.unit).toBe('25 lb');
			expect(result.items[0]?.name).toBe('AP Flour (25 lb)');
		});
	});

	describe('loadStorePrices', () => {
		it('returns parsed data from file', async () => {
			const fileContent = [
				'---', 'store: Costco', 'slug: costco', 'last_updated: "2026-04-07"', 'item_count: 1', '---', '',
				'## Dairy', '- Eggs (60ct): $7.99 <!-- updated: 2026-04-05 -->',
			].join('\n');
			const store = createMockStore({ read: vi.fn().mockResolvedValue(fileContent) });
			const result = await loadStorePrices(store as never, 'costco');
			expect(result.store).toBe('Costco');
			expect(result.items).toHaveLength(1);
		});
		it('returns empty data for missing file', async () => {
			const store = createMockStore();
			const result = await loadStorePrices(store as never, 'costco');
			expect(result.items).toEqual([]);
			expect(result.slug).toBe('costco');
		});
	});

	describe('saveStorePrices', () => {
		it('writes formatted price file', async () => {
			const store = createMockStore();
			const data: StorePriceData = { store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07', items: [makeEntry()] };
			await saveStorePrices(store as never, data);
			expect(store.write).toHaveBeenCalledOnce();
			const [path, content] = store.write.mock.calls[0] as [string, string];
			expect(path).toBe('prices/costco.md');
			expect(content).toContain('store: Costco');
			expect(content).toContain('- Eggs (60ct): $7.99');
		});
	});

	describe('addOrUpdatePrice', () => {
		it('adds a new item', () => {
			const data: StorePriceData = { store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07', items: [] };
			const updated = addOrUpdatePrice(data, makeEntry({ name: 'Bananas (3 lb)', price: 1.49, department: 'Produce' }));
			expect(updated.items).toHaveLength(1);
			expect(updated.items[0]?.name).toBe('Bananas (3 lb)');
		});
		it('rejects entry with zero price and returns data unchanged', () => {
			const data: StorePriceData = {
				store: 'Test', slug: 'test', lastUpdated: '2026-04-01',
				items: [makeEntry({ name: 'Eggs (60ct)', price: 7.99 })],
			};
			const updated = addOrUpdatePrice(data, makeEntry({ name: 'Free Item', price: 0 }));
			expect(updated.items).toHaveLength(1);
			expect(updated).toBe(data);
		});
		it('rejects entry with negative price and returns data unchanged', () => {
			const data: StorePriceData = { store: 'Test', slug: 'test', lastUpdated: '2026-04-01', items: [] };
			const updated = addOrUpdatePrice(data, makeEntry({ price: -3.50 }));
			expect(updated.items).toHaveLength(0);
			expect(updated).toBe(data);
		});
		it('rejects entry with price > 9999 and returns data unchanged', () => {
			const data: StorePriceData = { store: 'Test', slug: 'test', lastUpdated: '2026-04-01', items: [] };
			const updated = addOrUpdatePrice(data, makeEntry({ price: 10000 }));
			expect(updated.items).toHaveLength(0);
			expect(updated).toBe(data);
		});
		it('rejects entry with empty name and returns data unchanged', () => {
			const data: StorePriceData = { store: 'Test', slug: 'test', lastUpdated: '2026-04-01', items: [] };
			const updated = addOrUpdatePrice(data, makeEntry({ name: '' }));
			expect(updated.items).toHaveLength(0);
			expect(updated).toBe(data);
		});
		it('accepts valid entry and proceeds normally', () => {
			const data: StorePriceData = { store: 'Test', slug: 'test', lastUpdated: '2026-04-01', items: [] };
			const updated = addOrUpdatePrice(data, makeEntry({ name: 'Butter (1 lb)', price: 4.99 }));
			expect(updated.items).toHaveLength(1);
			expect(updated.items[0]?.name).toBe('Butter (1 lb)');
		});
		it('updates existing item by name (case-insensitive)', () => {
			const data: StorePriceData = { store: 'Costco', slug: 'costco', lastUpdated: '2026-04-07', items: [makeEntry({ name: 'Eggs (60ct)', price: 7.99 })] };
			const updated = addOrUpdatePrice(data, makeEntry({ name: 'eggs (60ct)', price: 8.49, updatedAt: '2026-04-07' }));
			expect(updated.items).toHaveLength(1);
			expect(updated.items[0]?.price).toBe(8.49);
			expect(updated.items[0]?.name).toBe('Eggs (60ct)');
		});
	});

	describe('lookupPrice', () => {
		it('finds exact match', () => {
			const items = [makeEntry({ name: 'Eggs (60ct)', price: 7.99 })];
			expect(lookupPrice(items, 'Eggs (60ct)')?.price).toBe(7.99);
		});
		it('finds case-insensitive match', () => {
			const items = [makeEntry({ name: 'Eggs (60ct)', price: 7.99 })];
			expect(lookupPrice(items, 'eggs (60ct)')?.price).toBe(7.99);
		});
		it('returns null for no match', () => {
			const items = [makeEntry()];
			expect(lookupPrice(items, 'Bananas')).toBeNull();
		});
	});

	describe('listStores', () => {
		it('lists store slugs from prices directory', async () => {
			const store = createMockStore({ list: vi.fn().mockResolvedValue(['costco.md', 'kroger.md', 'walmart.md']) });
			const result = await listStores(store as never);
			expect(result).toEqual(['costco', 'kroger', 'walmart']);
		});
		it('returns empty array when no price files', async () => {
			const store = createMockStore();
			const result = await listStores(store as never);
			expect(result).toEqual([]);
		});
	});

	describe('updatePricesFromReceipt', () => {
		function createMockServices(): CoreServices {
			return {
				llm: {
					complete: vi.fn().mockResolvedValue(JSON.stringify([
						{ receiptName: 'KS ORG EGGS 5DZ', normalizedName: 'Eggs (60ct)', department: 'Dairy', unit: '60ct' },
						{ receiptName: 'BANANA', normalizedName: 'Bananas (3 lb)', department: 'Produce', unit: '3 lb' },
					])),
				},
				logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			} as unknown as CoreServices;
		}

		const receipt: Receipt = {
			id: '2026-04-07-abc123', store: 'Costco', date: '2026-04-07',
			lineItems: [
				{ name: 'KS ORG EGGS 5DZ', quantity: 1, unitPrice: 8.49, totalPrice: 8.49 },
				{ name: 'BANANA', quantity: 1, unitPrice: 1.49, totalPrice: 1.49 },
			],
			subtotal: 9.98, tax: 0.60, total: 10.58,
			photoPath: 'photos/receipt-abc.jpg', capturedAt: '2026-04-07T10:00:00.000Z',
		};

		it('normalizes receipt items and updates price store', async () => {
			const mockStore = createMockStore();
			const mockServices = createMockServices();
			const result = await updatePricesFromReceipt(mockServices, mockStore as never, receipt);
			expect(result.updatedCount + result.addedCount).toBe(2);
			expect(mockStore.write).toHaveBeenCalledOnce();
			const [path] = mockStore.write.mock.calls[0] as [string, string];
			expect(path).toBe('prices/costco.md');
		});

		it('returns summary with counts', async () => {
			const existingContent = [
				'---', 'store: Costco', 'slug: costco', 'last_updated: "2026-04-01"', 'item_count: 1', '---', '',
				'## Dairy', '- Eggs (60ct): $7.99 <!-- updated: 2026-04-01 -->',
			].join('\n');
			const mockStore = createMockStore({ read: vi.fn().mockResolvedValue(existingContent) });
			const mockServices = createMockServices();
			const result = await updatePricesFromReceipt(mockServices, mockStore as never, receipt);
			expect(result.updatedCount).toBe(1);
			expect(result.addedCount).toBe(1);
		});

		it('handles LLM failure gracefully', async () => {
			const mockStore = createMockStore();
			const mockServices = createMockServices();
			vi.mocked(mockServices.llm.complete).mockRejectedValue(new Error('LLM unavailable'));
			const result = await updatePricesFromReceipt(mockServices, mockStore as never, receipt);
			expect(result.updatedCount).toBe(0);
			expect(result.addedCount).toBe(0);
			expect(result.error).toBeTruthy();
		});

		it('skips line items with zero or negative prices', async () => {
			const mockStore = createMockStore();
			const mockServices = createMockServices();
			vi.mocked(mockServices.llm.complete).mockResolvedValue(JSON.stringify([
				{ receiptName: 'COUPON DISC', normalizedName: 'Coupon', department: 'Other', unit: '' },
			]));
			const receiptWithDiscount: Receipt = {
				...receipt, lineItems: [{ name: 'COUPON DISC', quantity: 1, unitPrice: null, totalPrice: -2.00 }],
			};
			const result = await updatePricesFromReceipt(mockServices, mockStore as never, receiptWithDiscount);
			expect(result.addedCount).toBe(0);
		});

		it('sets updatedAt from capturedAt (date-only) when capturedAt is present', async () => {
			const mockStore = createMockStore();
			const mockServices = createMockServices();
			const receiptWithCapturedAt: Receipt = {
				...receipt,  // receipt fixture has date: '2026-04-07', capturedAt: '2026-04-07T10:00:00.000Z'
				date: '2026-01-01',      // stale display date (what LLM might hallucinate)
				capturedAt: '2026-04-07T10:00:00.000Z',  // real capture time
			};
			await updatePricesFromReceipt(mockServices, mockStore as never, receiptWithCapturedAt);
			const [, content] = mockStore.write.mock.calls[0] as [string, string];
			expect(content).toContain('updated: 2026-04-07');   // capturedAt.slice(0,10), not '2026-01-01'
			expect(content).not.toContain('updated: 2026-01-01');
		});

		it('falls back to receipt.date for updatedAt when capturedAt is absent', async () => {
			const mockStore = createMockStore();
			const mockServices = createMockServices();
			const receiptWithoutCapturedAt: Receipt = {
				...receipt,
				capturedAt: undefined as unknown as string,  // legacy receipt without capturedAt
			};
			await updatePricesFromReceipt(mockServices, mockStore as never, receiptWithoutCapturedAt);
			const [, content] = mockStore.write.mock.calls[0] as [string, string];
			expect(content).toContain('updated: 2026-04-07');   // falls back to receipt.date
		});
	});

	describe('isPriceUpdateIntent', () => {
		it('detects "eggs are $3.50 at costco"', () => { expect(isPriceUpdateIntent('eggs are $3.50 at costco')).toBe(true); });
		it('detects "update milk price to $4.29"', () => { expect(isPriceUpdateIntent('update milk price to $4.29')).toBe(true); });
		it('detects "chicken breast is $17.99 at kroger"', () => { expect(isPriceUpdateIntent('chicken breast is $17.99 at kroger')).toBe(true); });
		it('detects "milk costs $3.89 at costco now"', () => { expect(isPriceUpdateIntent('milk costs $3.89 at costco now')).toBe(true); });
		it('rejects "what is milk?"', () => { expect(isPriceUpdateIntent('what is milk?')).toBe(false); });
		it('rejects "add milk to grocery list"', () => { expect(isPriceUpdateIntent('add milk to grocery list')).toBe(false); });
		it('rejects messages about prices without update intent', () => {
			expect(isPriceUpdateIntent('how much do eggs cost?')).toBe(false);
			expect(isPriceUpdateIntent('eggs are expensive these days')).toBe(false);
		});
		it('rejects budget queries with dollar amounts', () => {
			expect(isPriceUpdateIntent('we spent $200 on groceries')).toBe(false);
			expect(isPriceUpdateIntent('food costs $50 this week')).toBe(false);
			expect(isPriceUpdateIntent('I heard eggs were $3 last week')).toBe(false);
		});
	});

	describe('parsePriceUpdateText', () => {
		function createMockServices(): CoreServices {
			return {
				llm: { complete: vi.fn().mockResolvedValue(JSON.stringify({ item: 'Eggs (60ct)', price: 3.50, store: 'Costco', unit: '60ct', department: 'Dairy' })) },
				logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
			} as unknown as CoreServices;
		}

		it('parses text into price update', async () => {
			const svc = createMockServices();
			const result = await parsePriceUpdateText(svc, 'eggs are $3.50 at costco');
			expect(result).not.toBeNull();
			expect(result!.item).toBe('Eggs (60ct)');
			expect(result!.price).toBe(3.50);
			expect(result!.store).toBe('Costco');
		});

		it('returns null on LLM failure', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockRejectedValue(new Error('fail'));
			const result = await parsePriceUpdateText(svc, 'eggs $3.50 costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns invalid JSON', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue('not valid json');
			const result = await parsePriceUpdateText(svc, 'eggs are $3.50 at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns JSON with missing fields', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: 'Eggs' }));
			const result = await parsePriceUpdateText(svc, 'eggs are $3.50 at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns negative price', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: 'Eggs (60ct)', price: -3.50, store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'eggs are $3.50 at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns zero price', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: 'Eggs (60ct)', price: 0, store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'eggs at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns price > 9999', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: 'Eggs (60ct)', price: 9999.01, store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'eggs at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns string price', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: 'Eggs (60ct)', price: '8.49', store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'eggs are $8.49 at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns empty item name', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ item: '', price: 3.50, store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'something at costco');
			expect(result).toBeNull();
		});
		it('returns null when LLM returns missing item', async () => {
			const svc = createMockServices();
			vi.mocked(svc.llm.complete).mockResolvedValue(JSON.stringify({ price: 3.50, store: 'Costco', unit: '60ct', department: 'Dairy' }));
			const result = await parsePriceUpdateText(svc, 'something at costco');
			expect(result).toBeNull();
		});
	});
});
