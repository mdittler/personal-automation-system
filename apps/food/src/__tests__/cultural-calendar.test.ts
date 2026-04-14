/**
 * Cultural Calendar Service Tests (H12b)
 *
 * Tests for holiday date computation (fixed, nthWeekday, easter, table),
 * upcoming holiday lookup, shared store load/ensure, and year-boundary handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stringify } from 'yaml';
import { generateFrontmatter } from '@pas/core/utils/frontmatter';
import type { ScopedDataStore } from '@pas/core/types';
import type { CulturalCalendar, Holiday } from '../types.js';
import {
	resolveHolidayDate,
	computeEaster,
	getUpcomingHolidays,
	loadCalendar,
	ensureCalendar,
	DEFAULT_HOLIDAYS,
} from '../services/cultural-calendar.js';

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

function makeCalendar(holidays: Partial<Holiday>[] = []): CulturalCalendar {
	return {
		holidays: holidays.map((h, i) => ({
			id: h.id ?? `holiday-${i}`,
			name: h.name ?? `Holiday ${i}`,
			dateRule: h.dateRule ?? { type: 'fixed', month: 1, day: 1 },
			cuisine: h.cuisine ?? 'Global',
			traditionalFoods: h.traditionalFoods ?? ['food'],
			region: h.region ?? 'US',
			enabled: h.enabled ?? true,
		})),
	};
}

function serializeCalendar(calendar: CulturalCalendar): string {
	const fm = generateFrontmatter({ title: 'Cultural Calendar', date: new Date().toISOString(), tags: ['food', 'cultural-calendar'] });
	return fm + stringify({ holidays: calendar.holidays });
}

// ─── resolveHolidayDate ───────────────────────────────────────────────────

describe('resolveHolidayDate', () => {
	describe('fixed rule', () => {
		it('returns correct date for Christmas', () => {
			const result = resolveHolidayDate({ type: 'fixed', month: 12, day: 25 }, 2025);
			expect(result).toBe('2025-12-25');
		});

		it('returns correct date for Independence Day', () => {
			const result = resolveHolidayDate({ type: 'fixed', month: 7, day: 4 }, 2026);
			expect(result).toBe('2026-07-04');
		});
	});

	describe('nthWeekday rule', () => {
		it('resolves Thanksgiving 2025 to Nov 27', () => {
			// 4th Thursday (weekday=4) of November (month=11)
			const result = resolveHolidayDate({ type: 'nthWeekday', month: 11, weekday: 4, n: 4 }, 2025);
			expect(result).toBe('2025-11-27');
		});

		it('resolves Thanksgiving 2026 to Nov 26', () => {
			const result = resolveHolidayDate({ type: 'nthWeekday', month: 11, weekday: 4, n: 4 }, 2026);
			expect(result).toBe('2026-11-26');
		});

		it('resolves Thanksgiving 2024 to Nov 28', () => {
			const result = resolveHolidayDate({ type: 'nthWeekday', month: 11, weekday: 4, n: 4 }, 2024);
			expect(result).toBe('2024-11-28');
		});

		it('resolves 1st Monday of September (Labor Day) 2025 to Sep 1', () => {
			const result = resolveHolidayDate({ type: 'nthWeekday', month: 9, weekday: 1, n: 1 }, 2025);
			expect(result).toBe('2025-09-01');
		});
	});

	describe('easter rule', () => {
		it('resolves Easter 2025 to Apr 20', () => {
			const result = resolveHolidayDate({ type: 'easter' }, 2025);
			expect(result).toBe('2025-04-20');
		});

		it('resolves Easter 2026 to Apr 5', () => {
			const result = resolveHolidayDate({ type: 'easter' }, 2026);
			expect(result).toBe('2026-04-05');
		});

		it('resolves Easter 2027 to Mar 28', () => {
			const result = resolveHolidayDate({ type: 'easter' }, 2027);
			expect(result).toBe('2027-03-28');
		});

		it('resolves Mardi Gras 2025 using -47 offset (Mar 4)', () => {
			// Easter 2025 = Apr 20. Apr 20 - 47 days = Mar 4
			// Apr 20 = day 110. 110 - 47 = day 63 = Mar 4
			const result = resolveHolidayDate({ type: 'easter', offset: -47 }, 2025);
			expect(result).toBe('2025-03-04');
		});
	});

	describe('table rule', () => {
		it('returns date for year present in table', () => {
			const result = resolveHolidayDate({ type: 'table', dates: { 2025: '01-29', 2026: '02-17' } }, 2025);
			expect(result).toBe('2025-01-29');
		});

		it('returns null for year missing from table', () => {
			const result = resolveHolidayDate({ type: 'table', dates: { 2025: '01-29' } }, 2030);
			expect(result).toBeNull();
		});
	});
});

// ─── computeEaster ───────────────────────────────────────────────────────

describe('computeEaster', () => {
	it('returns Easter 2025 as Apr 20', () => {
		expect(computeEaster(2025)).toEqual({ month: 4, day: 20 });
	});

	it('returns Easter 2026 as Apr 5', () => {
		expect(computeEaster(2026)).toEqual({ month: 4, day: 5 });
	});
});

// ─── getUpcomingHolidays ─────────────────────────────────────────────────

describe('getUpcomingHolidays', () => {
	it('returns holidays whose date falls within the window', () => {
		const calendar = makeCalendar([
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 } },
		]);
		const result = getUpcomingHolidays(calendar, '2025-12-20', 14);
		expect(result).toHaveLength(1);
		expect(result[0].holiday.id).toBe('xmas');
		expect(result[0].date).toBe('2025-12-25');
	});

	it('excludes disabled holidays', () => {
		const calendar = makeCalendar([
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 }, enabled: false },
		]);
		const result = getUpcomingHolidays(calendar, '2025-12-20', 14);
		expect(result).toHaveLength(0);
	});

	it('returns empty array when no holidays are in window', () => {
		const calendar = makeCalendar([
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 } },
		]);
		const result = getUpcomingHolidays(calendar, '2025-01-01', 14);
		expect(result).toHaveLength(0);
	});

	it('handles cross-year boundary (Dec 28 + 14 days includes Jan 1 next year)', () => {
		const calendar = makeCalendar([
			{ id: 'new-year', dateRule: { type: 'fixed', month: 1, day: 1 } },
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 } },
		]);
		const result = getUpcomingHolidays(calendar, '2025-12-28', 14);
		// Jan 1 2026 is within window, Christmas 2025 is before fromDate
		expect(result).toHaveLength(1);
		expect(result[0].holiday.id).toBe('new-year');
		expect(result[0].date).toBe('2026-01-01');
	});

	it('includes holiday exactly on fromDate (inclusive)', () => {
		const calendar = makeCalendar([
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 } },
		]);
		const result = getUpcomingHolidays(calendar, '2025-12-25', 7);
		expect(result).toHaveLength(1);
	});

	it('includes holiday exactly on last day of window (inclusive)', () => {
		const calendar = makeCalendar([
			{ id: 'xmas', dateRule: { type: 'fixed', month: 12, day: 25 } },
		]);
		// fromDate Dec 18, window 7 days → endDate Dec 25 (inclusive)
		const result = getUpcomingHolidays(calendar, '2025-12-18', 7);
		expect(result).toHaveLength(1);
	});

	it('skips table-rule holidays with no entry for that year', () => {
		const calendar = makeCalendar([
			{ id: 'lunar-new-year', dateRule: { type: 'table', dates: { 2025: '01-29' } } },
		]);
		// 2026 has no entry
		const result = getUpcomingHolidays(calendar, '2026-01-20', 14);
		expect(result).toHaveLength(0);
	});
});

// ─── loadCalendar ────────────────────────────────────────────────────────

describe('loadCalendar', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('parses a valid cultural-calendar.yaml and returns calendar', async () => {
		const calendar: CulturalCalendar = makeCalendar([
			{ id: 'thanksgiving', name: 'Thanksgiving', dateRule: { type: 'nthWeekday', month: 11, weekday: 4, n: 4 } },
		]);
		store.read.mockResolvedValue(serializeCalendar(calendar));

		const result = await loadCalendar(store as unknown as ScopedDataStore);
		expect(result).not.toBeNull();
		expect(result!.holidays).toHaveLength(1);
		expect(result!.holidays[0].id).toBe('thanksgiving');
	});

	it('returns null when file does not exist', async () => {
		store.read.mockResolvedValue(null);
		const result = await loadCalendar(store as unknown as ScopedDataStore);
		expect(result).toBeNull();
	});

	it('returns null when YAML is corrupt', async () => {
		store.read.mockResolvedValue('---\ntitle: test\n---\n{invalid yaml: [');
		const result = await loadCalendar(store as unknown as ScopedDataStore);
		expect(result).toBeNull();
	});
});

// ─── ensureCalendar ──────────────────────────────────────────────────────

describe('ensureCalendar', () => {
	let store: ReturnType<typeof createMockStore>;

	beforeEach(() => {
		store = createMockStore();
	});

	it('writes DEFAULT_HOLIDAYS to shared store on first run (file missing)', async () => {
		store.read.mockResolvedValue(null);

		const result = await ensureCalendar(store as unknown as ScopedDataStore);
		expect(store.write).toHaveBeenCalledOnce();
		expect(result.holidays).toHaveLength(DEFAULT_HOLIDAYS.length);
		expect(result.holidays[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
	});

	it('includes type: cultural-calendar in frontmatter when writing', async () => {
		store.read.mockResolvedValue(null);

		await ensureCalendar(store as unknown as ScopedDataStore);
		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		expect(written).toContain('type: cultural-calendar');
	});

	it('writes frontmatter with app: food and pas/ tags', async () => {
		store.read.mockResolvedValue(null);

		await ensureCalendar(store as unknown as ScopedDataStore);
		const written = vi.mocked(store.write).mock.calls[0]![1] as string;
		expect(written).toContain('app: food');
		expect(written).toContain('pas/'); // buildAppTags uses pas/ prefix
	});

	it('returns existing calendar without overwriting when file exists', async () => {
		const existing: CulturalCalendar = makeCalendar([{ id: 'custom-holiday', name: 'Custom' }]);
		store.read.mockResolvedValue(serializeCalendar(existing));

		const result = await ensureCalendar(store as unknown as ScopedDataStore);
		expect(store.write).not.toHaveBeenCalled();
		expect(result.holidays[0].id).toBe('custom-holiday');
	});
});

// ─── DEFAULT_HOLIDAYS ────────────────────────────────────────────────────

describe('DEFAULT_HOLIDAYS', () => {
	it('contains approximately 15 holidays', () => {
		expect(DEFAULT_HOLIDAYS.length).toBeGreaterThanOrEqual(13);
		expect(DEFAULT_HOLIDAYS.length).toBeLessThanOrEqual(17);
	});

	it('includes Thanksgiving with nthWeekday rule', () => {
		const thanksgiving = DEFAULT_HOLIDAYS.find(h => h.id === 'thanksgiving-us');
		expect(thanksgiving).toBeDefined();
		expect(thanksgiving!.dateRule.type).toBe('nthWeekday');
	});

	it('includes Christmas with fixed rule', () => {
		const christmas = DEFAULT_HOLIDAYS.find(h => h.id === 'christmas');
		expect(christmas).toBeDefined();
		expect(christmas!.dateRule.type).toBe('fixed');
	});

	it('all holidays have required fields', () => {
		for (const h of DEFAULT_HOLIDAYS) {
			expect(h.id).toBeTruthy();
			expect(h.name).toBeTruthy();
			expect(h.traditionalFoods.length).toBeGreaterThan(0);
			expect(h.dateRule).toBeDefined();
		}
	});

	it('all holidays are enabled by default', () => {
		expect(DEFAULT_HOLIDAYS.every(h => h.enabled)).toBe(true);
	});
});
