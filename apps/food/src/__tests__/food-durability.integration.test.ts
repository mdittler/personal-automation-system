import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { handleMessage, init } from '../index.js';
import type { Household } from '../types.js';

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh-durability',
		name: 'Durability Test Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'DURABL',
		createdAt: '2026-04-01T00:00:00.000Z',
		...overrides,
	};
}

describe('food durability integration', () => {
	let services: CoreServices;
	let storage: Map<string, string>;
	let sharedStore: {
		read: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		append: ReturnType<typeof vi.fn>;
		list: ReturnType<typeof vi.fn>;
		exists: ReturnType<typeof vi.fn>;
		archive: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		storage = new Map<string, string>([
			['household.yaml', stringify(makeHousehold())],
			['pantry.yaml', stringify({
				items: [
					{ name: 'milk', quantity: '1 gallon', addedDate: '2026-04-20', expiryEstimate: '2026-04-26' },
				],
			})],
			['waste-log.yaml', stringify({ entries: [] })],
		]);
		sharedStore = {
			read: vi.fn(async (path: string) => storage.get(path) ?? null),
			write: vi.fn(async (path: string, content: string) => {
				if (path === 'pantry.yaml') {
					throw new Error('pantry save failed');
				}
				storage.set(path, content);
			}),
			append: vi.fn(),
			list: vi.fn(async () => []),
			exists: vi.fn(),
			archive: vi.fn(),
		};
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.data.forUser).mockReturnValue(sharedStore as any);
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'shadow_sample_rate') return 0 as never;
			return undefined as never;
		});
		await init(services);
	});

	it('keeps the waste-log entry but withholds success UI when pantry cleanup fails', async () => {
		await expect(
			handleMessage(createTestMessageContext({ userId: 'user1', text: 'the milk went bad' })),
		).rejects.toThrow('pantry save failed');

		const pantry = parse(stripFrontmatter(storage.get('pantry.yaml') ?? ''));
		expect(pantry.items).toHaveLength(1);
		expect(pantry.items[0].name).toBe('milk');

		const wasteLog = parse(stripFrontmatter(storage.get('waste-log.yaml') ?? ''));
		expect(wasteLog.entries).toHaveLength(1);
		expect(wasteLog.entries[0].name).toBe('milk');

		expect(services.telegram.send).not.toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('🗑 Logged waste'),
		);
	});
});
