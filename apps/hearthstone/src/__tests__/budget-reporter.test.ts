import { describe, expect, it, vi } from 'vitest';
import {
	generateWeeklyReport,
	generateMonthlyReport,
	generateYearlyReport,
	formatWeeklyReportMessage,
	formatMonthlyReportMessage,
	formatYearlyReportMessage,
	saveWeeklyHistory,
	loadWeeklyHistory,
	listWeeklyHistories,
} from '../services/budget-reporter.js';
import {
	checkBudgetAlert,
	formatBudgetAlert,
} from '../services/budget-alerts.js';
import type { CostHistoryWeek, MealCostEstimate, MealPlan } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeMealEstimate(overrides: Partial<MealCostEstimate> = {}): MealCostEstimate {
	return {
		recipeId: 'recipe-1',
		recipeTitle: 'Pancakes',
		store: 'Costco',
		ingredientCosts: [],
		totalCost: 4.50,
		perServingCost: 1.13,
		servings: 4,
		estimatedAt: '2026-04-07T10:00:00.000Z',
		...overrides,
	};
}

function makePlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-1',
		startDate: '2026-04-07',
		endDate: '2026-04-13',
		meals: [
			{
				recipeId: 'recipe-1',
				recipeTitle: 'Pancakes',
				date: '2026-04-07',
				mealType: 'breakfast',
				votes: {},
				cooked: false,
				rated: false,
				isNew: false,
			},
			{
				recipeId: 'recipe-2',
				recipeTitle: 'Pasta',
				date: '2026-04-08',
				mealType: 'dinner',
				votes: {},
				cooked: false,
				rated: false,
				isNew: false,
			},
		],
		status: 'active',
		createdAt: '2026-04-07T00:00:00.000Z',
		updatedAt: '2026-04-07T00:00:00.000Z',
		...overrides,
	};
}

const recentWeeks: CostHistoryWeek[] = [
	{ weekId: '2026-W12', startDate: '2026-03-16', endDate: '2026-03-22', meals: [], totalCost: 36.00, avgPerMeal: 5.14, avgPerServing: 1.29, mealCount: 7 },
	{ weekId: '2026-W13', startDate: '2026-03-23', endDate: '2026-03-29', meals: [], totalCost: 38.00, avgPerMeal: 5.43, avgPerServing: 1.36, mealCount: 7 },
	{ weekId: '2026-W14', startDate: '2026-03-30', endDate: '2026-04-05', meals: [], totalCost: 34.00, avgPerMeal: 4.86, avgPerServing: 1.21, mealCount: 7 },
	{ weekId: '2026-W15', startDate: '2026-04-06', endDate: '2026-04-12', meals: [], totalCost: 40.00, avgPerMeal: 5.71, avgPerServing: 1.43, mealCount: 7 },
];

// ─── generateWeeklyReport ─────────────────────────────────────────────────────

describe('generateWeeklyReport', () => {
	it('builds report from plan and estimates', () => {
		const plan = makePlan();
		const estimates = [
			makeMealEstimate({ recipeId: 'recipe-1', recipeTitle: 'Pancakes', totalCost: 4.50, perServingCost: 1.13 }),
			makeMealEstimate({ recipeId: 'recipe-2', recipeTitle: 'Pasta', totalCost: 8.00, perServingCost: 2.00, servings: 4 }),
		];
		const result = generateWeeklyReport(plan, estimates);

		expect(result.weekId).toBe('2026-W15');
		expect(result.meals).toHaveLength(2);
		expect(result.totalCost).toBeCloseTo(12.50);
		expect(result.mealCount).toBe(2);
		expect(result.avgPerMeal).toBeCloseTo(6.25);
	});

	it('handles single meal plans correctly', () => {
		const plan = makePlan({
			meals: [
				{
					recipeId: 'r1',
					recipeTitle: 'Solo Meal',
					date: '2026-04-07',
					mealType: 'dinner',
					votes: {},
					cooked: false,
					rated: false,
					isNew: false,
				},
			],
		});
		const estimates = [
			makeMealEstimate({ recipeId: 'r1', recipeTitle: 'Solo Meal', totalCost: 5.00, perServingCost: 1.25, servings: 4 }),
		];
		const result = generateWeeklyReport(plan, estimates);
		expect(result.totalCost).toBe(5.00);
		expect(result.mealCount).toBe(1);
		expect(result.avgPerMeal).toBe(5.00);
	});

	it('handles empty estimates gracefully', () => {
		const plan = makePlan();
		const result = generateWeeklyReport(plan, []);

		expect(result.weekId).toBe('2026-W15');
		expect(result.meals).toHaveLength(0);
		expect(result.totalCost).toBe(0);
		expect(result.mealCount).toBe(0);
		expect(result.avgPerMeal).toBe(0);
		expect(result.avgPerServing).toBe(0);
	});

	it('maps meals to correct dates from plan', () => {
		const plan = makePlan();
		const estimates = [
			makeMealEstimate({ recipeId: 'recipe-1', recipeTitle: 'Pancakes', totalCost: 4.50 }),
		];
		const result = generateWeeklyReport(plan, estimates);

		expect(result.meals[0]?.recipeTitle).toBe('Pancakes');
		expect(result.meals[0]?.date).toBe('2026-04-07');
		expect(result.meals[0]?.cost).toBeCloseTo(4.50);
	});
});

// ─── generateMonthlyReport ────────────────────────────────────────────────────

describe('generateMonthlyReport', () => {
	it('aggregates weeks into monthly summary', () => {
		const weeks: CostHistoryWeek[] = [
			{ weekId: '2026-W14', startDate: '2026-03-30', endDate: '2026-04-05', meals: [], totalCost: 34.00, avgPerMeal: 4.86, avgPerServing: 1.21, mealCount: 7 },
			{ weekId: '2026-W15', startDate: '2026-04-06', endDate: '2026-04-12', meals: [], totalCost: 40.00, avgPerMeal: 5.71, avgPerServing: 1.43, mealCount: 7 },
		];
		const result = generateMonthlyReport('2026-04', weeks);

		expect(result.monthId).toBe('2026-04');
		expect(result.totalCost).toBeCloseTo(74.00);
		expect(result.mealCount).toBe(14);
		expect(result.weeks).toHaveLength(2);
		expect(result.avgPerMeal).toBeCloseTo(74.00 / 14);
	});
});

// ─── generateYearlyReport ─────────────────────────────────────────────────────

describe('generateYearlyReport', () => {
	it('aggregates months into yearly summary', () => {
		const months = [
			{ monthLabel: '2026-01', totalCost: 120.00, mealCount: 28 },
			{ monthLabel: '2026-02', totalCost: 105.00, mealCount: 28 },
			{ monthLabel: '2026-03', totalCost: 140.00, mealCount: 30 },
		];
		const result = generateYearlyReport('2026', months);

		expect(result.totalCost).toBeCloseTo(365.00);
		expect(result.avgPerMonth).toBeCloseTo(365.00 / 3);
		expect(result.months).toHaveLength(3);
	});
});

// ─── formatWeeklyReportMessage ────────────────────────────────────────────────

describe('formatWeeklyReportMessage', () => {
	const week: CostHistoryWeek = {
		weekId: '2026-W15',
		startDate: '2026-04-07',
		endDate: '2026-04-13',
		meals: [
			{ date: '2026-04-07', recipeTitle: 'Pancakes', cost: 4.50, perServing: 1.13 },
			{ date: '2026-04-08', recipeTitle: 'Pasta', cost: 8.00, perServing: 2.00 },
		],
		totalCost: 12.50,
		avgPerMeal: 6.25,
		avgPerServing: 1.57,
		mealCount: 2,
	};

	it('contains the 📊 header with week date', () => {
		const result = formatWeeklyReportMessage(week, null);
		expect(result).toContain('📊 Food Budget');
		expect(result).toContain('Apr 7');
	});

	it('contains meal names and costs', () => {
		const result = formatWeeklyReportMessage(week, null);
		expect(result).toContain('Pancakes');
		expect(result).toContain('$4.50');
		expect(result).toContain('Pasta');
		expect(result).toContain('$8.00');
	});

	it('contains weekly total and avg per meal', () => {
		const result = formatWeeklyReportMessage(week, null);
		expect(result).toContain('$12.50');
		expect(result).toContain('$6.25');
	});

	it('includes comparison when prevWeek is provided', () => {
		const prevWeek: CostHistoryWeek = {
			weekId: '2026-W14',
			startDate: '2026-03-30',
			endDate: '2026-04-05',
			meals: [],
			totalCost: 15.00,
			avgPerMeal: 7.50,
			avgPerServing: 1.88,
			mealCount: 2,
		};
		const result = formatWeeklyReportMessage(week, prevWeek);
		expect(result).toMatch(/↓|↑/);
		expect(result).toContain('last week');
	});

	it('shows most and least expensive meals', () => {
		const result = formatWeeklyReportMessage(week, null);
		// Should mention the most or least expensive meal
		expect(result.toLowerCase()).toMatch(/most expensive|priciest|cheapest|least expensive/);
	});

	it('handles very long recipe names without breaking', () => {
		const longNameWeek: CostHistoryWeek = {
			weekId: '2026-W15',
			startDate: '2026-04-07',
			endDate: '2026-04-13',
			meals: [{ date: '2026-04-07', recipeTitle: 'A'.repeat(100), cost: 10.00, perServing: 2.50 }],
			totalCost: 10.00,
			avgPerMeal: 10.00,
			avgPerServing: 2.50,
			mealCount: 1,
		};
		const msg = formatWeeklyReportMessage(longNameWeek, null);
		expect(msg).toContain('A'.repeat(100));
	});

	it('shows no comparison when prevWeek is null', () => {
		const result = formatWeeklyReportMessage(week, null);
		expect(result).not.toContain('last week');
	});
});

// ─── formatMonthlyReportMessage ───────────────────────────────────────────────

describe('formatMonthlyReportMessage', () => {
	const weeks: CostHistoryWeek[] = [
		{
			weekId: '2026-W14',
			startDate: '2026-03-30',
			endDate: '2026-04-05',
			meals: [{ date: '2026-03-30', recipeTitle: 'Tacos', cost: 10.00, perServing: 2.50 }],
			totalCost: 34.00,
			avgPerMeal: 4.86,
			avgPerServing: 1.21,
			mealCount: 7,
		},
		{
			weekId: '2026-W15',
			startDate: '2026-04-06',
			endDate: '2026-04-12',
			meals: [{ date: '2026-04-07', recipeTitle: 'Pancakes', cost: 4.50, perServing: 1.13 }],
			totalCost: 40.00,
			avgPerMeal: 5.71,
			avgPerServing: 1.43,
			mealCount: 7,
		},
	];

	it('contains the month label', () => {
		const result = formatMonthlyReportMessage('April 2026', weeks, null);
		expect(result).toContain('April 2026');
	});

	it('contains total cost', () => {
		const result = formatMonthlyReportMessage('April 2026', weeks, null);
		expect(result).toContain('$74.00');
	});

	it('includes comparison vs last month when provided', () => {
		const result = formatMonthlyReportMessage('April 2026', weeks, 60.00);
		expect(result).toMatch(/↓|↑/);
		expect(result).toContain('last month');
	});
});

// ─── formatYearlyReportMessage ────────────────────────────────────────────────

describe('formatYearlyReportMessage', () => {
	const months = [
		{ monthLabel: 'Jan', totalCost: 120.00, mealCount: 28 },
		{ monthLabel: 'Feb', totalCost: 105.00, mealCount: 28 },
		{ monthLabel: 'Mar', totalCost: 140.00, mealCount: 30 },
	];

	it('contains year label', () => {
		const result = formatYearlyReportMessage('2026', months);
		expect(result).toContain('2026');
	});

	it('contains monthly totals', () => {
		const result = formatYearlyReportMessage('2026', months);
		expect(result).toContain('$120.00');
		expect(result).toContain('$105.00');
		expect(result).toContain('$140.00');
	});

	it('contains YTD total', () => {
		const result = formatYearlyReportMessage('2026', months);
		// Total: 365.00
		expect(result).toContain('$365.00');
	});

	it('mentions cheapest and priciest months', () => {
		const result = formatYearlyReportMessage('2026', months);
		expect(result.toLowerCase()).toMatch(/cheapest|lowest|priciest|highest/);
	});
});

// ─── saveWeeklyHistory / loadWeeklyHistory ────────────────────────────────────

describe('saveWeeklyHistory', () => {
	it('saves to cost-history/{weekId}.md path', async () => {
		const store = createMockStore();
		const week: CostHistoryWeek = {
			weekId: '2026-W15',
			startDate: '2026-04-07',
			endDate: '2026-04-13',
			meals: [],
			totalCost: 42.00,
			avgPerMeal: 6.00,
			avgPerServing: 1.50,
			mealCount: 7,
		};
		await saveWeeklyHistory(store as never, week);
		expect(store.write).toHaveBeenCalledOnce();
		const [path] = store.write.mock.calls[0] as [string, string];
		expect(path).toBe('cost-history/2026-W15.md');
	});

	it('includes frontmatter in saved file', async () => {
		const store = createMockStore();
		const week: CostHistoryWeek = {
			weekId: '2026-W15',
			startDate: '2026-04-07',
			endDate: '2026-04-13',
			meals: [],
			totalCost: 42.00,
			avgPerMeal: 6.00,
			avgPerServing: 1.50,
			mealCount: 7,
		};
		await saveWeeklyHistory(store as never, week);
		const [, content] = store.write.mock.calls[0] as [string, string];
		expect(content).toMatch(/^---\n/);
		expect(content).toContain('hearthstone');
	});
});

describe('loadWeeklyHistory', () => {
	it('returns null when file does not exist', async () => {
		const store = createMockStore();
		const result = await loadWeeklyHistory(store as never, '2026-W15');
		expect(result).toBeNull();
	});

	it('loads and parses a saved week back', async () => {
		const week: CostHistoryWeek = {
			weekId: '2026-W15',
			startDate: '2026-04-07',
			endDate: '2026-04-13',
			meals: [{ date: '2026-04-07', recipeTitle: 'Pancakes', cost: 4.50, perServing: 1.13 }],
			totalCost: 42.00,
			avgPerMeal: 6.00,
			avgPerServing: 1.50,
			mealCount: 7,
		};

		// Capture what saveWeeklyHistory writes
		let savedContent = '';
		const writeStore = createMockStore({
			write: vi.fn().mockImplementation((_path: string, content: string) => {
				savedContent = content;
				return Promise.resolve();
			}),
		});
		await saveWeeklyHistory(writeStore as never, week);

		// Now load it back
		const readStore = createMockStore({
			read: vi.fn().mockResolvedValue(savedContent),
		});
		const result = await loadWeeklyHistory(readStore as never, '2026-W15');
		expect(result).not.toBeNull();
		expect(result!.weekId).toBe('2026-W15');
		expect(result!.totalCost).toBe(42.00);
		expect(result!.meals).toHaveLength(1);
	});
});

describe('listWeeklyHistories', () => {
	it('returns weekId strings from cost-history directory', async () => {
		const store = createMockStore({
			list: vi.fn().mockResolvedValue(['2026-W13.md', '2026-W14.md', '2026-W15.md']),
		});
		const result = await listWeeklyHistories(store as never);
		expect(result).toEqual(['2026-W13', '2026-W14', '2026-W15']);
	});

	it('returns empty array when no history files', async () => {
		const store = createMockStore();
		const result = await listWeeklyHistories(store as never);
		expect(result).toEqual([]);
	});
});

// ─── checkBudgetAlert ─────────────────────────────────────────────────────────

describe('checkBudgetAlert', () => {
	it('returns null when no historical data', () => {
		const estimates = [makeMealEstimate({ totalCost: 10.00 })];
		const result = checkBudgetAlert(estimates, []);
		expect(result).toBeNull();
	});

	it('returns null when no estimates', () => {
		const result = checkBudgetAlert([], recentWeeks);
		expect(result).toBeNull();
	});

	it('returns null when projected cost is exactly at 15% threshold', () => {
		// Average of recentWeeks = 37.00, exactly 15% above = 42.55
		// Provide estimates totaling exactly 42.55 (should NOT alert — percentAbove <= 15)
		const estimates = [
			makeMealEstimate({ recipeId: 'r-1', recipeTitle: 'Meal A', totalCost: 42.55 }),
		];
		const alert = checkBudgetAlert(estimates, recentWeeks);
		expect(alert).toBeNull();
	});

	it('returns null when projected cost is within budget', () => {
		// Average of recentWeeks = (36+38+34+40)/4 = 37.00
		// 15% threshold → alert if > 37 * 1.15 = 42.55
		// Provide estimates totaling ~35 (within budget)
		const estimates = Array.from({ length: 7 }, (_, i) =>
			makeMealEstimate({ recipeId: `r-${i}`, recipeTitle: `Meal ${i}`, totalCost: 5.00 }),
		);
		const result = checkBudgetAlert(estimates, recentWeeks);
		expect(result).toBeNull();
	});

	it('returns alert when projected cost is >15% above average', () => {
		// Average = 37.00, threshold = 42.55
		// Provide estimates totaling ~55 (well above)
		const estimates = Array.from({ length: 7 }, (_, i) =>
			makeMealEstimate({ recipeId: `r-${i}`, recipeTitle: `Meal ${i}`, totalCost: 8.00 }),
		);
		const result = checkBudgetAlert(estimates, recentWeeks);
		expect(result).not.toBeNull();
		expect(result!.projectedCost).toBeCloseTo(56.00);
		expect(result!.percentAbove).toBeGreaterThan(15);
	});

	it('identifies the most expensive meal in the alert', () => {
		const estimates = [
			makeMealEstimate({ recipeId: 'r-1', recipeTitle: 'Cheap Meal', totalCost: 5.00 }),
			makeMealEstimate({ recipeId: 'r-2', recipeTitle: 'Expensive Steak', totalCost: 30.00 }),
			makeMealEstimate({ recipeId: 'r-3', recipeTitle: 'Medium Meal', totalCost: 8.00 }),
		];
		const result = checkBudgetAlert(estimates, recentWeeks);
		expect(result).not.toBeNull();
		expect(result!.mostExpensiveMeal.title).toBe('Expensive Steak');
		expect(result!.mostExpensiveMeal.cost).toBe(30.00);
	});
});

// ─── formatBudgetAlert ────────────────────────────────────────────────────────

describe('formatBudgetAlert', () => {
	it('contains warning emoji and percentage', () => {
		const alert = {
			projectedCost: 55.00,
			averageCost: 37.00,
			percentAbove: 48.6,
			mostExpensiveMeal: { title: 'Steak Dinner', cost: 25.00 },
		};
		const result = formatBudgetAlert(alert);
		expect(result).toContain('⚠️');
		expect(result).toMatch(/48|49/); // ~48.6%
	});

	it('contains most expensive meal title and cost', () => {
		const alert = {
			projectedCost: 55.00,
			averageCost: 37.00,
			percentAbove: 48.6,
			mostExpensiveMeal: { title: 'Steak Dinner', cost: 25.00 },
		};
		const result = formatBudgetAlert(alert);
		expect(result).toContain('Steak Dinner');
		expect(result).toContain('$25.00');
	});

	it('includes suggestion to swap', () => {
		const alert = {
			projectedCost: 55.00,
			averageCost: 37.00,
			percentAbove: 48.6,
			mostExpensiveMeal: { title: 'Steak Dinner', cost: 25.00 },
		};
		const result = formatBudgetAlert(alert);
		expect(result.toLowerCase()).toMatch(/swap|lower|consider/);
	});

	it('includes the 4-week avg cost', () => {
		const alert = {
			projectedCost: 55.00,
			averageCost: 37.00,
			percentAbove: 48.6,
			mostExpensiveMeal: { title: 'Steak Dinner', cost: 25.00 },
		};
		const result = formatBudgetAlert(alert);
		expect(result).toContain('$37.00');
	});
});
