/**
 * migration.test.ts
 *
 * Integration tests for runHouseholdMigration using real temp directories.
 *
 * Each test creates a fixture data tree, calls the migration, then asserts the
 * post-migration layout.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { HouseholdMigrationError, runHouseholdMigration } from '../migration.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal env vars required by loadSystemConfig. */
const REQUIRED_ENV: Record<string, string> = {
	TELEGRAM_BOT_TOKEN: 'test-bot-token',
	ANTHROPIC_API_KEY: 'test-api-key',
	GUI_AUTH_TOKEN: 'test-gui-token',
};

let savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>): void {
	for (const [k, v] of Object.entries(vars)) {
		savedEnv[k] = process.env[k];
		process.env[k] = v;
	}
}

function restoreEnv(): void {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
	savedEnv = {};
}

/** Write a minimal pas.yaml with optional users. */
function makePasYaml(opts: {
	users?: Array<{ id: string; name: string; is_admin?: boolean; enabled_apps?: string[] }>;
}): string {
	return stringify({
		users: opts.users ?? [
			{
				id: 'u1',
				name: 'Admin User',
				is_admin: true,
				enabled_apps: ['*'],
				shared_scopes: [],
			},
		],
	});
}

/** Check if a path exists. */
async function pathExists(p: string): Promise<boolean> {
	return stat(p)
		.then(() => true)
		.catch(() => false);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempRoot: string; // e.g. /tmp/pas-migration-test-XXXXX
let dataDir: string; // tempRoot/data
let configPath: string; // tempRoot/pas.yaml
let systemDir: string; // tempRoot/data/system

beforeEach(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), 'pas-migration-test-'));
	dataDir = join(tempRoot, 'data');
	configPath = join(tempRoot, 'pas.yaml');
	systemDir = join(dataDir, 'system');
	await mkdir(systemDir, { recursive: true });
	setEnv(REQUIRED_ENV);
});

afterEach(async () => {
	restoreEnv();
	await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Happy path — existing install
// ---------------------------------------------------------------------------

describe('runHouseholdMigration — happy path (existing install)', () => {
	it('migrates user, shared, and space directories; rewrites YAML; writes marker', async () => {
		// Build fixture files
		// data/users/u1/food/grocery.md
		await mkdir(join(dataDir, 'users', 'u1', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'users', 'u1', 'food', 'grocery.md'), '# Grocery', 'utf-8');

		// data/users/shared/food/prices.md
		await mkdir(join(dataDir, 'users', 'shared', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'users', 'shared', 'food', 'prices.md'), '# Prices', 'utf-8');

		// data/spaces/s1/food/recipes.md
		await mkdir(join(dataDir, 'spaces', 's1', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'spaces', 's1', 'food', 'recipes.md'), '# Recipes', 'utf-8');

		// data/system/spaces.yaml with one space entry
		const spacesYaml = stringify({
			s1: {
				id: 's1',
				name: 'Family',
				description: '',
				members: ['u1'],
				createdBy: 'u1',
				createdAt: '2026-01-01T00:00:00.000Z',
			},
		});
		await writeFile(join(systemDir, 'spaces.yaml'), spacesYaml, 'utf-8');

		// pas.yaml with one admin user (no householdId)
		await writeFile(configPath, makePasYaml({
			users: [{ id: 'u1', name: 'Admin User', is_admin: true, enabled_apps: ['*'] }],
		}), 'utf-8');

		await runHouseholdMigration({ dataDir, configPath });

		// --- Post-migration assertions ---

		// User directory moved
		const groceryPath = join(dataDir, 'households', 'default', 'users', 'u1', 'food', 'grocery.md');
		expect(await pathExists(groceryPath)).toBe(true);
		expect(await readFile(groceryPath, 'utf-8')).toBe('# Grocery');

		// Shared directory moved
		const pricesPath = join(dataDir, 'households', 'default', 'shared', 'food', 'prices.md');
		expect(await pathExists(pricesPath)).toBe(true);
		expect(await readFile(pricesPath, 'utf-8')).toBe('# Prices');

		// Space directory moved
		const recipesPath = join(dataDir, 'households', 'default', 'spaces', 's1', 'food', 'recipes.md');
		expect(await pathExists(recipesPath)).toBe(true);
		expect(await readFile(recipesPath, 'utf-8')).toBe('# Recipes');

		// Old directories removed
		expect(await pathExists(join(dataDir, 'users'))).toBe(false);
		expect(await pathExists(join(dataDir, 'spaces'))).toBe(false);

		// households.yaml written
		const householdsRaw = await readFile(join(systemDir, 'households.yaml'), 'utf-8');
		const households = parse(householdsRaw) as Record<string, unknown>;
		const defaultHh = households['default'] as Record<string, unknown>;
		expect(defaultHh).toBeDefined();
		expect(defaultHh['id']).toBe('default');
		expect(defaultHh['name']).toBe('Default Household');
		expect(Array.isArray(defaultHh['adminUserIds'])).toBe(true);
		expect((defaultHh['adminUserIds'] as string[])).toContain('u1');

		// spaces.yaml updated with kind and householdId
		const spacesRaw = await readFile(join(systemDir, 'spaces.yaml'), 'utf-8');
		const spaces = parse(spacesRaw) as Record<string, Record<string, unknown>>;
		expect(spaces['s1']?.['kind']).toBe('household');
		expect(spaces['s1']?.['householdId']).toBe('default');

		// pas.yaml updated with householdId
		const pasRaw = await readFile(configPath, 'utf-8');
		const pas = parse(pasRaw) as { users: Array<Record<string, unknown>> };
		expect(pas.users[0]?.['household_id']).toBe('default');

		// Marker written with correct shape
		expect(await pathExists(join(systemDir, '.household-migration-v1'))).toBe(true);
		const markerRaw = await readFile(join(systemDir, '.household-migration-v1'), 'utf-8');
		const marker = JSON.parse(markerRaw) as Record<string, unknown>;
		expect(marker['version']).toBe(1);
		expect(typeof marker['timestamp']).toBe('string');

		// Backup created as a sibling of dataDir
		const siblings = await readdir(tempRoot);
		const backupDirs = siblings.filter((n: string) =>
			n.startsWith('data-backup-pre-household-migration-'),
		);
		expect(backupDirs.length).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Test 2: Idempotency
// ---------------------------------------------------------------------------

describe('runHouseholdMigration — idempotency', () => {
	it('second call skips without error and leaves data in place', async () => {
		// Same fixture as Test 1 (single user, no spaces)
		await mkdir(join(dataDir, 'users', 'u1', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'users', 'u1', 'food', 'grocery.md'), '# Grocery', 'utf-8');
		await writeFile(join(systemDir, 'spaces.yaml'), stringify({}), 'utf-8');
		await writeFile(configPath, makePasYaml({}), 'utf-8');

		// First run
		await runHouseholdMigration({ dataDir, configPath });

		// Second run — must not throw
		await expect(runHouseholdMigration({ dataDir, configPath })).resolves.toBeUndefined();

		// Data should still be in new location
		expect(
			await pathExists(join(dataDir, 'households', 'default', 'users', 'u1', 'food', 'grocery.md')),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Test 3: Fresh install
// ---------------------------------------------------------------------------

describe('runHouseholdMigration — fresh install', () => {
	it('writes marker, skips backup and household dir creation', async () => {
		// No data/users/ or data/spaces/ — fresh install
		await writeFile(configPath, stringify({ users: [] }), 'utf-8');

		await runHouseholdMigration({ dataDir, configPath });

		// Marker written with fresh-install note
		expect(await pathExists(join(systemDir, '.household-migration-v1'))).toBe(true);
		const markerRaw = await readFile(join(systemDir, '.household-migration-v1'), 'utf-8');
		const marker = JSON.parse(markerRaw) as Record<string, unknown>;
		expect(marker['note']).toMatch(/fresh install/i);

		// No backup created (no siblings matching backup prefix)
		const siblings = await readdir(tempRoot);
		const backupDirs = siblings.filter((n: string) =>
			n.startsWith('data-backup-pre-household-migration-'),
		);
		expect(backupDirs).toHaveLength(0);

		// No household dirs created
		expect(await pathExists(join(dataDir, 'households'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test 4: Backup failure
// ---------------------------------------------------------------------------

describe('runHouseholdMigration — backup failure', () => {
	it('throws HouseholdMigrationError with code backup_failed; data tree untouched', async () => {
		// Fixture with a user dir
		await mkdir(join(dataDir, 'users', 'u1', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'users', 'u1', 'food', 'grocery.md'), '# Grocery', 'utf-8');
		await writeFile(configPath, makePasYaml({}), 'utf-8');

		// Injectable _createBackup that always throws
		const backupError = Object.assign(new Error('Simulated backup failure'), {
			name: 'MigrationBackupError',
		});
		const _createBackup = async () => {
			throw backupError;
		};

		const err = await runHouseholdMigration({ dataDir, configPath, _createBackup }).catch(
			(e: unknown) => e,
		);

		// Must throw HouseholdMigrationError with code 'backup_failed'
		expect(err).toBeInstanceOf(HouseholdMigrationError);
		expect((err as HouseholdMigrationError).code).toBe('backup_failed');

		// data/users/ must still exist (data tree untouched)
		expect(await pathExists(join(dataDir, 'users', 'u1', 'food', 'grocery.md'))).toBe(true);

		// Marker must NOT be written
		expect(await pathExists(join(systemDir, '.household-migration-v1'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Test 5: Move failure — marker not written
// ---------------------------------------------------------------------------

describe('runHouseholdMigration — move failure', () => {
	it('throws HouseholdMigrationError with code move_failed; marker not written', async () => {
		// Fixture
		await mkdir(join(dataDir, 'users', 'u1', 'food'), { recursive: true });
		await writeFile(join(dataDir, 'users', 'u1', 'food', 'grocery.md'), '# Grocery', 'utf-8');
		await writeFile(join(systemDir, 'spaces.yaml'), stringify({}), 'utf-8');
		await writeFile(configPath, makePasYaml({}), 'utf-8');

		// Injectable _createBackup that does nothing (succeeds without creating backup)
		const _createBackup = async () => {
			/* no-op — skip actual backup in this test */
		};

		// Injectable _rename that always throws with ENOENT
		const _rename = async (_src: string, _dest: string) => {
			throw Object.assign(new Error('ENOENT mock'), { code: 'ENOENT' });
		};

		const err = await runHouseholdMigration({
			dataDir,
			configPath,
			_createBackup,
			_rename,
		}).catch((e: unknown) => e);

		// Must throw HouseholdMigrationError with code 'move_failed'
		expect(err).toBeInstanceOf(HouseholdMigrationError);
		expect((err as HouseholdMigrationError).code).toBe('move_failed');

		// Marker must NOT be written
		expect(await pathExists(join(systemDir, '.household-migration-v1'))).toBe(false);
	});
});
