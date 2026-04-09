import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ScopedDataStore } from '@pas/core/types';
import {
	recordAdHocLog,
	findSimilarAdHoc,
	trimExpired,
} from '../ad-hoc-history.js';

function createMockStore() {
	const storage = new Map<string, string>();
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			storage.set(path, content);
		}),
		append: vi.fn(async () => {}),
		exists: vi.fn(async (path: string) => storage.has(path)),
		list: vi.fn(async () => []),
		archive: vi.fn(async () => {}),
	} as unknown as ScopedDataStore;
}

describe('ad-hoc-history', () => {
	let store: ScopedDataStore;
	beforeEach(() => {
		store = createMockStore();
	});

	it('records and finds similar entries', async () => {
		await recordAdHocLog(store, 'burger and potato salad at bbq', '2026-04-09');
		const match = await findSimilarAdHoc(store, 'burger and potato salad');
		expect(match).toBeTruthy();
		expect(match?.occurrences).toBe(1);
	});

	it('recognizes near-duplicate text on second record', async () => {
		await recordAdHocLog(store, 'burger and potato salad at bbq', '2026-04-09');
		await recordAdHocLog(store, 'burger potato salad bbq', '2026-04-09');
		const match = await findSimilarAdHoc(store, 'burger potato salad');
		expect(match?.occurrences).toBe(2);
	});

	it('treats distinct meals as separate', async () => {
		await recordAdHocLog(store, 'burger and fries', '2026-04-09');
		const match = await findSimilarAdHoc(store, 'pasta primavera');
		expect(match).toBeNull();
	});

	it('trims entries older than 30 days', async () => {
		await recordAdHocLog(store, 'old meal', '2026-03-01');
		await recordAdHocLog(store, 'recent meal', '2026-04-09');
		await trimExpired(store, '2026-04-09');
		const old = await findSimilarAdHoc(store, 'old meal');
		const recent = await findSimilarAdHoc(store, 'recent meal');
		expect(old).toBeNull();
		expect(recent).toBeTruthy();
	});

	it('returns null when store is empty', async () => {
		const match = await findSimilarAdHoc(store, 'anything');
		expect(match).toBeNull();
	});
});
