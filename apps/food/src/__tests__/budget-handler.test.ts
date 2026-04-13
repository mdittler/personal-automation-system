import { describe, expect, it, vi } from 'vitest';
import { getPrevWeekId, handleBudgetCommand, isBudgetViewIntent, loadWeeksForMonth } from '../handlers/budget.js';
import type { CoreServices } from '@pas/core/types';
import type { CostHistoryWeek } from '../types.js';

function createMockStore(overrides: Record<string, unknown> = {}) {
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

function createMockServices(): CoreServices {
	return {
		llm: { complete: vi.fn().mockResolvedValue('[]') },
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
		},
		data: { forShared: vi.fn().mockReturnValue(createMockStore()) },
		config: { get: vi.fn().mockResolvedValue(null) },
		logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
		timezone: 'America/New_York',
	} as unknown as CoreServices;
}

// Helper to build a minimal CostHistoryWeek for tests
function makeWeek(weekId: string, startDate: string, endDate: string): CostHistoryWeek {
	return {
		weekId,
		startDate,
		endDate,
		totalCost: 100,
		mealCount: 7,
		avgPerMeal: 14.29,
		avgPerServing: 7.14,
		meals: [],
	};
}

describe('budget-handler', () => {
	describe('getPrevWeekId', () => {
		it('returns W53 when 2021-W01 goes to 2020-W53 (ISO 53-week year)', () => {
			// 2020 is a long (53-week) ISO year; Dec 28 2020 = W53
			expect(getPrevWeekId('2021-W01')).toBe('2020-W53');
		});
		it('returns W52 for a normal year (2026-W01 → 2025-W52)', () => {
			// 2025 has 52 ISO weeks; Dec 28 2025 = W52
			expect(getPrevWeekId('2026-W01')).toBe('2025-W52');
		});
		it('decrements week within a year (2026-W15 → 2026-W14)', () => {
			expect(getPrevWeekId('2026-W15')).toBe('2026-W14');
		});
		it('returns the input unchanged for invalid format', () => {
			expect(getPrevWeekId('not-a-week')).toBe('not-a-week');
		});
	});

	describe('loadWeeksForMonth', () => {
		// The boundary week: startDate in March (2026-03-30), endDate in April (2026-04-05).
		// loadWeeklyHistory strips frontmatter then yaml.parse()s the body, so the mock
		// must return YAML that parses to a CostHistoryWeek with a valid weekId string.
		const boundaryWeekYaml = [
			'weekId: "2026-W14"',
			'startDate: "2026-03-30"',
			'endDate: "2026-04-05"',
			'totalCost: 150',
			'mealCount: 7',
			'avgPerMeal: 21.43',
			'avgPerServing: 10.71',
			'meals: []',
		].join('\n');

		function makeBoundaryStore() {
			return {
				read: vi.fn().mockResolvedValue(boundaryWeekYaml),
				write: vi.fn(),
				append: vi.fn(),
				exists: vi.fn().mockResolvedValue(true),
				list: vi.fn().mockResolvedValue([]),
				archive: vi.fn(),
			};
		}

		it('includes boundary week in March because startDate is 2026-03-30', async () => {
			const store = makeBoundaryStore();
			const results = await loadWeeksForMonth(store as never, ['2026-W14'], '2026-03');
			expect(results).toHaveLength(1);
			expect(results[0]!.weekId).toBe('2026-W14');
		});

		it('excludes boundary week from April because startDate is 2026-03-30, not April', async () => {
			const store = makeBoundaryStore();
			const results = await loadWeeksForMonth(store as never, ['2026-W14'], '2026-04');
			expect(results).toHaveLength(0);
		});

		it('returns empty array when no weekIds are provided', async () => {
			const store = makeBoundaryStore();
			const results = await loadWeeksForMonth(store as never, [], '2026-03');
			expect(results).toHaveLength(0);
		});

		it('skips weeks whose store.read returns null (missing files)', async () => {
			const store = {
				...makeBoundaryStore(),
				read: vi.fn().mockResolvedValue(null),
			};
			const results = await loadWeeksForMonth(store as never, ['2026-W14'], '2026-03');
			expect(results).toHaveLength(0);
		});
	});

	describe('yearly aggregation boundary week logic via loadWeeksForMonth', () => {
		// 2025-W53: startDate 2025-12-29 (calendar year 2025), endDate 2026-01-04 (calendar year 2026)
		const w53Yaml = [
			'weekId: "2025-W53"',
			'startDate: "2025-12-29"',
			'endDate: "2026-01-04"',
			'totalCost: 100',
			'mealCount: 7',
			'avgPerMeal: 14.29',
			'avgPerServing: 7.14',
			'meals: []',
		].join('\n');

		// 2026-W01: startDate 2026-01-02, endDate 2026-01-08 — fully in 2026
		const w01Yaml = [
			'weekId: "2026-W01"',
			'startDate: "2026-01-02"',
			'endDate: "2026-01-08"',
			'totalCost: 120',
			'mealCount: 7',
			'avgPerMeal: 17.14',
			'avgPerServing: 8.57',
			'meals: []',
		].join('\n');

		it('includes W53 week in 2025 yearly because startDate is 2025-12-29', async () => {
			const store = {
				read: vi.fn().mockResolvedValue(w53Yaml),
				write: vi.fn(), append: vi.fn(), exists: vi.fn(), list: vi.fn(), archive: vi.fn(),
			};
			// Use a month prefix of '2025' to simulate yearly filtering (startDate.startsWith('2025'))
			const results = await loadWeeksForMonth(store as never, ['2025-W53'], '2025');
			expect(results).toHaveLength(1);
			expect(results[0]!.weekId).toBe('2025-W53');
		});

		it('excludes W53 week from 2026 yearly because startDate is 2025-12-29, not 2026', async () => {
			const store = {
				read: vi.fn().mockResolvedValue(w53Yaml),
				write: vi.fn(), append: vi.fn(), exists: vi.fn(), list: vi.fn(), archive: vi.fn(),
			};
			const results = await loadWeeksForMonth(store as never, ['2025-W53'], '2026');
			expect(results).toHaveLength(0);
		});

		it('includes W01 week in 2026 yearly because startDate is 2026-01-02', async () => {
			const store = {
				read: vi.fn().mockResolvedValue(w01Yaml),
				write: vi.fn(), append: vi.fn(), exists: vi.fn(), list: vi.fn(), archive: vi.fn(),
			};
			const results = await loadWeeksForMonth(store as never, ['2026-W01'], '2026');
			expect(results).toHaveLength(1);
			expect(results[0]!.weekId).toBe('2026-W01');
		});
	});

	describe('isBudgetViewIntent', () => {
		it('detects "how much did we spend on food"', () => {
			expect(isBudgetViewIntent('how much did we spend on food')).toBe(true);
		});
		it('detects "food budget"', () => {
			expect(isBudgetViewIntent('food budget')).toBe(true);
		});
		it('detects "what did we spend this week"', () => {
			expect(isBudgetViewIntent('what did we spend this week')).toBe(true);
		});
		it('detects "show food costs"', () => {
			expect(isBudgetViewIntent('show food costs')).toBe(true);
		});
		it('rejects "add eggs to grocery list"', () => {
			expect(isBudgetViewIntent('add eggs to grocery list')).toBe(false);
		});
		it('rejects unrelated messages with food keywords', () => {
			expect(isBudgetViewIntent('make me a meal plan for this week')).toBe(false);
			expect(isBudgetViewIntent('what food should I buy')).toBe(false);
		});
		it('rejects price update messages', () => {
			expect(isBudgetViewIntent('eggs are $3.50 at costco')).toBe(false);
		});
	});

	describe('handleBudgetCommand', () => {
		it('shows weekly report by default', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, [], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
			const [, msg] = vi.mocked(svc.telegram.send).mock.calls[0]!;
			expect(
				(msg as string).includes('Food Budget') || (msg as string).includes('No active meal plan'),
			).toBe(true);
		});
		it('shows monthly report for "month" arg', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, ['month'], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
		});
		it('shows yearly report for "year" arg', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, ['year'], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
		});
		it('handles no data gracefully', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, [], 'user1', store as never);
			const [, msg] = vi.mocked(svc.telegram.send).mock.calls[0]!;
			expect(typeof msg).toBe('string');
		});
		it('handles /foodbudget with invalid subcommand gracefully', async () => {
			const svc = createMockServices();
			const store = createMockStore({ read: vi.fn().mockResolvedValue(null) });
			await handleBudgetCommand(svc, ['invalid'], 'user1', store as never);
			// Should fall through to weekly default since 'invalid' !== 'month' or 'year'
			expect(svc.telegram.send).toHaveBeenCalled();
		});
	});
});
