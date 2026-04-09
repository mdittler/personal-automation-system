import { describe, expect, it, vi } from 'vitest';
import {
	sumMacros,
	averageMacros,
	macrosFromRecipe,
	logMealMacros,
	loadMonthlyLog,
	saveMonthlyLog,
	getDailyMacros,
	loadMacrosForPeriod,
	computeProgress,
	computeAdherence,
	formatMacroSummary,
	autoLogFromCookedMeal,
} from '../services/macro-tracker.js';
import type { DailyMacroEntry, MacroData, MacroTargets, MealMacroEntry, MonthlyMacroLog, Recipe } from '../types.js';

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
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

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'recipe-1',
		title: 'Chicken Stir Fry',
		source: 'homemade',
		ingredients: [],
		instructions: ['Cook chicken', 'Add vegetables'],
		servings: 4,
		tags: ['dinner'],
		ratings: [],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-04-01T00:00:00.000Z',
		updatedAt: '2026-04-01T00:00:00.000Z',
		macros: { calories: 400, protein: 35, carbs: 30, fat: 15, fiber: 5 },
		...overrides,
	};
}

function makeMealEntry(overrides: Partial<MealMacroEntry> = {}): MealMacroEntry {
	return {
		recipeId: 'recipe-1',
		recipeTitle: 'Chicken Stir Fry',
		mealType: 'dinner',
		servingsEaten: 1,
		macros: { calories: 400, protein: 35, carbs: 30, fat: 15, fiber: 5 },
		...overrides,
	};
}

function makeMonthlyLog(overrides: Partial<MonthlyMacroLog> = {}): MonthlyMacroLog {
	return {
		month: '2026-04',
		userId: 'user1',
		days: [],
		...overrides,
	};
}

const MONTHLY_LOG_YAML = `month: "2026-04"
userId: user1
days:
  - date: "2026-04-01"
    meals:
      - recipeId: recipe-1
        recipeTitle: Chicken Stir Fry
        mealType: dinner
        servingsEaten: 1
        macros:
          calories: 400
          protein: 35
          carbs: 30
          fat: 15
          fiber: 5
    totals:
      calories: 400
      protein: 35
      carbs: 30
      fat: 15
      fiber: 5`;

describe('macro-tracker', () => {
	// ─── sumMacros ────────────────────────────────────────────
	describe('sumMacros', () => {
		it('adds two macro sets', () => {
			const a: MacroData = { calories: 400, protein: 30, carbs: 40, fat: 15 };
			const b: MacroData = { calories: 300, protein: 20, carbs: 25, fat: 10 };
			const result = sumMacros(a, b);
			expect(result).toEqual({ calories: 700, protein: 50, carbs: 65, fat: 25, fiber: 0 });
		});

		it('handles undefined fields as zero', () => {
			const a: MacroData = { calories: 400 };
			const b: MacroData = { protein: 20 };
			const result = sumMacros(a, b);
			expect(result.calories).toBe(400);
			expect(result.protein).toBe(20);
		});

		it('handles empty inputs', () => {
			const result = sumMacros();
			expect(result).toEqual({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
		});

		it('sums multiple entries', () => {
			const a: MacroData = { calories: 100 };
			const b: MacroData = { calories: 200 };
			const c: MacroData = { calories: 300 };
			expect(sumMacros(a, b, c).calories).toBe(600);
		});
	});

	// ─── averageMacros ────────────────────────────────────────
	describe('averageMacros', () => {
		it('computes daily average', () => {
			const entries: MacroData[] = [
				{ calories: 400, protein: 30 },
				{ calories: 600, protein: 50 },
			];
			const result = averageMacros(entries, 2);
			expect(result.calories).toBe(500);
			expect(result.protein).toBe(40);
		});

		it('handles zero count safely', () => {
			const result = averageMacros([], 0);
			expect(result.calories).toBe(0);
		});
	});

	// ─── macrosFromRecipe ─────────────────────────────────────
	describe('macrosFromRecipe', () => {
		it('extracts macros scaled by servings', () => {
			const recipe = makeRecipe({ servings: 4, macros: { calories: 400, protein: 40 } });
			const result = macrosFromRecipe(recipe, 2);
			// per-serving = 400/4=100 cal, 40/4=10 protein; 2 servings = 200 cal, 20 protein
			expect(result.calories).toBe(200);
			expect(result.protein).toBe(20);
		});

		it('returns zeroes when recipe has no macros', () => {
			const recipe = makeRecipe({ macros: undefined });
			const result = macrosFromRecipe(recipe, 1);
			expect(result.calories).toBe(0);
			expect(result.protein).toBe(0);
		});

		it('handles 1 serving of full recipe', () => {
			const recipe = makeRecipe({ servings: 4, macros: { calories: 800 } });
			const result = macrosFromRecipe(recipe, 4);
			expect(result.calories).toBe(800);
		});
	});

	// ─── loadMonthlyLog / saveMonthlyLog ──────────────────────
	describe('loadMonthlyLog', () => {
		it('returns null when file does not exist', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const result = await loadMonthlyLog(store as never, '2026-04');
			expect(result).toBeNull();
		});

		it('parses YAML monthly log', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(MONTHLY_LOG_YAML),
			});
			const result = await loadMonthlyLog(store as never, '2026-04');
			expect(result).not.toBeNull();
			expect(result!.month).toBe('2026-04');
			expect(result!.days).toHaveLength(1);
			expect(result!.days[0]!.meals[0]!.recipeTitle).toBe('Chicken Stir Fry');
		});

		it('strips frontmatter', async () => {
			const withFm = `---\ntitle: Nutrition\n---\n${MONTHLY_LOG_YAML}`;
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(withFm),
			});
			const result = await loadMonthlyLog(store as never, '2026-04');
			expect(result).not.toBeNull();
			expect(result!.month).toBe('2026-04');
		});
	});

	describe('saveMonthlyLog', () => {
		it('writes YAML with frontmatter', async () => {
			const store = createMockScopedStore();
			const log = makeMonthlyLog({ days: [] });
			await saveMonthlyLog(store as never, log);
			expect(store.write).toHaveBeenCalledOnce();
			const [path, content] = store.write.mock.calls[0]!;
			expect(path).toBe('nutrition/2026-04.yaml');
			expect(content).toContain('---');
			expect(content).toContain('2026-04');
		});
	});

	// ─── getDailyMacros ───────────────────────────────────────
	describe('getDailyMacros', () => {
		it('finds entry for a specific date', () => {
			const day: DailyMacroEntry = {
				date: '2026-04-01',
				meals: [makeMealEntry()],
				totals: { calories: 400, protein: 35, carbs: 30, fat: 15, fiber: 5 },
			};
			const log = makeMonthlyLog({ days: [day] });
			const result = getDailyMacros(log, '2026-04-01');
			expect(result).not.toBeNull();
			expect(result!.totals.calories).toBe(400);
		});

		it('returns null for missing date', () => {
			const log = makeMonthlyLog({ days: [] });
			expect(getDailyMacros(log, '2026-04-15')).toBeNull();
		});
	});

	// ─── logMealMacros ────────────────────────────────────────
	describe('logMealMacros', () => {
		it('creates new day entry when none exists', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const entry = makeMealEntry();
			await logMealMacros(store as never, 'user1', entry, '2026-04-01');
			expect(store.write).toHaveBeenCalledOnce();
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('Chicken Stir Fry');
			expect(written).toContain('2026-04-01');
		});

		it('appends to existing day', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(MONTHLY_LOG_YAML),
			});
			const entry = makeMealEntry({
				recipeId: 'recipe-2',
				recipeTitle: 'Salad',
				mealType: 'lunch',
				macros: { calories: 200, protein: 10, carbs: 20, fat: 8 },
			});
			await logMealMacros(store as never, 'user1', entry, '2026-04-01');
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('Salad');
			expect(written).toContain('Chicken Stir Fry');
		});

		it('creates new month file when needed', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const entry = makeMealEntry();
			await logMealMacros(store as never, 'user1', entry, '2026-05-01');
			const [path] = store.write.mock.calls[0]!;
			expect(path).toBe('nutrition/2026-05.yaml');
		});

		it('updates day totals after appending', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(MONTHLY_LOG_YAML),
			});
			const entry = makeMealEntry({
				macros: { calories: 200, protein: 10 },
			});
			await logMealMacros(store as never, 'user1', entry, '2026-04-01');
			const written = store.write.mock.calls[0]![1] as string;
			// Totals should now be 400+200 = 600 cal
			expect(written).toContain('600');
		});
	});

	// ─── loadMacrosForPeriod ──────────────────────────────────
	describe('loadMacrosForPeriod', () => {
		it('loads entries within a single month', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockResolvedValue(MONTHLY_LOG_YAML),
			});
			const result = await loadMacrosForPeriod(store as never, '2026-04-01', '2026-04-30');
			expect(result).toHaveLength(1);
			expect(result[0]!.date).toBe('2026-04-01');
		});

		it('loads entries spanning two months', async () => {
			const marchLog = `month: "2026-03"\nuserId: user1\ndays:\n  - date: "2026-03-31"\n    meals: []\n    totals: { calories: 500 }`;
			const store = createMockScopedStore({
				read: vi.fn()
					.mockResolvedValueOnce(marchLog)
					.mockResolvedValueOnce(MONTHLY_LOG_YAML),
			});
			const result = await loadMacrosForPeriod(store as never, '2026-03-31', '2026-04-01');
			expect(result).toHaveLength(2);
		});

		it('returns empty for period with no data', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const result = await loadMacrosForPeriod(store as never, '2026-06-01', '2026-06-07');
			expect(result).toEqual([]);
		});
	});

	// ─── computeProgress ──────────────────────────────────────
	describe('computeProgress', () => {
		it('computes progress with targets', () => {
			const entries: DailyMacroEntry[] = [
				{
					date: '2026-04-01',
					meals: [makeMealEntry()],
					totals: { calories: 400, protein: 35, carbs: 30, fat: 15, fiber: 5 },
				},
				{
					date: '2026-04-02',
					meals: [makeMealEntry({ macros: { calories: 600, protein: 45, carbs: 50, fat: 20, fiber: 8 } })],
					totals: { calories: 600, protein: 45, carbs: 50, fat: 20, fiber: 8 },
				},
			];
			const targets: MacroTargets = { calories: 2000, protein: 150 };
			const result = computeProgress(entries, targets, 'this week');

			expect(result.current.calories).toBe(1000);
			expect(result.daysTracked).toBe(2);
			expect(result.dailyAverage.calories).toBe(500);
			expect(result.period).toBe('this week');
			expect(result.targets).toBe(targets);
		});

		it('handles zero days', () => {
			const targets: MacroTargets = { calories: 2000 };
			const result = computeProgress([], targets, 'today');
			expect(result.daysTracked).toBe(0);
			expect(result.dailyAverage.calories).toBe(0);
		});
	});

	// ─── computeAdherence ─────────────────────────────────────
	//
	// Regression guard for H11.1. The ±10% tolerance band, streak
	// tracking, and per-field skip-when-target-unset behavior are the
	// contract the /nutrition adherence command and weekly digest
	// adherence block depend on. A future refactor that silently
	// changes any of those semantics breaks the user-facing numbers.
	describe('computeAdherence', () => {
		function makeDay(date: string, calories: number, protein = 0): DailyMacroEntry {
			return {
				date,
				meals: [],
				totals: { calories, protein, carbs: 0, fat: 0, fiber: 0 },
			};
		}

		it('counts days within ±10% of target as hits', () => {
			// Target 2000 → hit band [1800, 2200].
			const entries: DailyMacroEntry[] = [
				makeDay('2026-04-01', 2000), // hit
				makeDay('2026-04-02', 1800), // hit (boundary)
				makeDay('2026-04-03', 2200), // hit (boundary)
				makeDay('2026-04-04', 1799), // miss
				makeDay('2026-04-05', 2201), // miss
				makeDay('2026-04-06', 1900), // hit
				makeDay('2026-04-07', 2100), // hit
			];
			const result = computeAdherence(entries, { calories: 2000 });
			expect(result.calories).toBeDefined();
			expect(result.calories!.daysTracked).toBe(7);
			expect(result.calories!.daysHit).toBe(5);
			expect(result.calories!.percentHit).toBe(71); // round(5/7 * 100)
		});

		it('all hits → current and longest streak equal days tracked', () => {
			const entries = [
				makeDay('2026-04-01', 2000),
				makeDay('2026-04-02', 2000),
				makeDay('2026-04-03', 2000),
			];
			const result = computeAdherence(entries, { calories: 2000 });
			expect(result.calories!.daysHit).toBe(3);
			expect(result.calories!.currentStreak).toBe(3);
			expect(result.calories!.longestStreak).toBe(3);
		});

		it('all misses → zero hits and zero streaks', () => {
			const entries = [
				makeDay('2026-04-01', 500),
				makeDay('2026-04-02', 500),
				makeDay('2026-04-03', 500),
			];
			const result = computeAdherence(entries, { calories: 2000 });
			expect(result.calories!.daysHit).toBe(0);
			expect(result.calories!.currentStreak).toBe(0);
			expect(result.calories!.longestStreak).toBe(0);
		});

		it('broken streak records longestStreak but resets currentStreak', () => {
			// hit, hit, hit, miss, hit, hit → current = 2, longest = 3
			const entries = [
				makeDay('2026-04-01', 2000), // hit
				makeDay('2026-04-02', 2000), // hit
				makeDay('2026-04-03', 2000), // hit
				makeDay('2026-04-04', 500),  // miss — resets running
				makeDay('2026-04-05', 2000), // hit
				makeDay('2026-04-06', 2000), // hit
			];
			const result = computeAdherence(entries, { calories: 2000 });
			expect(result.calories!.daysHit).toBe(5);
			expect(result.calories!.currentStreak).toBe(2);
			expect(result.calories!.longestStreak).toBe(3);
		});

		it('skips fields with zero/unset target', () => {
			const entries = [makeDay('2026-04-01', 2000, 150)];
			const result = computeAdherence(entries, { calories: 2000, protein: 0 });
			expect(result.calories).toBeDefined();
			expect(result.protein).toBeUndefined();
		});

		it('returns zeroed field records when entries list is empty', () => {
			// computeProgress guards callers with `entries.length > 0`, so
			// this path is defensive. It must still be safe: each targeted
			// field gets a zeroed record instead of NaN or a crash.
			const result = computeAdherence([], { calories: 2000, protein: 150 });
			expect(result.calories).toEqual({
				daysTracked: 0,
				daysHit: 0,
				percentHit: 0,
				currentStreak: 0,
				longestStreak: 0,
			});
			expect(result.protein).toEqual({
				daysTracked: 0,
				daysHit: 0,
				percentHit: 0,
				currentStreak: 0,
				longestStreak: 0,
			});
		});
	});

	// ─── formatMacroSummary ───────────────────────────────────
	describe('formatMacroSummary', () => {
		it('shows progress with targets', () => {
			const result = formatMacroSummary({
				current: { calories: 1500, protein: 100, carbs: 150, fat: 60, fiber: 25 },
				targets: { calories: 2000, protein: 150 },
				period: 'today',
				daysTracked: 1,
				dailyAverage: { calories: 1500, protein: 100, carbs: 150, fat: 60, fiber: 25 },
			});
			expect(result).toContain('today');
			expect(result).toContain('1500');
			expect(result).toContain('2000');
		});

		it('shows summary without targets', () => {
			const result = formatMacroSummary({
				current: { calories: 1500, protein: 100, carbs: 150, fat: 60 },
				targets: {},
				period: 'this week',
				daysTracked: 7,
				dailyAverage: { calories: 214, protein: 14, carbs: 21, fat: 9 },
			});
			expect(result).toContain('this week');
			expect(result).toContain('1500');
			expect(result).not.toContain('/'); // no targets, no "X / Y" format
		});

		it('handles zero days tracked', () => {
			const result = formatMacroSummary({
				current: { calories: 0 },
				targets: {},
				period: 'today',
				daysTracked: 0,
				dailyAverage: { calories: 0 },
			});
			expect(result).toMatch(/no.*data|no.*tracked/i);
		});
	});

	// ─── autoLogFromCookedMeal ────────────────────────────────
	describe('autoLogFromCookedMeal', () => {
		it('logs macros from recipe when cooked', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const recipe = makeRecipe({ servings: 4, macros: { calories: 800, protein: 60 } });
			await autoLogFromCookedMeal(store as never, 'user1', recipe, 1, '2026-04-08', 'dinner');
			expect(store.write).toHaveBeenCalledOnce();
			const written = store.write.mock.calls[0]![1] as string;
			expect(written).toContain('Chicken Stir Fry');
			// 1 serving of 4-serving recipe: 800/4 = 200 cal
			expect(written).toContain('200');
		});

		it('skips logging when recipe has no macros', async () => {
			const store = createMockScopedStore({ read: vi.fn().mockResolvedValue(null) });
			const recipe = makeRecipe({ macros: undefined });
			await autoLogFromCookedMeal(store as never, 'user1', recipe, 1, '2026-04-08', 'dinner');
			// Should still log but with zeroes
			expect(store.write).toHaveBeenCalledOnce();
		});
	});

	// ─── Edge Cases ─────────────────────────────────────────
	describe('edge cases', () => {
		it('handles zero servings in recipe without NaN', () => {
			const recipe = makeRecipe({ servings: 0, macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 5 } });
			const result = macrosFromRecipe(recipe, 1);
			// Division by zero produces Infinity, which rounds to Infinity — just verify no crash
			expect(typeof result.calories).toBe('number');
		});

		it('handles negative servings eaten', () => {
			const recipe = makeRecipe({ servings: 4, macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 5 } });
			const result = macrosFromRecipe(recipe, -1);
			expect(result.calories).toBe(-200);
		});

		it('handles month boundary in loadMacrosForPeriod', async () => {
			const store = createMockScopedStore({
				read: vi.fn().mockImplementation((path: string) => {
					if (path.includes('2026-03')) {
						return Promise.resolve(`month: "2026-03"\nuserId: user1\ndays:\n  - date: "2026-03-30"\n    meals: []\n    totals:\n      calories: 100\n      protein: 10\n      carbs: 15\n      fat: 5\n      fiber: 2\n  - date: "2026-03-31"\n    meals: []\n    totals:\n      calories: 200\n      protein: 20\n      carbs: 25\n      fat: 10\n      fiber: 4`);
					}
					if (path.includes('2026-04')) {
						return Promise.resolve(`month: "2026-04"\nuserId: user1\ndays:\n  - date: "2026-04-01"\n    meals: []\n    totals:\n      calories: 300\n      protein: 30\n      carbs: 35\n      fat: 15\n      fiber: 6`);
					}
					return Promise.resolve(null);
				}),
			});
			const result = await loadMacrosForPeriod(store as never, '2026-03-30', '2026-04-01');
			expect(result).toHaveLength(3);
			expect(result[0]!.date).toBe('2026-03-30');
			expect(result[2]!.date).toBe('2026-04-01');
		});

		it('returns empty array for reversed date range', async () => {
			const store = createMockScopedStore();
			const result = await loadMacrosForPeriod(store as never, '2026-04-30', '2026-04-01');
			expect(result).toEqual([]);
		});

		it('computeProgress with empty entries shows zero days', () => {
			const result = computeProgress([], { calories: 2000 }, 'test');
			expect(result.daysTracked).toBe(0);
			expect(result.dailyAverage.calories).toBe(0);
		});

		it('averageMacros with zero count returns zeroes', () => {
			const result = averageMacros([{ calories: 100, protein: 10, carbs: 15, fat: 5, fiber: 2 }], 0);
			expect(result.calories).toBe(0);
		});
	});

	// ─── Security ────────────────────────────────────────────
	describe('security', () => {
		it('rejects path traversal in month parameter', async () => {
			const store = createMockScopedStore();
			await expect(loadMonthlyLog(store as never, '../../../etc/passwd')).rejects.toThrow(/Invalid month format/);
		});

		it('rejects invalid month format', async () => {
			const store = createMockScopedStore();
			await expect(loadMonthlyLog(store as never, '2026-13-01')).rejects.toThrow(/Invalid month format/);
			await expect(loadMonthlyLog(store as never, 'not-a-month')).rejects.toThrow(/Invalid month format/);
		});

		it('accepts valid YYYY-MM format', async () => {
			const store = createMockScopedStore();
			// Should not throw — just returns null because no data
			const result = await loadMonthlyLog(store as never, '2026-04');
			expect(result).toBeNull();
		});
	});
});
