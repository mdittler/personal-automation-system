/**
 * Household-aware VaultService tests.
 *
 * Verifies that:
 * - Personal symlinks target `households/<hh>/users/<u>/<app>` when wired
 * - Shared symlinks target `households/<hh>/shared/<app>` when wired
 * - Household-kind spaces link to `households/<hh>/spaces/<s>/<app>`
 * - Collaboration-kind spaces link to `collaborations/<s>/<app>`
 * - When wired but user has no household, personal + shared symlinks are skipped
 * - Legacy layout is unchanged when householdService is absent
 */

import { mkdir, readlink, writeFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { VaultService } from '../index.js';
import type { SpaceDefinition } from '../../../types/spaces.js';
import type { SpaceService } from '../../spaces/index.js';
import type { UserManager } from '../../user-manager/index.js';

function makeLogger() {
	const warnFn = vi.fn();
	return {
		info: vi.fn(),
		warn: warnFn,
		error: vi.fn(),
		debug: vi.fn(),
		child: () => makeLogger(),
		_warn: warnFn,
	} as unknown as import('pino').Logger & { _warn: ReturnType<typeof vi.fn> };
}

function makeSpaceService(spaces: SpaceDefinition[]): SpaceService {
	return {
		getSpacesForUser: (_userId: string) => [],
		getSpace: (id: string) => spaces.find((s) => s.id === id) ?? null,
		isMember: () => false,
		listSpaces: () => spaces,
		setVaultService: vi.fn(),
	} as unknown as SpaceService;
}

function makeUserManager(userIds: string[]): UserManager {
	return {
		getAllUsers: () => userIds.map((id) => ({ id })),
		isRegistered: (id: string) => userIds.includes(id),
	} as unknown as UserManager;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = join(tmpdir(), `vault-test-${Date.now()}`);
	await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe('VaultService — household routing', () => {
	it('wired + household: personal symlink targets household layout', async () => {
		// Create personal app dir at household layout
		const appDir = join(tmpDir, 'households', 'hh-a', 'users', 'matt', 'food');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'items.md'), 'pasta');

		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService: makeSpaceService([]),
			userManager: makeUserManager(['matt']),
			householdService: { getHouseholdForUser: (_uid) => 'hh-a' },
			logger: makeLogger(),
		});

		await vaultService.rebuildVault('matt');

		const linkPath = join(tmpDir, 'vaults', 'matt', 'food');
		const target = await readlink(linkPath);
		expect(resolve(target)).toBe(resolve(appDir));
	});

	it('wired + household: shared symlink targets household/shared layout', async () => {
		// Create shared app dir at household layout
		const sharedDir = join(tmpDir, 'households', 'hh-a', 'shared', 'food');
		await mkdir(sharedDir, { recursive: true });
		await writeFile(join(sharedDir, 'shared.md'), 'shared content');

		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService: makeSpaceService([]),
			userManager: makeUserManager(['matt']),
			householdService: { getHouseholdForUser: (_uid) => 'hh-a' },
			logger: makeLogger(),
		});

		await vaultService.rebuildVault('matt');

		const linkPath = join(tmpDir, 'vaults', 'matt', '_shared', 'food');
		const target = await readlink(linkPath);
		expect(resolve(target)).toBe(resolve(sharedDir));
	});

	it('wired + no household: skips personal + shared symlinks, logs warn', async () => {
		const logger = makeLogger();
		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService: makeSpaceService([]),
			userManager: makeUserManager(['nohh']),
			householdService: { getHouseholdForUser: (_uid) => null },
			logger,
		});

		await vaultService.rebuildVault('nohh');

		// Vault dir created but no app symlinks
		const vaultDir = join(tmpDir, 'vaults', 'nohh');
		expect(await pathExists(vaultDir)).toBe(true);
		expect(logger._warn).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'nohh' }),
			expect.stringContaining('no household'),
		);
	});

	it('no householdService: personal symlink targets legacy users/<u>/<app>', async () => {
		// Create personal app dir at legacy layout
		const appDir = join(tmpDir, 'users', 'legacy-user', 'food');
		await mkdir(appDir, { recursive: true });
		await writeFile(join(appDir, 'items.md'), 'pasta');

		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService: makeSpaceService([]),
			userManager: makeUserManager(['legacy-user']),
			logger: makeLogger(),
		});

		await vaultService.rebuildVault('legacy-user');

		const linkPath = join(tmpDir, 'vaults', 'legacy-user', 'food');
		const target = await readlink(linkPath);
		expect(resolve(target)).toBe(resolve(appDir));
	});

	it('household space: symlink targets households/<hh>/spaces/<s>/<app>', async () => {
		const spaceDataDir = join(tmpDir, 'households', 'hh-a', 'spaces', 'family', 'food');
		await mkdir(spaceDataDir, { recursive: true });
		await writeFile(join(spaceDataDir, 'list.md'), 'groceries');

		const space: SpaceDefinition = {
			id: 'family',
			name: 'Family',
			description: '',
			members: ['matt'],
			createdBy: 'matt',
			createdAt: '2026-01-01T00:00:00Z',
			kind: 'household',
			householdId: 'hh-a',
		};

		const spaceService = {
			...makeSpaceService([space]),
			getSpacesForUser: (_userId: string) => [space],
		} as unknown as SpaceService;

		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService,
			userManager: makeUserManager(['matt']),
			householdService: { getHouseholdForUser: (_uid) => 'hh-a' },
			logger: makeLogger(),
		});

		await vaultService.rebuildVault('matt');

		const linkPath = join(tmpDir, 'vaults', 'matt', '_spaces', 'family', 'food');
		const target = await readlink(linkPath);
		expect(resolve(target)).toBe(resolve(spaceDataDir));
	});

	it('collaboration space: symlink targets collaborations/<s>/<app>', async () => {
		const collabDataDir = join(tmpDir, 'collaborations', 'book-club', 'notes');
		await mkdir(collabDataDir, { recursive: true });
		await writeFile(join(collabDataDir, 'reading.md'), 'books');

		const space: SpaceDefinition = {
			id: 'book-club',
			name: 'Book Club',
			description: '',
			members: ['matt'],
			createdBy: 'matt',
			createdAt: '2026-01-01T00:00:00Z',
			kind: 'collaboration',
		};

		const spaceService = {
			...makeSpaceService([space]),
			getSpacesForUser: (_userId: string) => [space],
		} as unknown as SpaceService;

		const vaultService = new VaultService({
			dataDir: tmpDir,
			spaceService,
			userManager: makeUserManager(['matt']),
			householdService: { getHouseholdForUser: (_uid) => 'hh-a' },
			logger: makeLogger(),
		});

		await vaultService.rebuildVault('matt');

		const linkPath = join(tmpDir, 'vaults', 'matt', '_spaces', 'book-club', 'notes');
		const target = await readlink(linkPath);
		expect(resolve(target)).toBe(resolve(collabDataDir));
	});
});
