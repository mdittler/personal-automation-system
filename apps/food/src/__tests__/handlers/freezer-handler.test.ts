/**
 * Tests for freezer-handler — callbacks and Monday check job.
 */

import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { handleFreezerCallback, handleFreezerCheckJob } from '../../handlers/freezer-handler.js';
import type { FreezerItem, Household } from '../../types.js';

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeHousehold(members = ['user1', 'user2']): Household {
	return {
		id: 'hh1',
		name: 'Test',
		createdBy: 'user1',
		members,
		joinCode: 'ABC123',
		createdAt: '2026-01-01',
	};
}

function makeFreezerItem(overrides: Partial<FreezerItem> = {}): FreezerItem {
	return {
		name: 'Chicken Breasts',
		quantity: '2 lbs',
		frozenDate: '2025-12-01',
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

function makeHouseholdYaml(members = ['user1', 'user2']): string {
	return stringify(makeHousehold(members));
}

function makeFreezerYaml(items: FreezerItem[]): string {
	return stringify({ items });
}

function makeWasteYaml(): string {
	return stringify({ entries: [] });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('freezer-handler', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as ScopedDataStore);
	});

	// ─── handleFreezerCallback ────────────────────────────────────────────────

	describe('handleFreezerCallback', () => {
		describe('thaw action', () => {
			it('removes item at index and edits message with thaw confirmation', async () => {
				const items = [
					makeFreezerItem({ name: 'Chicken Breasts' }),
					makeFreezerItem({ name: 'Salmon', quantity: '1 lb' }),
				];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'thaw:0', 'user1', 100, 200, store);

				expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
					100,
					200,
					expect.stringContaining('Chicken Breasts'),
				);
				const [, , msg] = vi.mocked(services.telegram.editMessage).mock.calls[0]!;
				expect(msg).toContain('Thawed');
			});

			it('removes the correct item by index', async () => {
				const items = [
					makeFreezerItem({ name: 'Chicken Breasts' }),
					makeFreezerItem({ name: 'Salmon', quantity: '1 lb' }),
				];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'thaw:1', 'user1', 100, 200, store);

				expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
					100,
					200,
					expect.stringContaining('Salmon'),
				);
			});

			it('saves updated freezer after thaw', async () => {
				const items = [makeFreezerItem({ name: 'Steak' })];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'thaw:0', 'user1', 100, 200, store);

				expect(vi.mocked(store.write)).toHaveBeenCalledWith(
					'freezer.yaml',
					expect.any(String),
				);
			});

			it('does not log waste for thaw', async () => {
				const items = [makeFreezerItem()];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'thaw:0', 'user1', 100, 200, store);

				// waste-log.yaml should not be written
				expect(vi.mocked(store.write)).not.toHaveBeenCalledWith(
					'waste-log.yaml',
					expect.any(String),
				);
			});
		});

		describe('toss action', () => {
			it('removes item at index and edits message with toss confirmation', async () => {
				const items = [
					makeFreezerItem({ name: 'Beef Stew' }),
					makeFreezerItem({ name: 'Pork Ribs', quantity: 'some' }),
				];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
					'waste-log.yaml': makeWasteYaml(),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'toss:0', 'user1', 100, 200, store);

				expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
					100,
					200,
					expect.stringContaining('Beef Stew'),
				);
				const [, , msg] = vi.mocked(services.telegram.editMessage).mock.calls[0]!;
				expect(msg).toContain('Tossed');
			});

			it('withholds the toss confirmation when waste logging fails', async () => {
				const items = [makeFreezerItem({ name: 'Beef Stew' })];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
					'waste-log.yaml': makeWasteYaml(),
				}) as unknown as ScopedDataStore;
				vi.mocked(store.write).mockImplementation(async (path: string, content: string) => {
					if (path === 'waste-log.yaml') {
						throw new Error('waste append failed');
					}
				});

				await expect(
					handleFreezerCallback(services, 'toss:0', 'user1', 100, 200, store),
				).rejects.toThrow('waste append failed');

				expect(services.telegram.editMessage).not.toHaveBeenCalledWith(
					100,
					200,
					expect.stringContaining('🗑 Tossed'),
				);
			});

			it('logs waste entry with reason=discarded and source=freezer', async () => {
				const items = [makeFreezerItem({ name: 'Old Turkey', quantity: '3 lbs' })];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
					'waste-log.yaml': makeWasteYaml(),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'toss:0', 'user1', 100, 200, store);

				expect(vi.mocked(store.write)).toHaveBeenCalledWith(
					'waste-log.yaml',
					expect.stringContaining('discarded'),
				);
				expect(vi.mocked(store.write)).toHaveBeenCalledWith(
					'waste-log.yaml',
					expect.stringContaining('freezer'),
				);
			});

			it('saves updated freezer after toss', async () => {
				const items = [makeFreezerItem({ name: 'Mystery Meat' })];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
					'waste-log.yaml': makeWasteYaml(),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'toss:0', 'user1', 100, 200, store);

				expect(vi.mocked(store.write)).toHaveBeenCalledWith(
					'freezer.yaml',
					expect.any(String),
				);
			});

			it('toss second item by index', async () => {
				const items = [
					makeFreezerItem({ name: 'Chicken Breasts' }),
					makeFreezerItem({ name: 'Fish Fillets', quantity: '4 pieces' }),
				];
				const store = mockStore({
					'freezer.yaml': makeFreezerYaml(items),
					'waste-log.yaml': makeWasteYaml(),
				}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'toss:1', 'user1', 100, 200, store);

				const [, , msg] = vi.mocked(services.telegram.editMessage).mock.calls[0]!;
				expect(msg).toContain('Fish Fillets');
				expect(vi.mocked(store.write)).toHaveBeenCalledWith(
					'waste-log.yaml',
					expect.stringContaining('Fish Fillets'),
				);
			});
		});

		describe('unknown action', () => {
			it('does nothing for unknown callback action', async () => {
				const store = mockStore({}) as unknown as ScopedDataStore;

				await handleFreezerCallback(services, 'unknown:0', 'user1', 100, 200, store);

				expect(vi.mocked(services.telegram.editMessage)).not.toHaveBeenCalled();
			});
		});
	});

	// ─── handleFreezerCheckJob ────────────────────────────────────────────────

	describe('handleFreezerCheckJob', () => {
		it('sends reminder to all household members for 3+ month old items', async () => {
			// Items frozen more than 3 months before 2026-04-02
			const items = [
				makeFreezerItem({ name: 'Old Chicken', frozenDate: '2025-12-01' }), // ~4 months old
				makeFreezerItem({ name: 'Recent Salmon', frozenDate: '2026-03-15' }), // ~2 weeks old
			];
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1', 'user2']);
				if (path === 'freezer.yaml') return makeFreezerYaml(items);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			// Both members should receive the message
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalledTimes(2);
			const [firstUserId, firstMsg] = vi.mocked(services.telegram.send).mock.calls[0]!;
			expect(['user1', 'user2']).toContain(firstUserId);
			expect(firstMsg).toContain('Old Chicken');
			expect(firstMsg).toContain('/freezer');
		});

		it('does not mention recent items in the reminder', async () => {
			const items = [
				makeFreezerItem({ name: 'Old Beef', frozenDate: '2025-12-01' }),
				makeFreezerItem({ name: 'Fresh Veggies', frozenDate: '2026-03-20' }),
			];
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1']);
				if (path === 'freezer.yaml') return makeFreezerYaml(items);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			const [, msg] = vi.mocked(services.telegram.send).mock.calls[0]!;
			expect(msg).toContain('Old Beef');
			expect(msg).not.toContain('Fresh Veggies');
		});

		it('sends nothing when no aging items exist', async () => {
			// All items recently frozen
			const items = [
				makeFreezerItem({ name: 'Fresh Chicken', frozenDate: '2026-03-01' }),
				makeFreezerItem({ name: 'New Salmon', frozenDate: '2026-03-15' }),
			];
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1']);
				if (path === 'freezer.yaml') return makeFreezerYaml(items);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			expect(vi.mocked(services.telegram.send)).not.toHaveBeenCalled();
		});

		it('sends nothing when freezer is empty', async () => {
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1']);
				if (path === 'freezer.yaml') return makeFreezerYaml([]);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			expect(vi.mocked(services.telegram.send)).not.toHaveBeenCalled();
		});

		it('sends nothing when no household exists', async () => {
			sharedStore.read = vi.fn(async (_path: string) => null) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			expect(vi.mocked(services.telegram.send)).not.toHaveBeenCalled();
		});

		it('uses services.timezone when no todayOverride provided', async () => {
			sharedStore.read = vi.fn(async (_path: string) => null) as ScopedDataStore['read'];

			// Should not throw — just exits early due to no household
			await expect(handleFreezerCheckJob(services)).resolves.not.toThrow();
		});

		it('message ends with /freezer instruction', async () => {
			const items = [makeFreezerItem({ name: 'Aged Stew', frozenDate: '2025-12-01' })];
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1']);
				if (path === 'freezer.yaml') return makeFreezerYaml(items);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			const [, msg] = vi.mocked(services.telegram.send).mock.calls[0]!;
			expect(msg).toContain('Use /freezer to manage your inventory.');
		});

		it('message includes month count for aging items', async () => {
			// Frozen exactly 4 months ago
			const items = [makeFreezerItem({ name: 'Pork Shoulder', frozenDate: '2025-12-02' })];
			sharedStore.read = vi.fn(async (path: string) => {
				if (path === 'household.yaml') return makeHouseholdYaml(['user1']);
				if (path === 'freezer.yaml') return makeFreezerYaml(items);
				return null;
			}) as ScopedDataStore['read'];

			await handleFreezerCheckJob(services, '2026-04-02');

			const [, msg] = vi.mocked(services.telegram.send).mock.calls[0]!;
			expect(msg).toContain('Pork Shoulder');
			// Should mention months
			expect(msg).toMatch(/month/i);
		});
	});
});
