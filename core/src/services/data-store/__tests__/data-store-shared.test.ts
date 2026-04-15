/**
 * Tests for forShared() — household-aware shared data routing.
 *
 * Covers:
 * - R9: forShared() with bypass token and no context throws post-migration
 * - A3: forShared() prefers getCurrentHouseholdId() before getCurrentUserId()
 * - Legacy (no HouseholdService) always uses data/users/shared path — regression guard
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import type { HouseholdService } from '../../household/index.js';
import { ChangeLog } from '../change-log.js';
import { DataStoreServiceImpl } from '../index.js';
import { SYSTEM_BYPASS_TOKEN } from '../system-bypass-token.js';

let tempDir: string;
let dataDir: string;
let changeLog: ChangeLog;

const mockHouseholdService = {
	getHouseholdForUser: vi.fn(),
	listHouseholds: vi.fn(),
} as unknown as HouseholdService;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-shared-test-'));
	dataDir = join(tempDir, 'data');
	changeLog = new ChangeLog(dataDir);
	vi.clearAllMocks();
	vi.mocked(mockHouseholdService.getHouseholdForUser).mockReturnValue(null);
	vi.mocked(mockHouseholdService.listHouseholds).mockReturnValue([]);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('forShared() — household routing (A3/R9)', () => {
	it('routes to household shared dir when only householdId is in context (no userId)', async () => {
		vi.mocked(mockHouseholdService.getHouseholdForUser).mockReturnValue(null);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'food',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
			householdService: mockHouseholdService,
		});

		await requestContext.run({ householdId: 'hh-alpha' }, async () => {
			const store = service.forShared('recipes');
			await store.write('recipes.md', '# Recipes');
		});

		// File must land under data/households/hh-alpha/shared/food/
		const expectedPath = join(dataDir, 'households', 'hh-alpha', 'shared', 'food', 'recipes.md');
		const s = await stat(expectedPath);
		expect(s.isFile()).toBe(true);

		// Must NOT be written to legacy path
		const legacyPath = join(dataDir, 'users', 'shared', 'food', 'recipes.md');
		await expect(stat(legacyPath)).rejects.toThrow();
	});

	it('routes to household shared dir when userId is in context (derives householdId)', async () => {
		vi.mocked(mockHouseholdService.getHouseholdForUser).mockReturnValue('hh-beta');

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'food',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
			householdService: mockHouseholdService,
		});

		await requestContext.run({ userId: 'u1', householdId: 'hh-beta' }, async () => {
			const store = service.forShared('grocery');
			await store.write('list.md', '- Eggs');
		});

		const expectedPath = join(dataDir, 'households', 'hh-beta', 'shared', 'food', 'list.md');
		const s = await stat(expectedPath);
		expect(s.isFile()).toBe(true);
	});

	it('throws when HouseholdService is wired, bypass token is used, and no context is set (R9)', () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'food',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
			householdService: mockHouseholdService,
		});

		// No requestContext at all — neither householdId nor userId
		// The bypass token does NOT skip household routing (R9 fix).
		expect(() => service.forShared('recipes')).toThrow('cannot resolve a household');
	});

	it('throws when HouseholdService is wired, no bypass token, and no context is set', () => {
		// This was already tested by I-2, preserved as regression guard
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'food',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			householdService: mockHouseholdService,
			// no bypass token
		});

		expect(() => service.forShared('recipes')).toThrow();
	});

	it('legacy mode (no HouseholdService) permits no-context call — regression guard', async () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'food',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
			// no householdService → transitional / legacy mode
		});

		// Must not throw even with no context; write should succeed
		const store = service.forShared('recipes');
		await store.write('test.md', 'ok');

		// File lands under legacy path
		const legacyPath = join(dataDir, 'users', 'shared', 'food', 'test.md');
		const s = await stat(legacyPath);
		expect(s.isFile()).toBe(true);
	});
});
