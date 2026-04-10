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

	// ── Hardening regression tests (H11.w thorough review) ──

	// H1: future-dated entries (clock skew) must be treated as expired, not
	// matched forever. Previously `Math.abs(diff)` let a future entry from
	// 2027-01-01 keep matching in 2026.
	it('drops future-dated entries from similarity search (H1)', async () => {
		await recordAdHocLog(store, 'tofu scramble', '2027-01-01');
		// "today" is earlier than the entry's lastSeenDate → signed diff negative.
		const match = await findSimilarAdHoc(store, 'tofu scramble', '2026-04-09');
		expect(match).toBeNull();
	});

	// H2: opportunistic trim on write keeps the file bounded without a cron,
	// and MAX_ENTRIES is enforced with FIFO.
	it('opportunistically trims expired entries on every write (H2)', async () => {
		await recordAdHocLog(store, 'ancient meal', '2026-01-01');
		await recordAdHocLog(store, 'fresh meal', '2026-04-09');
		// The ancient one is > 30 days before 2026-04-09 and should have been
		// swept on the second write.
		const ancient = await findSimilarAdHoc(store, 'ancient meal', '2026-04-09');
		expect(ancient).toBeNull();
	});

	// H8: the stop-word filter must not let filler tokens inflate Jaccard.
	// "I ate the pasta" and "I ate the pizza" would previously look similar
	// because "ate"/"the"/"i" survived the length-only filter.
	it('stop-word filtering prevents false-positive dedup on meal nouns (H8)', async () => {
		await recordAdHocLog(store, 'I ate the pasta', '2026-04-09');
		const match = await findSimilarAdHoc(store, 'I ate the pizza', '2026-04-09');
		// pasta vs pizza have zero content-token overlap once stop words are
		// stripped, so Jaccard should not reach 0.5.
		expect(match).toBeNull();
	});
});
