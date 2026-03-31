import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	archivePlan,
	buildPlanButtons,
	formatPlanMessage,
	formatTonightMessage,
	getTonightsMeal,
	loadCurrentPlan,
	savePlan,
} from '../services/meal-plan-store.js';
import type { MealPlan, PlannedMeal, Recipe } from '../types.js';

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

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'chicken-stir-fry-abc123',
		recipeTitle: 'Chicken Stir Fry',
		date: '2026-03-31',
		mealType: 'dinner',
		votes: {},
		cooked: false,
		rated: false,
		isNew: false,
		...overrides,
	};
}

function makePlan(overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-abc123',
		startDate: '2026-03-31',
		endDate: '2026-04-06',
		meals: [
			makeMeal({ date: '2026-03-31', recipeTitle: 'Chicken Stir Fry' }),
			makeMeal({ date: '2026-04-01', recipeTitle: 'Beef Lasagna', recipeId: 'beef-lasagna-xyz' }),
		],
		status: 'active',
		createdAt: '2026-03-31T00:00:00.000Z',
		updatedAt: '2026-03-31T00:00:00.000Z',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'chicken-stir-fry-abc123',
		title: 'Chicken Stir Fry',
		source: 'homemade',
		ingredients: [{ name: 'chicken breast', quantity: 1, unit: 'lb' }],
		instructions: ['Heat oil in wok.', 'Add chicken and stir fry for 5 minutes.'],
		servings: 4,
		prepTime: 10,
		cookTime: 20,
		tags: ['easy', 'weeknight'],
		cuisine: 'Asian',
		ratings: [{ userId: 'u1', score: 4, date: '2026-01-01' }],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('loadCurrentPlan', () => {
	it('returns null for empty content', async () => {
		const store = createMockScopedStore();
		const result = await loadCurrentPlan(store as any);
		expect(result).toBeNull();
	});

	it('returns null for malformed YAML', async () => {
		const store = createMockScopedStore({
			read: vi.fn().mockResolvedValue('{{{{not valid yaml!!!'),
		});
		const result = await loadCurrentPlan(store as any);
		expect(result).toBeNull();
	});

	it('parses valid YAML with frontmatter', async () => {
		const plan = makePlan();
		const content = '---\ntitle: Meal Plan\ndate: 2026-03-31\n---\n' + stringify(plan);
		const store = createMockScopedStore({
			read: vi.fn().mockResolvedValue(content),
		});
		const result = await loadCurrentPlan(store as any);
		expect(result).not.toBeNull();
		expect(result?.id).toBe('plan-abc123');
		expect(result?.meals).toHaveLength(2);
	});

	it('parses valid YAML without frontmatter', async () => {
		const plan = makePlan();
		const store = createMockScopedStore({
			read: vi.fn().mockResolvedValue(stringify(plan)),
		});
		const result = await loadCurrentPlan(store as any);
		expect(result).not.toBeNull();
		expect(result?.id).toBe('plan-abc123');
	});

	it('reads from correct path', async () => {
		const store = createMockScopedStore();
		await loadCurrentPlan(store as any);
		expect(store.read).toHaveBeenCalledWith('meal-plans/current.yaml');
	});
});

describe('savePlan', () => {
	it('writes to correct path', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		await savePlan(store as any, plan);
		expect(store.write).toHaveBeenCalledWith(
			'meal-plans/current.yaml',
			expect.any(String),
		);
	});

	it('writes with YAML frontmatter header', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		await savePlan(store as any, plan);
		const written = store.write.mock.calls[0][1] as string;
		expect(written).toMatch(/^---\n/);
		expect(written).toContain('app: hearthstone');
	});

	it('updates updatedAt timestamp', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		const before = plan.updatedAt;
		await savePlan(store as any, plan);
		expect(plan.updatedAt).not.toBe(before);
	});

	it('serializes plan data in YAML body', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		await savePlan(store as any, plan);
		const written = store.write.mock.calls[0][1] as string;
		expect(written).toContain('plan-abc123');
		expect(written).toContain('Chicken Stir Fry');
	});
});

describe('archivePlan', () => {
	it('writes to archive path with ISO week filename', async () => {
		const store = createMockScopedStore();
		const plan = makePlan({ startDate: '2026-03-30' }); // 2026-W14
		await archivePlan(store as any, plan);
		const writePath = store.write.mock.calls[0][0] as string;
		expect(writePath).toMatch(/^meal-plans\/archive\//);
		expect(writePath).toMatch(/\.yaml$/);
		expect(writePath).toContain('2026-W');
	});

	it('uses startDate for the archive filename', async () => {
		const store = createMockScopedStore();
		const plan = makePlan({ startDate: '2026-01-05' }); // 2026-W02
		await archivePlan(store as any, plan);
		const writePath = store.write.mock.calls[0][0] as string;
		expect(writePath).toContain('2026-W02');
	});

	it('writes with frontmatter', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		await archivePlan(store as any, plan);
		const written = store.write.mock.calls[0][1] as string;
		expect(written).toMatch(/^---\n/);
	});

	it('includes plan data in body', async () => {
		const store = createMockScopedStore();
		const plan = makePlan();
		await archivePlan(store as any, plan);
		const written = store.write.mock.calls[0][1] as string;
		expect(written).toContain('plan-abc123');
	});
});

describe('getTonightsMeal', () => {
	it('returns meal matching the given date', () => {
		const plan = makePlan();
		const result = getTonightsMeal(plan, '2026-03-31');
		expect(result).not.toBeNull();
		expect(result?.recipeTitle).toBe('Chicken Stir Fry');
	});

	it('returns null when no meal matches the date', () => {
		const plan = makePlan();
		const result = getTonightsMeal(plan, '2026-04-05');
		expect(result).toBeNull();
	});

	it('returns the correct meal from multiple options', () => {
		const plan = makePlan();
		const result = getTonightsMeal(plan, '2026-04-01');
		expect(result?.recipeTitle).toBe('Beef Lasagna');
	});

	it('returns null for empty meal list', () => {
		const plan = makePlan({ meals: [] });
		const result = getTonightsMeal(plan, '2026-03-31');
		expect(result).toBeNull();
	});
});

describe('formatPlanMessage', () => {
	it('includes plan date range header', () => {
		const plan = makePlan();
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('Meal Plan');
		expect(text).toContain('Mar');
	});

	it('shows all meal titles', () => {
		const plan = makePlan();
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('Chicken Stir Fry');
		expect(text).toContain('Beef Lasagna');
	});

	it('shows recipe details for existing recipes (cuisine, time, rating)', () => {
		const plan = makePlan();
		const recipe = makeRecipe();
		const text = formatPlanMessage(plan, [recipe], 'Raleigh, NC');
		expect(text).toContain('Asian');
		expect(text).toContain('30 min');
	});

	it('shows star rating for existing recipes with ratings', () => {
		const plan = makePlan();
		const recipe = makeRecipe({
			ratings: [{ userId: 'u1', score: 4, date: '2026-01-01' }],
		});
		const text = formatPlanMessage(plan, [recipe], 'Raleigh, NC');
		expect(text).toContain('⭐');
	});

	it('shows new suggestion marker for isNew meals', () => {
		const plan = makePlan({
			meals: [
				makeMeal({
					isNew: true,
					recipeTitle: 'Lemon Herb Salmon',
					description: 'Pan-seared salmon with lemon and dill',
				}),
			],
		});
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('✨');
		expect(text).toContain('Lemon Herb Salmon');
		expect(text).toContain('Pan-seared salmon');
	});

	it('includes location in season note', () => {
		const plan = makePlan();
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('Raleigh, NC');
	});

	it('includes usage hints', () => {
		const plan = makePlan();
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('swap');
		expect(text).toContain('grocery');
	});

	it('shows meal count summary', () => {
		const plan = makePlan();
		const text = formatPlanMessage(plan, [], 'Raleigh, NC');
		expect(text).toContain('dinner');
	});
});

describe('formatTonightMessage', () => {
	it('shows meal title in header', () => {
		const meal = makeMeal();
		const recipe = makeRecipe();
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('Chicken Stir Fry');
	});

	it('shows total time when both prepTime and cookTime are set', () => {
		const meal = makeMeal();
		const recipe = makeRecipe({ prepTime: 10, cookTime: 20 });
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('30 min');
	});

	it('shows prep breakdown (prep + cook)', () => {
		const meal = makeMeal();
		const recipe = makeRecipe({ prepTime: 10, cookTime: 20 });
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('10');
		expect(text).toContain('20');
	});

	it('shows servings', () => {
		const meal = makeMeal();
		const recipe = makeRecipe({ servings: 4 });
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('4');
	});

	it('shows first instruction step as quick prep', () => {
		const meal = makeMeal();
		const recipe = makeRecipe({
			instructions: ['Heat oil in wok.', 'Add chicken and stir fry for 5 minutes.'],
		});
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('Heat oil in wok');
	});

	it('truncates long instruction steps at 120 chars', () => {
		const meal = makeMeal();
		const longStep = 'A'.repeat(200);
		const recipe = makeRecipe({ instructions: [longStep] });
		const text = formatTonightMessage(meal, recipe);
		// Should be truncated
		expect(text).not.toContain(longStep);
		// Should contain truncation indicator
		expect(text).toContain('…');
	});

	it('handles new suggestion meal with description', () => {
		const meal = makeMeal({
			isNew: true,
			recipeTitle: 'Lemon Herb Salmon',
			description: 'Pan-seared salmon with lemon and dill.',
		});
		const text = formatTonightMessage(meal, null);
		expect(text).toContain('Lemon Herb Salmon');
		expect(text).toContain('Pan-seared salmon');
	});

	it('handles recipe with no timing info', () => {
		const meal = makeMeal();
		const recipe = makeRecipe({ prepTime: undefined, cookTime: undefined });
		const text = formatTonightMessage(meal, recipe);
		expect(text).toContain('Chicken Stir Fry');
		// Should not throw and should not show "NaN min"
		expect(text).not.toContain('NaN');
	});
});

describe('buildPlanButtons', () => {
	it('returns a non-empty button array', () => {
		const buttons = buildPlanButtons();
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toHaveLength(2);
	});

	it('includes Grocery List button', () => {
		const buttons = buildPlanButtons();
		const flat = buttons.flat();
		const groceryBtn = flat.find((b) => b.text.toLowerCase().includes('grocery'));
		expect(groceryBtn).toBeDefined();
		expect(groceryBtn?.callbackData).toContain('hearthstone');
		expect(groceryBtn?.callbackData).toContain('grocery');
	});

	it('includes Regenerate button', () => {
		const buttons = buildPlanButtons();
		const flat = buttons.flat();
		const regenBtn = flat.find((b) => b.text.toLowerCase().includes('regenerate'));
		expect(regenBtn).toBeDefined();
		expect(regenBtn?.callbackData).toContain('hearthstone');
		expect(regenBtn?.callbackData).toContain('regenerate');
	});

	it('callback data follows app:hearthstone:action format', () => {
		const buttons = buildPlanButtons();
		for (const row of buttons) {
			for (const btn of row) {
				expect(btn.callbackData).toMatch(/^app:hearthstone:/);
			}
		}
	});
});
