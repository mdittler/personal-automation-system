/**
 * Vault service.
 *
 * Manages per-user Obsidian vault directories with symlinks.
 * Each user's vault at `data/vaults/<userId>/` contains:
 * - `<appId>/` → symlink to `data/users/<userId>/<appId>/`
 * - `_shared/<appId>/` → symlink to `data/users/shared/<appId>/`
 * - `_spaces/<spaceId>/<appId>/` → symlink to `data/spaces/<spaceId>/<appId>/`
 *
 * Vaults are a derived view layer — all data stays at canonical locations.
 * Symlinks provide per-user access control: users only see spaces they belong to.
 */

import { lstat, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { ensureDir } from '../../utils/file.js';
import type { SpaceService } from '../spaces/index.js';
import type { UserManager } from '../user-manager/index.js';

export interface VaultServiceOptions {
	dataDir: string;
	spaceService: SpaceService;
	userManager: UserManager;
	logger: Logger;
}

/** Symlink type: 'junction' on Windows, 'dir' on Unix. */
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Validates userId/spaceId segments to prevent path traversal. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Check if a path is a symlink. Returns false if path doesn't exist.
 */
async function isSymlink(path: string): Promise<boolean> {
	try {
		const stats = await lstat(path);
		return stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Check if a path exists (file, dir, or symlink).
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * List subdirectories in a directory. Returns empty array if dir doesn't exist.
 */
async function listSubdirs(dirPath: string): Promise<string[]> {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

/**
 * Create a symlink, removing any existing symlink at the path first.
 * Only removes existing symlinks — never removes real directories.
 */
async function createSymlink(target: string, linkPath: string, logger: Logger): Promise<void> {
	// If a symlink already exists at this path, check if it points to the right target
	if (await isSymlink(linkPath)) {
		try {
			const existingTarget = await readlink(linkPath);
			const resolvedExisting = resolve(existingTarget);
			const resolvedTarget = resolve(target);
			if (resolvedExisting === resolvedTarget) {
				return; // Already correct
			}
		} catch {
			// Can't read — remove and recreate
		}
		await rm(linkPath, { force: true });
	}

	try {
		await symlink(target, linkPath, SYMLINK_TYPE);
	} catch (err) {
		logger.warn({ err, target, linkPath }, 'Failed to create symlink');
	}
}

export class VaultService {
	private readonly dataDir: string;
	private readonly vaultsDir: string;
	private readonly spaceService: SpaceService;
	private readonly userManager: UserManager;
	private readonly logger: Logger;

	constructor(options: VaultServiceOptions) {
		this.dataDir = options.dataDir;
		this.vaultsDir = join(options.dataDir, 'vaults');
		this.spaceService = options.spaceService;
		this.userManager = options.userManager;
		this.logger = options.logger;
	}

	/**
	 * Rebuild all symlinks for a user from scratch (idempotent).
	 *
	 * 1. Personal app dirs → `<appId>/` symlinks
	 * 2. Shared dirs → `_shared/<appId>/` symlinks
	 * 3. Space dirs → `_spaces/<spaceId>/<appId>/` symlinks (only for member spaces)
	 * 4. Remove stale symlinks
	 */
	async rebuildVault(userId: string): Promise<void> {
		if (!SAFE_SEGMENT.test(userId)) {
			this.logger.warn({ userId }, 'Invalid userId — skipping vault rebuild');
			return;
		}

		const vaultDir = join(this.vaultsDir, userId);
		await ensureDir(vaultDir);

		// 1. Personal app directories
		const userDir = join(this.dataDir, 'users', userId);
		const personalApps = await listSubdirs(userDir);
		for (const appId of personalApps) {
			const target = resolve(join(userDir, appId));
			const linkPath = join(vaultDir, appId);
			await createSymlink(target, linkPath, this.logger);
		}

		// 2. Shared directories
		const sharedDir = join(this.dataDir, 'users', 'shared');
		const sharedApps = await listSubdirs(sharedDir);
		const sharedVaultDir = join(vaultDir, '_shared');
		if (sharedApps.length > 0) {
			await ensureDir(sharedVaultDir);
			for (const appId of sharedApps) {
				const target = resolve(join(sharedDir, appId));
				const linkPath = join(sharedVaultDir, appId);
				await createSymlink(target, linkPath, this.logger);
			}
		}
		// Remove stale shared symlinks (even if no shared apps remain)
		if (await pathExists(sharedVaultDir)) {
			await this.removeStaleSymlinks(sharedVaultDir, new Set(sharedApps));
		}

		// 3. Space directories (only spaces user is a member of)
		const memberSpaces = this.spaceService.getSpacesForUser(userId);
		const memberSpaceIds = new Set(memberSpaces.map((s) => s.id));

		const spacesVaultDir = join(vaultDir, '_spaces');
		if (memberSpaces.length > 0) {
			await ensureDir(spacesVaultDir);
		}

		for (const space of memberSpaces) {
			const spaceDataDir = join(this.dataDir, 'spaces', space.id);
			const spaceApps = await listSubdirs(spaceDataDir);
			const spaceVaultDir = join(spacesVaultDir, space.id);

			if (spaceApps.length > 0) {
				await ensureDir(spaceVaultDir);
				for (const appId of spaceApps) {
					const target = resolve(join(spaceDataDir, appId));
					const linkPath = join(spaceVaultDir, appId);
					await createSymlink(target, linkPath, this.logger);
				}
				// Remove stale app symlinks within this space
				await this.removeStaleSymlinks(spaceVaultDir, new Set(spaceApps));
			}
		}

		// 4. Remove stale top-level symlinks (apps uninstalled, etc.)
		// Protected names: _shared, _spaces (real dirs, not symlinks)
		const validTopLevel = new Set([...personalApps, '_shared', '_spaces']);
		await this.removeStaleSymlinks(vaultDir, validTopLevel);

		// Remove stale space directories
		if (await pathExists(spacesVaultDir)) {
			await this.removeStaleEntries(spacesVaultDir, memberSpaceIds);
		}

		this.logger.debug(
			{ userId, personalApps: personalApps.length, spaces: memberSpaces.length },
			'Vault rebuilt',
		);
	}

	/**
	 * Rebuild vaults for ALL registered users.
	 * Called on startup after registry.loadAll().
	 */
	async rebuildAll(): Promise<void> {
		const users = this.userManager.getAllUsers();
		for (const user of users) {
			try {
				await this.rebuildVault(user.id);
			} catch (err) {
				this.logger.error({ err, userId: user.id }, 'Failed to rebuild vault');
			}
		}
		this.logger.info({ userCount: users.length }, 'All vaults rebuilt');
	}

	/**
	 * Add space symlinks for a user (called on membership add).
	 */
	async addSpaceLink(userId: string, spaceId: string): Promise<void> {
		if (!SAFE_SEGMENT.test(userId) || !SAFE_SEGMENT.test(spaceId)) {
			this.logger.warn({ userId, spaceId }, 'Invalid userId/spaceId — skipping vault link');
			return;
		}

		const vaultDir = join(this.vaultsDir, userId);
		if (!(await pathExists(vaultDir))) {
			// Vault doesn't exist yet — full rebuild is cheaper
			await this.rebuildVault(userId);
			return;
		}

		const spacesVaultDir = join(vaultDir, '_spaces');
		await ensureDir(spacesVaultDir);

		const spaceDataDir = join(this.dataDir, 'spaces', spaceId);
		const spaceApps = await listSubdirs(spaceDataDir);
		const spaceVaultDir = join(spacesVaultDir, spaceId);

		if (spaceApps.length > 0) {
			await ensureDir(spaceVaultDir);
			for (const appId of spaceApps) {
				const target = resolve(join(spaceDataDir, appId));
				const linkPath = join(spaceVaultDir, appId);
				await createSymlink(target, linkPath, this.logger);
			}
		}

		this.logger.debug({ userId, spaceId }, 'Space symlinks added to vault');
	}

	/**
	 * Remove space symlinks for a user (called on membership remove).
	 */
	async removeSpaceLink(userId: string, spaceId: string): Promise<void> {
		if (!SAFE_SEGMENT.test(userId) || !SAFE_SEGMENT.test(spaceId)) {
			this.logger.warn({ userId, spaceId }, 'Invalid userId/spaceId — skipping vault unlink');
			return;
		}

		const spaceVaultDir = join(this.vaultsDir, userId, '_spaces', spaceId);
		try {
			await rm(spaceVaultDir, { recursive: true, force: true });
			this.logger.debug({ userId, spaceId }, 'Space symlinks removed from vault');
		} catch (err) {
			this.logger.warn({ err, userId, spaceId }, 'Failed to remove space symlinks');
		}
	}

	/**
	 * Remove space symlinks from ALL members' vaults (called on space delete).
	 */
	async removeSpaceFromAll(spaceId: string, memberIds: string[]): Promise<void> {
		for (const userId of memberIds) {
			await this.removeSpaceLink(userId, spaceId);
		}
	}

	// --- Private helpers ---

	/**
	 * Remove symlinks in a directory that aren't in the valid set.
	 */
	private async removeStaleSymlinks(dirPath: string, validNames: Set<string>): Promise<void> {
		try {
			const entries = await readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				const entryPath = join(dirPath, entry.name);
				if (!validNames.has(entry.name) && (await isSymlink(entryPath))) {
					await rm(entryPath, { force: true });
					this.logger.debug({ path: entryPath }, 'Removed stale symlink');
				}
			}
		} catch {
			// Directory doesn't exist
		}
	}

	/**
	 * Remove directories/symlinks in a directory that aren't in the valid set.
	 * Used for cleaning stale space directories.
	 */
	private async removeStaleEntries(dirPath: string, validNames: Set<string>): Promise<void> {
		try {
			const entries = await readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!validNames.has(entry.name)) {
					const entryPath = join(dirPath, entry.name);
					await rm(entryPath, { recursive: true, force: true });
					this.logger.debug({ path: entryPath }, 'Removed stale space vault entry');
				}
			}
		} catch {
			// Directory doesn't exist
		}
	}
}
