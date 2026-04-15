import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegisteredUser } from '../../../types/users.js';
import {
	HouseholdBoundaryError,
	HouseholdService,
	UserBoundaryError,
	slugify,
} from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-household-service-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeUser(id: string, householdId?: string): RegisteredUser {
	return {
		id,
		name: `User ${id}`,
		isAdmin: false,
		enabledApps: ['*'],
		sharedScopes: [],
		householdId,
	};
}

function makeService(users: RegisteredUser[] = []): HouseholdService {
	return new HouseholdService({ dataDir: tempDir, users, logger });
}

describe('HouseholdService', () => {
	// --- createHousehold ---

	describe('createHousehold', () => {
		it('creates a household and returns it', async () => {
			const svc = makeService();
			await svc.init();

			const hh = await svc.createHousehold('Dittler Family', 'user1');

			expect(hh.id).toBe('dittler-family');
			expect(hh.name).toBe('Dittler Family');
			expect(hh.createdBy).toBe('user1');
			expect(hh.adminUserIds).toContain('user1');
			expect(hh.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('includes additional adminUserIds (deduped, creator always included)', async () => {
			const svc = makeService();
			await svc.init();

			const hh = await svc.createHousehold('My House', 'user1', ['user2', 'user1']);

			expect(hh.adminUserIds).toContain('user1');
			expect(hh.adminUserIds).toContain('user2');
			// user1 not duplicated
			expect(hh.adminUserIds.filter((id) => id === 'user1')).toHaveLength(1);
		});

		it('persists to YAML on disk', async () => {
			const svc = makeService();
			await svc.init();

			await svc.createHousehold('Smith Family', 'user99');

			const content = await readFile(join(tempDir, 'system', 'households.yaml'), 'utf-8');
			expect(content).toContain('smith-family');
			expect(content).toContain('Smith Family');
		});

		it('generates suffix on slug collision', async () => {
			const svc = makeService();
			await svc.init();

			const hh1 = await svc.createHousehold('Test', 'user1');
			const hh2 = await svc.createHousehold('Test', 'user2');
			const hh3 = await svc.createHousehold('Test', 'user3');

			expect(hh1.id).toBe('test');
			expect(hh2.id).toBe('test-2');
			expect(hh3.id).toBe('test-3');
		});

		it('trims whitespace from name', async () => {
			const svc = makeService();
			await svc.init();

			const hh = await svc.createHousehold('  Jones Family  ', 'user1');
			expect(hh.name).toBe('Jones Family');
		});

		it('throws for empty name', async () => {
			const svc = makeService();
			await svc.init();

			await expect(svc.createHousehold('', 'user1')).rejects.toThrow('required');
		});

		it('throws for whitespace-only name', async () => {
			const svc = makeService();
			await svc.init();

			await expect(svc.createHousehold('   ', 'user1')).rejects.toThrow('required');
		});
	});

	// --- getHousehold ---

	describe('getHousehold', () => {
		it('returns household by ID', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Test Family', 'user1');

			const hh = svc.getHousehold('test-family');
			expect(hh).not.toBeNull();
			expect(hh?.name).toBe('Test Family');
		});

		it('returns null for unknown ID', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.getHousehold('does-not-exist')).toBeNull();
		});
	});

	// --- listHouseholds ---

	describe('listHouseholds', () => {
		it('returns all households sorted by name', async () => {
			const svc = makeService();
			await svc.init();

			await svc.createHousehold('Zulu Fam', 'u1');
			await svc.createHousehold('Alpha Fam', 'u2');
			await svc.createHousehold('Mike Fam', 'u3');

			const list = svc.listHouseholds();
			expect(list).toHaveLength(3);
			expect(list[0]?.name).toBe('Alpha Fam');
			expect(list[1]?.name).toBe('Mike Fam');
			expect(list[2]?.name).toBe('Zulu Fam');
		});

		it('returns empty array when no households exist', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.listHouseholds()).toEqual([]);
		});
	});

	// --- getHouseholdForUser ---

	describe('getHouseholdForUser', () => {
		it('returns householdId for a user assigned at construction', async () => {
			const users = [makeUser('u1', 'hh-alpha')];
			const svc = makeService(users);
			await svc.init();

			expect(svc.getHouseholdForUser('u1')).toBe('hh-alpha');
		});

		it('returns null for a user with no householdId', async () => {
			const users = [makeUser('u1')]; // no householdId
			const svc = makeService(users);
			await svc.init();

			expect(svc.getHouseholdForUser('u1')).toBeNull();
		});

		it('returns null for an unknown userId', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.getHouseholdForUser('unknown')).toBeNull();
		});
	});

	// --- getMembers ---

	describe('getMembers', () => {
		it('returns users belonging to a household', async () => {
			const users = [
				makeUser('u1', 'hh-a'),
				makeUser('u2', 'hh-a'),
				makeUser('u3', 'hh-b'),
			];
			const svc = makeService(users);
			await svc.init();

			const members = svc.getMembers('hh-a');
			expect(members).toHaveLength(2);
			expect(members.map((u) => u.id).sort()).toEqual(['u1', 'u2']);
		});

		it('returns empty array for household with no members in registry', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Empty', 'u99');

			expect(svc.getMembers('empty')).toEqual([]);
		});
	});

	// --- addAdmin / removeAdmin ---

	describe('addAdmin', () => {
		it('adds an admin to an existing household', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1');

			await svc.addAdmin('alpha', 'u2');

			const hh = svc.getHousehold('alpha');
			expect(hh?.adminUserIds).toContain('u2');
		});

		it('is idempotent — adding existing admin does not duplicate', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1');

			await svc.addAdmin('alpha', 'u1'); // u1 is already admin

			const hh = svc.getHousehold('alpha');
			expect(hh?.adminUserIds.filter((id) => id === 'u1')).toHaveLength(1);
		});

		it('throws for non-existent household', async () => {
			const svc = makeService();
			await svc.init();

			await expect(svc.addAdmin('no-such-hh', 'u1')).rejects.toThrow('not found');
		});

		it('persists admin change to disk', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1');
			await svc.addAdmin('alpha', 'u2');

			// Reload
			const svc2 = makeService();
			await svc2.init();
			expect(svc2.getHousehold('alpha')?.adminUserIds).toContain('u2');
		});
	});

	describe('removeAdmin', () => {
		it('removes an admin from a household', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1', ['u2']);

			await svc.removeAdmin('alpha', 'u2');

			const hh = svc.getHousehold('alpha');
			expect(hh?.adminUserIds).not.toContain('u2');
		});

		it('throws when removing the last admin', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1'); // only u1 is admin

			await expect(svc.removeAdmin('alpha', 'u1')).rejects.toThrow('last admin');
		});

		it('is idempotent — removing non-admin silently succeeds', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1', ['u2']);

			// u3 is not an admin — should not throw
			await expect(svc.removeAdmin('alpha', 'u3')).resolves.toBeUndefined();
		});

		it('throws for non-existent household', async () => {
			const svc = makeService();
			await svc.init();

			await expect(svc.removeAdmin('no-such-hh', 'u1')).rejects.toThrow('not found');
		});

		it('persists admin removal to disk', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Alpha', 'u1', ['u2']);
			await svc.removeAdmin('alpha', 'u2');

			const svc2 = makeService();
			await svc2.init();
			expect(svc2.getHousehold('alpha')?.adminUserIds).not.toContain('u2');
		});
	});

	// --- requireSameHousehold ---

	describe('requireSameHousehold', () => {
		it('does not throw when both users are in the same household', () => {
			const users = [makeUser('u1', 'hh-x'), makeUser('u2', 'hh-x')];
			const svc = makeService(users);

			expect(() => svc.requireSameHousehold('u1', 'u2')).not.toThrow();
		});

		it('throws HouseholdBoundaryError when users are in different households', () => {
			const users = [makeUser('u1', 'hh-x'), makeUser('u2', 'hh-y')];
			const svc = makeService(users);

			expect(() => svc.requireSameHousehold('u1', 'u2')).toThrow(HouseholdBoundaryError);
		});

		it('throws HouseholdBoundaryError when one user has no household', () => {
			const users = [makeUser('u1', 'hh-x'), makeUser('u2')];
			const svc = makeService(users);

			expect(() => svc.requireSameHousehold('u1', 'u2')).toThrow(HouseholdBoundaryError);
		});

		it('throws HouseholdBoundaryError when both users have no household', () => {
			const users = [makeUser('u1'), makeUser('u2')];
			const svc = makeService(users);

			expect(() => svc.requireSameHousehold('u1', 'u2')).toThrow(HouseholdBoundaryError);
		});

		it('error message includes both household IDs', () => {
			const users = [makeUser('u1', 'hh-x'), makeUser('u2', 'hh-y')];
			const svc = makeService(users);

			let caught: HouseholdBoundaryError | undefined;
			try {
				svc.requireSameHousehold('u1', 'u2');
			} catch (e) {
				caught = e as HouseholdBoundaryError;
			}

			expect(caught).toBeInstanceOf(HouseholdBoundaryError);
			expect(caught?.householdIdA).toBe('hh-x');
			expect(caught?.householdIdB).toBe('hh-y');
		});
	});

	// --- assertUserCanAccessHousehold ---

	describe('assertUserCanAccessHousehold', () => {
		it('does not throw when user belongs to the requested household', () => {
			const users = [makeUser('u1', 'hh-a')];
			const svc = makeService(users);

			expect(() => svc.assertUserCanAccessHousehold('u1', 'hh-a')).not.toThrow();
		});

		it('throws HouseholdBoundaryError when user belongs to a different household', () => {
			const users = [makeUser('u1', 'hh-a')];
			const svc = makeService(users);

			expect(() => svc.assertUserCanAccessHousehold('u1', 'hh-b')).toThrow(HouseholdBoundaryError);
		});

		it('throws HouseholdBoundaryError when user has no household', () => {
			const users = [makeUser('u1')];
			const svc = makeService(users);

			expect(() => svc.assertUserCanAccessHousehold('u1', 'hh-a')).toThrow(HouseholdBoundaryError);
		});
	});

	// --- syncUser ---

	describe('syncUser', () => {
		it('adds a new user to the userId→householdId map', () => {
			const svc = makeService();

			svc.syncUser(makeUser('u5', 'hh-z'));

			expect(svc.getHouseholdForUser('u5')).toBe('hh-z');
		});

		it('updates an existing user household assignment', () => {
			const users = [makeUser('u1', 'hh-old')];
			const svc = makeService(users);

			svc.syncUser(makeUser('u1', 'hh-new'));

			expect(svc.getHouseholdForUser('u1')).toBe('hh-new');
		});

		it('removes user from map when householdId is unset', () => {
			const users = [makeUser('u1', 'hh-x')];
			const svc = makeService(users);

			svc.syncUser(makeUser('u1')); // no householdId

			expect(svc.getHouseholdForUser('u1')).toBeNull();
		});

		it('updates getMembers result after sync', async () => {
			const svc = makeService();
			await svc.init();

			const hh = await svc.createHousehold('Beta', 'u1');

			// Sync a new user pointing to this household
			svc.syncUser(makeUser('u2', hh.id));

			const members = svc.getMembers(hh.id);
			expect(members.some((u) => u.id === 'u2')).toBe(true);
		});
	});

	// --- Persistence / reload ---

	describe('init() — load from existing YAML', () => {
		it('loads households created in a previous instance', async () => {
			const svc1 = makeService();
			await svc1.init();
			await svc1.createHousehold('Reload Test', 'u1');

			// Second instance reads from same temp dir
			const svc2 = makeService();
			await svc2.init();

			const hh = svc2.getHousehold('reload-test');
			expect(hh).not.toBeNull();
			expect(hh?.name).toBe('Reload Test');
		});

		it('handles missing households.yaml gracefully (empty state)', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.listHouseholds()).toEqual([]);
		});

		it('handles corrupt YAML gracefully — treats as empty', async () => {
			const { writeFile, mkdir } = await import('node:fs/promises');
			await mkdir(join(tempDir, 'system'), { recursive: true });
			await writeFile(join(tempDir, 'system', 'households.yaml'), '{{invalid yaml');

			const svc = makeService();
			await svc.init(); // should not throw

			expect(svc.listHouseholds()).toEqual([]);
		});

		it('excludes invalid entries (missing name) from operational map', async () => {
			const { writeFile, mkdir } = await import('node:fs/promises');
			await mkdir(join(tempDir, 'system'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'households.yaml'),
				[
					'good-hh:',
					'  id: good-hh',
					'  name: Good Household',
					'  createdAt: "2026-01-01T00:00:00.000Z"',
					'  createdBy: u1',
					'  adminUserIds: [u1]',
					'bad-hh:',
					'  id: bad-hh',
					// missing 'name'
					'  createdAt: "2026-01-01T00:00:00.000Z"',
					'  createdBy: u1',
					'  adminUserIds: [u1]',
				].join('\n'),
			);

			const svc = makeService();
			await svc.init();

			expect(svc.getHousehold('good-hh')).not.toBeNull();
			expect(svc.getHousehold('bad-hh')).toBeNull();
		});

		it('excludes entries where YAML key does not match id field', async () => {
			const { writeFile, mkdir } = await import('node:fs/promises');
			await mkdir(join(tempDir, 'system'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'households.yaml'),
				[
					'key-mismatch:',
					'  id: wrong-id',
					'  name: Some Household',
					'  createdAt: "2026-01-01T00:00:00.000Z"',
					'  createdBy: u1',
					'  adminUserIds: [u1]',
				].join('\n'),
			);

			const svc = makeService();
			await svc.init();

			expect(svc.getHousehold('key-mismatch')).toBeNull();
		});
	});

	// --- id generation (slugify) ---

	describe('slugify', () => {
		it('lowercases and replaces spaces with hyphens', () => {
			expect(slugify('Smith Family')).toBe('smith-family');
		});

		it('collapses consecutive special chars to one hyphen', () => {
			expect(slugify('A & B -- Family')).toBe('a-b-family');
		});

		it('preserves underscores', () => {
			expect(slugify('my_household')).toBe('my_household');
		});

		it('strips leading and trailing hyphens', () => {
			expect(slugify('!Family!')).toBe('family');
		});

		it('produces SAFE_SEGMENT-valid output for typical names', () => {
			const slug = slugify('The Dittler-Jones Family');
			expect(/^[a-zA-Z0-9_-]+$/.test(slug)).toBe(true);
		});
	});

	// --- Concurrency ---

	describe('concurrency', () => {
		it('concurrent createHousehold calls serialize correctly', async () => {
			const svc = makeService();
			await svc.init();

			const [hh1, hh2] = await Promise.all([
				svc.createHousehold('Alpha', 'u1'),
				svc.createHousehold('Beta', 'u2'),
			]);

			expect(hh1.id).toBeDefined();
			expect(hh2.id).toBeDefined();
			expect(hh1.id).not.toBe(hh2.id);

			const list = svc.listHouseholds();
			expect(list).toHaveLength(2);
		});

		it('concurrent addAdmin calls serialize correctly', async () => {
			const svc = makeService();
			await svc.init();
			await svc.createHousehold('Gamma', 'u1');

			await Promise.all([svc.addAdmin('gamma', 'u2'), svc.addAdmin('gamma', 'u3')]);

			const hh = svc.getHousehold('gamma');
			expect(hh?.adminUserIds).toContain('u2');
			expect(hh?.adminUserIds).toContain('u3');
		});
	});

	// --- Error class shape ---

	describe('HouseholdBoundaryError', () => {
		it('has correct name and properties', () => {
			const err = new HouseholdBoundaryError('hh-a', 'hh-b');
			expect(err.name).toBe('HouseholdBoundaryError');
			expect(err.householdIdA).toBe('hh-a');
			expect(err.householdIdB).toBe('hh-b');
			expect(err.message).toContain('hh-a');
			expect(err.message).toContain('hh-b');
		});
	});

	describe('UserBoundaryError', () => {
		it('has correct name and properties', () => {
			const err = new UserBoundaryError('actor1', 'target1');
			expect(err.name).toBe('UserBoundaryError');
			expect(err.actorId).toBe('actor1');
			expect(err.targetId).toBe('target1');
			expect(err.message).toContain('actor1');
			expect(err.message).toContain('target1');
		});
	});
});
