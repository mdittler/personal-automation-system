import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createHousehold,
	getHouseholdInfo,
	joinHousehold,
	leaveHousehold,
} from '../services/household.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('Household Service', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	describe('createHousehold', () => {
		it('creates a new household', async () => {
			const result = await createHousehold(services, 'user1', 'Test Family');
			expect(result.success).toBe(true);
			expect(result.household).toBeDefined();
			expect(result.household?.name).toBe('Test Family');
			expect(result.household?.members).toEqual(['user1']);
			expect(result.household?.createdBy).toBe('user1');
			expect(result.household?.joinCode).toHaveLength(6);
			expect(sharedStore.write).toHaveBeenCalledWith('household.yaml', expect.any(String));
		});

		it('uses default name when none provided', async () => {
			const result = await createHousehold(services, 'user1', '');
			expect(result.success).toBe(true);
			expect(result.household?.name).toBe('My Household');
		});

		it('rejects if household already exists', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Existing\ncreatedBy: user2\nmembers:\n  - user2\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const result = await createHousehold(services, 'user1', 'New');
			expect(result.success).toBe(false);
			expect(result.message).toContain('already exists');
		});

		it('rejects if user is already a member', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Existing\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const result = await createHousehold(services, 'user1', 'New');
			expect(result.success).toBe(false);
			expect(result.message).toContain('already in household');
		});
	});

	describe('joinHousehold', () => {
		const householdYaml =
			'id: abc\nname: Test Family\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABC123\ncreatedAt: "2026-01-01"';

		beforeEach(() => {
			sharedStore.read.mockResolvedValue(householdYaml);
		});

		it('joins with correct code', async () => {
			const result = await joinHousehold(services, 'user2', 'ABC123');
			expect(result.success).toBe(true);
			expect(result.message).toContain('Welcome');
			expect(sharedStore.write).toHaveBeenCalledWith(
				'household.yaml',
				expect.stringContaining('user2'),
			);
		});

		it('joins with case-insensitive code', async () => {
			const result = await joinHousehold(services, 'user2', 'abc123');
			expect(result.success).toBe(true);
		});

		it('rejects wrong code', async () => {
			const result = await joinHousehold(services, 'user2', 'WRONG1');
			expect(result.success).toBe(false);
			expect(result.message).toContain('Invalid join code');
		});

		it('rejects if already a member', async () => {
			const result = await joinHousehold(services, 'user1', 'ABC123');
			expect(result.success).toBe(false);
			expect(result.message).toContain('already a member');
		});

		it('rejects if no household exists', async () => {
			sharedStore.read.mockResolvedValue('');
			const result = await joinHousehold(services, 'user2', 'ABC123');
			expect(result.success).toBe(false);
			expect(result.message).toContain('No household exists');
		});
	});

	describe('leaveHousehold', () => {
		const householdYaml =
			'id: abc\nname: Test Family\ncreatedBy: user1\nmembers:\n  - user1\n  - user2\njoinCode: ABC123\ncreatedAt: "2026-01-01"';

		beforeEach(() => {
			sharedStore.read.mockResolvedValue(householdYaml);
		});

		it('allows non-creator to leave', async () => {
			const result = await leaveHousehold(services, 'user2');
			expect(result.success).toBe(true);
			expect(result.message).toContain("You've left");
			expect(sharedStore.write).toHaveBeenCalledWith(
				'household.yaml',
				expect.not.stringContaining('user2'),
			);
		});

		it('prevents creator from leaving', async () => {
			const result = await leaveHousehold(services, 'user1');
			expect(result.success).toBe(false);
			expect(result.message).toContain('creator');
		});

		it('rejects if not a member', async () => {
			const result = await leaveHousehold(services, 'user3');
			expect(result.success).toBe(false);
			expect(result.message).toContain('not a member');
		});

		it('rejects if no household', async () => {
			sharedStore.read.mockResolvedValue('');
			const result = await leaveHousehold(services, 'user1');
			expect(result.success).toBe(false);
			expect(result.message).toContain('No household exists');
		});
	});

	describe('getHouseholdInfo', () => {
		it('shows household info for members', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test Family\ncreatedBy: user1\nmembers:\n  - user1\n  - user2\njoinCode: ABC123\ncreatedAt: "2026-01-01"',
			);
			const result = await getHouseholdInfo(services, 'user1');
			expect(result.success).toBe(true);
			expect(result.message).toContain('Test Family');
			expect(result.message).toContain('user1 (creator)');
			expect(result.message).toContain('ABC123');
		});

		it('rejects non-members', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test Family\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABC123\ncreatedAt: "2026-01-01"',
			);
			const result = await getHouseholdInfo(services, 'user3');
			expect(result.success).toBe(false);
		});

		it('returns setup message when no household', async () => {
			const result = await getHouseholdInfo(services, 'user1');
			expect(result.success).toBe(false);
			expect(result.message).toContain('No household');
		});
	});

	describe('input validation', () => {
		it('truncates household name to 100 chars', async () => {
			const longName = 'A'.repeat(200);
			const result = await createHousehold(services, 'user1', longName);
			expect(result.success).toBe(true);
			expect(result.household?.name).toHaveLength(100);
		});

		it('rejects join with invalid code format', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABC123\ncreatedAt: "2026-01-01"',
			);
			const result = await joinHousehold(services, 'user2', 'AB');
			expect(result.success).toBe(false);
			expect(result.message).toContain('Invalid code format');
		});

		it('rejects join with code containing spaces', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABC123\ncreatedAt: "2026-01-01"',
			);
			const result = await joinHousehold(services, 'user2', 'AB C1 23');
			expect(result.success).toBe(false);
			expect(result.message).toContain('Invalid code format');
		});

		it('handles household name with YAML special chars', async () => {
			const result = await createHousehold(services, 'user1', 'Test: Family [yaml] {special}');
			expect(result.success).toBe(true);
			expect(result.household?.name).toBe('Test: Family [yaml] {special}');
			// Verify it serializes safely (write is called)
			expect(sharedStore.write).toHaveBeenCalled();
		});
	});
});
