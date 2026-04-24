import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceDefinition } from '../../../types/spaces.js';
import type { SpaceService } from '../../spaces/index.js';
import type { UserManager } from '../../user-manager/index.js';
import { VaultService } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-vault-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeUserManager(users: Array<{ id: string; name: string }> = []): UserManager {
	return {
		isRegistered: vi.fn((id: string) => users.some((u) => u.id === id)),
		getUser: vi.fn((id: string) => users.find((u) => u.id === id) ?? null),
		getAllUsers: vi.fn(() => users),
	} as unknown as UserManager;
}

function makeSpaceService(spacesForUser: Record<string, SpaceDefinition[]> = {}): SpaceService {
	const allSpaces = Object.values(spacesForUser).flat();
	return {
		getSpacesForUser: vi.fn((userId: string) => spacesForUser[userId] ?? []),
		listSpaces: vi.fn(() => allSpaces),
		getSpace: vi.fn((id: string) => allSpaces.find((s) => s.id === id) ?? null),
	} as unknown as SpaceService;
}

function makeService(
	options: {
		users?: Array<{ id: string; name: string }>;
		spacesForUser?: Record<string, SpaceDefinition[]>;
	} = {},
): VaultService {
	return new VaultService({
		dataDir: tempDir,
		spaceService: makeSpaceService(options.spacesForUser),
		userManager: makeUserManager(options.users ?? []),
		logger,
	});
}

/** Create a directory and return its path. */
async function createDir(...parts: string[]): Promise<string> {
	const dirPath = join(tempDir, ...parts);
	await mkdir(dirPath, { recursive: true });
	return dirPath;
}

/** Check if a path is a symlink. */
async function isSymlink(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path);
		return stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/** Check if a path exists. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

describe('VaultService', () => {
	describe('rebuildVault', () => {
		it('should create symlinks for personal app directories', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('users', 'user1', 'food-tracker');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');

			const vaultDir = join(tempDir, 'vaults', 'user1');
			expect(await isSymlink(join(vaultDir, 'notes'))).toBe(true);
			expect(await isSymlink(join(vaultDir, 'food-tracker'))).toBe(true);

			// Verify symlink targets
			const notesTarget = await readlink(join(vaultDir, 'notes'));
			expect(resolve(notesTarget)).toBe(resolve(join(tempDir, 'users', 'user1', 'notes')));
		});

		it('should create symlinks for shared app directories', async () => {
			await createDir('users', 'shared', 'grocery');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');

			const sharedLink = join(tempDir, 'vaults', 'user1', '_shared', 'grocery');
			expect(await isSymlink(sharedLink)).toBe(true);
		});

		it('should create symlinks for space directories the user is a member of', async () => {
			await createDir('spaces', 'family', 'grocery');
			await createDir('spaces', 'family', 'recipes');

			const familySpace: SpaceDefinition = {
				id: 'family',
				name: 'Family',
				members: ['user1', 'user2'],
				createdBy: 'user1',
			};

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: [familySpace] },
			});

			await service.rebuildVault('user1');

			const spacesDir = join(tempDir, 'vaults', 'user1', '_spaces', 'family');
			expect(await isSymlink(join(spacesDir, 'grocery'))).toBe(true);
			expect(await isSymlink(join(spacesDir, 'recipes'))).toBe(true);
		});

		it('should not create space symlinks for spaces the user is not a member of', async () => {
			await createDir('spaces', 'work', 'tasks');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: [] },
			});

			await service.rebuildVault('user1');

			const workDir = join(tempDir, 'vaults', 'user1', '_spaces', 'work');
			expect(await pathExists(workDir)).toBe(false);
		});

		it('should remove stale symlinks on rebuild', async () => {
			// First build with app "notes"
			await createDir('users', 'user1', 'notes');
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			const vaultDir = join(tempDir, 'vaults', 'user1');
			expect(await isSymlink(join(vaultDir, 'notes'))).toBe(true);

			// Simulate app removal: delete the user's app dir
			await rm(join(tempDir, 'users', 'user1', 'notes'), { recursive: true });

			// Rebuild — stale symlink should be removed
			await service.rebuildVault('user1');
			expect(await pathExists(join(vaultDir, 'notes'))).toBe(false);
		});

		it('should remove stale space directories on rebuild', async () => {
			// Set up a space and build
			await createDir('spaces', 'family', 'grocery');
			const familySpace: SpaceDefinition = {
				id: 'family',
				name: 'Family',
				members: ['user1'],
				createdBy: 'user1',
			};

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: [familySpace] },
			});
			await service.rebuildVault('user1');

			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', 'family'))).toBe(true);

			// Simulate user removed from space (spacesForUser now empty)
			const service2 = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: [] },
			});
			await service2.rebuildVault('user1');

			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', 'family'))).toBe(false);
		});

		it('should be idempotent — second rebuild produces same result', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('users', 'shared', 'grocery');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');
			await service.rebuildVault('user1');

			const vaultDir = join(tempDir, 'vaults', 'user1');
			expect(await isSymlink(join(vaultDir, 'notes'))).toBe(true);
			expect(await isSymlink(join(vaultDir, '_shared', 'grocery'))).toBe(true);
		});

		it('should handle user with no data directories', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');

			const vaultDir = join(tempDir, 'vaults', 'user1');
			expect(await pathExists(vaultDir)).toBe(true);
		});

		it('should not remove real directories, only symlinks', async () => {
			await createDir('users', 'user1', 'notes');
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			// Manually create a real directory in the vault (not a symlink)
			const realDir = join(tempDir, 'vaults', 'user1', '.obsidian');
			await mkdir(realDir, { recursive: true });
			await writeFile(join(realDir, 'config.json'), '{}');

			// Rebuild should not remove .obsidian (it's a real dir, not a symlink)
			await service.rebuildVault('user1');
			expect(await pathExists(realDir)).toBe(true);
		});
	});

	describe('rebuildAll', () => {
		it('should rebuild vaults for all registered users', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('users', 'user2', 'food');

			const service = makeService({
				users: [
					{ id: 'user1', name: 'User 1' },
					{ id: 'user2', name: 'User 2' },
				],
			});

			await service.rebuildAll();

			expect(await isSymlink(join(tempDir, 'vaults', 'user1', 'notes'))).toBe(true);
			expect(await isSymlink(join(tempDir, 'vaults', 'user2', 'food'))).toBe(true);
		});

		it('should continue if one user vault fails', async () => {
			// user1 has data, user2 doesn't — both should get vaults
			await createDir('users', 'user1', 'notes');

			const service = makeService({
				users: [
					{ id: 'user1', name: 'User 1' },
					{ id: 'user2', name: 'User 2' },
				],
			});

			await service.rebuildAll();

			expect(await isSymlink(join(tempDir, 'vaults', 'user1', 'notes'))).toBe(true);
			expect(await pathExists(join(tempDir, 'vaults', 'user2'))).toBe(true);
		});

		it('should handle no registered users', async () => {
			const service = makeService({ users: [] });
			await service.rebuildAll(); // should not throw
		});
	});

	describe('addSpaceLink', () => {
		it('should add space symlinks to user vault', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('spaces', 'family', 'grocery');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			// First build the base vault
			await service.rebuildVault('user1');

			// Then add the space link
			await service.addSpaceLink('user1', 'family');

			const groceryLink = join(tempDir, 'vaults', 'user1', '_spaces', 'family', 'grocery');
			expect(await isSymlink(groceryLink)).toBe(true);
		});

		it('should trigger full rebuild if vault does not exist yet', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('spaces', 'family', 'grocery');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: {
					user1: [
						{
							id: 'family',
							name: 'Family',
							members: ['user1'],
							createdBy: 'user1',
						},
					],
				},
			});

			await service.addSpaceLink('user1', 'family');

			// Should have rebuilt the whole vault including personal data
			expect(await isSymlink(join(tempDir, 'vaults', 'user1', 'notes'))).toBe(true);
		});

		it('should handle space with no app directories', async () => {
			await createDir('users', 'user1', 'notes');
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			// Space directory doesn't exist yet
			await service.addSpaceLink('user1', 'empty-space');

			// Should not crash, _spaces dir should be created
			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces'))).toBe(true);
		});
	});

	describe('removeSpaceLink', () => {
		it('should remove space symlinks from user vault', async () => {
			await createDir('spaces', 'family', 'grocery');

			const familySpace: SpaceDefinition = {
				id: 'family',
				name: 'Family',
				members: ['user1'],
				createdBy: 'user1',
			};

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: [familySpace] },
			});

			await service.rebuildVault('user1');
			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', 'family'))).toBe(true);

			await service.removeSpaceLink('user1', 'family');
			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', 'family'))).toBe(false);
		});

		it('should not throw if space link does not exist', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			// Should not throw
			await service.removeSpaceLink('user1', 'nonexistent');
		});
	});

	describe('removeSpaceFromAll', () => {
		it('should remove space from all members vaults', async () => {
			await createDir('spaces', 'family', 'grocery');

			const familySpace: SpaceDefinition = {
				id: 'family',
				name: 'Family',
				members: ['user1', 'user2'],
				createdBy: 'user1',
			};

			const service = makeService({
				users: [
					{ id: 'user1', name: 'User 1' },
					{ id: 'user2', name: 'User 2' },
				],
				spacesForUser: {
					user1: [familySpace],
					user2: [familySpace],
				},
			});

			await service.rebuildVault('user1');
			await service.rebuildVault('user2');

			await service.removeSpaceFromAll('family', ['user1', 'user2']);

			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', 'family'))).toBe(false);
			expect(await pathExists(join(tempDir, 'vaults', 'user2', '_spaces', 'family'))).toBe(false);
		});
	});

	describe('symlink correctness', () => {
		it('should use absolute targets for symlinks', async () => {
			await createDir('users', 'user1', 'notes');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');

			const linkPath = join(tempDir, 'vaults', 'user1', 'notes');
			const target = await readlink(linkPath);
			// Target should be absolute
			expect(resolve(target)).toBe(target);
		});

		it('should update symlink if target changes', async () => {
			await createDir('users', 'user1', 'notes');
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			const linkPath = join(tempDir, 'vaults', 'user1', 'notes');
			const originalTarget = await readlink(linkPath);

			// Rebuild again — should keep the same target (idempotent)
			await service.rebuildVault('user1');
			const newTarget = await readlink(linkPath);
			expect(newTarget).toBe(originalTarget);
		});
	});

	describe('edge cases', () => {
		it('should handle multiple spaces per user', async () => {
			await createDir('spaces', 'family', 'grocery');
			await createDir('spaces', 'work', 'tasks');

			const spaces: SpaceDefinition[] = [
				{ id: 'family', name: 'Family', members: ['user1'], createdBy: 'user1' },
				{ id: 'work', name: 'Work', members: ['user1'], createdBy: 'user1' },
			];

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: { user1: spaces },
			});

			await service.rebuildVault('user1');

			expect(
				await isSymlink(join(tempDir, 'vaults', 'user1', '_spaces', 'family', 'grocery')),
			).toBe(true);
			expect(await isSymlink(join(tempDir, 'vaults', 'user1', '_spaces', 'work', 'tasks'))).toBe(
				true,
			);
		});

		it('should handle personal and space data together', async () => {
			await createDir('users', 'user1', 'notes');
			await createDir('users', 'shared', 'config');
			await createDir('spaces', 'family', 'grocery');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: {
					user1: [{ id: 'family', name: 'Family', members: ['user1'], createdBy: 'user1' }],
				},
			});

			await service.rebuildVault('user1');

			const vaultDir = join(tempDir, 'vaults', 'user1');
			expect(await isSymlink(join(vaultDir, 'notes'))).toBe(true);
			expect(await isSymlink(join(vaultDir, '_shared', 'config'))).toBe(true);
			expect(await isSymlink(join(vaultDir, '_spaces', 'family', 'grocery'))).toBe(true);
		});

		it('should not create _shared dir if no shared data exists', async () => {
			await createDir('users', 'user1', 'notes');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.rebuildVault('user1');

			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_shared'))).toBe(false);
		});

		it('should handle space with empty app directories (data dir exists but no subdirs)', async () => {
			// Space directory exists but has no app subdirectories (just files)
			await createDir('spaces', 'family');
			await writeFile(join(tempDir, 'spaces', 'family', 'README.md'), 'test');

			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
				spacesForUser: {
					user1: [{ id: 'family', name: 'Family', members: ['user1'], createdBy: 'user1' }],
				},
			});

			await service.rebuildVault('user1');

			// _spaces/family should exist but have no symlinks (only dirs get linked)
			const spaceFamilyDir = join(tempDir, 'vaults', 'user1', '_spaces', 'family');
			// No app subdirs, so no spaceVaultDir created
			expect(await pathExists(spaceFamilyDir)).toBe(false);
		});

		it('should remove stale shared app symlinks', async () => {
			await createDir('users', 'shared', 'grocery');
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			expect(await isSymlink(join(tempDir, 'vaults', 'user1', '_shared', 'grocery'))).toBe(true);

			// Remove the shared app dir
			await rm(join(tempDir, 'users', 'shared', 'grocery'), { recursive: true });

			await service.rebuildVault('user1');
			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_shared', 'grocery'))).toBe(false);
		});
	});

	describe('security', () => {
		it('should reject path traversal in userId for rebuildVault', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			// Should silently skip — not throw, not create directories outside vaults/
			await service.rebuildVault('../../etc');
			expect(await pathExists(join(tempDir, 'vaults', '..', '..', 'etc'))).toBe(false);
		});

		it('should reject path traversal in userId for addSpaceLink', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});

			await service.addSpaceLink('../../../evil', 'family');
			// Should not create anything outside vaults/
			expect(await pathExists(join(tempDir, 'vaults', '..', '..', '..', 'evil'))).toBe(false);
		});

		it('should reject path traversal in spaceId for addSpaceLink', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			await service.addSpaceLink('user1', '../../etc');
			// _spaces dir may be created but the traversal space should not
			expect(await pathExists(join(tempDir, 'vaults', 'user1', '_spaces', '..', '..', 'etc'))).toBe(
				false,
			);
		});

		it('should reject path traversal in spaceId for removeSpaceLink', async () => {
			const service = makeService({
				users: [{ id: 'user1', name: 'User 1' }],
			});
			await service.rebuildVault('user1');

			// This should be a no-op, not delete anything outside the vault
			await service.removeSpaceLink('user1', '../../important');
		});
	});

	describe('SpaceService integration', () => {
		it('should call vault hooks from SpaceService.addMember', async () => {
			await createDir('spaces', 'family', 'grocery');

			const userManager = makeUserManager([
				{ id: '111', name: 'User 1' },
				{ id: '222', name: 'User 2' },
			]);

			const { SpaceService } = await import('../../spaces/index.js');
			const spaceService = new SpaceService({
				dataDir: tempDir,
				userManager,
				logger,
			});
			await spaceService.init();

			// Create space with user 111
			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111'],
				createdBy: '111',
			});

			// Wire VaultService
			const vaultService = new VaultService({
				dataDir: tempDir,
				spaceService,
				userManager,
				logger,
			});
			spaceService.setVaultService(vaultService);

			// Build vault for user 222 first
			await vaultService.rebuildVault('222');

			// Add user 222 to family space — should trigger vault update
			await spaceService.addMember('family', '222');

			// User 222's vault should now have space symlinks
			const groceryLink = join(tempDir, 'vaults', '222', '_spaces', 'family', 'grocery');
			expect(await isSymlink(groceryLink)).toBe(true);
		});

		it('should call vault hooks from SpaceService.removeMember', async () => {
			await createDir('spaces', 'family', 'grocery');

			const userManager = makeUserManager([
				{ id: '111', name: 'User 1' },
				{ id: '222', name: 'User 2' },
			]);

			const { SpaceService } = await import('../../spaces/index.js');
			const spaceService = new SpaceService({
				dataDir: tempDir,
				userManager,
				logger,
			});
			await spaceService.init();

			// Create space with both users
			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111', '222'],
				createdBy: '111',
			});

			// Wire VaultService
			const vaultService = new VaultService({
				dataDir: tempDir,
				spaceService,
				userManager,
				logger,
			});
			spaceService.setVaultService(vaultService);

			// Build vault for user 222
			await vaultService.rebuildVault('222');
			expect(await isSymlink(join(tempDir, 'vaults', '222', '_spaces', 'family', 'grocery'))).toBe(
				true,
			);

			// Remove user 222 — should remove space symlinks
			await spaceService.removeMember('family', '222');
			expect(await pathExists(join(tempDir, 'vaults', '222', '_spaces', 'family'))).toBe(false);
		});

		it('should remove stale vault links when SpaceService.saveSpace drops a member', async () => {
			await createDir('spaces', 'family', 'grocery');

			const userManager = makeUserManager([
				{ id: '111', name: 'User 1' },
				{ id: '222', name: 'User 2' },
			]);

			const { SpaceService } = await import('../../spaces/index.js');
			const spaceService = new SpaceService({
				dataDir: tempDir,
				userManager,
				logger,
			});
			await spaceService.init();

			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111', '222'],
				createdBy: '111',
			});

			const vaultService = new VaultService({
				dataDir: tempDir,
				spaceService,
				userManager,
				logger,
			});
			spaceService.setVaultService(vaultService);

			await vaultService.rebuildVault('222');
			expect(await isSymlink(join(tempDir, 'vaults', '222', '_spaces', 'family', 'grocery'))).toBe(
				true,
			);

			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111'],
				createdBy: '111',
			});

			expect(await pathExists(join(tempDir, 'vaults', '222', '_spaces', 'family'))).toBe(false);
		});

		it('should call vault hooks from SpaceService.deleteSpace', async () => {
			await createDir('spaces', 'family', 'grocery');

			const userManager = makeUserManager([{ id: '111', name: 'User 1' }]);

			const { SpaceService } = await import('../../spaces/index.js');
			const spaceService = new SpaceService({
				dataDir: tempDir,
				userManager,
				logger,
			});
			await spaceService.init();

			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111'],
				createdBy: '111',
			});

			const vaultService = new VaultService({
				dataDir: tempDir,
				spaceService,
				userManager,
				logger,
			});
			spaceService.setVaultService(vaultService);

			await vaultService.rebuildVault('111');
			expect(await isSymlink(join(tempDir, 'vaults', '111', '_spaces', 'family', 'grocery'))).toBe(
				true,
			);

			// Delete space — should remove from vault
			await spaceService.deleteSpace('family');
			expect(await pathExists(join(tempDir, 'vaults', '111', '_spaces', 'family'))).toBe(false);
		});

		it('should work without vault service (backward compat)', async () => {
			const userManager = makeUserManager([
				{ id: '111', name: 'User 1' },
				{ id: '222', name: 'User 2' },
			]);

			const { SpaceService } = await import('../../spaces/index.js');
			const spaceService = new SpaceService({
				dataDir: tempDir,
				userManager,
				logger,
			});
			await spaceService.init();

			// No setVaultService call — operations should still work
			await spaceService.saveSpace({
				id: 'family',
				name: 'Family',
				members: ['111'],
				createdBy: '111',
			});
			const errors = await spaceService.addMember('family', '222');
			expect(errors).toHaveLength(0);

			const removeErrors = await spaceService.removeMember('family', '222');
			expect(removeErrors).toHaveLength(0);

			const deleted = await spaceService.deleteSpace('family');
			expect(deleted).toBe(true);
		});
	});
});
