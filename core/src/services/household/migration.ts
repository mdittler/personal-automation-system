/**
 * migration.ts
 *
 * Household migration runner.
 *
 * Moves existing PAS data from the old flat layout to the household-scoped layout:
 *
 *   Old:  data/users/<uid>/<app>/
 *         data/users/shared/<app>/
 *         data/spaces/<sId>/<app>/
 *         data/system/                 (unchanged)
 *
 *   New:  data/households/default/users/<uid>/<app>/
 *         data/households/default/shared/<app>/
 *         data/households/default/spaces/<sId>/<app>/
 *         data/collaborations/<sId>/<app>/  (new, unused at runtime in D5a)
 *         data/system/                       (unchanged)
 *
 * The migration is idempotent: if the marker file exists it skips silently.
 * On any unrecoverable error it throws HouseholdMigrationError; the marker
 * is NOT written, so the operator can recover from the backup and retry.
 */

import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { syncUsersToConfig } from '../config/config-writer.js';
import { loadSystemConfig } from '../config/index.js';
import { type BackupResult, createMigrationBackup } from './migration-backup.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MigrationErrorCode =
	| 'backup_failed'
	| 'move_failed'
	| 'yaml_rewrite_failed'
	| 'config_write_failed'
	| 'validation_failed';

export class HouseholdMigrationError extends Error {
	override readonly name = 'HouseholdMigrationError';
	constructor(
		public readonly code: MigrationErrorCode,
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
	}
}

export interface MigrationDeps {
	/** Absolute path to the live data directory (e.g. <root>/data). */
	dataDir: string;
	/** Absolute path to pas.yaml. */
	configPath: string;
	logger?: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
	/**
	 * Injectable for tests — replaces the real createMigrationBackup call.
	 * Signature matches createMigrationBackup (dataDir, parentDir) → Promise<BackupResult>.
	 */
	_createBackup?: (dataDir: string, parentDir: string) => Promise<BackupResult>;
	/**
	 * Injectable for tests — replaces fs.rename for individual dir moves.
	 * Signature matches fs.rename (src, dest) → Promise<void>.
	 */
	_rename?: (src: string, dest: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_FILE = '.household-migration-v1';
const DEFAULT_HOUSEHOLD_ID = 'default';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists (mkdir -p). */
async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

/**
 * Atomically write JSON to a file (temp-file + rename).
 * Creates parent directories as needed.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const dir = dirname(filePath);
	await ensureDir(dir);
	const tmp = `${filePath}.tmp-${Date.now().toString(36)}`;
	await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
	await rename(tmp, filePath);
}

/**
 * Atomically write a YAML string to a file (temp-file + rename).
 * Creates parent directories as needed.
 */
async function atomicWriteYaml(filePath: string, data: unknown): Promise<void> {
	const dir = dirname(filePath);
	await ensureDir(dir);
	const tmp = `${filePath}.tmp-${Date.now().toString(36)}`;
	await writeFile(tmp, stringify(data), 'utf-8');
	await rename(tmp, filePath);
}

/**
 * Move a directory from `src` to `dest`.
 * Tries renameFn first; falls back to fs.cp + fs.rm on EXDEV (cross-device).
 * Ensures the destination's parent directory exists before moving.
 *
 * @param renameFn - Injectable rename function (defaults to fs.rename).
 */
async function moveDir(
	src: string,
	dest: string,
	renameFn: (s: string, d: string) => Promise<void> = rename,
): Promise<void> {
	await ensureDir(dirname(dest));
	try {
		await renameFn(src, dest);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EXDEV') {
			// Cross-device move: copy then delete
			await cp(src, dest, { recursive: true });
			await rm(src, { recursive: true, force: true });
		} else {
			throw err;
		}
	}
}

/**
 * Check whether a path is a directory. Returns false if it doesn't exist.
 */
async function isDirectory(p: string): Promise<boolean> {
	return stat(p)
		.then((s) => s.isDirectory())
		.catch(() => false);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run the one-time household migration.
 *
 * Idempotent: a second call (or a call on a fresh install) returns immediately
 * after writing/finding the marker file.
 *
 * Throws HouseholdMigrationError on any unrecoverable failure. The caller
 * (bootstrap) should abort startup on this error.
 */
export async function runHouseholdMigration(deps: MigrationDeps): Promise<void> {
	const { dataDir, configPath, _createBackup, _rename } = deps;
	const log = deps.logger ?? {
		info: () => {},
		warn: () => {},
		error: () => {},
	};

	const systemDir = join(dataDir, 'system');
	const markerPath = join(systemDir, MARKER_FILE);

	// ------------------------------------------------------------------
	// Step 1: Check marker — skip if migration already done
	// ------------------------------------------------------------------
	try {
		await stat(markerPath);
		log.info('Household migration already done, skipping');
		return;
	} catch {
		// Marker doesn't exist — proceed
	}

	// ------------------------------------------------------------------
	// Step 2: Detect fresh install — no data to migrate
	// ------------------------------------------------------------------
	const usersDir = join(dataDir, 'users');
	const spacesDir = join(dataDir, 'spaces');
	const usersExist = await isDirectory(usersDir);
	const spacesExist = await isDirectory(spacesDir);

	if (!usersExist && !spacesExist) {
		log.info('Fresh install detected — no data to migrate; writing marker');
		await ensureDir(systemDir);
		await atomicWriteJson(markerPath, {
			version: 1,
			timestamp: new Date().toISOString(),
			note: 'fresh install — no data to migrate',
		});
		return;
	}

	// ------------------------------------------------------------------
	// Step 3: Pre-flight backup
	// ------------------------------------------------------------------
	log.info('Starting household migration — creating backup first');
	const parentDir = dirname(dataDir);
	try {
		if (_createBackup) {
			await _createBackup(dataDir, parentDir);
		} else {
			await createMigrationBackup(dataDir, parentDir);
		}
	} catch (err) {
		throw new HouseholdMigrationError(
			'backup_failed',
			`Pre-migration backup failed: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}
	log.info('Backup created successfully');

	// ------------------------------------------------------------------
	// Step 4: Determine admin users
	// ------------------------------------------------------------------
	let createdBy = 'unknown';
	let adminUserIds: string[] = [];
	let allUsers: Awaited<ReturnType<typeof loadSystemConfig>>['users'] = [];

	try {
		const cfg = await loadSystemConfig({ configPath, mode: 'transitional' });
		allUsers = cfg.users;
		const admins = cfg.users.filter((u) => u.isAdmin);
		adminUserIds = admins.map((u) => u.id);
		createdBy = admins[0]?.id ?? cfg.users[0]?.id ?? 'unknown';
	} catch (err) {
		// Non-fatal: we'll still migrate the data and write an empty household
		log.warn('Could not load admin users from config — proceeding with empty adminUserIds', err);
	}

	// ------------------------------------------------------------------
	// Step 5: Create data/system/households.yaml
	// ------------------------------------------------------------------
	log.info(
		`Creating default household: createdBy=${createdBy} adminUserIds=${adminUserIds.join(',')}`,
	);
	await ensureDir(systemDir);

	const householdsPath = join(systemDir, 'households.yaml');
	const householdData = {
		[DEFAULT_HOUSEHOLD_ID]: {
			id: DEFAULT_HOUSEHOLD_ID,
			name: 'Default Household',
			createdAt: new Date().toISOString(),
			createdBy,
			adminUserIds,
		},
	};
	await atomicWriteYaml(householdsPath, householdData);

	// ------------------------------------------------------------------
	// Step 6: Move directories
	// ------------------------------------------------------------------
	log.info('Moving user and space directories into household scope');

	const defaultUsersDir = join(dataDir, 'households', DEFAULT_HOUSEHOLD_ID, 'users');
	const defaultSharedDir = join(dataDir, 'households', DEFAULT_HOUSEHOLD_ID, 'shared');
	const defaultSpacesDir = join(dataDir, 'households', DEFAULT_HOUSEHOLD_ID, 'spaces');

	let movedUsersCount = 0;
	let movedSpacesCount = 0;

	try {
		// Move per-user directories
		if (usersExist) {
			const entries = await readdir(usersDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;

				if (entry.name === 'shared') {
					// Move shared dir: data/users/shared/ → data/households/default/shared/
					await moveDir(join(usersDir, 'shared'), defaultSharedDir, _rename);
					log.info('Moved users/shared → households/default/shared');
				} else {
					// Move user dir: data/users/<uid>/ → data/households/default/users/<uid>/
					await moveDir(join(usersDir, entry.name), join(defaultUsersDir, entry.name), _rename);
					log.info(`Moved user directory: ${entry.name}`);
					movedUsersCount++;
				}
			}

			// Remove now-empty data/users/ directory
			try {
				await rmdir(usersDir);
			} catch {
				// Not empty or doesn't exist — log but don't fail
				log.warn('Could not remove data/users/ — may not be empty');
			}
		}

		// Move space directories
		if (spacesExist) {
			const spaceEntries = await readdir(spacesDir, { withFileTypes: true });
			for (const entry of spaceEntries) {
				if (!entry.isDirectory()) continue;
				// Move: data/spaces/<sId>/ → data/households/default/spaces/<sId>/
				await moveDir(join(spacesDir, entry.name), join(defaultSpacesDir, entry.name), _rename);
				log.info(`Moved space directory: ${entry.name}`);
				movedSpacesCount++;
			}

			// Remove now-empty data/spaces/ directory
			try {
				await rmdir(spacesDir);
			} catch {
				// Not empty or doesn't exist — log but don't fail
				log.warn('Could not remove data/spaces/ — may not be empty');
			}
		}
	} catch (err) {
		if (err instanceof HouseholdMigrationError) throw err;
		throw new HouseholdMigrationError(
			'move_failed',
			`Failed to move data directories: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}

	log.info(`Directory moves complete: ${movedUsersCount} users, ${movedSpacesCount} spaces`);

	// ------------------------------------------------------------------
	// Step 7: Rewrite data/system/spaces.yaml
	// ------------------------------------------------------------------
	const spacesYamlPath = join(systemDir, 'spaces.yaml');
	try {
		const spacesFileContent = await readFile(spacesYamlPath, 'utf-8').catch(() => null);
		if (spacesFileContent !== null) {
			const parsed = parse(spacesFileContent) as Record<string, unknown> | null;
			if (parsed && typeof parsed === 'object') {
				const updated: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof value === 'object' && value !== null) {
						updated[key] = {
							...(value as Record<string, unknown>),
							kind: 'household',
							householdId: DEFAULT_HOUSEHOLD_ID,
						};
					} else {
						updated[key] = value;
					}
				}
				await atomicWriteYaml(spacesYamlPath, updated);
				log.info(`Rewrote spaces.yaml with household kind: ${Object.keys(updated).length} entries`);
			}
		}
		// If spaces.yaml doesn't exist, nothing to rewrite — that's fine
	} catch (err) {
		throw new HouseholdMigrationError(
			'yaml_rewrite_failed',
			`Failed to rewrite spaces.yaml: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}

	// ------------------------------------------------------------------
	// Step 8: Update pas.yaml — set householdId = 'default' for all users
	// ------------------------------------------------------------------
	try {
		const updatedUsers = allUsers.map((u) => ({ ...u, householdId: DEFAULT_HOUSEHOLD_ID }));
		await syncUsersToConfig(configPath, updatedUsers);
		log.info(`Updated pas.yaml with householdId for ${updatedUsers.length} users`);
	} catch (err) {
		throw new HouseholdMigrationError(
			'config_write_failed',
			`Failed to update pas.yaml with householdId: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}

	// ------------------------------------------------------------------
	// Step 9: Validate — load config in strict mode
	// ------------------------------------------------------------------
	try {
		await loadSystemConfig({ configPath, mode: 'strict' });
		log.info('Post-migration config validation passed');
	} catch (err) {
		throw new HouseholdMigrationError(
			'validation_failed',
			`Post-migration config validation failed: ${err instanceof Error ? err.message : String(err)}`,
			err,
		);
	}

	// ------------------------------------------------------------------
	// Step 10: Write marker
	// ------------------------------------------------------------------
	await atomicWriteJson(markerPath, {
		version: 1,
		timestamp: new Date().toISOString(),
		usersCount: movedUsersCount,
		spacesCount: movedSpacesCount,
	});

	log.info(
		`Household migration complete: users=${movedUsersCount} spaces=${movedSpacesCount} marker=${markerPath}`,
	);
}
