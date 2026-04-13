/**
 * Tests for UserMutationService — coordination layer that wraps UserManager
 * mutations with automatic config file sync.
 *
 * Uses real filesystem (mkdtemp) and real UserManager instances to verify
 * both in-memory state AND config file content after each operation.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { SystemConfig } from '../../../types/config.js';
import type { RegisteredUser } from '../../../types/users.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../index.js';
import { UserMutationService } from '../user-mutation-service.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockConfig(users: RegisteredUser[]): SystemConfig {
	return { users } as unknown as SystemConfig;
}

function createMockAppToggle(): AppToggleStore {
	return {
		isEnabled: vi.fn(async (_userId: string, appId: string, defaults: string[]) => {
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

const INITIAL_YAML = `users:
  - id: "111"
    name: Alice
    is_admin: true
    enabled_apps:
      - "*"
    shared_scopes:
      - grocery
      - family
  - id: "222"
    name: Bob
    is_admin: false
    enabled_apps:
      - chatbot
      - notes
    shared_scopes:
      - grocery

defaults:
  log_level: info
`;

const initialUsers: RegisteredUser[] = [
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
		enabledApps: ['chatbot', 'notes'],
		sharedScopes: ['grocery'],
	},
];

// ─── Test setup ─────────────────────────────────────────────────────────────

let tempDir: string;
let configPath: string;
let userManager: UserManager;
let service: UserMutationService;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-user-mutation-'));
	configPath = join(tempDir, 'pas.yaml');
	await writeFile(configPath, INITIAL_YAML, 'utf-8');

	userManager = new UserManager({
		config: createMockConfig(initialUsers),
		appToggle: createMockAppToggle(),
		logger: mockLogger,
	});

	service = new UserMutationService({ userManager, configPath, logger: mockLogger });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ─── Helpers for reading config ──────────────────────────────────────────────

async function readConfigUsers(): Promise<Array<Record<string, unknown>>> {
	const content = await readFile(configPath, 'utf-8');
	const parsed = parse(content) as Record<string, unknown>;
	return (parsed.users as Array<Record<string, unknown>>) ?? [];
}

async function readConfigDefaults(): Promise<Record<string, unknown>> {
	const content = await readFile(configPath, 'utf-8');
	const parsed = parse(content) as Record<string, unknown>;
	return (parsed.defaults as Record<string, unknown>) ?? {};
}

// ─── registerUser ────────────────────────────────────────────────────────────

describe('registerUser', () => {
	it('adds user to in-memory manager', async () => {
		const newUser: RegisteredUser = {
			id: '333',
			name: 'Carol',
			isAdmin: false,
			enabledApps: ['notes'],
			sharedScopes: [],
		};

		await service.registerUser(newUser);

		expect(userManager.isRegistered('333')).toBe(true);
		expect(userManager.getUser('333')).toMatchObject({ id: '333', name: 'Carol' });
	});

	it('syncs new user to config file', async () => {
		const newUser: RegisteredUser = {
			id: '333',
			name: 'Carol',
			isAdmin: false,
			enabledApps: ['notes'],
			sharedScopes: [],
		};

		await service.registerUser(newUser);

		const users = await readConfigUsers();
		expect(users).toHaveLength(3);
		expect(users.find((u) => u.id === '333')).toMatchObject({
			id: '333',
			name: 'Carol',
			is_admin: false,
			enabled_apps: ['notes'],
			shared_scopes: [],
		});
	});

	it('rolls back in-memory state if config sync fails', async () => {
		const newUser: RegisteredUser = {
			id: '333',
			name: 'Carol',
			isAdmin: false,
			enabledApps: ['notes'],
			sharedScopes: [],
		};

		// Make the config path unwritable by removing the file and replacing with a directory
		await rm(configPath, { force: true });
		const { mkdir } = await import('node:fs/promises');
		await mkdir(configPath);

		await expect(service.registerUser(newUser)).rejects.toThrow();

		// In-memory state must be rolled back
		expect(userManager.isRegistered('333')).toBe(false);
	});

	it('preserves other config sections when syncing', async () => {
		const newUser: RegisteredUser = {
			id: '444',
			name: 'Dave',
			isAdmin: false,
			enabledApps: [],
			sharedScopes: [],
		};

		await service.registerUser(newUser);

		const defaults = await readConfigDefaults();
		expect(defaults.log_level).toBe('info');
	});
});

// ─── removeUser ─────────────────────────────────────────────────────────────

describe('removeUser', () => {
	it('removes an existing user from in-memory manager', async () => {
		const result = await service.removeUser('222');

		expect(result).toEqual({});
		expect(userManager.isRegistered('222')).toBe(false);
		expect(userManager.getAllUsers()).toHaveLength(1);
	});

	it('syncs removal to config file', async () => {
		await service.removeUser('222');

		const users = await readConfigUsers();
		expect(users).toHaveLength(1);
		expect(users.find((u) => u.id === '222')).toBeUndefined();
	});

	it('returns error if user not found', async () => {
		const result = await service.removeUser('999');

		expect(result).toEqual({ error: 'User not found.' });
		// No config sync occurred — users unchanged
		const users = await readConfigUsers();
		expect(users).toHaveLength(2);
	});

	it('returns error if caller is trying to remove themselves', async () => {
		const result = await service.removeUser('222', '222');

		expect(result).toEqual({ error: 'Cannot remove your own account.' });
		expect(userManager.isRegistered('222')).toBe(true);
	});

	it('returns error if removing the last admin', async () => {
		// Alice (111) is the only admin
		const result = await service.removeUser('111');

		expect(result).toEqual({ error: 'Cannot remove the last admin user.' });
		expect(userManager.isRegistered('111')).toBe(true);
	});

	it('allows removing an admin when another admin exists', async () => {
		// Add a second admin first
		const secondAdmin: RegisteredUser = {
			id: '333',
			name: 'Carol',
			isAdmin: true,
			enabledApps: ['*'],
			sharedScopes: [],
		};
		userManager.addUser(secondAdmin);

		const result = await service.removeUser('111');

		expect(result).toEqual({});
		expect(userManager.isRegistered('111')).toBe(false);
	});

	it('allows non-admin caller to remove a different non-admin user', async () => {
		// Bob (222, non-admin) can be removed by Alice (111)
		const result = await service.removeUser('222', '111');

		expect(result).toEqual({});
		expect(userManager.isRegistered('222')).toBe(false);
	});

	it('preserves other config sections when syncing removal', async () => {
		await service.removeUser('222');

		const defaults = await readConfigDefaults();
		expect(defaults.log_level).toBe('info');
	});
});

// ─── updateUserApps ──────────────────────────────────────────────────────────

describe('updateUserApps', () => {
	it('updates in-memory user apps', async () => {
		await service.updateUserApps('222', ['food', 'chatbot']);

		expect(userManager.getUserApps('222')).toEqual(['food', 'chatbot']);
	});

	it('syncs updated apps to config file', async () => {
		await service.updateUserApps('222', ['food', 'chatbot']);

		const users = await readConfigUsers();
		const bob = users.find((u) => u.id === '222');
		expect(bob?.enabled_apps).toEqual(['food', 'chatbot']);
	});

	it('preserves other users in config file', async () => {
		await service.updateUserApps('222', ['food']);

		const users = await readConfigUsers();
		expect(users).toHaveLength(2);
		const alice = users.find((u) => u.id === '111');
		expect(alice?.enabled_apps).toEqual(['*']);
	});

	it('preserves other config sections when syncing', async () => {
		await service.updateUserApps('222', ['food']);

		const defaults = await readConfigDefaults();
		expect(defaults.log_level).toBe('info');
	});
});

// ─── updateUserSharedScopes ──────────────────────────────────────────────────

describe('updateUserSharedScopes', () => {
	it('updates in-memory user shared scopes', async () => {
		await service.updateUserSharedScopes('222', ['family', 'work']);

		expect(userManager.getSharedScopes('222')).toEqual(['family', 'work']);
	});

	it('syncs updated shared scopes to config file', async () => {
		await service.updateUserSharedScopes('222', ['family', 'work']);

		const users = await readConfigUsers();
		const bob = users.find((u) => u.id === '222');
		expect(bob?.shared_scopes).toEqual(['family', 'work']);
	});

	it('preserves other users in config file', async () => {
		await service.updateUserSharedScopes('222', ['work']);

		const users = await readConfigUsers();
		const alice = users.find((u) => u.id === '111');
		expect(alice?.shared_scopes).toEqual(['grocery', 'family']);
	});

	it('preserves other config sections when syncing', async () => {
		await service.updateUserSharedScopes('222', ['work']);

		const defaults = await readConfigDefaults();
		expect(defaults.log_level).toBe('info');
	});
});
