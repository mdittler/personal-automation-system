import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	JOIN_CODE_PATTERN,
	generateJoinCode,
	loadHousehold,
	requireHousehold,
	saveHousehold,
} from '../utils/household-guard.js';

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

describe('Household Guard', () => {
	describe('loadHousehold', () => {
		it('loads valid YAML household', async () => {
			const store = createMockScopedStore();
			store.read.mockResolvedValue(
				'id: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const hh = await loadHousehold(store as any);
			expect(hh).toBeDefined();
			expect(hh?.name).toBe('Test');
			expect(hh?.members).toEqual(['user1']);
		});

		it('returns null for empty file', async () => {
			const store = createMockScopedStore();
			store.read.mockResolvedValue('');
			const hh = await loadHousehold(store as any);
			expect(hh).toBeNull();
		});

		it('returns null for malformed YAML', async () => {
			const store = createMockScopedStore();
			store.read.mockResolvedValue('{{{{invalid yaml!!! [[[');
			const hh = await loadHousehold(store as any);
			expect(hh).toBeNull();
		});

		it('handles YAML with frontmatter', async () => {
			const store = createMockScopedStore();
			store.read.mockResolvedValue(
				'---\ntitle: Test\ndate: 2026-01-01\n---\nid: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const hh = await loadHousehold(store as any);
			expect(hh).toBeDefined();
			expect(hh?.name).toBe('Test');
		});
	});

	describe('saveHousehold', () => {
		it('writes YAML with frontmatter', async () => {
			const store = createMockScopedStore();
			await saveHousehold(store as any, {
				id: 'abc',
				name: 'Test Family',
				createdBy: 'user1',
				members: ['user1'],
				joinCode: 'ABCDEF',
				createdAt: '2026-01-01T00:00:00.000Z',
			});
			expect(store.write).toHaveBeenCalledWith(
				'household.yaml',
				expect.stringContaining('---'),
			);
			const written = store.write.mock.calls[0][1] as string;
			expect(written).toContain('Test Family');
		});
	});

	describe('requireHousehold', () => {
		let services: CoreServices;
		let sharedStore: ReturnType<typeof createMockScopedStore>;

		beforeEach(() => {
			sharedStore = createMockScopedStore();
			services = createMockCoreServices();
			vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		});

		it('returns household and store for member', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const result = await requireHousehold(services, 'user1');
			expect(result).toBeDefined();
			expect(result?.household.name).toBe('Test');
			expect(result?.sharedStore).toBeDefined();
		});

		it('returns null for non-member', async () => {
			sharedStore.read.mockResolvedValue(
				'id: abc\nname: Test\ncreatedBy: user1\nmembers:\n  - user1\njoinCode: ABCDEF\ncreatedAt: "2026-01-01"',
			);
			const result = await requireHousehold(services, 'user3');
			expect(result).toBeNull();
		});

		it('returns null when no household exists', async () => {
			sharedStore.read.mockResolvedValue('');
			const result = await requireHousehold(services, 'user1');
			expect(result).toBeNull();
		});
	});

	describe('generateJoinCode', () => {
		it('generates 6-character code', () => {
			const code = generateJoinCode();
			expect(code).toHaveLength(6);
		});

		it('matches join code pattern', () => {
			const code = generateJoinCode();
			expect(JOIN_CODE_PATTERN.test(code)).toBe(true);
		});

		it('does not contain ambiguous chars (0, O, 1, I)', () => {
			// Generate many codes and verify none contain ambiguous chars
			for (let i = 0; i < 50; i++) {
				const code = generateJoinCode();
				expect(code).not.toMatch(/[01OI]/);
			}
		});
	});
});
