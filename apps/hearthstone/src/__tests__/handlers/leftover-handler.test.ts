/**
 * Tests for the leftover handler — callback routing and daily check job.
 *
 * Covers: handleLeftoverCallback (use/freeze/toss/keep/post-meal:no)
 *         handleLeftoverCheckJob (auto-waste expired, alert expiring, no-op cases)
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleLeftoverCallback,
	handleLeftoverCheckJob,
} from '../../handlers/leftover-handler.js';
import type { Household, Leftover } from '../../types.js';

// ─── Mock store factory ───────────────────────────────────────────

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

// ─── Sample data factories ────────────────────────────────────────

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh1',
		name: 'Test Family',
		createdBy: 'user1',
		members: ['user1', 'user2'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'Pasta',
		quantity: '2 servings',
		fromRecipe: 'Pasta Bolognese',
		storedDate: '2026-04-01',
		expiryEstimate: '2026-04-05',
		status: 'active',
		...overrides,
	};
}

// ─── handleLeftoverCallback ───────────────────────────────────────

describe('handleLeftoverCallback — use', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		const leftover = makeLeftover();
		store = mockStore({
			'leftovers.yaml': stringify({ items: [leftover] }),
		});
	});

	it('marks leftover as used and edits message', async () => {
		await handleLeftoverCallback(services, 'use:0', 'user1', 12345, 99, store as any);

		expect(store.write).toHaveBeenCalledWith('leftovers.yaml', expect.any(String));

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCall = vi.mocked(store.write).mock.calls.find((c) =>
			String(c[0]).includes('leftovers'),
		);
		const saved = parse(stripFrontmatter(String(writeCall?.[1])));
		expect(saved.items[0].status).toBe('used');

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('✅ Used: Pasta'),
		);
	});
});

describe('handleLeftoverCallback — freeze', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		const leftover = makeLeftover({ fromRecipe: 'Pasta Bolognese' });
		store = mockStore({
			'leftovers.yaml': stringify({ items: [leftover] }),
			'freezer.yaml': stringify({ items: [] }),
		});
	});

	it('marks leftover as frozen', async () => {
		await handleLeftoverCallback(services, 'freeze:0', 'user1', 12345, 99, store as any);

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(store.write).mock.calls;
		const leftoverWrite = writeCalls.find((c) => String(c[0]).includes('leftovers'));
		const saved = parse(stripFrontmatter(String(leftoverWrite?.[1])));
		expect(saved.items[0].status).toBe('frozen');
	});

	it('adds item to freezer with correct source', async () => {
		await handleLeftoverCallback(services, 'freeze:0', 'user1', 12345, 99, store as any);

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(store.write).mock.calls;
		const freezerWrite = writeCalls.find((c) => String(c[0]).includes('freezer'));
		expect(freezerWrite).toBeDefined();
		const saved = parse(stripFrontmatter(String(freezerWrite?.[1])));
		expect(saved.items).toHaveLength(1);
		expect(saved.items[0].name).toBe('Pasta');
		expect(saved.items[0].source).toBe('Pasta Bolognese');
	});

	it('uses "leftover" as source when no fromRecipe', async () => {
		store = mockStore({
			'leftovers.yaml': stringify({ items: [makeLeftover({ fromRecipe: undefined })] }),
			'freezer.yaml': stringify({ items: [] }),
		});

		await handleLeftoverCallback(services, 'freeze:0', 'user1', 12345, 99, store as any);

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(store.write).mock.calls;
		const freezerWrite = writeCalls.find((c) => String(c[0]).includes('freezer'));
		const saved = parse(stripFrontmatter(String(freezerWrite?.[1])));
		expect(saved.items[0].source).toBe('leftover');
	});

	it('edits message with frozen confirmation', async () => {
		await handleLeftoverCallback(services, 'freeze:0', 'user1', 12345, 99, store as any);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('🧊 Frozen: Pasta'),
		);
	});
});

describe('handleLeftoverCallback — toss', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = mockStore({
			'leftovers.yaml': stringify({ items: [makeLeftover()] }),
			'waste-log.yaml': stringify({ entries: [] }),
		});
	});

	it('marks leftover as wasted', async () => {
		await handleLeftoverCallback(services, 'toss:0', 'user1', 12345, 99, store as any);

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(store.write).mock.calls;
		const leftoverWrite = writeCalls.find((c) => String(c[0]).includes('leftovers'));
		const saved = parse(stripFrontmatter(String(leftoverWrite?.[1])));
		expect(saved.items[0].status).toBe('wasted');
	});

	it('appends waste log entry with reason discarded', async () => {
		await handleLeftoverCallback(services, 'toss:0', 'user1', 12345, 99, store as any);

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(store.write).mock.calls;
		const wasteWrite = writeCalls.find((c) => String(c[0]).includes('waste-log'));
		expect(wasteWrite).toBeDefined();
		const saved = parse(stripFrontmatter(String(wasteWrite?.[1])));
		expect(saved.entries).toHaveLength(1);
		expect(saved.entries[0].reason).toBe('discarded');
		expect(saved.entries[0].source).toBe('leftover');
		expect(saved.entries[0].name).toBe('Pasta');
	});

	it('edits message with toss confirmation', async () => {
		await handleLeftoverCallback(services, 'toss:0', 'user1', 12345, 99, store as any);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('🗑 Tossed: Pasta'),
		);
	});
});

describe('handleLeftoverCallback — keep', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = mockStore({
			'leftovers.yaml': stringify({ items: [makeLeftover()] }),
		});
	});

	it('does not change leftover data', async () => {
		await handleLeftoverCallback(services, 'keep:0', 'user1', 12345, 99, store as any);

		expect(store.write).not.toHaveBeenCalled();
	});

	it('edits message acknowledging keep', async () => {
		await handleLeftoverCallback(services, 'keep:0', 'user1', 12345, 99, store as any);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('keeping Pasta'),
		);
	});
});

describe('handleLeftoverCallback — post-meal:no', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = mockStore({});
	});

	it('edits message with no leftovers noted', async () => {
		await handleLeftoverCallback(services, 'post-meal:no', 'user1', 12345, 99, store as any);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('No leftovers'),
		);
		expect(store.write).not.toHaveBeenCalled();
	});
});

describe('handleLeftoverCallback — out-of-range index', () => {
	let services: CoreServices;
	let store: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		store = mockStore({
			'leftovers.yaml': stringify({ items: [makeLeftover()] }),
		});
	});

	it('does nothing for out-of-range use index', async () => {
		await handleLeftoverCallback(services, 'use:99', 'user1', 12345, 99, store as any);

		expect(store.write).not.toHaveBeenCalled();
		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});
});

// ─── handleLeftoverCheckJob ───────────────────────────────────────

describe('handleLeftoverCheckJob', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof mockStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		sharedStore = mockStore({});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	it('returns early when no household exists', async () => {
		sharedStore = mockStore({ 'household.yaml': null });
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('returns early when no active leftovers', async () => {
		const household = makeHousehold();
		const leftover = makeLeftover({ status: 'used' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [leftover] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('returns early when no leftovers at all', async () => {
		const household = makeHousehold();
		sharedStore = mockStore({
			'household.yaml': stringify(household),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('returns early when active leftovers are not expiring soon', async () => {
		const household = makeHousehold();
		// Expires in 5 days — not expiring today/tomorrow
		const leftover = makeLeftover({ expiryEstimate: '2026-04-07', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [leftover] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it('auto-wastes expired items and writes updated leftovers', async () => {
		const household = makeHousehold({ members: ['user1'] });
		// Expired yesterday
		const expired = makeLeftover({ name: 'Old Soup', expiryEstimate: '2026-04-01', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expired] }),
			'waste-log.yaml': stringify({ entries: [] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const leftoverWrite = writeCalls.find((c) => String(c[0]).includes('leftovers'));
		expect(leftoverWrite).toBeDefined();
		const saved = parse(stripFrontmatter(String(leftoverWrite?.[1])));
		expect(saved.items[0].status).toBe('wasted');
	});

	it('appends waste log entry with reason expired for auto-wasted items', async () => {
		const household = makeHousehold({ members: ['user1'] });
		const expired = makeLeftover({ name: 'Old Soup', expiryEstimate: '2026-04-01', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expired] }),
			'waste-log.yaml': stringify({ entries: [] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const wasteWrite = writeCalls.find((c) => String(c[0]).includes('waste-log'));
		expect(wasteWrite).toBeDefined();
		const saved = parse(stripFrontmatter(String(wasteWrite?.[1])));
		expect(saved.entries[0].reason).toBe('expired');
		expect(saved.entries[0].name).toBe('Old Soup');
	});

	it('sends alert message mentioning expired items to all household members', async () => {
		const household = makeHousehold({ members: ['user1', 'user2'] });
		const expired = makeLeftover({ name: 'Old Soup', expiryEstimate: '2026-04-01', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expired] }),
			'waste-log.yaml': stringify({ entries: [] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		// Should send to both household members
		const sendCalls = [
			...vi.mocked(services.telegram.send).mock.calls,
			...vi.mocked(services.telegram.sendWithButtons).mock.calls,
		];
		const userIds = sendCalls.map((c) => c[0]);
		expect(userIds).toContain('user1');
		expect(userIds).toContain('user2');

		// Message should mention the expired item
		const messages = sendCalls.map((c) => String(c[1]));
		expect(messages.some((m) => m.includes('Old Soup'))).toBe(true);
	});

	it('sends alert with buttons for items expiring today', async () => {
		const household = makeHousehold({ members: ['user1'] });
		// Expires today
		const expiringToday = makeLeftover({ name: 'Chicken', expiryEstimate: '2026-04-02', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expiringToday] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Chicken'),
			expect.any(Array),
		);
	});

	it('includes freeze/eat/toss buttons for items expiring today', async () => {
		const household = makeHousehold({ members: ['user1'] });
		const expiringToday = makeLeftover({ name: 'Chicken', expiryEstimate: '2026-04-02', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expiringToday] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		const callArgs = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
		const buttons = callArgs[2].flat();
		const callbackDatas = buttons.map((b) => b.callbackData);
		expect(callbackDatas.some((d) => d.includes('freeze'))).toBe(true);
		expect(callbackDatas.some((d) => d.includes('toss'))).toBe(true);
	});

	it('sends alert with buttons for items expiring tomorrow', async () => {
		const household = makeHousehold({ members: ['user1'] });
		// Expires tomorrow
		const expiringTomorrow = makeLeftover({ name: 'Rice', expiryEstimate: '2026-04-03', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expiringTomorrow] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Rice'),
			expect.any(Array),
		);

		const callArgs = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
		const buttons = callArgs[2].flat();
		const callbackDatas = buttons.map((b) => b.callbackData);
		expect(callbackDatas.some((d) => d.includes('freeze'))).toBe(true);
		// Toss is for today items; tomorrow items have freeze/keep
		expect(callbackDatas.some((d) => d.includes('keep'))).toBe(true);
	});

	it('handles mix of expired, expiring today, and expiring tomorrow', async () => {
		const household = makeHousehold({ members: ['user1'] });
		const expired = makeLeftover({ name: 'Old Soup', expiryEstimate: '2026-04-01', status: 'active' });
		const today = makeLeftover({ name: 'Chicken', expiryEstimate: '2026-04-02', status: 'active' });
		const tomorrow = makeLeftover({ name: 'Rice', expiryEstimate: '2026-04-03', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expired, today, tomorrow] }),
			'waste-log.yaml': stringify({ entries: [] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		// Should have sent message to user1
		const allCalls = [
			...vi.mocked(services.telegram.send).mock.calls,
			...vi.mocked(services.telegram.sendWithButtons).mock.calls,
		];
		expect(allCalls.length).toBeGreaterThan(0);

		const allMessages = allCalls.map((c) => String(c[1]));
		// Expired section
		expect(allMessages.some((m) => m.includes('Old Soup'))).toBe(true);
		// Expiring today section
		expect(allMessages.some((m) => m.includes('Chicken'))).toBe(true);
		// Expiring tomorrow section
		expect(allMessages.some((m) => m.includes('Rice'))).toBe(true);
	});

	it('sends to all household members', async () => {
		const household = makeHousehold({ members: ['user1', 'user2', 'user3'] });
		const expiringToday = makeLeftover({ name: 'Chicken', expiryEstimate: '2026-04-02', status: 'active' });
		sharedStore = mockStore({
			'household.yaml': stringify(household),
			'leftovers.yaml': stringify({ items: [expiringToday] }),
		});
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

		await handleLeftoverCheckJob(services, '2026-04-02');

		const allCalls = [
			...vi.mocked(services.telegram.send).mock.calls,
			...vi.mocked(services.telegram.sendWithButtons).mock.calls,
		];
		const userIds = allCalls.map((c) => c[0]);
		expect(userIds).toContain('user1');
		expect(userIds).toContain('user2');
		expect(userIds).toContain('user3');
	});
});
