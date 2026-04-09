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
import {
	beginQuickMealAdd,
	beginQuickMealEdit,
	handleQuickMealAddReply,
	handleQuickMealAddCallback,
	handleQuickMealEditReply,
	handleQuickMealEditCallback,
	hasPendingQuickMealAdd,
	hasPendingQuickMealEdit,
	__resetQuickMealFlowForTests,
} from '../../handlers/quick-meal-flow.js';
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

interface BuildServicesOverrides {
	llm?: {
		complete?: ReturnType<typeof vi.fn>;
		getModelForTier?: ReturnType<typeof vi.fn>;
		classify?: ReturnType<typeof vi.fn>;
		extractStructured?: ReturnType<typeof vi.fn>;
	};
}

function buildServices(
	userStore: ReturnType<typeof buildUserStore>,
	telegram: TelegramSpy,
	overrides: BuildServicesOverrides = {},
) {
	const defaultLlm = {
		complete: vi.fn().mockResolvedValue('ok'),
		getModelForTier: vi.fn().mockReturnValue('anthropic/claude-haiku-4-5'),
		classify: vi.fn(),
		extractStructured: vi.fn(),
	};
	return {
		telegram,
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		llm: {
			...defaultLlm,
			...(overrides.llm ?? {}),
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

describe('H11.w — /nutrition meals add guided flow', () => {
	beforeEach(() => __resetQuickMealFlowForTests());

	it('walks through all 4 steps and saves the template', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram, {
			llm: {
				complete: vi.fn().mockResolvedValue(JSON.stringify({
					calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12,
					confidence: 0.75, reasoning: 'standard Chipotle bowl',
				})),
				getModelForTier: vi.fn().mockReturnValue('anthropic/claude-haiku-4-5'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
		});

		// Step 0: begin
		await dispatchAs('u1', () => beginQuickMealAdd(services as never, 'u1'));
		expect(telegram.lastMessage).toMatch(/what do you want to call/i);
		expect(hasPendingQuickMealAdd('u1')).toBe(true);

		// Step 1: label reply
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'Chipotle chicken bowl'),
		);
		expect(telegram.lastMessage).toMatch(/kind of meal/i);
		expect((telegram.lastButtons as unknown[])?.length ?? 0).toBeGreaterThanOrEqual(1);

		// Step 2: kind callback
		await dispatchAs('u1', () =>
			handleQuickMealAddCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:add:kind:restaurant',
			),
		);
		expect(telegram.lastMessage).toMatch(/ingredients/i);

		// Step 3: ingredients reply
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(
				services as never,
				userStore as never,
				'u1',
				'brown rice\nchicken\nguac\nsalsa',
			),
		);
		expect(telegram.lastMessage).toMatch(/notes/i);

		// Step 4: notes reply — skip + LLM call + confirm
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'skip'),
		);
		expect(telegram.lastMessage).toMatch(/850 cal/);
		const confirmButtons = telegram.lastButtons as Array<Array<{ text: string; callbackData: string }>>;
		expect(confirmButtons.flat().map((b) => b.text)).toContain('Save');

		// Step 5: save callback
		await dispatchAs('u1', () =>
			handleQuickMealAddCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:add:confirm:save',
			),
		);
		expect(telegram.lastMessage).toMatch(/saved quick-meal/i);

		// Verify persistence
		const list = await loadQuickMeals(userStore as never);
		expect(list).toHaveLength(1);
		expect(list[0]!.label).toBe('Chipotle chicken bowl');
		expect(list[0]!.kind).toBe('restaurant');
		expect(list[0]!.ingredients).toEqual(['brown rice', 'chicken', 'guac', 'salsa']);
		expect(list[0]!.estimatedMacros.calories).toBe(850);
		expect(list[0]!.confidence).toBe(0.75);
		expect(hasPendingQuickMealAdd('u1')).toBe(false);
	});

	it('cancel reply aborts the flow', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);

		await dispatchAs('u1', () => beginQuickMealAdd(services as never, 'u1'));
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'cancel'),
		);

		expect(hasPendingQuickMealAdd('u1')).toBe(false);
		expect(telegram.lastMessage).toMatch(/cancel/i);
	});

	it('LLM failure on confirmation step exits cleanly', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram, {
			llm: {
				complete: vi.fn().mockResolvedValue('not json'),
				getModelForTier: vi.fn().mockReturnValue('x'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
		});

		await dispatchAs('u1', () => beginQuickMealAdd(services as never, 'u1'));
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'Mystery meal'),
		);
		await dispatchAs('u1', () =>
			handleQuickMealAddCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:add:kind:home',
			),
		);
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'stuff'),
		);
		await dispatchAs('u1', () =>
			handleQuickMealAddReply(services as never, userStore as never, 'u1', 'skip'),
		);

		expect(telegram.lastMessage).toMatch(/couldn't estimate/i);
		expect(hasPendingQuickMealAdd('u1')).toBe(false);
	});

	it('nutrition meals add command kicks off the flow', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['meals', 'add'], 'u1', sharedStore as never),
		);

		expect(hasPendingQuickMealAdd('u1')).toBe(true);
		expect(telegram.lastMessage).toMatch(/what do you want to call/i);
	});
});

describe('H11.w — /nutrition meals edit guided flow', () => {
	beforeEach(() => __resetQuickMealFlowForTests());

	it('editing ingredients re-runs LLM and updates macros; id stays stable', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const llmComplete = vi.fn().mockResolvedValue(
			JSON.stringify({
				calories: 920,
				protein: 52,
				carbs: 85,
				fat: 40,
				fiber: 14,
				confidence: 0.8,
				reasoning: 'updated chipotle bowl estimate',
			}),
		);
		const services = buildServices(userStore, telegram, {
			llm: {
				complete: llmComplete,
				getModelForTier: vi.fn().mockReturnValue('anthropic/claude-haiku-4-5'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
		});
		const sharedStore = buildUserStore();

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'chipotle-bowl',
				label: 'Chipotle bowl',
				kind: 'restaurant',
				ingredients: ['brown rice', 'chicken'],
				estimatedMacros: { calories: 700, protein: 40, carbs: 70, fat: 25, fiber: 10 },
				confidence: 0.7,
				usageCount: 5,
			}),
		);

		// Entry: /nutrition meals edit chipotle bowl
		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['meals', 'edit', 'chipotle', 'bowl'],
				'u1',
				sharedStore as never,
			),
		);
		expect(hasPendingQuickMealEdit('u1')).toBe(true);
		expect(telegram.lastMessage).toMatch(/edit quick-meal/i);
		expect(telegram.lastMessage).toContain('Chipotle bowl');

		// Pick Ingredients
		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:ingredients',
			),
		);
		expect(telegram.lastMessage).toMatch(/ingredients/i);

		// Supply new ingredients
		await dispatchAs('u1', () =>
			handleQuickMealEditReply(
				services as never,
				userStore as never,
				'u1',
				'brown rice\nchicken\nguac\nsalsa\nsour cream',
			),
		);
		expect(llmComplete).toHaveBeenCalledTimes(1);
		expect(telegram.lastMessage).toMatch(/920 cal/);

		// Confirm save (returns to picker)
		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:confirm:save',
			),
		);
		expect(telegram.lastMessage).toMatch(/edit quick-meal/i);

		// Done
		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:done',
			),
		);
		expect(telegram.lastMessage).toMatch(/updated quick-meal/i);
		expect(hasPendingQuickMealEdit('u1')).toBe(false);

		const list = await loadQuickMeals(userStore as never);
		expect(list).toHaveLength(1);
		const saved = list[0]!;
		expect(saved.id).toBe('chipotle-bowl');
		expect(saved.ingredients).toContain('guac');
		expect(saved.estimatedMacros.calories).toBe(920);
		expect(saved.estimatedMacros.protein).toBe(52);
		expect(saved.confidence).toBe(0.8);
		expect(saved.usageCount).toBe(5);
	});

	it('editing label only does NOT call the LLM and keeps id stable', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const llmComplete = vi.fn();
		const services = buildServices(userStore, telegram, {
			llm: {
				complete: llmComplete,
				getModelForTier: vi.fn().mockReturnValue('anthropic/claude-haiku-4-5'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
		});
		const sharedStore = buildUserStore();

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'breakfast-oats',
				label: 'Breakfast oats',
				kind: 'home',
				ingredients: ['oats', 'milk'],
				estimatedMacros: { calories: 450, protein: 20, carbs: 70, fat: 10, fiber: 8 },
				confidence: 0.85,
				usageCount: 3,
			}),
		);

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['meals', 'edit', 'breakfast', 'oats'],
				'u1',
				sharedStore as never,
			),
		);

		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:label',
			),
		);

		await dispatchAs('u1', () =>
			handleQuickMealEditReply(
				services as never,
				userStore as never,
				'u1',
				'Overnight oats w/ berries',
			),
		);

		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:done',
			),
		);

		expect(llmComplete).not.toHaveBeenCalled();
		const list = await loadQuickMeals(userStore as never);
		expect(list).toHaveLength(1);
		expect(list[0]!.id).toBe('breakfast-oats');
		expect(list[0]!.label).toBe('Overnight oats w/ berries');
		expect(list[0]!.estimatedMacros.calories).toBe(450);
		expect(list[0]!.usageCount).toBe(3);
	});

	it('editing kind only — picker re-appears after field edit, Done commits', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const llmComplete = vi.fn();
		const services = buildServices(userStore, telegram, {
			llm: {
				complete: llmComplete,
				getModelForTier: vi.fn().mockReturnValue('anthropic/claude-haiku-4-5'),
				classify: vi.fn(),
				extractStructured: vi.fn(),
			},
		});
		const sharedStore = buildUserStore();

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'pad-thai',
				label: 'Pad Thai',
				kind: 'home',
			}),
		);

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['meals', 'edit', 'pad', 'thai'],
				'u1',
				sharedStore as never,
			),
		);

		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:kind',
			),
		);
		expect(telegram.lastMessage).toMatch(/kind/i);

		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:kind:restaurant',
			),
		);
		// Picker should re-appear
		expect(telegram.lastMessage).toMatch(/edit quick-meal/i);

		await dispatchAs('u1', () =>
			handleQuickMealEditCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:meals:edit:field:done',
			),
		);

		expect(llmComplete).not.toHaveBeenCalled();
		const list = await loadQuickMeals(userStore as never);
		expect(list[0]!.kind).toBe('restaurant');
		expect(list[0]!.id).toBe('pad-thai');
	});

	it('edit nonexistent label reports no match and does not begin flow', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['meals', 'edit', 'nonexistent'],
				'u1',
				sharedStore as never,
			),
		);

		expect(telegram.lastMessage).toMatch(/no quick-meal matches/i);
		expect(telegram.lastMessage).toContain('nonexistent');
		expect(hasPendingQuickMealEdit('u1')).toBe(false);
	});
});

describe('H11.w — /nutrition log quick-pick grid and quick-meal path', () => {
	it('no-args shows top-5 most-used quick-meal buttons', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		// Seed 7 quick-meals with usageCount 0..6.
		for (let i = 0; i < 7; i++) {
			await saveQuickMeal(
				userStore as never,
				quickMealFixture({
					id: `meal-${i}`,
					label: `Meal ${i}`,
					usageCount: i,
					estimatedMacros: { calories: 100 + i * 10, protein: 10, carbs: 20, fat: 5, fiber: 2 },
				}),
			);
		}

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['log'], 'u1', sharedStore as never),
		);

		expect(telegram.sendWithButtons).toHaveBeenCalled();
		const buttons = telegram.lastButtons as Array<Array<{ text: string; callbackData: string }>>;
		const flat = buttons.flat();
		const quickMealButtons = flat.filter((b) => b.callbackData.startsWith('app:food:nut:log:quickmeal:'));
		expect(quickMealButtons.length).toBeGreaterThanOrEqual(5);
		// Highest usage = Meal 6 — should be in the first quick-meal button.
		expect(quickMealButtons[0]!.text).toContain('Meal 6');
		// Escape row present.
		expect(flat.some((b) => b.callbackData === 'app:food:nut:log:adhoc-prompt')).toBe(true);
	});

	it('no-args with empty quick-meal store sends usage message (no buttons)', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await dispatchAs('u1', () =>
			handleNutritionCommand(services as never, ['log'], 'u1', sharedStore as never),
		);

		expect(telegram.sendWithButtons).not.toHaveBeenCalled();
		expect(telegram.lastMessage).toMatch(/usage/i);
		expect(telegram.lastMessage).toMatch(/meals add/i);
	});

	it('quick-meal log via callback with portion 1 logs at full macros and bumps usageCount', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'chipotle-bowl',
				label: 'Chipotle bowl',
				kind: 'restaurant',
				estimatedMacros: { calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12 },
				confidence: 0.75,
				usageCount: 1,
			}),
		);

		// Use the callback router the same way handleCallbackQuery would.
		const { handleQuickMealLogCallback } = await import('../../handlers/quick-meal-log.js');
		await dispatchAs('u1', () =>
			handleQuickMealLogCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:log:quickmeal:chipotle-bowl:1',
			),
		);

		// Read back the log.
		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		expect(key).toBeDefined();
		const log = await readLoggedEntries(
			userStore,
			key!.replace('nutrition/', '').replace('.yaml', ''),
		);
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.sourceId).toBe('chipotle-bowl');
		expect(entry.estimationKind).toBe('quick-meal');
		expect(entry.confidence).toBe(0.75);
		expect(entry.macros.calories).toBe(850);
		expect(entry.servingsEaten).toBe(1);

		// usageCount bumped to 2.
		const list = await loadQuickMeals(userStore as never);
		const updated = list.find((m) => m.id === 'chipotle-bowl')!;
		expect(updated.usageCount).toBe(2);
	});

	it('quick-meal log via callback with portion 0.5 scales macros', async () => {
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'chipotle-bowl',
				label: 'Chipotle bowl',
				kind: 'restaurant',
				estimatedMacros: { calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12 },
				confidence: 0.75,
				usageCount: 1,
			}),
		);

		const { handleQuickMealLogCallback } = await import('../../handlers/quick-meal-log.js');
		await dispatchAs('u1', () =>
			handleQuickMealLogCallback(
				services as never,
				userStore as never,
				'u1',
				'app:food:nut:log:quickmeal:chipotle-bowl:0.5',
			),
		);

		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/'));
		const log = await readLoggedEntries(
			userStore,
			key!.replace('nutrition/', '').replace('.yaml', ''),
		);
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.servingsEaten).toBe(0.5);
		expect(entry.macros.calories).toBe(425);
		expect(entry.macros.protein).toBe(25);
	});

	it('/nutrition log <label> falls through to quick-meal match when no recipe matches', async () => {
		mockRecipes.current = []; // no recipes
		const userStore = buildUserStore();
		const telegram = buildTelegramSpy();
		const services = buildServices(userStore, telegram);
		const sharedStore = buildUserStore();

		await saveQuickMeal(
			userStore as never,
			quickMealFixture({
				id: 'chipotle-bowl',
				label: 'Chipotle bowl',
				kind: 'restaurant',
				estimatedMacros: { calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12 },
				confidence: 0.75,
				usageCount: 0,
			}),
		);

		await dispatchAs('u1', () =>
			handleNutritionCommand(
				services as never,
				['log', 'chipotle', 'bowl', '1'],
				'u1',
				sharedStore as never,
			),
		);

		const key = Array.from(userStore.files.keys()).find((k) => k.startsWith('nutrition/') && k.endsWith('.yaml'));
		expect(key).toBeDefined();
		const log = await readLoggedEntries(
			userStore,
			key!.replace('nutrition/', '').replace('.yaml', ''),
		);
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.sourceId).toBe('chipotle-bowl');
		expect(entry.estimationKind).toBe('quick-meal');
		expect(entry.macros.calories).toBe(850);
	});
});
