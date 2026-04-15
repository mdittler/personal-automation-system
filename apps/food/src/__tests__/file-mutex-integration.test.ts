/**
 * Integration tests for in-process RMW locks on food shared stores.
 *
 * Verifies that concurrent operations on the same store produce correct
 * (non-lost) results, and that multi-store locks don't deadlock.
 */

import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import type { ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import {
	addItems,
	archivePurchased,
	createEmptyList,
	loadGroceryList,
	saveGroceryList,
	withGroceryLock,
} from '../services/grocery-store.js';
import {
	addPantryItems,
	loadPantry,
	savePantry,
	withPantryLock,
} from '../services/pantry-store.js';
import { appendWaste, withWasteLock } from '../services/waste-store.js';
import { withFreezerLock } from '../services/freezer-store.js';
import { withMultiFileLock } from '@pas/core/utils/file-mutex';
import type { GroceryItem, PantryItem, WasteLogEntry } from '../types.js';

/**
 * Build a real-ish in-memory ScopedDataStore. Uses a Map to simulate
 * file reads/writes with full async semantics. This is sufficient for
 * testing lock serialization — we don't need disk I/O here.
 */
function createMemoryStore(): ScopedDataStore {
	const files = new Map<string, string>();
	return {
		read: vi.fn(async (path: string) => files.get(path) ?? ''),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		append: vi.fn(async (path: string, content: string) => {
			files.set(path, (files.get(path) ?? '') + content);
		}),
		exists: vi.fn(async (path: string) => files.has(path)),
		list: vi.fn(async () => []),
		archive: vi.fn(async () => {}),
	} as unknown as ScopedDataStore;
}

function makeGroceryItem(name: string): GroceryItem {
	return {
		name,
		quantity: 1,
		unit: 'ct',
		department: 'Other',
		recipeIds: [],
		purchased: false,
		addedBy: 'test-user',
	};
}

function makePantryItem(name: string): PantryItem {
	return {
		name,
		quantity: '1',
		addedDate: '2026-04-14',
		category: 'Other',
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('file-mutex food store integration', () => {
	it('two concurrent grocery list additions both survive (no lost update)', async () => {
		const store = createMemoryStore();

		// Seed an empty list
		const emptyList = createEmptyList();
		await saveGroceryList(store, emptyList);

		// Two concurrent additions — both should appear in the final list
		await Promise.all([
			withGroceryLock(async () => {
				let list = await loadGroceryList(store);
				if (!list) list = createEmptyList();
				list = addItems(list, [makeGroceryItem('Milk')]);
				await saveGroceryList(store, list);
			}),
			withGroceryLock(async () => {
				let list = await loadGroceryList(store);
				if (!list) list = createEmptyList();
				list = addItems(list, [makeGroceryItem('Eggs')]);
				await saveGroceryList(store, list);
			}),
		]);

		const finalList = await loadGroceryList(store);
		expect(finalList).not.toBeNull();
		const names = finalList!.items.map((i) => i.name).sort();
		expect(names).toEqual(['Eggs', 'Milk']);
	});

	it('two concurrent pantry additions both survive', async () => {
		const store = createMemoryStore();

		await Promise.all([
			withPantryLock(async () => {
				const existing = await loadPantry(store);
				const updated = addPantryItems(existing, [makePantryItem('Apples')]);
				await savePantry(store, updated);
			}),
			withPantryLock(async () => {
				const existing = await loadPantry(store);
				const updated = addPantryItems(existing, [makePantryItem('Bananas')]);
				await savePantry(store, updated);
			}),
		]);

		const final = await loadPantry(store);
		const names = final.map((i) => i.name).sort();
		expect(names).toEqual(['Apples', 'Bananas']);
	});

	it('archivePurchased merges same-day history correctly', async () => {
		const store = createMemoryStore();

		// Two clears on the same day — both batches should appear in history
		const batch1 = [makeGroceryItem('Milk'), makeGroceryItem('Eggs')];
		const batch2 = [makeGroceryItem('Bread')];

		// Use a fixed timezone that gives a predictable date
		await archivePurchased(store, batch1, 'UTC');
		await archivePurchased(store, batch2, 'UTC');

		// Read the history file directly
		const today = new Date().toISOString().slice(0, 10);
		const raw = await store.read(`grocery/history/${today}.yaml`);
		expect(raw).toBeTruthy();
		const content = stripFrontmatter(raw);
		const data = parse(content) as { items: GroceryItem[] };
		expect(data.items).toHaveLength(3);
		const names = data.items.map((i) => i.name).sort();
		expect(names).toEqual(['Bread', 'Eggs', 'Milk']);
	});

	it('appendWaste self-locking under concurrency (5 concurrent appends)', async () => {
		const store = createMemoryStore();

		const entries: WasteLogEntry[] = Array.from({ length: 5 }, (_, i) => ({
			name: `item-${i}`,
			quantity: 'some',
			reason: 'expired' as const,
			source: 'pantry',
			date: '2026-04-14',
		}));

		// All 5 fire concurrently — appendWaste self-locks so no lost writes
		await Promise.all(entries.map((entry) => appendWaste(store, entry)));

		// Verify all 5 entries are in the log
		const raw = await store.read('waste-log.yaml');
		const content = stripFrontmatter(raw);
		const data = parse(content) as { entries: WasteLogEntry[] };
		expect(data.entries).toHaveLength(5);
		const names = data.entries.map((e) => e.name).sort();
		expect(names).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
	});

	it('withMultiFileLock (pantry + freezer) does not deadlock under concurrency', async () => {
		// Two operations that both need pantry + freezer locks.
		// withMultiFileLock sorts keys, so both callers acquire in the same
		// order, which should prevent deadlock.
		const store = createMemoryStore();

		const results: string[] = [];

		await Promise.all([
			withMultiFileLock(['pantry.yaml', 'freezer.yaml'], async () => {
				results.push('op1-start');
				// Simulate some async work
				await new Promise((r) => setTimeout(r, 10));
				results.push('op1-end');
			}),
			withMultiFileLock(['freezer.yaml', 'pantry.yaml'], async () => {
				results.push('op2-start');
				await new Promise((r) => setTimeout(r, 10));
				results.push('op2-end');
			}),
		]);

		// Both operations completed (no deadlock)
		expect(results).toHaveLength(4);
		// They ran sequentially (not interleaved) due to locking
		// Either op1 fully then op2, or op2 fully then op1
		const firstStart = results.indexOf('op1-start');
		const firstEnd = results.indexOf('op1-end');
		const secondStart = results.indexOf('op2-start');
		const secondEnd = results.indexOf('op2-end');
		// The first operation that started must finish before the second starts
		if (firstStart < secondStart) {
			expect(firstEnd).toBeLessThan(secondStart);
		} else {
			expect(secondEnd).toBeLessThan(firstStart);
		}
	});

	it('grocery lock prevents interleaved toggle operations', async () => {
		const store = createMemoryStore();

		// Seed a list with 2 items
		const list = createEmptyList();
		list.items = [makeGroceryItem('Milk'), makeGroceryItem('Eggs')];
		await saveGroceryList(store, list);

		// Two concurrent toggles — both should take effect
		await Promise.all([
			withGroceryLock(async () => {
				const l = await loadGroceryList(store);
				if (!l) return;
				l.items[0]!.purchased = true;
				await saveGroceryList(store, l);
			}),
			withGroceryLock(async () => {
				const l = await loadGroceryList(store);
				if (!l) return;
				l.items[1]!.purchased = true;
				await saveGroceryList(store, l);
			}),
		]);

		const final = await loadGroceryList(store);
		expect(final!.items[0]!.purchased).toBe(true);
		expect(final!.items[1]!.purchased).toBe(true);
	});
});
