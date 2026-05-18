/**
 * Batch 2C: Defensive uniqueness check at registration time.
 *
 * `createInvite` is the first uniqueness frontier, but a concurrent registration
 * could in principle race past it. `UserMutationService.registerUser` therefore
 * repeats the check, holding the same DISPLAY_NAME_LOCK_KEY so the two layers
 * serialize against each other. This file exercises the defensive layer in
 * isolation — without an InviteService — to prove it rejects collisions on its
 * own merits.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { RegisteredUser } from '../../../types/users.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../index.js';
import { UserMutationService } from '../user-mutation-service.js';

function makeConfig(users: RegisteredUser[]): SystemConfig {
	return { users } as unknown as SystemConfig;
}

function makeAppToggle(): AppToggleStore {
	return {
		isEnabled: vi.fn(async (_userId: string, appId: string, defaults: string[]) => {
			return defaults.includes('*') || defaults.includes(appId);
		}),
	} as unknown as AppToggleStore;
}

const silentLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as never;

const SEED_YAML = `users:
  - id: "111"
    name: Sarah
    is_admin: true
    enabled_apps:
      - "*"
    shared_scopes: []
`;

let tempDir: string;
let configPath: string;
let userManager: UserManager;
let service: UserMutationService;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-register-uniqueness-'));
	configPath = join(tempDir, 'pas.yaml');
	await writeFile(configPath, SEED_YAML, 'utf-8');

	userManager = new UserManager({
		config: makeConfig([
			{
				id: '111',
				name: 'Sarah',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		]),
		appToggle: makeAppToggle(),
		logger: silentLogger,
	});

	service = new UserMutationService({ userManager, configPath, logger: silentLogger });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('registerUser defensive uniqueness', () => {
	it('rejects registration of a name that already exists (case-insensitive)', async () => {
		await expect(
			service.registerUser({
				id: '222',
				name: 'sarah',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			}),
		).rejects.toThrow(/already taken/i);

		// In-memory state must NOT include the rejected user.
		expect(userManager.isRegistered('222')).toBe(false);
	});

	it('rejects registration of a name with whitespace padding that normalizes to an existing user', async () => {
		await expect(
			service.registerUser({
				id: '222',
				name: ' Sarah ',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			}),
		).rejects.toThrow(/already taken/i);

		expect(userManager.isRegistered('222')).toBe(false);
	});

	it('allows a non-colliding name', async () => {
		await service.registerUser({
			id: '222',
			name: 'Carol',
			isAdmin: false,
			enabledApps: [],
			sharedScopes: [],
		});

		expect(userManager.isRegistered('222')).toBe(true);
		expect(userManager.getUser('222')?.name).toBe('Carol');
	});

	it('rejects two concurrent registrations of the same name', async () => {
		const results = await Promise.allSettled([
			service.registerUser({
				id: '222',
				name: 'Carol',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			}),
			service.registerUser({
				id: '333',
				name: 'Carol',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			}),
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already taken/i);

		// Only one of the two new users should be in the manager.
		const has222 = userManager.isRegistered('222');
		const has333 = userManager.isRegistered('333');
		expect(has222 !== has333).toBe(true);
	});

	it('idempotent re-registration of the same id with the same name is not blocked by its own name', async () => {
		// The same user retrying after a transient failure shouldn't be blocked by
		// their own previously-stored name. The implementation skips the existing
		// user when the id matches.
		await service.registerUser({
			id: '222',
			name: 'Carol',
			isAdmin: false,
			enabledApps: [],
			sharedScopes: [],
		});

		// Subsequent registration with the same id+name should not throw "already taken".
		// (The downstream addUser/sync path may complain about duplicate ids, but the
		// name-uniqueness check must not be the rejecter.)
		try {
			await service.registerUser({
				id: '222',
				name: 'Carol',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			});
		} catch (err) {
			expect((err as Error).message).not.toMatch(/already taken/i);
		}
	});

	it('allows registration when user.name is empty (other layers handle that)', async () => {
		// normalizeDisplayName('') === '' — the implementation skips the check when
		// the incoming name is empty (post-normalization), so empty-name registration
		// is not blocked by THIS layer. UserManager.validateConfig and the invite
		// layer's blank-name guard cover the actual policy.
		await expect(
			service.registerUser({
				id: '444',
				name: '',
				isAdmin: false,
				enabledApps: [],
				sharedScopes: [],
			}),
		).resolves.toBeUndefined();
	});
});
