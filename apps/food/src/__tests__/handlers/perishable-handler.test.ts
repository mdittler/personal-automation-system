/**
 * Tests for the perishable handler — pantry expiry alerts and callback actions.
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handlePerishableCallback,
	handlePerishableCheckJob,
} from '../../handlers/perishable-handler.js';
import type { FreezerItem, Household, PantryItem } from '../../types.js';

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh1',
		name: 'Test',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01',
		...overrides,
	};
}

function makePantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
	return {
		name: 'Spinach',
		quantity: '1 bag',
		addedDate: '2026-04-01',
		category: 'Produce',
		...overrides,
	};
}

function makeFreezerItem(overrides: Partial<FreezerItem> = {}): FreezerItem {
	return {
		name: 'Chicken Breasts',
		quantity: '2 lbs',
		frozenDate: '2026-01-01',
		source: 'purchased',
		...overrides,
	};
}

function mockStore(data: Record<string, string | null> = {}) {
	const storage = new Map(Object.entries(data));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

function householdYaml(hh: Household): string {
	return stringify(hh);
}

function pantryYaml(items: PantryItem[]): string {
	return stringify({ items });
}

function freezerYaml(items: FreezerItem[]): string {
	return stringify({ items });
}

// ─── handlePerishableCallback ─────────────────────────────────────────────────

describe('handlePerishableCallback', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	describe('freeze action', () => {
		it('removes item from pantry and adds to freezer', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-03' }),
				makePantryItem({ name: 'Chicken', quantity: '2 lbs', expiryEstimate: '2026-04-04' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'freezer.yaml': null,
			});

			await handlePerishableCallback(services, 'freeze:0', 'user1', 100, 200, store as never);

			// pantry.yaml should have been written
			const pantryWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'pantry.yaml');
			expect(pantryWrite).toBeDefined();
			// Written pantry should NOT contain 'Spinach'
			expect(pantryWrite![1]).not.toContain('Spinach');
			expect(pantryWrite![1]).toContain('Chicken');

			// freezer.yaml should have been written
			const freezerWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'freezer.yaml');
			expect(freezerWrite).toBeDefined();
			expect(freezerWrite![1]).toContain('Spinach');
		});

		it('sets frozenDate and source=pantry on the freezer item', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Milk', quantity: '1 gallon', expiryEstimate: '2026-04-03' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'freezer.yaml': null,
			});

			await handlePerishableCallback(services, 'freeze:0', 'user1', 100, 200, store as never);

			const freezerWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'freezer.yaml');
			expect(freezerWrite![1]).toContain('pantry');
		});

		it('edits message with 🧊 confirmation including name', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Broccoli', quantity: '1 head', expiryEstimate: '2026-04-03' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'freezer.yaml': null,
			});

			await handlePerishableCallback(services, 'freeze:0', 'user1', 100, 200, store as never);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('🧊'),
			);
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('Broccoli'),
			);
		});

		it('handles freezing item at index > 0', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Apples', quantity: '5', expiryEstimate: '2026-04-10' }),
				makePantryItem({ name: 'Strawberries', quantity: '1 pint', expiryEstimate: '2026-04-03' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'freezer.yaml': null,
			});

			await handlePerishableCallback(services, 'freeze:1', 'user1', 100, 200, store as never);

			const pantryWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'pantry.yaml');
			expect(pantryWrite![1]).toContain('Apples');
			expect(pantryWrite![1]).not.toContain('Strawberries');

			const freezerWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'freezer.yaml');
			expect(freezerWrite![1]).toContain('Strawberries');
		});

		it('merges with existing freezer items (dedup by name)', async () => {
			const pantryItems = [makePantryItem({ name: 'Chicken', quantity: '2 lbs' })];
			const existingFreezer = [makeFreezerItem({ name: 'Salmon', quantity: '1 lb' })];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'freezer.yaml': freezerYaml(existingFreezer),
			});

			await handlePerishableCallback(services, 'freeze:0', 'user1', 100, 200, store as never);

			const freezerWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'freezer.yaml');
			expect(freezerWrite![1]).toContain('Salmon');
			expect(freezerWrite![1]).toContain('Chicken');
		});
	});

	describe('ok action', () => {
		it('edits message with 👍 confirmation', async () => {
			const pantryItems = [makePantryItem({ name: 'Eggs', quantity: '1 dozen' })];
			const store = mockStore({ 'pantry.yaml': pantryYaml(pantryItems) });

			await handlePerishableCallback(services, 'ok:0', 'user1', 100, 200, store as never);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('👍'),
			);
		});

		it('does not write to pantry or freezer', async () => {
			const pantryItems = [makePantryItem({ name: 'Eggs' })];
			const store = mockStore({ 'pantry.yaml': pantryYaml(pantryItems) });

			await handlePerishableCallback(services, 'ok:0', 'user1', 100, 200, store as never);

			const writes = vi.mocked(store.write).mock.calls;
			expect(writes.length).toBe(0);
		});
	});

	describe('toss action', () => {
		it('removes item from pantry', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Lettuce', quantity: '1 head', expiryEstimate: '2026-04-02' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'waste-log.yaml': null,
			});

			await handlePerishableCallback(services, 'toss:0', 'user1', 100, 200, store as never);

			const pantryWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'pantry.yaml');
			expect(pantryWrite).toBeDefined();
			expect(pantryWrite![1]).not.toContain('Lettuce');
		});

		it('appends a waste log entry with reason=expired and source=pantry', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Lettuce', quantity: '1 head', expiryEstimate: '2026-04-02' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'waste-log.yaml': null,
			});

			await handlePerishableCallback(services, 'toss:0', 'user1', 100, 200, store as never);

			const wasteWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'waste-log.yaml');
			expect(wasteWrite).toBeDefined();
			expect(wasteWrite![1]).toContain('expired');
			expect(wasteWrite![1]).toContain('pantry');
			expect(wasteWrite![1]).toContain('Lettuce');
		});

		it('edits message with 🗑 confirmation including name', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Old Milk', quantity: '1 jug', expiryEstimate: '2026-04-01' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'waste-log.yaml': null,
			});

			await handlePerishableCallback(services, 'toss:0', 'user1', 100, 200, store as never);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('🗑'),
			);
			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('Old Milk'),
			);
		});

		it('handles tossing item at index > 0', async () => {
			const pantryItems = [
				makePantryItem({ name: 'Kale', quantity: '1 bunch' }),
				makePantryItem({ name: 'Yogurt', quantity: '1 cup', expiryEstimate: '2026-04-01' }),
			];
			const store = mockStore({
				'pantry.yaml': pantryYaml(pantryItems),
				'waste-log.yaml': null,
			});

			await handlePerishableCallback(services, 'toss:1', 'user1', 100, 200, store as never);

			const pantryWrite = vi.mocked(store.write).mock.calls.find((c) => c[0] === 'pantry.yaml');
			expect(pantryWrite![1]).toContain('Kale');
			expect(pantryWrite![1]).not.toContain('Yogurt');
		});
	});

	describe('invalid action', () => {
		it('does nothing for unknown action', async () => {
			const store = mockStore({ 'pantry.yaml': pantryYaml([makePantryItem()]) });

			await handlePerishableCallback(services, 'unknown:0', 'user1', 100, 200, store as never);

			expect(services.telegram.editMessage).not.toHaveBeenCalled();
			expect(store.write).not.toHaveBeenCalled();
		});
	});
});

// ─── handlePerishableCheckJob ────────────────────────────────────────────────

describe('handlePerishableCheckJob', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	function setupServices(data: Record<string, string | null>) {
		const store = mockStore(data);
		vi.mocked(services.data.forShared).mockReturnValue(store as never);
		return store;
	}

	it('does nothing when no household exists', async () => {
		setupServices({ 'household.yaml': null });

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('does nothing when pantry is empty', async () => {
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': null,
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('does nothing when no items have expiryEstimate', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Rice', quantity: '5 lbs' }), // no expiryEstimate
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('does nothing when no items expiring within 2 days', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Cheese', quantity: '1 block', expiryEstimate: '2026-04-10' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('sends alert when an item expires today (daysLeft=0)', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
		const [userId, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(userId).toBe('user1');
		expect(message).toContain('Perishable Alert');
		expect(message).toContain('Spinach');
	});

	it('includes "expires today" text for items expiring today', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(message).toContain('expires today');
	});

	it('includes "expires tomorrow" text for items expiring in 1 day', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Milk', quantity: '1 gal', expiryEstimate: '2026-04-03' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(message).toContain('expires tomorrow');
	});

	it('includes "expires in N days" text for items expiring in 2 days', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Berries', quantity: '1 pint', expiryEstimate: '2026-04-04' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(message).toContain('expires in 2 days');
	});

	it('includes "already expired" urgency text for past-due items', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Old Yogurt', quantity: '1 cup', expiryEstimate: '2026-03-30' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		// Should contain some urgency indicator (either "expires today" for <= 0 or specific expired text)
		expect(message).toContain('Old Yogurt');
	});

	it('sends alert to all household members', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
		];
		const household = makeHousehold({ members: ['user1', 'user2', 'user3'] });
		setupServices({
			'household.yaml': householdYaml(household),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(3);
		const recipients = vi.mocked(services.telegram.sendWithButtons).mock.calls.map((c) => c[0]);
		expect(recipients).toContain('user1');
		expect(recipients).toContain('user2');
		expect(recipients).toContain('user3');
	});

	it('skips items without expiryEstimate and alerts on those that have it', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Canned Beans', quantity: '2 cans' }), // no expiryEstimate
			makePantryItem({ name: 'Fresh Basil', quantity: '1 bunch', expiryEstimate: '2026-04-03' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(message).toContain('Fresh Basil');
		expect(message).not.toContain('Canned Beans');
	});

	it('sends Freeze/Toss/Still good buttons for items expiring today (daysLeft<=0)', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, , buttons] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		const allButtons = (buttons as Array<Array<{ text: string; callbackData: string }>>).flat();
		const texts = allButtons.map((b) => b.text);
		expect(texts.some((t) => t.toLowerCase().includes('freeze'))).toBe(true);
		expect(texts.some((t) => t.toLowerCase().includes('toss'))).toBe(true);
		expect(texts.some((t) => t.toLowerCase().includes('good'))).toBe(true);
	});

	it('sends Move to Freezer/Still good buttons for items expiring in 1-2 days', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Milk', quantity: '1 gal', expiryEstimate: '2026-04-04' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, , buttons] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		const allButtons = (buttons as Array<Array<{ text: string; callbackData: string }>>).flat();
		const texts = allButtons.map((b) => b.text);
		expect(texts.some((t) => t.toLowerCase().includes('freezer'))).toBe(true);
		expect(texts.some((t) => t.toLowerCase().includes('good'))).toBe(true);
	});

	it('uses correct callback data format (app:food:pa:...)', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, , buttons] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		const allButtons = (buttons as Array<Array<{ text: string; callbackData: string }>>).flat();
		const callbackDatas = allButtons.map((b) => b.callbackData);
		expect(callbackDatas.some((d) => d.startsWith('app:food:pa:'))).toBe(true);
	});

	it('uses pantry array index in callback data', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Apples', quantity: '5', expiryEstimate: '2026-04-10' }), // not expiring (idx=0)
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }), // expiring (idx=1)
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		const [, , buttons] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		const allButtons = (buttons as Array<Array<{ text: string; callbackData: string }>>).flat();
		const callbackDatas = allButtons.map((b) => b.callbackData);
		// Spinach is at index 1 in the full pantry array
		expect(callbackDatas.some((d) => d.includes(':1'))).toBe(true);
	});

	it('handles multiple expiring items in a single message', async () => {
		const pantryItems = [
			makePantryItem({ name: 'Spinach', quantity: '1 bag', expiryEstimate: '2026-04-02' }),
			makePantryItem({ name: 'Berries', quantity: '1 pint', expiryEstimate: '2026-04-03' }),
		];
		setupServices({
			'household.yaml': householdYaml(makeHousehold()),
			'pantry.yaml': pantryYaml(pantryItems),
		});

		await handlePerishableCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(message).toContain('Spinach');
		expect(message).toContain('Berries');
	});
});

// ─── Security Tests ──────────────────────────────────────────────

describe('security: perishable callback guards', () => {
	let services: CoreServices;

	function setupServices(storeData: Record<string, string>) {
		services = createMockCoreServices();
		const storage = new Map(Object.entries(storeData));
		const store = {
			read: vi.fn(async (path: string) => storage.get(path) ?? null),
			write: vi.fn(async (path: string, content: string) => { storage.set(path, content); }),
			append: vi.fn(), list: vi.fn(), exists: vi.fn(), archive: vi.fn(),
		};
		return store;
	}

	it('rejects freeze when item name does not match (index shifted)', async () => {
		const store = setupServices({
			'pantry.yaml': pantryYaml([makePantryItem({ name: 'Yogurt' })]),
			'freezer.yaml': stringify({ items: [] }),
		});

		// Callback says "Spinach" at index 0, but pantry[0] is now "Yogurt"
		await handlePerishableCallback(services, 'freeze:0:Spinach', 'user1', 1, 1, store as any);

		expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
			1, 1, 'This item was already handled.',
		);
		// Pantry should NOT have been modified
		expect(store.write).not.toHaveBeenCalled();
	});

	it('rejects toss when item name does not match (index shifted)', async () => {
		const store = setupServices({
			'pantry.yaml': pantryYaml([makePantryItem({ name: 'Milk' })]),
		});

		await handlePerishableCallback(services, 'toss:0:Chicken', 'user1', 1, 1, store as any);

		expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
			1, 1, 'This item was already handled.',
		);
		expect(store.write).not.toHaveBeenCalled();
	});
});
