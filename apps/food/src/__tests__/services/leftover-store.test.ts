import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Leftover } from '../../types.js';
import {
	addLeftover,
	buildLeftoverButtons,
	formatLeftoverList,
	getActiveLeftovers,
	getExpiringLeftovers,
	loadLeftovers,
	parseLeftoverInput,
	saveLeftovers,
	updateLeftoverStatus,
} from '../../services/leftover-store.js';

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'Chili',
		quantity: '3 servings',
		fromRecipe: 'Beef Chili',
		storedDate: '2026-04-01',
		expiryEstimate: '2026-04-05',
		status: 'active',
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

describe('leftover-store', () => {
	// ── loadLeftovers ────────────────────────────────────────────────

	describe('loadLeftovers', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('leftovers.yaml');
		});

		it('parses YAML array format', async () => {
			const items: Leftover[] = [makeLeftover({ name: 'Soup' })];
			const store = mockStore(stringify(items));
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Soup');
		});

		it('parses { items: [...] } object format', async () => {
			const items: Leftover[] = [makeLeftover({ name: 'Pasta' })];
			const store = mockStore(stringify({ items }));
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Pasta');
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::not valid yaml{{{');
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when data is a non-array/non-object', async () => {
			const store = mockStore('just a string');
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
		});

		it('returns empty array when object has no items array', async () => {
			const store = mockStore(stringify({ something: 'else' }));
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
		});

		it('strips frontmatter before parsing', async () => {
			const items: Leftover[] = [makeLeftover({ name: 'Stew' })];
			const yaml = stringify({ items });
			const withFm = `---\ntitle: Leftovers\ndate: 2026-04-01\n---\n${yaml}`;
			const store = mockStore(withFm);
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Stew');
		});
	});

	// ── saveLeftovers ────────────────────────────────────────────────

	describe('saveLeftovers', () => {
		it('calls store.write with leftovers.yaml path', async () => {
			const store = mockStore();
			const items = [makeLeftover()];
			await saveLeftovers(store as never, items);
			expect(store.write).toHaveBeenCalledTimes(1);
			expect(store.write).toHaveBeenCalledWith(
				'leftovers.yaml',
				expect.stringContaining('items:'),
			);
		});

		it('includes frontmatter in output', async () => {
			const store = mockStore();
			await saveLeftovers(store as never, [makeLeftover()]);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toMatch(/^---\n/);
			expect(written).toContain('title: Leftovers');
			expect(written).toContain('food');
		});

		it('writes empty items array when given empty list', async () => {
			const store = mockStore();
			await saveLeftovers(store as never, []);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toContain('items: []');
		});
	});

	// ── addLeftover ──────────────────────────────────────────────────

	describe('addLeftover', () => {
		it('adds new item to empty list', () => {
			const result = addLeftover([], makeLeftover({ name: 'Chili' }));
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chili');
		});

		it('adds new item to existing list', () => {
			const existing = [makeLeftover({ name: 'Chili' })];
			const result = addLeftover(existing, makeLeftover({ name: 'Soup' }));
			expect(result).toHaveLength(2);
			expect(result.map((i) => i.name)).toEqual(['Chili', 'Soup']);
		});

		it('replaces existing item with same name (case-insensitive)', () => {
			const existing = [makeLeftover({ name: 'Chili', quantity: '1 serving' })];
			const result = addLeftover(existing, makeLeftover({ name: 'chili', quantity: '3 servings' }));
			expect(result).toHaveLength(1);
			expect(result[0].quantity).toBe('3 servings');
		});

		it('case-insensitive dedup preserves position', () => {
			const existing = [
				makeLeftover({ name: 'Chili' }),
				makeLeftover({ name: 'Soup' }),
			];
			const result = addLeftover(existing, makeLeftover({ name: 'CHILI', quantity: '5 servings' }));
			expect(result).toHaveLength(2);
			expect(result[0].quantity).toBe('5 servings');
			expect(result[1].name).toBe('Soup');
		});

		it('does not mutate original array', () => {
			const existing = [makeLeftover({ name: 'Chili' })];
			const result = addLeftover(existing, makeLeftover({ name: 'Soup' }));
			expect(existing).toHaveLength(1);
			expect(result).toHaveLength(2);
		});
	});

	// ── updateLeftoverStatus ─────────────────────────────────────────

	describe('updateLeftoverStatus', () => {
		it('updates status of item at given index', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = updateLeftoverStatus(items, 0, 'used');
			expect(result[0].status).toBe('used');
		});

		it('updates status to frozen', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = updateLeftoverStatus(items, 0, 'frozen');
			expect(result[0].status).toBe('frozen');
		});

		it('updates status to wasted', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = updateLeftoverStatus(items, 0, 'wasted');
			expect(result[0].status).toBe('wasted');
		});

		it('only updates the targeted item', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'active' }),
				makeLeftover({ name: 'Soup', status: 'active' }),
			];
			const result = updateLeftoverStatus(items, 1, 'used');
			expect(result[0].status).toBe('active');
			expect(result[1].status).toBe('used');
		});

		it('returns unchanged list for out-of-bounds index', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = updateLeftoverStatus(items, 99, 'used');
			expect(result[0].status).toBe('active');
		});

		it('does not mutate original array', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = updateLeftoverStatus(items, 0, 'used');
			expect(items[0].status).toBe('active');
			expect(result[0].status).toBe('used');
		});
	});

	// ── getActiveLeftovers ───────────────────────────────────────────

	describe('getActiveLeftovers', () => {
		it('returns only active items', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'active' }),
				makeLeftover({ name: 'Soup', status: 'used' }),
				makeLeftover({ name: 'Pasta', status: 'frozen' }),
				makeLeftover({ name: 'Rice', status: 'wasted' }),
			];
			const result = getActiveLeftovers(items);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chili');
		});

		it('returns empty array when no active items', () => {
			const items = [
				makeLeftover({ status: 'used' }),
				makeLeftover({ status: 'frozen' }),
			];
			const result = getActiveLeftovers(items);
			expect(result).toEqual([]);
		});

		it('returns all items when all are active', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'active' }),
				makeLeftover({ name: 'Soup', status: 'active' }),
			];
			const result = getActiveLeftovers(items);
			expect(result).toHaveLength(2);
		});

		it('returns empty array for empty list', () => {
			expect(getActiveLeftovers([])).toEqual([]);
		});
	});

	// ── getExpiringLeftovers ─────────────────────────────────────────

	describe('getExpiringLeftovers', () => {
		it('returns active items expiring within N days', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'active', expiryEstimate: '2026-04-04' }),
				makeLeftover({ name: 'Soup', status: 'active', expiryEstimate: '2026-04-10' }),
			];
			// today = 2026-04-02, withinDays = 3 → expires on or before 2026-04-05
			const result = getExpiringLeftovers(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('Chili');
		});

		it('includes already-expired items', () => {
			const items = [
				makeLeftover({ name: 'OldStew', status: 'active', expiryEstimate: '2026-03-30' }),
			];
			const result = getExpiringLeftovers(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('OldStew');
		});

		it('excludes non-active items', () => {
			const items = [
				makeLeftover({ name: 'UsedChili', status: 'used', expiryEstimate: '2026-04-04' }),
				makeLeftover({ name: 'FrozenSoup', status: 'frozen', expiryEstimate: '2026-04-03' }),
			];
			const result = getExpiringLeftovers(items, 5, '2026-04-02');
			expect(result).toEqual([]);
		});

		it('returns empty array for empty list', () => {
			expect(getExpiringLeftovers([], 3, '2026-04-02')).toEqual([]);
		});

		it('includes item expiring exactly on boundary day', () => {
			const items = [
				makeLeftover({ name: 'Boundary', status: 'active', expiryEstimate: '2026-04-05' }),
			];
			// today=2026-04-02, within 3 days → boundary is 2026-04-05
			const result = getExpiringLeftovers(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
		});
	});

	// ── formatLeftoverList ───────────────────────────────────────────

	describe('formatLeftoverList', () => {
		it('returns empty message when no active items', () => {
			const items = [makeLeftover({ status: 'used' })];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('No active leftovers');
		});

		it('shows active item names and quantities', () => {
			const items = [makeLeftover({ name: 'Chili', quantity: '3 servings', status: 'active', expiryEstimate: '2026-04-10' })];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('Chili');
			expect(result).toContain('3 servings');
		});

		it('shows warning emoji for item expiring tomorrow', () => {
			const items = [makeLeftover({ name: 'Soup', status: 'active', expiryEstimate: '2026-04-03' })];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('⚠️');
		});

		it('shows expired emoji for item expiring today', () => {
			const items = [makeLeftover({ name: 'Chili', status: 'active', expiryEstimate: '2026-04-02' })];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('❌');
		});

		it('shows expired emoji for past-due item', () => {
			const items = [makeLeftover({ name: 'OldStew', status: 'active', expiryEstimate: '2026-03-30' })];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('❌');
		});

		it('does not show non-active items', () => {
			const items = [
				makeLeftover({ name: 'Active', status: 'active', expiryEstimate: '2026-04-10' }),
				makeLeftover({ name: 'Used', status: 'used', expiryEstimate: '2026-04-10' }),
			];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('Active');
			expect(result).not.toContain('Used');
		});

		it('works without today parameter', () => {
			const items = [makeLeftover({ name: 'Chili', status: 'active', expiryEstimate: '2099-12-31' })];
			const result = formatLeftoverList(items);
			expect(result).toContain('Chili');
		});
	});

	// ── buildLeftoverButtons ─────────────────────────────────────────

	describe('buildLeftoverButtons', () => {
		it('returns Add button for empty list', () => {
			const result = buildLeftoverButtons([]);
			expect(result).toHaveLength(1);
			expect(result[0][0].text).toContain('Add');
		});

		it('returns Add button as first row', () => {
			const items = [makeLeftover({ status: 'active' })];
			const result = buildLeftoverButtons(items);
			expect(result[0][0].text).toContain('Add');
		});

		it('adds Use/Freeze/Toss buttons for each active item', () => {
			const items = [makeLeftover({ name: 'Chili', status: 'active' })];
			const result = buildLeftoverButtons(items);
			// First row is Add, subsequent rows are per-item
			const itemRows = result.slice(1);
			expect(itemRows).toHaveLength(1);
			const buttons = itemRows[0];
			expect(buttons.some((b) => b.text.includes('Use'))).toBe(true);
			expect(buttons.some((b) => b.text.includes('Freeze'))).toBe(true);
			expect(buttons.some((b) => b.text.includes('Toss'))).toBe(true);
		});

		it('uses original index in callback data', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'used' }),
				makeLeftover({ name: 'Soup', status: 'active' }),
			];
			const result = buildLeftoverButtons(items);
			const itemRows = result.slice(1);
			// Only 'Soup' (index 1) should have buttons
			expect(itemRows).toHaveLength(1);
			const useBtn = itemRows[0].find((b) => b.text.includes('Use'));
			expect(useBtn?.callbackData).toContain(':1');
		});

		it('uses correct callback data format', () => {
			const items = [makeLeftover({ name: 'Chili', status: 'active' })];
			const result = buildLeftoverButtons(items);
			const itemRows = result.slice(1);
			const useBtn = itemRows[0].find((b) => b.text.includes('Use'));
			const freezeBtn = itemRows[0].find((b) => b.text.includes('Freeze'));
			const tossBtn = itemRows[0].find((b) => b.text.includes('Toss'));
			expect(useBtn?.callbackData).toBe('app:food:lo:use:0:Chili');
			expect(freezeBtn?.callbackData).toBe('app:food:lo:freeze:0:Chili');
			expect(tossBtn?.callbackData).toBe('app:food:lo:toss:0:Chili');
		});

		it('skips non-active items for action buttons', () => {
			const items = [
				makeLeftover({ name: 'Used', status: 'used' }),
				makeLeftover({ name: 'Frozen', status: 'frozen' }),
				makeLeftover({ name: 'Wasted', status: 'wasted' }),
			];
			const result = buildLeftoverButtons(items);
			// Only the Add button row
			expect(result).toHaveLength(1);
		});

		it('includes item name in button label', () => {
			const items = [makeLeftover({ name: 'Beef Stew', status: 'active' })];
			const result = buildLeftoverButtons(items);
			const itemRows = result.slice(1);
			const rowText = itemRows[0].map((b) => b.text).join(' ');
			expect(rowText).toContain('Beef Stew');
		});
	});

	// ── parseLeftoverInput ───────────────────────────────────────────

	describe('parseLeftoverInput', () => {
		it('parses simple name', () => {
			const result = parseLeftoverInput('chili', undefined, 'UTC');
			expect(result.name).toBe('chili');
			expect(result.quantity).toBe('some');
		});

		it('parses name and quantity separated by comma', () => {
			const result = parseLeftoverInput('chili, about 3 servings', undefined, 'UTC');
			expect(result.name).toBe('chili');
			expect(result.quantity).toBe('about 3 servings');
		});

		it('uses provided fromRecipe', () => {
			const result = parseLeftoverInput('chili', 'Beef Chili Recipe', 'UTC');
			expect(result.fromRecipe).toBe('Beef Chili Recipe');
		});

		it('sets fromRecipe to undefined when not provided', () => {
			const result = parseLeftoverInput('chili', undefined, 'UTC');
			expect(result.fromRecipe).toBeUndefined();
		});

		it('sets storedDate from timezone', () => {
			const result = parseLeftoverInput('chili', undefined, 'UTC');
			expect(result.storedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it('sets status to active', () => {
			const result = parseLeftoverInput('chili', undefined, 'UTC');
			expect(result.status).toBe('active');
		});

		it('defaults quantity to "some" when none provided', () => {
			const result = parseLeftoverInput('leftover pasta', undefined, 'UTC');
			expect(result.quantity).toBe('some');
		});

		it('trims whitespace from name and quantity', () => {
			const result = parseLeftoverInput('  chili  ,  3 servings  ', undefined, 'UTC');
			expect(result.name).toBe('chili');
			expect(result.quantity).toBe('3 servings');
		});

		it('handles multi-word quantity', () => {
			const result = parseLeftoverInput('soup, half a pot', undefined, 'UTC');
			expect(result.name).toBe('soup');
			expect(result.quantity).toBe('half a pot');
		});
	});
});
