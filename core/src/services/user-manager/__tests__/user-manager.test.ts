import { describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { RegisteredUser } from '../../../types/users.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../index.js';

function createMockConfig(users: RegisteredUser[]): SystemConfig {
	return { users } as unknown as SystemConfig;
}

function createMockAppToggle(overrides?: Record<string, Record<string, boolean>>): AppToggleStore {
	return {
		isEnabled: vi.fn(async (userId: string, appId: string, defaults: string[]) => {
			const userOverrides = overrides?.[userId];
			if (userOverrides && appId in userOverrides) {
				return userOverrides[appId] ?? false;
			}
			return defaults.includes('*') || defaults.includes(appId);
		}),
	} as unknown as AppToggleStore;
}

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

const testUsers: RegisteredUser[] = [
	{
		id: '111',
		name: 'Alice',
		isAdmin: true,
		enabledApps: ['*'],
		sharedScopes: ['grocery', 'family'],
	},
	{
		id: '222',
		name: 'Bob',
		isAdmin: false,
		enabledApps: ['fitness', 'grocery'],
		sharedScopes: ['grocery'],
	},
];

describe('UserManager', () => {
	describe('getUser', () => {
		it('returns user for known Telegram ID', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const user = mgr.getUser('111');
			expect(user).toBeDefined();
			expect(user?.name).toBe('Alice');
		});

		it('returns null for unknown Telegram ID', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getUser('999')).toBeNull();
		});
	});

	describe('isRegistered', () => {
		it('returns true for registered user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.isRegistered('111')).toBe(true);
			expect(mgr.isRegistered('222')).toBe(true);
		});

		it('returns false for unregistered user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.isRegistered('999')).toBe(false);
		});
	});

	describe('getUserApps', () => {
		it('returns enabled apps for known user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getUserApps('111')).toEqual(['*']);
			expect(mgr.getUserApps('222')).toEqual(['fitness', 'grocery']);
		});

		it('returns empty array for unknown user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getUserApps('999')).toEqual([]);
		});
	});

	describe('getSharedScopes', () => {
		it('returns shared scopes for known user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getSharedScopes('111')).toEqual(['grocery', 'family']);
		});

		it('returns empty array for unknown user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getSharedScopes('999')).toEqual([]);
		});
	});

	describe('isAppEnabled', () => {
		it('returns true for wildcard user', async () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(await mgr.isAppEnabled('111', 'anything')).toBe(true);
		});

		it('returns true for explicitly enabled app', async () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(await mgr.isAppEnabled('222', 'fitness')).toBe(true);
		});

		it('returns false for non-enabled app', async () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(await mgr.isAppEnabled('222', 'morning-briefing')).toBe(false);
		});

		it('returns false for unknown user', async () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(await mgr.isAppEnabled('999', 'fitness')).toBe(false);
		});

		it('respects toggle overrides', async () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle({ '222': { fitness: false } }),
				logger: mockLogger,
			});

			// Fitness is in enabled_apps but toggled off
			expect(await mgr.isAppEnabled('222', 'fitness')).toBe(false);
		});
	});

	describe('getAllUsers', () => {
		it('returns all registered users', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getAllUsers()).toHaveLength(2);
		});
	});

	describe('empty config', () => {
		it('works with zero users configured', () => {
			const mgr = new UserManager({
				config: createMockConfig([]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			expect(mgr.getAllUsers()).toHaveLength(0);
			expect(mgr.getUser('111')).toBeNull();
			expect(mgr.isRegistered('111')).toBe(false);
		});
	});

	describe('addUser', () => {
		it('adds a new user, verifiable via isRegistered and getUser', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const newUser: RegisteredUser = {
				id: '333',
				name: 'Carol',
				isAdmin: false,
				enabledApps: ['notes'],
				sharedScopes: [],
			};

			mgr.addUser(newUser);

			expect(mgr.isRegistered('333')).toBe(true);
			expect(mgr.getUser('333')).toEqual(newUser);
		});

		it('adds a new user, verifiable via getAllUsers', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const newUser: RegisteredUser = {
				id: '444',
				name: 'Dave',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			};

			mgr.addUser(newUser);

			const all = mgr.getAllUsers();
			expect(all).toHaveLength(3);
			expect(all.find((u) => u.id === '444')).toEqual(newUser);
		});
	});

	describe('removeUser', () => {
		it('removes an existing user and returns true', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.removeUser('222');

			expect(result).toBe(true);
			expect(mgr.isRegistered('222')).toBe(false);
			expect(mgr.getUser('222')).toBeNull();
			expect(mgr.getAllUsers()).toHaveLength(1);
		});

		it('returns false for a non-existent user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.removeUser('999');

			expect(result).toBe(false);
			expect(mgr.getAllUsers()).toHaveLength(2);
		});
	});

	describe('updateUserApps', () => {
		it('updates the enabledApps for an existing user and returns true', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.updateUserApps('222', ['notes', 'food']);

			expect(result).toBe(true);
			expect(mgr.getUserApps('222')).toEqual(['notes', 'food']);
		});

		it('returns false for a non-existent user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.updateUserApps('999', ['notes']);

			expect(result).toBe(false);
		});
	});

	describe('updateUserSharedScopes', () => {
		it('updates the sharedScopes for an existing user and returns true', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.updateUserSharedScopes('222', ['family', 'work']);

			expect(result).toBe(true);
			expect(mgr.getSharedScopes('222')).toEqual(['family', 'work']);
		});

		it('returns false for a non-existent user', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const result = mgr.updateUserSharedScopes('999', ['family']);

			expect(result).toBe(false);
		});
	});

	describe('validateConfig', () => {
		it('returns empty array for valid config', () => {
			const mgr = new UserManager({
				config: createMockConfig(testUsers),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig(['fitness', 'grocery']);
			expect(warnings).toEqual([]);
		});

		it('warns about duplicate user IDs', () => {
			const mgr = new UserManager({
				config: createMockConfig([
					...testUsers,
					{ id: '111', name: 'Duplicate', isAdmin: false, enabledApps: [], sharedScopes: [] },
				]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig([]);
			expect(warnings).toContainEqual(expect.stringContaining('Duplicate user ID'));
		});

		it('warns about non-numeric Telegram IDs', () => {
			const mgr = new UserManager({
				config: createMockConfig([
					{ id: 'abc', name: 'Bad ID', isAdmin: false, enabledApps: [], sharedScopes: [] },
				]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig([]);
			expect(warnings).toContainEqual(expect.stringContaining('non-numeric'));
		});

		it('warns about empty user names', () => {
			const mgr = new UserManager({
				config: createMockConfig([
					{ id: '333', name: '  ', isAdmin: false, enabledApps: [], sharedScopes: [] },
				]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig([]);
			expect(warnings).toContainEqual(expect.stringContaining('empty name'));
		});

		it('warns about unknown app references', () => {
			const mgr = new UserManager({
				config: createMockConfig([
					{
						id: '444',
						name: 'Test',
						isAdmin: false,
						enabledApps: ['nonexistent-app'],
						sharedScopes: [],
					},
				]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig(['fitness', 'grocery']);
			expect(warnings).toContainEqual(expect.stringContaining('unknown app'));
		});

		it('does not warn about wildcard app', () => {
			const mgr = new UserManager({
				config: createMockConfig([
					{
						id: '555',
						name: 'Admin',
						isAdmin: true,
						enabledApps: ['*'],
						sharedScopes: [],
					},
				]),
				appToggle: createMockAppToggle(),
				logger: mockLogger,
			});

			const warnings = mgr.validateConfig(['fitness']);
			expect(warnings).toEqual([]);
		});
	});
});
