/**
 * Integration test — H11.w Task 9: recipe-reference /nutrition log path.
 *
 * Exercises `handleNutritionCommand(['log', ...])` for the new smart-log
 * dispatcher:
 *   1. Legacy numeric form (6+ args) still works (back-compat fence).
 *   2. Recipe-reference path scales the recipe's per-serving macros by
 *      the parsed portion and persists a MealMacroEntry with
 *      estimationKind='recipe' and sourceId=<recipeId>.
 *   3. Ambiguous matches emit inline buttons plus a "none of these" escape.
 *   4. No-match emits a placeholder message (quick-meal / ad-hoc arrive in
 *      later H11.w tasks).
 *
 * Uses vi.mock on `recipe-store.js` to control `loadAllRecipes` directly;
 * seeding recipe YAML files is more ceremony than this focused test needs.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestContext } from '../../../../../core/src/services/context/request-context.js';
import { saveQuickMeal, loadQuickMeals } from '../../services/quick-meals-store.js';
import type { Recipe, MonthlyMacroLog, QuickMealTemplate } from '../../types.js';

// Mock loadAllRecipes so each test can control the recipe library without
// needing to write real YAML files through recipe-store's formatter.
const mockRecipes = vi.hoisted(() => ({ current: [] as Recipe[] }));
vi.mock('../../services/recipe-store.js', async () => {
	const actual = await vi.importActual<typeof import('../../services/recipe-store.js')>(
		'../../services/recipe-store.js',
	);
	return {
		...actual,
		loadAllRecipes: vi.fn(async () => mockRecipes.current),
	};
});

// Import AFTER vi.mock so the handler sees the mocked loadAllRecipes.
const { handleNutritionCommand } = await import('../../handlers/nutrition.js');

function dispatchAs<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, fn);
}

function makeRecipe(partial: Partial<Recipe> & { id: string; title: string }): Recipe {
	return {
		id: partial.id,
		title: partial.title,
		source: 'test',
		ingredients: [],
		instructions: [],
		servings: 1,
		tags: [],
		ratings: [],
		history: [],
		allergens: [],
		status: 'active',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...partial,
	};
}

/** Stateful per-user scoped store backed by an in-memory Map. */
function buildUserStore() {
	const files = new Map<string, string>();
	return {
		files,
		read: vi.fn(async (path: string) => files.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		append: vi.fn(async (path: string, content: string) => {
			files.set(path, (files.get(path) ?? '') + content);
		}),
		exists: vi.fn(async (path: string) => files.has(path)),
		list: vi.fn(async () => [] as string[]),
		archive: vi.fn(async () => undefined),
	};
}

type TelegramSpy = {
	lastMessage: string | null;
	lastButtons: unknown;
	messages: Array<{ userId: string; text: string }>;
	send: ReturnType<typeof vi.fn>;
	sendWithButtons: ReturnType<typeof vi.fn>;
};

function buildTelegramSpy(): TelegramSpy {
	const spy: TelegramSpy = {
		lastMessage: null,
		lastButtons: null,
		messages: [],
		send: vi.fn(),
		sendWithButtons: vi.fn(),
	};
	spy.send.mockImplementation(async (userId: string, text: string) => {
		spy.lastMessage = text;
		spy.messages.push({ userId, text });
	});
	spy.sendWithButtons.mockImplementation(async (userId: string, text: string, buttons: unknown) => {
		spy.lastMessage = text;
		spy.lastButtons = buttons;
	});
	return spy;
}

function buildServices(userStore: ReturnType<typeof buildUserStore>, telegram: TelegramSpy) {
	return {
		telegram,
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		llm: {
			complete: vi.fn().mockResolvedValue('ok'),
		},
		config: {
			get: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockResolvedValue({}),
			setAll: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
		},
		data: {
			forUser: vi.fn().mockReturnValue(userStore),
		},
		timezone: 'UTC',
	};
}

// Load the persisted monthly log from the user store. Uses the same YAML
// shape that macro-tracker.saveMonthlyLog produces.
async function readLoggedEntries(
	userStore: ReturnType<typeof buildUserStore>,
	month: string,
): Promise<MonthlyMacroLog | null> {
	const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
	const { parse } = await import('yaml');
	const raw = userStore.files.get(`nutrition/${month}.yaml`);
	if (!raw) return null;
	const content = stripFrontmatter(raw);
	return parse(content) as MonthlyMacroLog;
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-food-smart-log-'));
	mockRecipes.current = [];
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.clearAllMocks();
});

describe('H11.w — /nutrition log <recipe-name> <portion>', () => {
	it('scales a recipes cached macros by portion', async () => {
		mockRecipes.current = [
			makeRecipe({
				id: 'lasagna-abc123',
				title: 'Lasagna',
				macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 6 },
			}),
		];
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['log', 'lasagna', 'half'], 'u1', sharedStore as never),
		);

		// Find the log file across any month written.
		const month = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		expect(month).toBeDefined();
		const log = await readLoggedEntries(userStore, month!.replace('nutrition/', '').replace('.yaml', ''));
		expect(log).not.toBeNull();
		expect(log!.days).toHaveLength(1);
		expect(log!.days[0]!.meals).toHaveLength(1);
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.servingsEaten).toBe(0.5);
		expect(entry.macros.calories).toBe(400);
		expect(entry.macros.protein).toBe(20);
		expect(entry.estimationKind).toBe('recipe');
		expect(entry.sourceId).toBe('lasagna-abc123');
		expect(entry.recipeId).toBe('lasagna-abc123');
		expect(telegram.lastMessage).toMatch(/logged/i);
	});

	it('accepts numeric portion values', async () => {
		mockRecipes.current = [
			makeRecipe({
				id: 'lasagna-abc123',
				title: 'Lasagna',
				macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 6 },
			}),
		];
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['log', 'lasagna', '1.5'], 'u1', sharedStore as never),
		);

		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		const log = await readLoggedEntries(userStore, key!.replace('nutrition/', '').replace('.yaml', ''));
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.servingsEaten).toBe(1.5);
		expect(entry.macros.calories).toBe(1200);
		expect(entry.macros.protein).toBe(60);
	});

	it('defaults portion to 1 when no portion supplied', async () => {
		mockRecipes.current = [
			makeRecipe({
				id: 'lasagna-abc123',
				title: 'Lasagna',
				macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 6 },
			}),
		];
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['log', 'lasagna'], 'u1', sharedStore as never),
		);

		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		const log = await readLoggedEntries(userStore, key!.replace('nutrition/', '').replace('.yaml', ''));
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.servingsEaten).toBe(1);
		expect(entry.macros.calories).toBe(800);
	});

	it('returns ambiguity buttons when two recipes match', async () => {
		mockRecipes.current = [
			makeRecipe({
				id: 'chicken-curry-red-1',
				title: 'Red Chicken Curry',
				macros: { calories: 500, protein: 35, carbs: 20, fat: 25, fiber: 4 },
			}),
			makeRecipe({
				id: 'chicken-curry-green-2',
				title: 'Green Chicken Curry',
				macros: { calories: 480, protein: 34, carbs: 18, fat: 23, fiber: 3 },
			}),
		];
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['log', 'chicken', 'curry', '1'],
				'u1',
				sharedStore as never,
			),
		);

		expect(telegram.sendWithButtons).toHaveBeenCalled();
		const buttons = telegram.lastButtons as Array<Array<{ text: string; callbackData: string }>>;
		expect(buttons.length).toBeGreaterThanOrEqual(2); // 2 recipes + escape row
		expect(telegram.lastMessage).toMatch(/which/i);
		// First two rows should be the two candidate recipes.
		const allCallbackData = buttons.flat().map((b) => b.callbackData);
		expect(allCallbackData.some((c) => c.includes('chicken-curry-red-1'))).toBe(true);
		expect(allCallbackData.some((c) => c.includes('chicken-curry-green-2'))).toBe(true);
		expect(allCallbackData.some((c) => c === 'app:food:nut:log:none')).toBe(true);
		// Nothing persisted.
		expect(Array.from(userStore.files.keys()).some((k) => k.startsWith('nutrition/'))).toBe(false);
	});

	it('emits placeholder on no match', async () => {
		mockRecipes.current = [
			makeRecipe({
				id: 'lasagna-abc123',
				title: 'Lasagna',
				macros: { calories: 800, protein: 40, carbs: 60, fat: 30, fiber: 6 },
			}),
		];
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['log', 'unknownmeal', '1'],
				'u1',
				sharedStore as never,
			),
		);

		expect(telegram.lastMessage).toMatch(/no recipe/i);
		expect(Array.from(userStore.files.keys()).some((k) => k.startsWith('nutrition/'))).toBe(false);
	});

	it('preserves legacy numeric form for back-compat', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['log', 'lunch', '600', '40', '50', '20', '8'],
				'u1',
				sharedStore as never,
			),
		);

		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		expect(key).toBeDefined();
		const log = await readLoggedEntries(userStore, key!.replace('nutrition/', '').replace('.yaml', ''));
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.recipeId).toBe('manual');
		expect(entry.recipeTitle).toBe('lunch');
		expect(entry.macros.calories).toBe(600);
		expect(entry.macros.protein).toBe(40);
	});
});

function quickMealFixture(overrides: Partial<QuickMealTemplate> = {}): QuickMealTemplate {
	return {
		id: 'm1',
		userId: 'u1',
		label: 'Meal',
		kind: 'home',
		ingredients: ['rice'],
		estimatedMacros: { calories: 500, protein: 20, carbs: 60, fat: 15, fiber: 5 },
		confidence: 0.7,
		llmModel: 'test-model',
		usageCount: 0,
		createdAt: '2026-04-09T00:00:00Z',
		updatedAt: '2026-04-09T00:00:00Z',
		...overrides,
	};
}

describe('H11.w — /nutrition meals list + remove', () => {
	it('lists quick-meals grouped by kind and sorted by usageCount desc', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await saveQuickMeal(userStore as never, quickMealFixture({ id: 'a', label: 'A', kind: 'home', usageCount: 1 }));
		await saveQuickMeal(userStore as never, quickMealFixture({ id: 'b', label: 'B', kind: 'restaurant', usageCount: 5 }));
		await saveQuickMeal(userStore as never, quickMealFixture({ id: 'c', label: 'C', kind: 'home', usageCount: 3 }));

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['meals', 'list'], 'u1', sharedStore as never),
		);

		const msg = telegram.lastMessage ?? '';
		expect(msg).toContain('A');
		expect(msg).toContain('B');
		expect(msg).toContain('C');
		// C (home, 3) must appear before A (home, 1) in the home group.
		expect(msg.indexOf('C')).toBeLessThan(msg.indexOf('A'));
		// restaurant section must appear and contain B.
		expect(msg).toMatch(/restaurant/i);
	});

	it('shows an empty-state hint when no quick-meals exist', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['meals', 'list'], 'u1', sharedStore as never),
		);
		expect(telegram.lastMessage).toMatch(/no quick-meals/i);
		expect(telegram.lastMessage).toMatch(/meals add/i);
	});

	it('removes a quick-meal by label (case-insensitive slugify)', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await saveQuickMeal(userStore as never, quickMealFixture({ id: 'chipotle-bowl', label: 'Chipotle Bowl' }));
		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['meals', 'remove', 'chipotle', 'bowl'], 'u1', sharedStore as never),
		);
		const list = await loadQuickMeals(userStore as never);
		expect(list).toHaveLength(0);
		expect(telegram.lastMessage).toMatch(/removed/i);
	});

	it('remove with no label arg shows usage', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['meals', 'remove'], 'u1', sharedStore as never),
		);
		expect(telegram.lastMessage).toMatch(/usage/i);
	});
});
