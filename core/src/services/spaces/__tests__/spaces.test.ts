import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceDefinition } from '../../../types/spaces.js';
import {
	MAX_MEMBERS_PER_SPACE,
	MAX_SPACES,
	MAX_SPACE_ID_LENGTH,
	MAX_SPACE_NAME_LENGTH,
} from '../../../types/spaces.js';
import type { UserManager } from '../../user-manager/index.js';
import { SpaceService } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-space-service-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

const KNOWN_USERS = ['111', '222', '333', '444'];

function makeUserManager(): UserManager {
	return {
		isRegistered: vi.fn((id: string) => KNOWN_USERS.includes(id)),
		getUser: vi.fn(),
		getAllUsers: vi.fn(),
	} as unknown as UserManager;
}

function makeService(userManager?: UserManager): SpaceService {
	return new SpaceService({
		dataDir: tempDir,
		userManager: userManager ?? makeUserManager(),
		logger,
	});
}

function makeSpace(overrides: Partial<SpaceDefinition> = {}): SpaceDefinition {
	return {
		id: 'family',
		name: 'Family Space',
		description: 'Shared family data',
		members: ['111', '222'],
		createdBy: '111',
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe('SpaceService', () => {
	// --- Standard (happy path) ---

	describe('init', () => {
		it('loads spaces and active spaces from disk', async () => {
			// First instance: create a space and set active
			const svc1 = makeService();
			await svc1.init();
			await svc1.saveSpace(makeSpace());
			await svc1.setActiveSpace('111', 'family');

			// Second instance: should load from disk
			const svc2 = makeService();
			await svc2.init();

			const spaces = svc2.listSpaces();
			expect(spaces).toHaveLength(1);
			expect(spaces[0]?.id).toBe('family');

			const active = svc2.getActiveSpace('111');
			expect(active).toBe('family');
		});

		it('handles missing files (empty state)', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.listSpaces()).toEqual([]);
			expect(svc.getActiveSpace('111')).toBeNull();
		});
	});

	describe('listSpaces', () => {
		it('returns sorted list by name', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ id: 'zulu', name: 'Zulu Space' }));
			await svc.saveSpace(makeSpace({ id: 'alpha', name: 'Alpha Space' }));
			await svc.saveSpace(makeSpace({ id: 'mike', name: 'Mike Space' }));

			const spaces = svc.listSpaces();
			expect(spaces).toHaveLength(3);
			expect(spaces[0]?.name).toBe('Alpha Space');
			expect(spaces[1]?.name).toBe('Mike Space');
			expect(spaces[2]?.name).toBe('Zulu Space');
		});
	});

	describe('getSpace', () => {
		it('returns space by ID', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());

			const space = svc.getSpace('family');
			expect(space).not.toBeNull();
			expect(space?.name).toBe('Family Space');
			expect(space?.members).toEqual(['111', '222']);
		});

		it('returns null for non-existent ID', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.getSpace('nonexistent')).toBeNull();
		});
	});

	describe('saveSpace', () => {
		it('creates a new space', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace());
			expect(errors).toEqual([]);

			const space = svc.getSpace('family');
			expect(space).not.toBeNull();
			expect(space?.name).toBe('Family Space');
		});

		it('updates an existing space', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());

			const errors = await svc.saveSpace(makeSpace({ name: 'Updated Family' }));
			expect(errors).toEqual([]);

			const space = svc.getSpace('family');
			expect(space?.name).toBe('Updated Family');
		});

		it('persists to disk', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());

			// Read the raw YAML file
			const content = await readFile(join(tempDir, 'system', 'spaces.yaml'), 'utf-8');
			expect(content).toContain('family');
			expect(content).toContain('Family Space');
		});
	});

	describe('deleteSpace', () => {
		it('removes the definition', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());

			const result = await svc.deleteSpace('family');
			expect(result).toBe(true);
			expect(svc.getSpace('family')).toBeNull();
			expect(svc.listSpaces()).toHaveLength(0);
		});

		it('returns false for non-existent space', async () => {
			const svc = makeService();
			await svc.init();

			const result = await svc.deleteSpace('nonexistent');
			expect(result).toBe(false);
		});

		it('clears active spaces for affected users', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());
			await svc.setActiveSpace('111', 'family');
			await svc.setActiveSpace('222', 'family');

			await svc.deleteSpace('family');

			// Both users should have null active space now
			expect(svc.getActiveSpace('111')).toBeNull();
			expect(svc.getActiveSpace('222')).toBeNull();
		});
	});

	describe('isMember', () => {
		it('returns true for a member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111', '222'] }));

			expect(svc.isMember('family', '111')).toBe(true);
			expect(svc.isMember('family', '222')).toBe(true);
		});

		it('returns false for a non-member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			expect(svc.isMember('family', '333')).toBe(false);
		});

		it('returns false for non-existent space', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.isMember('nonexistent', '111')).toBe(false);
		});
	});

	describe('getSpacesForUser', () => {
		it('returns all spaces where user is a member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ id: 'family', name: 'Family', members: ['111', '222'] }));
			await svc.saveSpace(makeSpace({ id: 'work', name: 'Work', members: ['111', '333'] }));
			await svc.saveSpace(makeSpace({ id: 'friends', name: 'Friends', members: ['222', '333'] }));

			const spaces = svc.getSpacesForUser('111');
			expect(spaces).toHaveLength(2);
			expect(spaces.map((s) => s.id).sort()).toEqual(['family', 'work']);
		});

		it('returns empty array for user with no spaces', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			expect(svc.getSpacesForUser('444')).toEqual([]);
		});
	});

	describe('addMember', () => {
		it('adds a member to a space', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			const errors = await svc.addMember('family', '222');
			expect(errors).toEqual([]);

			expect(svc.isMember('family', '222')).toBe(true);
			const space = svc.getSpace('family');
			expect(space?.members).toContain('222');
		});

		it('persists new member to disk', async () => {
			const svc1 = makeService();
			await svc1.init();
			await svc1.saveSpace(makeSpace({ members: ['111'] }));
			await svc1.addMember('family', '222');

			// Reload from disk
			const svc2 = makeService();
			await svc2.init();
			expect(svc2.isMember('family', '222')).toBe(true);
		});
	});

	describe('removeMember', () => {
		it('removes a member from a space', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111', '222'] }));

			const errors = await svc.removeMember('family', '222');
			expect(errors).toEqual([]);

			expect(svc.isMember('family', '222')).toBe(false);
			const space = svc.getSpace('family');
			expect(space?.members).not.toContain('222');
		});

		it('clears active space for removed member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111', '222'] }));
			await svc.setActiveSpace('222', 'family');

			await svc.removeMember('family', '222');
			expect(svc.getActiveSpace('222')).toBeNull();
		});
	});

	describe('getActiveSpace', () => {
		it('returns active space ID for user', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());
			await svc.setActiveSpace('111', 'family');

			expect(svc.getActiveSpace('111')).toBe('family');
		});

		it('returns null when user has no active space', async () => {
			const svc = makeService();
			await svc.init();

			expect(svc.getActiveSpace('111')).toBeNull();
		});
	});

	describe('setActiveSpace', () => {
		it('enters space mode', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());

			const errors = await svc.setActiveSpace('111', 'family');
			expect(errors).toEqual([]);
			expect(svc.getActiveSpace('111')).toBe('family');
		});

		it('exits space mode (null)', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());
			await svc.setActiveSpace('111', 'family');

			const errors = await svc.setActiveSpace('111', null);
			expect(errors).toEqual([]);
			expect(svc.getActiveSpace('111')).toBeNull();
		});

		it('persists active space to disk', async () => {
			const svc1 = makeService();
			await svc1.init();
			await svc1.saveSpace(makeSpace());
			await svc1.setActiveSpace('111', 'family');

			// Reload from disk
			const svc2 = makeService();
			await svc2.init();
			expect(svc2.getActiveSpace('111')).toBe('family');
		});
	});

	// --- Edge cases ---

	describe('edge cases', () => {
		it('saveSpace enforces max spaces limit', async () => {
			const svc = makeService();
			await svc.init();

			// Fill up to MAX_SPACES
			for (let i = 0; i < MAX_SPACES; i++) {
				const errors = await svc.saveSpace(
					makeSpace({ id: `space-${String(i).padStart(3, '0')}`, name: `Space ${i}` }),
				);
				expect(errors).toEqual([]);
			}

			// Next one should fail
			const errors = await svc.saveSpace(makeSpace({ id: 'overflow', name: 'Overflow Space' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('id');
			expect(errors[0]?.message).toContain(String(MAX_SPACES));
		});

		it('saveSpace allows update when at limit', async () => {
			const svc = makeService();
			await svc.init();

			for (let i = 0; i < MAX_SPACES; i++) {
				await svc.saveSpace(
					makeSpace({ id: `space-${String(i).padStart(3, '0')}`, name: `Space ${i}` }),
				);
			}

			// Updating an existing space should still work
			const errors = await svc.saveSpace(makeSpace({ id: 'space-000', name: 'Updated Space 0' }));
			expect(errors).toEqual([]);
			expect(svc.getSpace('space-000')?.name).toBe('Updated Space 0');
		});

		it('addMember rejects duplicate', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			const errors = await svc.addMember('family', '111');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('userId');
			expect(errors[0]?.message).toContain('already a member');
		});

		it('addMember rejects at member limit', async () => {
			// We need a UserManager that knows many users for this test
			const manyUserIds = Array.from({ length: MAX_MEMBERS_PER_SPACE + 1 }, (_, i) =>
				String(1000 + i),
			);
			const um = {
				isRegistered: vi.fn((id: string) => manyUserIds.includes(id)),
			} as unknown as UserManager;

			const svc = makeService(um);
			await svc.init();

			// Create space with MAX_MEMBERS_PER_SPACE members
			const maxMembers = manyUserIds.slice(0, MAX_MEMBERS_PER_SPACE);
			await svc.saveSpace(makeSpace({ members: maxMembers, createdBy: maxMembers[0]! }));

			// Try to add one more
			const extraUser = manyUserIds[MAX_MEMBERS_PER_SPACE]!;
			const errors = await svc.addMember('family', extraUser);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('members');
			expect(errors[0]?.message).toContain(String(MAX_MEMBERS_PER_SPACE));
		});

		it('addMember returns error for non-existent space', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.addMember('nonexistent', '111');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain('not found');
		});

		it('removeMember returns error for non-member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			const errors = await svc.removeMember('family', '333');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('userId');
			expect(errors[0]?.message).toContain('not a member');
		});

		it('removeMember returns error for non-existent space', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.removeMember('nonexistent', '111');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain('not found');
		});

		it('getActiveSpace clears stale active space (deleted space)', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());
			await svc.setActiveSpace('111', 'family');

			// Delete the space
			await svc.deleteSpace('family');

			// getActiveSpace should return null (cleared by deleteSpace)
			expect(svc.getActiveSpace('111')).toBeNull();
		});

		it('getActiveSpace clears stale active space (removed from membership)', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111', '222'] }));
			await svc.setActiveSpace('222', 'family');

			// Remove non-creator member from membership
			await svc.removeMember('family', '222');

			// getActiveSpace should return null (cleared by removeMember)
			expect(svc.getActiveSpace('222')).toBeNull();
		});

		it('getActiveSpace detects stale reference on reload', async () => {
			const svc1 = makeService();
			await svc1.init();
			await svc1.saveSpace(makeSpace({ members: ['111', '222'] }));
			await svc1.setActiveSpace('222', 'family');

			// Remove non-creator member from membership
			await svc1.removeMember('family', '222');
			// removeMember already cleared active space, but let's test the
			// isMember guard in getActiveSpace by creating a fresh service
			// that has an active-space entry but no membership
			const svc2 = makeService();
			await svc2.init();
			// svc2 should see that 222 is not a member and clear the stale active
			expect(svc2.getActiveSpace('222')).toBeNull();
		});
	});

	// --- Validation ---

	describe('validation', () => {
		it('rejects invalid ID (pattern)', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ id: 'INVALID' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'id')).toBe(true);
		});

		it('rejects ID starting with number', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ id: '123abc' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'id')).toBe(true);
		});

		it('rejects ID with spaces', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ id: 'my space' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'id')).toBe(true);
		});

		it('rejects ID too long', async () => {
			const svc = makeService();
			await svc.init();

			const longId = `a${'b'.repeat(MAX_SPACE_ID_LENGTH)}`;
			const errors = await svc.saveSpace(makeSpace({ id: longId }));
			expect(errors.length).toBeGreaterThan(0);
			expect(
				errors.some((e) => e.field === 'id' && e.message.includes(String(MAX_SPACE_ID_LENGTH))),
			).toBe(true);
		});

		it('rejects empty name', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ name: '' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'name')).toBe(true);
		});

		it('rejects whitespace-only name', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ name: '   ' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'name')).toBe(true);
		});

		it('rejects name too long', async () => {
			const svc = makeService();
			await svc.init();

			const longName = 'A'.repeat(MAX_SPACE_NAME_LENGTH + 1);
			const errors = await svc.saveSpace(makeSpace({ name: longName }));
			expect(errors.length).toBeGreaterThan(0);
			expect(
				errors.some((e) => e.field === 'name' && e.message.includes(String(MAX_SPACE_NAME_LENGTH))),
			).toBe(true);
		});

		it('rejects unregistered members', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ members: ['111', 'unknown-user'] }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'members' && e.message.includes('unknown-user'))).toBe(
				true,
			);
		});

		it('rejects missing creator', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ createdBy: '' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'createdBy')).toBe(true);
		});

		it('rejects empty ID', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ id: '' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'id')).toBe(true);
		});

		it('rejects members exceeding max limit on create', async () => {
			// Create a user manager that knows many users
			const manyUserIds = Array.from({ length: MAX_MEMBERS_PER_SPACE + 5 }, (_, i) =>
				String(2000 + i),
			);
			const um = {
				isRegistered: vi.fn((id: string) => manyUserIds.includes(id)),
			} as unknown as UserManager;

			const svc = makeService(um);
			await svc.init();

			const errors = await svc.saveSpace(
				makeSpace({
					members: manyUserIds.slice(0, MAX_MEMBERS_PER_SPACE + 1),
					createdBy: manyUserIds[0]!,
				}),
			);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'members')).toBe(true);
		});
	});

	// --- Concurrency ---

	describe('concurrency', () => {
		it('concurrent saveSpace operations serialize correctly', async () => {
			const svc = makeService();
			await svc.init();

			// Fire two saves concurrently — both should succeed without corruption
			const [errors1, errors2] = await Promise.all([
				svc.saveSpace(makeSpace({ id: 'alpha', name: 'Alpha Space' })),
				svc.saveSpace(makeSpace({ id: 'beta', name: 'Beta Space' })),
			]);

			expect(errors1).toEqual([]);
			expect(errors2).toEqual([]);

			// Both spaces should exist
			const spaces = svc.listSpaces();
			expect(spaces).toHaveLength(2);
			expect(spaces.map((s) => s.id).sort()).toEqual(['alpha', 'beta']);
		});

		it('concurrent saveSpace and deleteSpace serialize correctly', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ id: 'doomed', name: 'Doomed' }));

			// Fire save and delete concurrently
			const [saveErrors, deleted] = await Promise.all([
				svc.saveSpace(makeSpace({ id: 'survivor', name: 'Survivor' })),
				svc.deleteSpace('doomed'),
			]);

			expect(saveErrors).toEqual([]);
			expect(deleted).toBe(true);

			// survivor should exist, doomed should not
			expect(svc.getSpace('survivor')).not.toBeNull();
			expect(svc.getSpace('doomed')).toBeNull();
		});

		it('concurrent addMember operations serialize correctly', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			// Add two different members concurrently
			const [errors1, errors2] = await Promise.all([
				svc.addMember('family', '222'),
				svc.addMember('family', '333'),
			]);

			expect(errors1).toEqual([]);
			expect(errors2).toEqual([]);

			const space = svc.getSpace('family');
			expect(space?.members).toContain('222');
			expect(space?.members).toContain('333');
		});
	});

	// --- Security ---

	describe('security', () => {
		it('setActiveSpace rejects non-member', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			const errors = await svc.setActiveSpace('222', 'family');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain('not a member');
		});

		it('setActiveSpace rejects non-existent space', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.setActiveSpace('111', 'nonexistent');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain('not found');
		});

		it('addMember rejects unregistered user', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111'] }));

			const errors = await svc.addMember('family', 'unregistered-id');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('userId');
			expect(errors[0]?.message).toContain('not registered');
		});

		it('setActiveSpace allows exit (null) even without prior space', async () => {
			const svc = makeService();
			await svc.init();

			// Should not error when setting null with no active space
			const errors = await svc.setActiveSpace('111', null);
			expect(errors).toEqual([]);
		});

		it('removeMember rejects removing the creator', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace({ members: ['111', '222'], createdBy: '111' }));

			const errors = await svc.removeMember('family', '111');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.field).toBe('userId');
			expect(errors[0]?.message).toContain('Cannot remove the space creator');

			// Creator should still be a member
			expect(svc.isMember('family', '111')).toBe(true);
		});

		it('saveSpace rejects unregistered creator', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(
				makeSpace({ members: ['111'], createdBy: 'unknown-creator' }),
			);
			expect(errors.length).toBeGreaterThan(0);
			expect(
				errors.some((e) => e.field === 'createdBy' && e.message.includes('not a registered user')),
			).toBe(true);
		});

		it('saveSpace rejects creator not in members array', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ members: ['222'], createdBy: '111' }));
			expect(errors.length).toBeGreaterThan(0);
			expect(
				errors.some((e) => e.field === 'createdBy' && e.message.includes('must be a member')),
			).toBe(true);
		});

		it('saveSpace rejects duplicate members', async () => {
			const svc = makeService();
			await svc.init();

			const errors = await svc.saveSpace(makeSpace({ members: ['111', '111', '222'] }));
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e) => e.field === 'members' && e.message.includes('Duplicate'))).toBe(
				true,
			);
		});
	});

	// --- Error handling ---

	describe('error handling', () => {
		it('init recovers from corrupt YAML (empty state)', async () => {
			// Write corrupt YAML
			const { writeFile, mkdir } = await import('node:fs/promises');
			await mkdir(join(tempDir, 'system'), { recursive: true });
			await writeFile(join(tempDir, 'system', 'spaces.yaml'), '{{invalid yaml');

			const svc = makeService();
			// init should not throw — returns empty state
			await svc.init();
			expect(svc.listSpaces()).toEqual([]);
		});
	});

	// --- State transitions ---

	describe('state transitions', () => {
		it('setActiveSpace on deleted space returns error', async () => {
			const svc = makeService();
			await svc.init();
			await svc.saveSpace(makeSpace());
			await svc.deleteSpace('family');

			const errors = await svc.setActiveSpace('111', 'family');
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]?.message).toContain('not found');
		});
	});
});
