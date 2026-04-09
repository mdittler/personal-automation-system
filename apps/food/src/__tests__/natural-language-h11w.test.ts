/**
 * H11.w Task 15 — Natural-language meal-log routing tests.
 *
 * Verifies that free-text phrasings like "I had X", "I ate X", "I just
 * finished X", "log X", etc. are detected by `isLogMealNLIntent` and
 * dispatched through `handleNutritionLogNL` into the shared smart-log
 * pipeline (recipe → quick-meal → ad-hoc LLM) without tripping the
 * legacy 6-arg numeric guard in /nutrition log.
 *
 * Negative tests fence the existing `isNutritionViewIntent` path so
 * that "how are my macros" and "what should I eat" keep working.
 *
 * Mirrors the harness style of natural-language-h11x.test.ts — single
 * shared store mock, real handleMessage, assertions on persisted
 * nutrition/YYYY-MM.yaml writes.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { handleMessage, init } from '../index.js';
import type { Household, MonthlyMacroLog, QuickMealTemplate, Recipe } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const lasagnaRecipe: Recipe = {
	id: 'r-lasagna',
	title: 'Classic Lasagna',
	source: 'homemade',
	ingredients: [{ name: 'pasta', quantity: 1, unit: 'lb' }],
	instructions: ['Layer and bake'],
	servings: 1, // per-serving macros already normalized
	tags: [],
	cuisine: 'Italian',
	ratings: [],
	history: [],
	allergens: [],
	status: 'confirmed',
	createdAt: '2026-02-01T00:00:00.000Z',
	updatedAt: '2026-02-01T00:00:00.000Z',
	macros: { calories: 800, protein: 40, carbs: 80, fat: 30, fiber: 5 },
};

const chipotleQuickMeal: QuickMealTemplate = {
	id: 'chipotle-bowl',
	userId: 'matt',
	label: 'Chipotle bowl',
	kind: 'restaurant',
	ingredients: ['rice', 'chicken', 'beans', 'cheese', 'salsa'],
	estimatedMacros: { calories: 850, protein: 50, carbs: 80, fat: 35, fiber: 12 },
	confidence: 0.75,
	llmModel: 'test-model',
	usageCount: 1,
	createdAt: '2026-04-01T00:00:00.000Z',
	updatedAt: '2026-04-01T00:00:00.000Z',
};

// ─── Store harness ──────────────────────────────────────────────────────────

interface TestOpts {
	recipes?: Recipe[];
	quickMeals?: QuickMealTemplate[];
}

function createStore(opts: TestOpts = {}) {
	const files = new Map<string, string>();
	const recipeIds = (opts.recipes ?? []).map((r) => `${r.id}.yaml`);

	// Seed recipe files as minimal YAML that loadRecipe can parse.
	for (const r of opts.recipes ?? []) {
		files.set(`recipes/${r.id}.yaml`, stringify(r));
	}

	// Seed quick-meals.yaml in the expected { active, archive } shape.
	if (opts.quickMeals && opts.quickMeals.length > 0) {
		files.set(
			'quick-meals.yaml',
			stringify({ active: opts.quickMeals, archive: [] }),
		);
	}

	files.set('household.yaml', stringify(household));

	const store = {
		read: vi.fn(async (path: string) => files.get(path) ?? ''),
		write: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		append: vi.fn(async (path: string, content: string) => {
			files.set(path, (files.get(path) ?? '') + content);
		}),
		exists: vi.fn(async (path: string) => files.has(path)),
		list: vi.fn(async (dir: string) => {
			if (dir === 'recipes') return recipeIds;
			if (dir === 'nutrition') {
				return Array.from(files.keys())
					.filter((k) => k.startsWith('nutrition/') && k.endsWith('.yaml'))
					.map((k) => k.replace('nutrition/', ''));
			}
			return [];
		}),
		archive: vi.fn(async () => undefined),
		files,
	};
	return store;
}

type TestStore = ReturnType<typeof createStore>;

function readMonthlyLog(store: TestStore): MonthlyMacroLog | null {
	const key = Array.from(store.files.keys()).find(
		(k) => k.startsWith('nutrition/') && k.endsWith('.yaml'),
	);
	if (!key) return null;
	const raw = store.files.get(key);
	if (!raw) return null;
	const body = stripFrontmatter(raw);
	if (!body.trim()) return null;
	return parse(body) as MonthlyMacroLog;
}

describe('H11.w Task 15 — Natural-language meal log routing', () => {
	let services: CoreServices;
	let store: TestStore;

	function msg(text: string, userId = 'matt') {
		return createTestMessageContext({ text, userId });
	}

	async function boot(opts: TestOpts = {}) {
		store = createStore(opts);
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(store as never);
		vi.mocked(services.data.forUser).mockReturnValue(store as never);
		await init(services);
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('"I had half of the lasagna I made last night" → recipe log with portion 0.5', async () => {
		await boot({ recipes: [lasagnaRecipe] });

		await handleMessage(msg('I had half of the lasagna I made last night'));

		const log = readMonthlyLog(store);
		expect(log).not.toBeNull();
		expect(log!.days).toHaveLength(1);
		expect(log!.days[0]!.meals).toHaveLength(1);
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.sourceId).toBe('r-lasagna');
		expect(entry.estimationKind).toBe('recipe');
		expect(entry.servingsEaten).toBe(0.5);
		expect(entry.macros.calories).toBe(400);
		expect(entry.macros.protein).toBe(20);
	});

	it('"I ate my usual chipotle bowl" → quick-meal log with portion 1', async () => {
		await boot({ quickMeals: [chipotleQuickMeal] });

		await handleMessage(msg('I ate my usual chipotle bowl'));

		const log = readMonthlyLog(store);
		expect(log).not.toBeNull();
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.estimationKind).toBe('quick-meal');
		expect(entry.sourceId).toBe('chipotle-bowl');
		expect(entry.macros.calories).toBe(850);
		expect(entry.servingsEaten).toBe(1);
	});

	it('"log a burger of unknown size and some potato salad" → ad-hoc LLM path', async () => {
		await boot({ recipes: [lasagnaRecipe] }); // lasagna won't match burger text

		vi.mocked(services.llm.complete).mockResolvedValue(
			JSON.stringify({
				calories: 800,
				protein: 30,
				carbs: 60,
				fat: 40,
				fiber: 5,
				confidence: 0.35,
			}),
		);

		await handleMessage(msg('log a burger of unknown size and potato salad'));

		const log = readMonthlyLog(store);
		expect(log).not.toBeNull();
		const entry = log!.days[0]!.meals[0]!;
		expect(entry.estimationKind).toBe('llm-ad-hoc');
		expect(entry.confidence).toBe(0.35);
		expect(entry.macros.calories).toBe(800);
		// Must not be routed through the legacy numeric guard — no
		// field-specific error referencing 'calories' / 'abc'.
		const sentCalls = vi.mocked(services.telegram.send).mock.calls;
		const joined = sentCalls.map((c) => c[1] as string).join('\n');
		expect(joined).not.toMatch(/Invalid calories value/);
	});

	it('"how are my macros today" does NOT trigger the NL log intent', async () => {
		await boot({ recipes: [lasagnaRecipe] });
		vi.mocked(services.llm.complete).mockResolvedValue('Weekly summary text');

		await handleMessage(msg('how are my macros today'));

		// Nothing should have been logged through the NL-log path.
		const log = readMonthlyLog(store);
		expect(log).toBeNull();
		// Nutrition view intent should still be handling this — some
		// telegram response is expected.
		expect(services.telegram.send).toHaveBeenCalled();
	});

	it('"what should I eat for dinner" does NOT trigger the NL log intent', async () => {
		await boot({ recipes: [lasagnaRecipe] });

		await handleMessage(msg('what should I eat for dinner'));

		// No macro log write for what-can-I-make / suggestion intents.
		const log = readMonthlyLog(store);
		expect(log).toBeNull();
	});
});
