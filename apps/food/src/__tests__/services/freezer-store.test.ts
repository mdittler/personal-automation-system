import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { FreezerItem } from '../../types.js';
import {
	addFreezerItem,
	buildFreezerButtons,
	formatFreezerList,
	getAgingFreezerItems,
	loadFreezer,
	parseFreezerInput,
	removeFreezerItem,
	saveFreezer,
} from '../../services/freezer-store.js';

function makeFreezerItem(overrides: Partial<FreezerItem> = {}): FreezerItem {
	return {
		name: 'Chicken Breasts',
		quantity: '2 lbs',
		frozenDate: '2026-01-01',
		source: 'purchased',
		...overrides,
	};
}

function mockStore(readResult: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(readResult),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

describe('freezer-store', () => {
	// ── loadFreezer ─────────────────────────────────────────────

	describe('loadFreezer', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('freezer.yaml');
		});

		it('parses YAML array format', async () => {
			const items: FreezerItem[] = [makeFreezerItem({ name: 'Salmon' })];
			const store = mockStore(stringify(items));
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Salmon');
		});

		it('parses { items: [...] } object format', async () => {
			const items: FreezerItem[] = [makeFreezerItem({ name: 'Ground Beef' })];
			const store = mockStore(stringify({ items }));
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Ground Beef');
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::not valid yaml{{{');
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when data is a non-array/non-object', async () => {
			const store = mockStore('just a string');
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when object has no items array', async () => {
			const store = mockStore(stringify({ something: 'else' }));
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
		});

		it('strips frontmatter before parsing', async () => {
			const items: FreezerItem[] = [makeFreezerItem({ name: 'Pork Tenderloin' })];
			const yaml = stringify({ items });
			const withFm = `---\ntitle: Freezer\ndate: 2026-01-01\n---\n${yaml}`;
			const store = mockStore(withFm);
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Pork Tenderloin');
		});
	});

	// ── saveFreezer ─────────────────────────────────────────────

	describe('saveFreezer', () => {
		it('calls store.write with freezer.yaml path', async () => {
			const store = mockStore();
			const items = [makeFreezerItem()];
			await saveFreezer(store as never, items);
			expect(store.write).toHaveBeenCalledTimes(1);
			expect(store.write).toHaveBeenCalledWith(
				'freezer.yaml',
				expect.stringContaining('items:'),
			);
		});

		it('includes frontmatter in output', async () => {
			const store = mockStore();
			await saveFreezer(store as never, [makeFreezerItem()]);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toMatch(/^---\n/);
			expect(written).toContain('title: Freezer Inventory');
			expect(written).toContain('food');
		});

		it('writes empty items array when given empty list', async () => {
			const store = mockStore();
			await saveFreezer(store as never, []);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toContain('items: []');
		});
	});

	// ── addFreezerItem ──────────────────────────────────────────

	describe('addFreezerItem', () => {
		it('adds new item to empty list', () => {
			const result = addFreezerItem([], makeFreezerItem({ name: 'Chicken' }));
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chicken');
		});

		it('adds new item to existing list', () => {
			const existing = [makeFreezerItem({ name: 'Salmon' })];
			const result = addFreezerItem(existing, makeFreezerItem({ name: 'Chicken' }));
			expect(result).toHaveLength(2);
			expect(result.map((i) => i.name)).toEqual(['Salmon', 'Chicken']);
		});

		it('deduplicates by name (case-insensitive) — updates existing', () => {
			const existing = [makeFreezerItem({ name: 'Chicken', quantity: '1 lb' })];
			const result = addFreezerItem(existing, makeFreezerItem({ name: 'chicken', quantity: '3 lbs' }));
			expect(result).toHaveLength(1);
			expect(result[0].quantity).toBe('3 lbs');
		});

		it('does not mutate original array', () => {
			const existing = [makeFreezerItem({ name: 'Salmon' })];
			const result = addFreezerItem(existing, makeFreezerItem({ name: 'Chicken' }));
			expect(existing).toHaveLength(1);
			expect(result).toHaveLength(2);
		});
	});

	// ── removeFreezerItem ───────────────────────────────────────

	describe('removeFreezerItem', () => {
		it('removes item at given index', () => {
			const items = [
				makeFreezerItem({ name: 'Salmon' }),
				makeFreezerItem({ name: 'Chicken' }),
			];
			const result = removeFreezerItem(items, 0);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chicken');
		});

		it('removes last item by index', () => {
			const items = [
				makeFreezerItem({ name: 'Salmon' }),
				makeFreezerItem({ name: 'Chicken' }),
			];
			const result = removeFreezerItem(items, 1);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Salmon');
		});

		it('returns unchanged list for out-of-range index', () => {
			const items = [makeFreezerItem({ name: 'Salmon' })];
			const result = removeFreezerItem(items, 5);
			expect(result).toHaveLength(1);
		});

		it('returns empty array when removing only item', () => {
			const items = [makeFreezerItem({ name: 'Salmon' })];
			const result = removeFreezerItem(items, 0);
			expect(result).toHaveLength(0);
		});

		it('does not mutate original array', () => {
			const items = [makeFreezerItem({ name: 'Salmon' }), makeFreezerItem({ name: 'Chicken' })];
			removeFreezerItem(items, 0);
			expect(items).toHaveLength(2);
		});
	});

	// ── getAgingFreezerItems ────────────────────────────────────

	describe('getAgingFreezerItems', () => {
		it('returns items frozen more than N months ago', () => {
			const items = [
				makeFreezerItem({ name: 'Old Chicken', frozenDate: '2025-10-01' }),
				makeFreezerItem({ name: 'Fresh Salmon', frozenDate: '2026-03-01' }),
			];
			// today = 2026-04-02, so Old Chicken is ~6 months old
			const result = getAgingFreezerItems(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Old Chicken');
		});

		it('returns empty array when no items are aging', () => {
			const items = [makeFreezerItem({ name: 'Fresh Salmon', frozenDate: '2026-03-01' })];
			const result = getAgingFreezerItems(items, 3, '2026-04-02');
			expect(result).toHaveLength(0);
		});

		it('returns empty array for empty list', () => {
			const result = getAgingFreezerItems([], 3, '2026-04-02');
			expect(result).toHaveLength(0);
		});

		it('includes item frozen exactly at threshold boundary (inclusive)', () => {
			// Frozen exactly 3 months ago from 2026-04-02 is 2026-01-02
			// olderThanMonths = 3 means 3+ months, so exactly 3 months IS included (aligns with display)
			const items = [makeFreezerItem({ name: 'Edge Case', frozenDate: '2026-01-02' })];
			const result = getAgingFreezerItems(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
		});

		it('includes item frozen one day past threshold', () => {
			// 2026-01-01 is 3 months + 1 day before 2026-04-02 → aging
			const items = [makeFreezerItem({ name: 'Aging Turkey', frozenDate: '2026-01-01' })];
			const result = getAgingFreezerItems(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
		});
	});

	// ── formatFreezerList ───────────────────────────────────────

	describe('formatFreezerList', () => {
		it('returns empty message for empty freezer', () => {
			const result = formatFreezerList([]);
			expect(result).toContain('freezer is empty');
		});

		it('shows item count in header', () => {
			const items = [
				makeFreezerItem({ name: 'Chicken' }),
				makeFreezerItem({ name: 'Salmon' }),
			];
			const result = formatFreezerList(items);
			expect(result).toContain('2 items');
		});

		it('shows item name and quantity', () => {
			const items = [makeFreezerItem({ name: 'Chicken Breasts', quantity: '2 lbs' })];
			const result = formatFreezerList(items);
			expect(result).toContain('Chicken Breasts');
			expect(result).toContain('2 lbs');
		});

		it('shows source when present', () => {
			const items = [makeFreezerItem({ name: 'Leftover Soup', source: 'Chicken Noodle Soup' })];
			const result = formatFreezerList(items);
			expect(result).toContain('Chicken Noodle Soup');
		});

		it('shows age warning for items frozen 3+ months ago', () => {
			const items = [
				makeFreezerItem({ name: 'Old Chicken', frozenDate: '2025-10-01' }),
			];
			// today ~6 months after frozen date
			const result = formatFreezerList(items, '2026-04-02');
			expect(result).toContain('⚠️');
		});

		it('does not show age warning for fresh items', () => {
			const items = [makeFreezerItem({ name: 'Fresh Salmon', frozenDate: '2026-03-15' })];
			const result = formatFreezerList(items, '2026-04-02');
			expect(result).not.toContain('⚠️');
		});

		it('shows frozenDate in output', () => {
			const items = [makeFreezerItem({ frozenDate: '2026-01-15' })];
			const result = formatFreezerList(items);
			expect(result).toContain('2026-01-15');
		});
	});

	// ── buildFreezerButtons ─────────────────────────────────────

	describe('buildFreezerButtons', () => {
		it('returns Add button for empty freezer', () => {
			const buttons = buildFreezerButtons([]);
			expect(buttons).toHaveLength(1);
			expect(buttons[0][0].text).toContain('Add');
		});

		it('returns Add button plus per-item rows', () => {
			const items = [
				makeFreezerItem({ name: 'Chicken' }),
				makeFreezerItem({ name: 'Salmon' }),
			];
			const buttons = buildFreezerButtons(items);
			// First row: Add button; then one row per item (Thaw + Toss)
			expect(buttons).toHaveLength(3);
		});

		it('each item row has Thaw and Toss buttons', () => {
			const items = [makeFreezerItem({ name: 'Chicken' })];
			const buttons = buildFreezerButtons(items);
			const itemRow = buttons[1];
			expect(itemRow).toBeDefined();
			expect(itemRow![0].text).toContain('Thaw');
			expect(itemRow![1].text).toContain('Toss');
		});

		it('uses correct callback data format for thaw', () => {
			const items = [makeFreezerItem({ name: 'Chicken' })];
			const buttons = buildFreezerButtons(items);
			expect(buttons[1]![0].callbackData).toBe('app:food:fz:thaw:0:Chicken');
		});

		it('uses correct callback data format for toss', () => {
			const items = [makeFreezerItem({ name: 'Chicken' })];
			const buttons = buildFreezerButtons(items);
			expect(buttons[1]![1].callbackData).toBe('app:food:fz:toss:0:Chicken');
		});

		it('uses correct indices for multiple items', () => {
			const items = [
				makeFreezerItem({ name: 'Chicken' }),
				makeFreezerItem({ name: 'Salmon' }),
			];
			const buttons = buildFreezerButtons(items);
			expect(buttons[1]![0].callbackData).toBe('app:food:fz:thaw:0:Chicken');
			expect(buttons[1]![1].callbackData).toBe('app:food:fz:toss:0:Chicken');
			expect(buttons[2]![0].callbackData).toBe('app:food:fz:thaw:1:Salmon');
			expect(buttons[2]![1].callbackData).toBe('app:food:fz:toss:1:Salmon');
		});

		it('includes item name in button text', () => {
			const items = [makeFreezerItem({ name: 'Chicken Breasts' })];
			const buttons = buildFreezerButtons(items);
			const itemRow = buttons[1]!;
			const rowText = itemRow.map((b) => b.text).join(' ');
			expect(rowText).toContain('Chicken Breasts');
		});
	});

	// ── parseFreezerInput ───────────────────────────────────────

	describe('parseFreezerInput', () => {
		it('parses quantity and unit from start of text', () => {
			const result = parseFreezerInput('2 lbs chicken breasts', 'purchased', 'UTC');
			expect(result.name).toBe('chicken breasts');
			expect(result.quantity).toBe('2 lbs');
		});

		it('parses fractional quantity', () => {
			const result = parseFreezerInput('1.5 lbs ground beef', 'purchased', 'UTC');
			expect(result.name).toBe('ground beef');
			expect(result.quantity).toBe('1.5 lbs');
		});

		it('uses "some" as default quantity when no quantity/unit prefix', () => {
			const result = parseFreezerInput('leftover soup', 'Chicken Noodle Soup', 'UTC');
			expect(result.quantity).toBe('some');
			expect(result.name).toBe('leftover soup');
		});

		it('sets source from parameter', () => {
			const result = parseFreezerInput('2 lbs salmon', 'purchased', 'UTC');
			expect(result.source).toBe('purchased');
		});

		it('sets source to undefined when parameter is undefined', () => {
			const result = parseFreezerInput('2 lbs salmon', undefined, 'UTC');
			expect(result.source).toBeUndefined();
		});

		it('sets frozenDate from timezone', () => {
			const result = parseFreezerInput('2 lbs chicken', 'purchased', 'UTC');
			expect(result.frozenDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('parses oz unit', () => {
			const result = parseFreezerInput('8 oz shrimp', 'purchased', 'UTC');
			expect(result.quantity).toBe('8 oz');
			expect(result.name).toBe('shrimp');
		});

		it('parses cups unit', () => {
			const result = parseFreezerInput('3 cups broth', undefined, 'UTC');
			expect(result.quantity).toBe('3 cups');
			expect(result.name).toBe('broth');
		});

		it('parses servings unit', () => {
			const result = parseFreezerInput('4 servings chili', 'Turkey Chili', 'UTC');
			expect(result.quantity).toBe('4 servings');
			expect(result.name).toBe('chili');
		});

		it('parses bags unit', () => {
			const result = parseFreezerInput('2 bags peas', 'purchased', 'UTC');
			expect(result.quantity).toBe('2 bags');
			expect(result.name).toBe('peas');
		});

		it('parses containers unit', () => {
			const result = parseFreezerInput('1 container soup', 'Minestrone', 'UTC');
			expect(result.quantity).toBe('1 container');
			expect(result.name).toBe('soup');
		});

		it('handles lb (singular) unit', () => {
			const result = parseFreezerInput('1 lb steak', 'purchased', 'UTC');
			expect(result.quantity).toBe('1 lb');
			expect(result.name).toBe('steak');
		});
	});
});
