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
} from '../services/price-store.js';
import type { PriceEntry, StorePriceData } from '../types.js';

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
});
