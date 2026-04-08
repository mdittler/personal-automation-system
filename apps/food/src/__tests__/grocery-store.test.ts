import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	addItems,
	archivePurchased,
	buildGroceryButtons,
	clearPurchased,
	createEmptyList,
	formatGroceryMessage,
	loadGroceryList,
	saveGroceryList,
	togglePurchased,
} from '../services/grocery-store.js';
import type { GroceryItem, GroceryList } from '../types.js';

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

function makeItem(overrides: Partial<GroceryItem> = {}): GroceryItem {
	return {
		name: 'Milk',
		quantity: 1,
		unit: 'gallon',
		department: 'Dairy & Eggs',
		recipeIds: [],
		purchased: false,
		addedBy: 'user1',
		...overrides,
	};
}

function makeList(overrides: Partial<GroceryList> = {}): GroceryList {
	return {
		id: 'list-123',
		items: [],
		createdAt: '2026-03-31T10:00:00.000Z',
		updatedAt: '2026-03-31T10:00:00.000Z',
		...overrides,
	};
}

describe('grocery-store', () => {
	// ─── createEmptyList ─────────────────────────────────────────

	describe('createEmptyList', () => {
		it('returns a list with an id', () => {
			const list = createEmptyList();
			expect(list.id).toBeTruthy();
			expect(typeof list.id).toBe('string');
			expect(list.id.length).toBeGreaterThan(0);
		});

		it('has empty items array', () => {
			const list = createEmptyList();
			expect(list.items).toEqual([]);
		});

		it('has createdAt and updatedAt timestamps', () => {
			const list = createEmptyList();
			expect(list.createdAt).toBeTruthy();
			expect(list.updatedAt).toBeTruthy();
			// Timestamps should be ISO format
			expect(() => new Date(list.createdAt)).not.toThrow();
			expect(() => new Date(list.updatedAt)).not.toThrow();
		});

		it('createdAt equals updatedAt on creation', () => {
			const list = createEmptyList();
			expect(list.createdAt).toBe(list.updatedAt);
		});

		it('generates unique ids', () => {
			const list1 = createEmptyList();
			const list2 = createEmptyList();
			expect(list1.id).not.toBe(list2.id);
		});
	});

	// ─── addItems ────────────────────────────────────────────────

	describe('addItems', () => {
		it('adds new items to an empty list', () => {
			const list = makeList();
			const items = [makeItem(), makeItem({ name: 'Eggs', department: 'Dairy & Eggs' })];
			const result = addItems(list, items);
			expect(result.items).toHaveLength(2);
			expect(result.items[0]!.name).toBe('Milk');
			expect(result.items[1]!.name).toBe('Eggs');
		});

		it('deduplicates by name (case insensitive)', () => {
			const list = makeList({ items: [makeItem({ name: 'milk', quantity: 1, unit: 'gallon' })] });
			const result = addItems(list, [makeItem({ name: 'Milk', quantity: 1, unit: 'gallon' })]);
			expect(result.items).toHaveLength(1);
		});

		it('merges quantities when same unit', () => {
			const list = makeList({ items: [makeItem({ name: 'Milk', quantity: 1, unit: 'gallon' })] });
			const result = addItems(list, [makeItem({ name: 'milk', quantity: 2, unit: 'gallon' })]);
			expect(result.items).toHaveLength(1);
			expect(result.items[0]!.quantity).toBe(3);
		});

		it('does not merge quantities when different units', () => {
			const list = makeList({ items: [makeItem({ name: 'Butter', quantity: 1, unit: 'stick' })] });
			const result = addItems(list, [
				makeItem({ name: 'butter', quantity: 500, unit: 'g' }),
			]);
			expect(result.items).toHaveLength(1);
			// Quantity stays at original value when units differ
			expect(result.items[0]!.quantity).toBe(1);
		});

		it('does not merge quantities when either is null', () => {
			const list = makeList({ items: [makeItem({ name: 'Salt', quantity: null, unit: null })] });
			const result = addItems(list, [makeItem({ name: 'salt', quantity: 2, unit: 'tbsp' })]);
			expect(result.items).toHaveLength(1);
			// Original quantity remains null since null != null check fails
			expect(result.items[0]!.quantity).toBeNull();
		});

		it('merges recipeIds without duplicates', () => {
			const list = makeList({
				items: [makeItem({ name: 'Chicken', recipeIds: ['recipe-1'] })],
			});
			const result = addItems(list, [
				makeItem({ name: 'chicken', recipeIds: ['recipe-1', 'recipe-2'] }),
			]);
			expect(result.items[0]!.recipeIds).toEqual(['recipe-1', 'recipe-2']);
		});

		it('resets purchased to false on re-add', () => {
			const list = makeList({
				items: [makeItem({ name: 'Bread', purchased: true })],
			});
			const result = addItems(list, [makeItem({ name: 'bread' })]);
			expect(result.items[0]!.purchased).toBe(false);
		});

		it('adds a copy of the new item (not reference)', () => {
			const list = makeList();
			const newItem = makeItem({ name: 'Tofu' });
			addItems(list, [newItem]);
			newItem.name = 'Modified';
			expect(list.items[0]!.name).toBe('Tofu');
		});

		it('handles adding empty items array', () => {
			const list = makeList({ items: [makeItem()] });
			const result = addItems(list, []);
			expect(result.items).toHaveLength(1);
		});
	});

	// ─── togglePurchased ─────────────────────────────────────────

	describe('togglePurchased', () => {
		it('toggles item from unpurchased to purchased', () => {
			const list = makeList({ items: [makeItem({ purchased: false })] });
			const result = togglePurchased(list, 0);
			expect(result.items[0]!.purchased).toBe(true);
		});

		it('toggles item from purchased to unpurchased', () => {
			const list = makeList({ items: [makeItem({ purchased: true })] });
			const result = togglePurchased(list, 0);
			expect(result.items[0]!.purchased).toBe(false);
		});

		it('is a no-op for out-of-bounds positive index', () => {
			const list = makeList({ items: [makeItem()] });
			const result = togglePurchased(list, 5);
			expect(result.items[0]!.purchased).toBe(false);
		});

		it('is a no-op for negative index', () => {
			const list = makeList({ items: [makeItem()] });
			const result = togglePurchased(list, -1);
			expect(result.items[0]!.purchased).toBe(false);
		});

		it('toggles the correct item in a multi-item list', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Milk', purchased: false }),
					makeItem({ name: 'Eggs', purchased: false }),
					makeItem({ name: 'Bread', purchased: false }),
				],
			});
			togglePurchased(list, 1);
			expect(list.items[0]!.purchased).toBe(false);
			expect(list.items[1]!.purchased).toBe(true);
			expect(list.items[2]!.purchased).toBe(false);
		});
	});

	// ─── clearPurchased ──────────────────────────────────────────

	describe('clearPurchased', () => {
		it('separates purchased items from remaining', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Milk', purchased: true }),
					makeItem({ name: 'Eggs', purchased: false }),
					makeItem({ name: 'Bread', purchased: true }),
				],
			});
			const { updated, purchased } = clearPurchased(list);
			expect(updated.items).toHaveLength(1);
			expect(updated.items[0]!.name).toBe('Eggs');
			expect(purchased).toHaveLength(2);
			expect(purchased[0]!.name).toBe('Milk');
			expect(purchased[1]!.name).toBe('Bread');
		});

		it('returns empty purchased array when none purchased', () => {
			const list = makeList({
				items: [makeItem({ purchased: false }), makeItem({ name: 'Eggs', purchased: false })],
			});
			const { updated, purchased } = clearPurchased(list);
			expect(updated.items).toHaveLength(2);
			expect(purchased).toHaveLength(0);
		});

		it('returns empty items when all purchased', () => {
			const list = makeList({
				items: [makeItem({ purchased: true }), makeItem({ name: 'Eggs', purchased: true })],
			});
			const { updated, purchased } = clearPurchased(list);
			expect(updated.items).toHaveLength(0);
			expect(purchased).toHaveLength(2);
		});

		it('handles empty list', () => {
			const list = makeList();
			const { updated, purchased } = clearPurchased(list);
			expect(updated.items).toHaveLength(0);
			expect(purchased).toHaveLength(0);
		});
	});

	// ─── loadGroceryList ─────────────────────────────────────────

	describe('loadGroceryList', () => {
		it('returns null when store returns empty string', async () => {
			const store = createMockStore({ read: vi.fn().mockResolvedValue('') });
			const result = await loadGroceryList(store as never);
			expect(result).toBeNull();
		});

		it('returns null when store returns null', async () => {
			const store = createMockStore({ read: vi.fn().mockResolvedValue(null) });
			const result = await loadGroceryList(store as never);
			expect(result).toBeNull();
		});

		it('parses YAML content correctly', async () => {
			const list: GroceryList = {
				id: 'list-abc',
				items: [makeItem()],
				createdAt: '2026-03-31T10:00:00.000Z',
				updatedAt: '2026-03-31T10:00:00.000Z',
			};
			const yaml = stringify(list);
			const store = createMockStore({ read: vi.fn().mockResolvedValue(yaml) });
			const result = await loadGroceryList(store as never);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('list-abc');
			expect(result!.items).toHaveLength(1);
			expect(result!.items[0]!.name).toBe('Milk');
		});

		it('strips frontmatter before parsing', async () => {
			const list: GroceryList = {
				id: 'list-fm',
				items: [],
				createdAt: '2026-03-31T10:00:00.000Z',
				updatedAt: '2026-03-31T10:00:00.000Z',
			};
			const content = `---\ntitle: Grocery List\ntags: []\n---\n${stringify(list)}`;
			const store = createMockStore({ read: vi.fn().mockResolvedValue(content) });
			const result = await loadGroceryList(store as never);
			expect(result).not.toBeNull();
			expect(result!.id).toBe('list-fm');
		});

		it('returns null on malformed YAML', async () => {
			const store = createMockStore({
				read: vi.fn().mockResolvedValue('{{{{not yaml at all::::'),
			});
			const result = await loadGroceryList(store as never);
			expect(result).toBeNull();
		});

		it('reads from grocery/active.yaml', async () => {
			const read = vi.fn().mockResolvedValue('');
			const store = createMockStore({ read });
			await loadGroceryList(store as never);
			expect(read).toHaveBeenCalledWith('grocery/active.yaml');
		});
	});

	// ─── saveGroceryList ─────────────────────────────────────────

	describe('saveGroceryList', () => {
		it('calls store.write with the correct path', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			const list = makeList();
			await saveGroceryList(store as never, list);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]![0]).toBe('grocery/active.yaml');
		});

		it('writes content with frontmatter', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			const list = makeList({ items: [makeItem()] });
			await saveGroceryList(store as never, list);
			const written = write.mock.calls[0]![1] as string;
			expect(written).toContain('---');
			expect(written).toContain('title: Grocery List');
			expect(written).toContain('food');
		});

		it('updates the updatedAt timestamp', async () => {
			const store = createMockStore();
			const list = makeList({ updatedAt: '2026-01-01T00:00:00.000Z' });
			await saveGroceryList(store as never, list);
			expect(list.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
		});

		it('serializes the list as YAML', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			const list = makeList({ items: [makeItem({ name: 'Avocado' })] });
			await saveGroceryList(store as never, list);
			const written = write.mock.calls[0]![1] as string;
			expect(written).toContain('Avocado');
			expect(written).toContain('items:');
		});
	});

	// ─── archivePurchased ────────────────────────────────────────

	describe('archivePurchased', () => {
		it('writes to history path with date', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			const items = [makeItem({ name: 'Milk', purchased: true })];
			await archivePurchased(store as never, items, 'America/New_York');
			expect(write).toHaveBeenCalledTimes(1);
			const path = write.mock.calls[0]![0] as string;
			expect(path).toMatch(/^grocery\/history\/\d{4}-\d{2}-\d{2}\.yaml$/);
		});

		it('includes frontmatter in archive', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			await archivePurchased(store as never, [makeItem()], 'UTC');
			const written = write.mock.calls[0]![1] as string;
			expect(written).toContain('---');
			expect(written).toContain('Grocery History');
		});

		it('includes items in the archive content', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			const items = [makeItem({ name: 'Bananas' }), makeItem({ name: 'Oranges' })];
			await archivePurchased(store as never, items, 'UTC');
			const written = write.mock.calls[0]![1] as string;
			expect(written).toContain('Bananas');
			expect(written).toContain('Oranges');
		});

		it('skips empty items array', async () => {
			const write = vi.fn().mockResolvedValue(undefined);
			const store = createMockStore({ write });
			await archivePurchased(store as never, [], 'UTC');
			expect(write).not.toHaveBeenCalled();
		});
	});

	// ─── formatGroceryMessage ────────────────────────────────────

	describe('formatGroceryMessage', () => {
		it('returns empty message for empty list', () => {
			const list = makeList();
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('empty');
		});

		it('groups items by department', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Milk', department: 'Dairy & Eggs' }),
					makeItem({ name: 'Apples', department: 'Produce' }),
					makeItem({ name: 'Cheese', department: 'Dairy & Eggs' }),
				],
			});
			const msg = formatGroceryMessage(list);
			// Produce should appear before Dairy & Eggs in display order
			const produceIndex = msg.indexOf('Produce');
			const dairyIndex = msg.indexOf('Dairy & Eggs');
			expect(produceIndex).toBeLessThan(dairyIndex);
			// Both dairy items should appear together
			expect(msg).toContain('Milk');
			expect(msg).toContain('Cheese');
		});

		it('shows checkmarks for purchased items', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Purchased Item', purchased: true }),
					makeItem({ name: 'Unpurchased Item', purchased: false }),
				],
			});
			const msg = formatGroceryMessage(list);
			// Purchased items show check, unpurchased show empty box
			const lines = msg.split('\n');
			const purchasedLine = lines.find((l) => l.includes('Purchased Item'));
			const unpurchasedLine = lines.find((l) => l.includes('Unpurchased Item'));
			expect(purchasedLine).toContain('✅');
			expect(unpurchasedLine).toContain('☐');
		});

		it('shows total count in header', () => {
			const list = makeList({
				items: [makeItem(), makeItem({ name: 'Eggs' }), makeItem({ name: 'Bread' })],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('3 items');
		});

		it('shows purchased count when some are purchased', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Milk', purchased: true }),
					makeItem({ name: 'Eggs', purchased: false }),
				],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('1 purchased');
		});

		it('does not show purchased count when none are purchased', () => {
			const list = makeList({
				items: [makeItem({ name: 'Milk', purchased: false })],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).not.toContain('purchased');
		});

		it('shows quantity and unit for items that have them', () => {
			const list = makeList({
				items: [makeItem({ name: 'Milk', quantity: 2, unit: 'gallon' })],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('2 gallon');
		});

		it('omits quantity display when quantity and unit are null', () => {
			const list = makeList({
				items: [makeItem({ name: 'Salt', quantity: null, unit: null })],
			});
			const msg = formatGroceryMessage(list);
			// Should show just the name without a dash separator
			const lines = msg.split('\n');
			const saltLine = lines.find((l) => l.includes('Salt'));
			expect(saltLine).not.toContain('—');
		});

		it('uses department emojis', () => {
			const list = makeList({
				items: [makeItem({ name: 'Apple', department: 'Produce' })],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('🥬');
		});

		it('handles items with unknown department as Other', () => {
			const list = makeList({
				items: [makeItem({ name: 'Widget', department: '' })],
			});
			const msg = formatGroceryMessage(list);
			expect(msg).toContain('Other');
		});
	});

	// ─── buildGroceryButtons ─────────────────────────────────────

	describe('buildGroceryButtons', () => {
		it('creates one button row per item', () => {
			const list = makeList({
				items: [makeItem({ name: 'Milk' }), makeItem({ name: 'Eggs' })],
			});
			const buttons = buildGroceryButtons(list);
			// 2 item rows + 1 control row
			expect(buttons).toHaveLength(3);
		});

		it('uses correct callbackData with index', () => {
			const list = makeList({
				items: [makeItem({ name: 'Milk' }), makeItem({ name: 'Eggs' })],
			});
			const buttons = buildGroceryButtons(list);
			expect(buttons[0]![0]!.callbackData).toBe('app:food:toggle:0');
			expect(buttons[1]![0]!.callbackData).toBe('app:food:toggle:1');
		});

		it('uses custom appId when provided', () => {
			const list = makeList({ items: [makeItem()] });
			const buttons = buildGroceryButtons(list, 'custom-app');
			expect(buttons[0]![0]!.callbackData).toBe('app:custom-app:toggle:0');
		});

		it('shows check marks in button text', () => {
			const list = makeList({
				items: [
					makeItem({ name: 'Milk', purchased: false }),
					makeItem({ name: 'Eggs', purchased: true }),
				],
			});
			const buttons = buildGroceryButtons(list);
			expect(buttons[0]![0]!.text).toBe('☐ Milk');
			expect(buttons[1]![0]!.text).toBe('✅ Eggs');
		});

		it('has control row at the bottom', () => {
			const list = makeList({ items: [makeItem()] });
			const buttons = buildGroceryButtons(list);
			const controlRow = buttons[buttons.length - 1]!;
			expect(controlRow).toHaveLength(3);
			expect(controlRow[0]!.text).toContain('Refresh');
			expect(controlRow[1]!.text).toContain('Clear');
			expect(controlRow[2]!.text).toContain('Pantry');
		});

		it('includes control row even for empty list', () => {
			const list = makeList();
			const buttons = buildGroceryButtons(list);
			expect(buttons).toHaveLength(1); // just control row
			expect(buttons[0]![0]!.callbackData).toContain('refresh');
		});

		it('control row callbackData uses appId', () => {
			const list = makeList();
			const buttons = buildGroceryButtons(list, 'my-app');
			const controlRow = buttons[0]!;
			expect(controlRow[0]!.callbackData).toBe('app:my-app:refresh');
			expect(controlRow[1]!.callbackData).toBe('app:my-app:clear');
			expect(controlRow[2]!.callbackData).toBe('app:my-app:pantry-prompt');
		});
	});
});
