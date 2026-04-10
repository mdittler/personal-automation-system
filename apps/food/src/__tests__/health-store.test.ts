/**
 * Health Store Tests
 *
 * Tests for healthPath path-guard, monthly health log CRUD,
 * upsertDailyHealth, and loadHealthForPeriod cross-month iteration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { generateFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import type { ScopedDataStore } from '@pas/core/types';
import type { DailyHealthEntry, MonthlyHealthLog } from '../services/health-store.js';
import {
	loadMonthlyHealth,
	saveMonthlyHealth,
	upsertDailyHealth,
	loadHealthForPeriod,
} from '../services/health-store.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockStore() {
	return {
		read: vi.fn<Parameters<ScopedDataStore['read']>, ReturnType<ScopedDataStore['read']>>(),
		write: vi.fn<Parameters<ScopedDataStore['write']>, ReturnType<ScopedDataStore['write']>>().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

function makeEntry(date: string, overrides: Partial<DailyHealthEntry> = {}): DailyHealthEntry {
	return {
		date,
		metrics: { sleepHours: 7 },
		source: 'health-app',
		...overrides,
	};
}

function makeLog(month: string, userId: string, days: DailyHealthEntry[] = []): MonthlyHealthLog {
	return { month, userId, days };
}

function serialiseLog(log: MonthlyHealthLog): string {
	const fm = generateFrontmatter({
		title: `Health ${log.month}`,
		date: new Date().toISOString(),
		tags: buildAppTags('food', 'health'),
	});
	return fm + stringify({ month: log.month, userId: log.userId, days: log.days });
}

// ─── loadMonthlyHealth ────────────────────────────────────────────────────

describe('loadMonthlyHealth', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('returns null when file does not exist', async () => {
		store.read.mockResolvedValue(null);
		const result = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');
		expect(result).toBeNull();
	});

	it('returns null for empty file', async () => {
		store.read.mockResolvedValue('');
		const result = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');
		expect(result).toBeNull();
	});

	it('loads a valid monthly health log', async () => {
		const log = makeLog('2026-04', 'alice', [makeEntry('2026-04-01')]);
		store.read.mockResolvedValue(serialiseLog(log));

		const result = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');

		expect(result).not.toBeNull();
		expect(result!.month).toBe('2026-04');
		expect(result!.userId).toBe('alice');
		expect(result!.days).toHaveLength(1);
		expect(result!.days[0]!.date).toBe('2026-04-01');
	});

	it('reads from path health/YYYY-MM.yaml', async () => {
		store.read.mockResolvedValue(null);
		await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');
		expect(store.read).toHaveBeenCalledWith('health/2026-04.yaml');
	});

	it('returns null for malformed YAML', async () => {
		store.read.mockResolvedValue('---\ntitle: broken\n---\n{{{invalid yaml');
		const result = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');
		expect(result).toBeNull();
	});

	it('rejects invalid month format (path traversal guard)', async () => {
		await expect(
			loadMonthlyHealth(store as unknown as ScopedDataStore, '../etc/passwd'),
		).rejects.toThrow('Invalid month format');
	});

	it('rejects month format missing day separator', async () => {
		await expect(
			loadMonthlyHealth(store as unknown as ScopedDataStore, '202604'),
		).rejects.toThrow('Invalid month format');
	});

	it('returns null for a file missing the userId field (corrupt log)', async () => {
		// A log file without userId is treated as corrupt — userId is required for routing
		const content = generateFrontmatter({ title: 'Health 2026-04', date: new Date().toISOString(), tags: [] })
			+ stringify({ month: '2026-04', days: [] }); // no userId field
		store.read.mockResolvedValue(content);
		const result = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');
		expect(result).toBeNull();
	});
});

// ─── saveMonthlyHealth ────────────────────────────────────────────────────

describe('saveMonthlyHealth', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('writes to path health/YYYY-MM.yaml', async () => {
		const log = makeLog('2026-04', 'alice');
		await saveMonthlyHealth(store as unknown as ScopedDataStore, log);
		expect(store.write).toHaveBeenCalledWith('health/2026-04.yaml', expect.any(String));
	});

	it('writes YAML frontmatter with food:health tags', async () => {
		const log = makeLog('2026-04', 'alice');
		await saveMonthlyHealth(store as unknown as ScopedDataStore, log);
		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		expect(written).toContain('tags:');
		expect(written).toContain('food');
		expect(written).toContain('health');
	});

	it('round-trips day entries through save and load', async () => {
		const log = makeLog('2026-04', 'alice', [makeEntry('2026-04-05', { metrics: { sleepHours: 8, weightKg: 72 } })]);

		let stored = '';
		store.write.mockImplementation(async (_path, content) => { stored = content as string; });
		store.read.mockImplementation(async () => stored);

		await saveMonthlyHealth(store as unknown as ScopedDataStore, log);
		const loaded = await loadMonthlyHealth(store as unknown as ScopedDataStore, '2026-04');

		expect(loaded!.days[0]!.metrics.sleepHours).toBe(8);
		expect(loaded!.days[0]!.metrics.weightKg).toBe(72);
	});
});

// ─── upsertDailyHealth ────────────────────────────────────────────────────

describe('upsertDailyHealth', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('creates a new monthly log when none exists', async () => {
		store.read.mockResolvedValue(null);
		const entry = makeEntry('2026-04-10');

		await upsertDailyHealth(store as unknown as ScopedDataStore, 'alice', entry);

		expect(store.write).toHaveBeenCalledOnce();
		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		expect(written).toContain('2026-04-10');
	});

	it('appends a new day to an existing log', async () => {
		const existingLog = makeLog('2026-04', 'alice', [makeEntry('2026-04-09')]);
		store.read.mockResolvedValue(serialiseLog(existingLog));

		await upsertDailyHealth(store as unknown as ScopedDataStore, 'alice', makeEntry('2026-04-10'));

		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		expect(written).toContain('2026-04-09');
		expect(written).toContain('2026-04-10');
	});

	it('throws when the entry date is not in YYYY-MM-DD format', async () => {
		const badEntry = makeEntry('2026-4-1'); // missing zero-padding — fails YYYY-MM-DD regex
		await expect(
			upsertDailyHealth(store as unknown as ScopedDataStore, 'alice', badEntry),
		).rejects.toThrow('Invalid date format');
	});

	it('throws when the entry date is completely invalid', async () => {
		const badEntry = makeEntry('not-a-date');
		await expect(
			upsertDailyHealth(store as unknown as ScopedDataStore, 'alice', badEntry),
		).rejects.toThrow('Invalid date format');
	});

	it('replaces an existing day entry (upsert semantics)', async () => {
		const existingLog = makeLog('2026-04', 'alice', [makeEntry('2026-04-10', { metrics: { sleepHours: 6 } })]);
		store.read.mockResolvedValue(serialiseLog(existingLog));

		const updated = makeEntry('2026-04-10', { metrics: { sleepHours: 9 } });
		await upsertDailyHealth(store as unknown as ScopedDataStore, 'alice', updated);

		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		const occurrences = (written.match(/2026-04-10/g) ?? []).length;
		expect(occurrences).toBeGreaterThanOrEqual(1);
		expect(written).toContain('sleepHours: 9');
		expect(written).not.toContain('sleepHours: 6');
	});
});

// ─── loadHealthForPeriod ──────────────────────────────────────────────────

describe('loadHealthForPeriod', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('returns empty array when no health data exists', async () => {
		store.read.mockResolvedValue(null);
		const result = await loadHealthForPeriod(store as unknown as ScopedDataStore, '2026-04-01', '2026-04-14');
		expect(result).toEqual([]);
	});

	it('returns entries within the date range', async () => {
		const log = makeLog('2026-04', 'alice', [
			makeEntry('2026-04-01'),
			makeEntry('2026-04-10'),
			makeEntry('2026-04-20'),
		]);
		store.read.mockResolvedValue(serialiseLog(log));

		const result = await loadHealthForPeriod(store as unknown as ScopedDataStore, '2026-04-05', '2026-04-15');

		expect(result).toHaveLength(1);
		expect(result[0]!.date).toBe('2026-04-10');
	});

	it('returns entries sorted chronologically', async () => {
		const log = makeLog('2026-04', 'alice', [
			makeEntry('2026-04-10'),
			makeEntry('2026-04-02'),
			makeEntry('2026-04-07'),
		]);
		store.read.mockResolvedValue(serialiseLog(log));

		const result = await loadHealthForPeriod(store as unknown as ScopedDataStore, '2026-04-01', '2026-04-30');

		expect(result.map(e => e.date)).toEqual(['2026-04-02', '2026-04-07', '2026-04-10']);
	});

	it('spans month boundaries correctly', async () => {
		const aprilLog = makeLog('2026-04', 'alice', [makeEntry('2026-04-29'), makeEntry('2026-04-30')]);
		const mayLog = makeLog('2026-05', 'alice', [makeEntry('2026-05-01'), makeEntry('2026-05-05')]);

		store.read.mockImplementation(async (path) => {
			if ((path as string).includes('2026-04')) return serialiseLog(aprilLog);
			if ((path as string).includes('2026-05')) return serialiseLog(mayLog);
			return null;
		});

		const result = await loadHealthForPeriod(store as unknown as ScopedDataStore, '2026-04-29', '2026-05-03');

		expect(result.map(e => e.date)).toEqual(['2026-04-29', '2026-04-30', '2026-05-01']);
	});

	it('includes entries on the start and end dates (inclusive)', async () => {
		const log = makeLog('2026-04', 'alice', [makeEntry('2026-04-01'), makeEntry('2026-04-14')]);
		store.read.mockResolvedValue(serialiseLog(log));

		const result = await loadHealthForPeriod(store as unknown as ScopedDataStore, '2026-04-01', '2026-04-14');

		expect(result).toHaveLength(2);
	});
});
