import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { GroceryItem, PantryItem } from '../types.js';
import {
	addPantryItems,
	enrichWithExpiry,
	formatPantry,
	groceryToPantryItems,
	isPerishableCategory,
	loadPantry,
	pantryContains,
	parsePantryItems,
	removePantryItem,
	savePantry,
} from '../services/pantry-store.js';

function makePantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
	return {
		name: 'Eggs',
		quantity: '12',
		addedDate: '2026-03-31',
		category: 'Dairy & Eggs',
		...overrides,
	};
}

function makeGroceryItem(overrides: Partial<GroceryItem> = {}): GroceryItem {
	return {
		name: 'Chicken',
		quantity: 2,
		unit: 'lbs',
		department: 'Meat & Seafood',
		recipeIds: [],
		purchased: true,
		addedBy: 'user1',
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

describe('pantry-store', () => {
	// ── loadPantry ──────────────────────────────────────────────

	describe('loadPantry', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadPantry(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('pantry.yaml');
		});

		it('parses YAML array format', async () => {
			const items: PantryItem[] = [
				makePantryItem({ name: 'Milk', category: 'Dairy & Eggs' }),
			];
			const store = mockStore(stringify(items));
			const result = await loadPantry(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Milk');
		});

		it('parses { items: [...] } object format', async () => {
			const items: PantryItem[] = [
				makePantryItem({ name: 'Rice', category: 'Pantry & Dry Goods' }),
			];
			const store = mockStore(stringify({ items }));
			const result = await loadPantry(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Rice');
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::not valid yaml{{{');
			const result = await loadPantry(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when data is a non-array/non-object', async () => {
			const store = mockStore('just a string');
			const result = await loadPantry(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when object has no items array', async () => {
			const store = mockStore(stringify({ something: 'else' }));
			const result = await loadPantry(store as never);
			expect(result).toEqual([]);
		});

		it('strips frontmatter before parsing', async () => {
			const items: PantryItem[] = [makePantryItem({ name: 'Butter' })];
			const yaml = stringify({ items });
			const withFm = `---\ntitle: Pantry\ndate: 2026-03-31\n---\n${yaml}`;
			const store = mockStore(withFm);
			const result = await loadPantry(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Butter');
		});
	});

	// ── savePantry ──────────────────────────────────────────────

	describe('savePantry', () => {
		it('calls store.write with pantry.yaml path', async () => {
			const store = mockStore();
			const items = [makePantryItem()];
			await savePantry(store as never, items);
			expect(store.write).toHaveBeenCalledTimes(1);
			expect(store.write).toHaveBeenCalledWith(
				'pantry.yaml',
				expect.stringContaining('items:'),
			);
		});

		it('includes frontmatter in output', async () => {
			const store = mockStore();
			await savePantry(store as never, [makePantryItem()]);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toMatch(/^---\n/);
			expect(written).toContain('title: Pantry Inventory');
			expect(written).toContain('food');
		});

		it('writes empty items array when given empty list', async () => {
			const store = mockStore();
			await savePantry(store as never, []);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toContain('items: []');
		});
	});

	// ── addPantryItems ──────────────────────────────────────────

	describe('addPantryItems', () => {
		it('adds new items to existing list', () => {
			const existing = [makePantryItem({ name: 'Eggs' })];
			const newItems = [makePantryItem({ name: 'Milk' })];
			const result = addPantryItems(existing, newItems);
			expect(result).toHaveLength(2);
			expect(result.map((i) => i.name)).toEqual(['Eggs', 'Milk']);
		});

		it('updates existing item by name (case-insensitive)', () => {
			const existing = [makePantryItem({ name: 'Eggs', quantity: '6' })];
			const newItems = [makePantryItem({ name: 'eggs', quantity: '12' })];
			const result = addPantryItems(existing, newItems);
			expect(result).toHaveLength(1);
			expect(result[0].quantity).toBe('12');
		});

		it('preserves other items when updating one', () => {
			const existing = [
				makePantryItem({ name: 'Eggs' }),
				makePantryItem({ name: 'Butter' }),
			];
			const newItems = [makePantryItem({ name: 'EGGS', quantity: '24' })];
			const result = addPantryItems(existing, newItems);
			expect(result).toHaveLength(2);
			expect(result[0].quantity).toBe('24');
			expect(result[1].name).toBe('Butter');
		});

		it('handles empty existing list', () => {
			const result = addPantryItems([], [makePantryItem({ name: 'Rice' })]);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Rice');
		});

		it('handles empty new items', () => {
			const existing = [makePantryItem()];
			const result = addPantryItems(existing, []);
			expect(result).toHaveLength(1);
		});

		it('does not mutate original array', () => {
			const existing = [makePantryItem({ name: 'Eggs' })];
			const result = addPantryItems(existing, [makePantryItem({ name: 'Milk' })]);
			expect(existing).toHaveLength(1);
			expect(result).toHaveLength(2);
		});
	});

	// ── removePantryItem ────────────────────────────────────────

	describe('removePantryItem', () => {
		it('removes item by exact name', () => {
			const items = [
				makePantryItem({ name: 'Eggs' }),
				makePantryItem({ name: 'Milk' }),
			];
			const result = removePantryItem(items, 'Eggs');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Milk');
		});

		it('removes case-insensitively', () => {
			const items = [makePantryItem({ name: 'Eggs' })];
			const result = removePantryItem(items, 'eggs');
			expect(result).toHaveLength(0);
		});

		it('returns unchanged list when no match', () => {
			const items = [makePantryItem({ name: 'Eggs' })];
			const result = removePantryItem(items, 'Chicken');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Eggs');
		});

		it('returns empty array when removing only item', () => {
			const items = [makePantryItem({ name: 'Eggs' })];
			const result = removePantryItem(items, 'Eggs');
			expect(result).toHaveLength(0);
		});
	});

	// ── pantryContains ──────────────────────────────────────────

	describe('pantryContains', () => {
		const items = [
			makePantryItem({ name: 'Chicken Breast' }),
			makePantryItem({ name: 'Eggs' }),
			makePantryItem({ name: 'Rice' }),
		];

		it('matches exact name', () => {
			expect(pantryContains(items, 'Eggs')).toBe(true);
		});

		it('matches case-insensitively', () => {
			expect(pantryContains(items, 'eggs')).toBe(true);
			expect(pantryContains(items, 'RICE')).toBe(true);
		});

		it('matches when names are similar length (60%+ ratio)', () => {
			// "chicken breast" (14) vs "chicken thigh" (13) — shorter/longer = 13/14 ≈ 93%
			// but "chicken thigh" does not contain "chicken breast" — no match
			expect(pantryContains(items, 'chicken thigh')).toBe(false);

			// "white rice" (10) vs "rice" (4) — 4/10 = 40% < 60% — no false positive
			expect(pantryContains(items, 'white rice')).toBe(false);

			// "brown rice" (10) vs "rice" (4) — 4/10 = 40% < 60% — correctly avoided
			expect(pantryContains(items, 'brown rice')).toBe(false);
		});

		it('matches close-length substrings', () => {
			// "Chicken Breast" (14) contains "Chicken Bre" (11) — 11/14 ≈ 79%
			expect(pantryContains(items, 'Chicken Bre')).toBe(true);

			// Pantry has "Rice" (4), searching for "Ric" (3) — 3/4 = 75% ≥ 60%
			expect(pantryContains(items, 'Ric')).toBe(true);
		});

		it('rejects short substrings to prevent false positives', () => {
			// "oil" in pantry should NOT match "olive oil" (3/9 = 33%)
			const oilItems = [makePantryItem({ name: 'oil' })];
			expect(pantryContains(oilItems, 'olive oil')).toBe(false);
		});

		it('returns false when no match', () => {
			expect(pantryContains(items, 'Salmon')).toBe(false);
		});

		it('returns false for empty pantry', () => {
			expect(pantryContains([], 'Eggs')).toBe(false);
		});
	});

	// ── groceryToPantryItems ────────────────────────────────────

	describe('groceryToPantryItems', () => {
		it('converts grocery items with quantity and unit', () => {
			const items = [makeGroceryItem({ name: 'Chicken', quantity: 2, unit: 'lbs' })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chicken');
			expect(result[0].quantity).toBe('2 lbs');
			expect(result[0].category).toBe('Meat & Seafood');
			expect(result[0].addedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('converts grocery item with quantity only (no unit)', () => {
			const items = [makeGroceryItem({ name: 'Eggs', quantity: 12, unit: null })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result[0].quantity).toBe('12');
		});

		it('converts grocery item with unit only (no quantity)', () => {
			const items = [makeGroceryItem({ name: 'Flour', quantity: null, unit: 'bag' })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result[0].quantity).toBe('bag');
		});

		it('defaults to "1" when no quantity and no unit', () => {
			const items = [makeGroceryItem({ name: 'Milk', quantity: null, unit: null })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result[0].quantity).toBe('1');
		});

		it('uses department as category', () => {
			const items = [makeGroceryItem({ department: 'Frozen' })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result[0].category).toBe('Frozen');
		});

		it('defaults category to Other for empty department', () => {
			const items = [makeGroceryItem({ department: '' })];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result[0].category).toBe('Other');
		});

		it('converts multiple items', () => {
			const items = [
				makeGroceryItem({ name: 'Milk', department: 'Dairy & Eggs' }),
				makeGroceryItem({ name: 'Bread', department: 'Bakery' }),
			];
			const result = groceryToPantryItems(items, 'UTC');
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('Milk');
			expect(result[1].name).toBe('Bread');
		});
	});

	// ── formatPantry ────────────────────────────────────────────

	describe('formatPantry', () => {
		it('returns empty message for empty pantry', () => {
			const result = formatPantry([]);
			expect(result).toContain('pantry is empty');
		});

		it('shows item count in header', () => {
			const items = [
				makePantryItem({ name: 'Eggs', category: 'Dairy & Eggs' }),
				makePantryItem({ name: 'Rice', category: 'Pantry & Dry Goods' }),
			];
			const result = formatPantry(items);
			expect(result).toContain('2 items');
		});

		it('groups items by category', () => {
			const items = [
				makePantryItem({ name: 'Eggs', quantity: '12', category: 'Dairy & Eggs' }),
				makePantryItem({ name: 'Rice', quantity: '2 lbs', category: 'Pantry & Dry Goods' }),
				makePantryItem({ name: 'Milk', quantity: '1 gal', category: 'Dairy & Eggs' }),
			];
			const result = formatPantry(items);
			// Dairy & Eggs should appear before Pantry & Dry Goods
			const dairyIndex = result.indexOf('Dairy & Eggs');
			const pantryIndex = result.indexOf('Pantry & Dry Goods');
			expect(dairyIndex).toBeLessThan(pantryIndex);
			expect(result).toContain('Eggs');
			expect(result).toContain('Rice');
			expect(result).toContain('Milk');
		});

		it('shows quantity alongside item name', () => {
			const items = [makePantryItem({ name: 'Eggs', quantity: '12', category: 'Dairy & Eggs' })];
			const result = formatPantry(items);
			expect(result).toContain('Eggs — 12');
		});

		it('handles items with unknown categories', () => {
			const items = [makePantryItem({ name: 'Widgets', category: 'Custom Category' })];
			const result = formatPantry(items);
			expect(result).toContain('Custom Category');
			expect(result).toContain('Widgets');
		});

		it('defaults empty category to Other', () => {
			const items = [makePantryItem({ name: 'Mystery', category: '' })];
			const result = formatPantry(items);
			expect(result).toContain('Other');
		});
	});

	// ── parsePantryItems ────────────────────────────────────────

	describe('parsePantryItems', () => {
		it('parses comma-separated items', () => {
			const result = parsePantryItems('eggs, milk, butter', 'UTC');
			expect(result).toHaveLength(3);
			expect(result.map((i) => i.name)).toEqual(['eggs', 'milk', 'butter']);
		});

		it('parses "and"-separated items', () => {
			const result = parsePantryItems('eggs and milk', 'UTC');
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('eggs');
			expect(result[1].name).toBe('milk');
		});

		it('parses newline-separated items', () => {
			const result = parsePantryItems('eggs\nmilk\nbutter', 'UTC');
			expect(result).toHaveLength(3);
		});

		it('assigns departments via assignDepartment', () => {
			const result = parsePantryItems('eggs, chicken, rice', 'UTC');
			expect(result[0].category).toBe('Dairy & Eggs');
			expect(result[1].category).toBe('Meat & Seafood');
			expect(result[2].category).toBe('Pantry & Dry Goods');
		});

		it('sets default quantity to "1"', () => {
			const result = parsePantryItems('milk', 'UTC');
			expect(result[0].quantity).toBe('1');
		});

		it('sets addedDate from timezone', () => {
			const result = parsePantryItems('eggs', 'UTC');
			expect(result[0].addedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('filters out empty parts', () => {
			const result = parsePantryItems(',, eggs,, milk,,', 'UTC');
			expect(result).toHaveLength(2);
		});

		it('trims whitespace from items', () => {
			const result = parsePantryItems('  eggs  ,  milk  ', 'UTC');
			expect(result[0].name).toBe('eggs');
			expect(result[1].name).toBe('milk');
		});

		it('handles single item', () => {
			const result = parsePantryItems('eggs', 'UTC');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('eggs');
		});

		it('returns empty array for empty string', () => {
			const result = parsePantryItems('', 'UTC');
			expect(result).toHaveLength(0);
		});

		it('assigns Other for unknown items', () => {
			const result = parsePantryItems('xylophone', 'UTC');
			expect(result[0].category).toBe('Other');
		});
	});

	// ── expiry estimation ───────────────────────────────────────

	describe('expiry estimation', () => {
		it('isPerishableCategory returns true for perishable categories', () => {
			expect(isPerishableCategory('Produce')).toBe(true);
			expect(isPerishableCategory('Dairy & Eggs')).toBe(true);
			expect(isPerishableCategory('Meat & Seafood')).toBe(true);
			expect(isPerishableCategory('Bakery')).toBe(true);
		});

		it('isPerishableCategory returns false for shelf-stable categories', () => {
			expect(isPerishableCategory('Pantry & Dry Goods')).toBe(false);
			expect(isPerishableCategory('Beverages')).toBe(false);
			expect(isPerishableCategory('Snacks')).toBe(false);
		});

		it('enrichWithExpiry adds expiryEstimate to perishable items', async () => {
			const items = [
				makePantryItem({ name: 'Chicken', category: 'Meat & Seafood', addedDate: '2026-04-01' }),
				makePantryItem({ name: 'Rice', category: 'Pantry & Dry Goods' }),
			];
			const mockServices = {
				llm: { complete: vi.fn().mockResolvedValue('3') },
				timezone: 'UTC',
			};

			const result = await enrichWithExpiry(mockServices, items);
			expect(result[0]?.expiryEstimate).toBe('2026-04-04');
			expect(result[1]?.expiryEstimate).toBeUndefined();
		});

		it('enrichWithExpiry skips items that already have expiryEstimate', async () => {
			const items = [
				makePantryItem({ name: 'Milk', category: 'Dairy & Eggs', expiryEstimate: '2026-04-05' }),
			];
			const mockServices = {
				llm: { complete: vi.fn() },
				timezone: 'UTC',
			};

			const result = await enrichWithExpiry(mockServices, items);
			expect(result[0]?.expiryEstimate).toBe('2026-04-05');
			expect(mockServices.llm.complete).not.toHaveBeenCalled();
		});

		it('enrichWithExpiry defaults to no expiry on LLM failure', async () => {
			const items = [
				makePantryItem({ name: 'Chicken', category: 'Meat & Seafood' }),
			];
			const mockServices = {
				llm: { complete: vi.fn().mockRejectedValue(new Error('fail')) },
				timezone: 'UTC',
			};

			const result = await enrichWithExpiry(mockServices, items);
			expect(result[0]?.expiryEstimate).toBeUndefined();
		});
	});
});
