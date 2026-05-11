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

/**
 * Compute YYYY-MM-DD relative to a fixed `today`. Avoids hardcoded dates
 * that rot when wall-clock time moves past the 30-day similarity window.
 */
function ymd(daysAgo: number, today: Date): string {
	const d = new Date(today);
	d.setUTCDate(d.getUTCDate() - daysAgo);
	return d.toISOString().slice(0, 10);
}

describe('ad-hoc-history', () => {
	let store: ScopedDataStore;
	// Anchor "today" to a stable reference computed at suite start. Tests
	// pass this explicit `today` into `findSimilarAdHoc`/`trimExpired` so
	// they never read the wall clock and never depend on date arithmetic
	// that drifts as the calendar advances.
	const TODAY = new Date();
	const TODAY_ISO = ymd(0, TODAY);
	const RECENT = ymd(2, TODAY); // 2 days ago — well within 30-day window
	const OLD = ymd(60, TODAY); // 60 days ago — definitely expired
	const FUTURE = ymd(-180, TODAY); // 180 days in the future — clock skew

	beforeEach(() => {
		store = createMockStore();
	});

	it('records and finds similar entries', async () => {
		await recordAdHocLog(store, 'burger and potato salad at bbq', RECENT);
		const match = await findSimilarAdHoc(store, 'burger and potato salad', TODAY_ISO);
		expect(match).toBeTruthy();
		expect(match?.occurrences).toBe(1);
	});

	it('recognizes near-duplicate text on second record', async () => {
		await recordAdHocLog(store, 'burger and potato salad at bbq', RECENT);
		await recordAdHocLog(store, 'burger potato salad bbq', RECENT);
		const match = await findSimilarAdHoc(store, 'burger potato salad', TODAY_ISO);
		expect(match?.occurrences).toBe(2);
	});

	it('treats distinct meals as separate', async () => {
		await recordAdHocLog(store, 'burger and fries', RECENT);
		const match = await findSimilarAdHoc(store, 'pasta primavera', TODAY_ISO);
		expect(match).toBeNull();
	});

	it('trims entries older than 30 days', async () => {
		await recordAdHocLog(store, 'old meal', OLD);
		await recordAdHocLog(store, 'recent meal', RECENT);
		await trimExpired(store, TODAY_ISO);
		const old = await findSimilarAdHoc(store, 'old meal', TODAY_ISO);
		const recent = await findSimilarAdHoc(store, 'recent meal', TODAY_ISO);
		expect(old).toBeNull();
		expect(recent).toBeTruthy();
	});

	it('returns null when store is empty', async () => {
		const match = await findSimilarAdHoc(store, 'anything', TODAY_ISO);
		expect(match).toBeNull();
	});

	// ── Hardening regression tests (H11.w thorough review) ──

	// H1: future-dated entries (clock skew) must be treated as expired, not
	// matched forever. Previously `Math.abs(diff)` let a future entry keep
	// matching even though today is earlier than its lastSeenDate.
	it('drops future-dated entries from similarity search (H1)', async () => {
		await recordAdHocLog(store, 'tofu scramble', FUTURE);
		// "today" is earlier than the entry's lastSeenDate → signed diff negative.
		const match = await findSimilarAdHoc(store, 'tofu scramble', TODAY_ISO);
		expect(match).toBeNull();
	});

	// H2: opportunistic trim on write keeps the file bounded without a cron,
	// and MAX_ENTRIES is enforced with FIFO.
	it('opportunistically trims expired entries on every write (H2)', async () => {
		await recordAdHocLog(store, 'ancient meal', OLD);
		await recordAdHocLog(store, 'fresh meal', RECENT);
		// The ancient one is > 30 days before `RECENT` and should have been
		// swept on the second write.
		const ancient = await findSimilarAdHoc(store, 'ancient meal', TODAY_ISO);
		expect(ancient).toBeNull();
	});

	// H8: the stop-word filter must not let filler tokens inflate Jaccard.
	// "I ate the pasta" and "I ate the pizza" would previously look similar
	// because "ate"/"the"/"i" survived the length-only filter.
	it('stop-word filtering prevents false-positive dedup on meal nouns (H8)', async () => {
		await recordAdHocLog(store, 'I ate the pasta', RECENT);
		const match = await findSimilarAdHoc(store, 'I ate the pizza', TODAY_ISO);
		// pasta vs pizza have zero content-token overlap once stop words are
		// stripped, so Jaccard should not reach 0.5.
		expect(match).toBeNull();
	});
});
