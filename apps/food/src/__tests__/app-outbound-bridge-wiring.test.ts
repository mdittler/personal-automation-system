/**
 * App-Outbound-Bridge wiring tests for the food app's proactive helpers.
 *
 * Each helper that sends a user-visible Telegram message via a scheduled job
 * also records a synthetic exchange through `services.appOutboundBridge`,
 * so the chatbot can reference what the app told the user later.
 *
 * Tests here cover:
 *   - weekly-health-correlation dispatcher path (kind: 'weekly-health')
 *   - generate-weekly-plan singleton-household path (kind: 'weekly-menu')
 *   - generate-weekly-plan batch-prep fan-out (kind: 'batch-prep')
 *
 * Per-helper coverage for weekly-nutrition lives in
 * `apps/food/src/__tests__/handlers/nutrition-summary.test.ts`. Per-helper
 * coverage for the multi-member voting path lives in
 * `apps/food/src/__tests__/voting-handler.test.ts`.
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { CorrelationInsight } from '../services/health-correlator.js';
import type { Household, MealPlan, Recipe } from '../types.js';

// ── Top-level mocks (hoisted) ────────────────────────────────────────────────

// Mock the health-correlator so the weekly-health dispatcher reaches the
// telegram + bridge call without needing real macro/health data.
vi.mock('../services/health-correlator.js', () => ({
	correlateHealth: vi.fn(),
}));

// Mock the meal-planner so the generate-weekly-plan dispatcher reaches the
// telegram + bridge call without needing LLM-generated meals.
vi.mock('../services/meal-planner.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../services/meal-planner.js')>();
	return { ...original, generatePlan: vi.fn() };
});

// Mock the batch-cooking analyzer so we control whether the batch-prep branch
// is reached and what content it sends.
vi.mock('../services/batch-cooking.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../services/batch-cooking.js')>();
	return { ...original, analyzeBatchPrep: vi.fn() };
});

// Imports after the mocks have been declared.
const { handleScheduledJob, init } = await import('../index.js');
const { correlateHealth } = await import('../services/health-correlator.js');
const { generatePlan } = await import('../services/meal-planner.js');
const { analyzeBatchPrep } = await import('../services/batch-cooking.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh1',
		name: 'Solo Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'r1',
		title: 'Test Recipe',
		source: 'homemade',
		ingredients: [],
		instructions: ['cook'],
		servings: 4,
		prepTime: 5,
		cookTime: 10,
		tags: [],
		cuisine: 'Other',
		ratings: [],
		history: [],
		allergens: [],
		status: 'draft',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makePlan(startDate: string, overrides: Partial<MealPlan> = {}): MealPlan {
	return {
		id: 'plan-001',
		startDate,
		endDate: startDate,
		meals: [
			{
				recipeId: 'r1',
				recipeTitle: 'Test Recipe',
				date: startDate,
				mealType: 'dinner',
				votes: {},
				cooked: false,
				rated: false,
				isNew: false,
			},
		],
		status: 'draft',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function nextMondayIso(): string {
	const today = new Date();
	const dow = today.getUTCDay();
	const daysUntilMonday = dow === 0 ? 1 : dow === 1 ? 7 : 8 - dow;
	const d = new Date(today);
	d.setUTCDate(d.getUTCDate() + daysUntilMonday);
	return d.toISOString().slice(0, 10);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App-Outbound-Bridge wiring (food scheduled jobs)', () => {
	let services: CoreServices;
	let recordOutboundMessage: ReturnType<typeof vi.fn>;
	let sharedStore: ReturnType<typeof createMockScopedStore>;
	let userStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(async () => {
		sharedStore = createMockScopedStore();
		userStore = createMockScopedStore();
		recordOutboundMessage = vi.fn().mockResolvedValue(undefined);
		services = createMockCoreServices();
		(services as { appOutboundBridge?: unknown }).appOutboundBridge = {
			recordOutboundMessage,
		};
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as never);
		vi.mocked(services.data.forUser).mockReturnValue(userStore as never);
		await init(services);
	});

	it('weekly-health-correlation: bridges with kind weekly-health', async () => {
		// Household required for jobs targeted at a user.
		sharedStore.read.mockImplementation(async (path: string) =>
			path === 'household.yaml' ? stringify(makeHousehold()) : '',
		);
		const insight: CorrelationInsight = {
			metric: 'protein',
			pattern: 'High protein days had better sleep',
			confidence: 0.7,
			disclaimer: 'Observational only — not medical advice.',
		};
		vi.mocked(correlateHealth).mockResolvedValue([insight]);

		await handleScheduledJob?.('weekly-health-correlation', 'user1');

		expect(services.telegram.send).toHaveBeenCalledTimes(1);
		expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
		const [recorded] = recordOutboundMessage.mock.calls[0]!;
		expect(recorded).toMatchObject({
			userId: 'user1',
			appId: 'food',
			kind: 'weekly-health',
			body: expect.stringContaining('Weekly Health Correlation'),
		});
		// Body sent to telegram MUST match the body bridged to the chatbot.
		const sendCallArgs = vi.mocked(services.telegram.send).mock.calls[0]!;
		expect(sendCallArgs[1]).toBe(recorded.body);
	});

	it('weekly-health-correlation: no bridge call when correlateHealth returns empty', async () => {
		sharedStore.read.mockImplementation(async (path: string) =>
			path === 'household.yaml' ? stringify(makeHousehold()) : '',
		);
		vi.mocked(correlateHealth).mockResolvedValue([]);

		await handleScheduledJob?.('weekly-health-correlation', 'user1');

		expect(services.telegram.send).not.toHaveBeenCalled();
		expect(recordOutboundMessage).not.toHaveBeenCalled();
	});

	it('generate-weekly-plan (singleton household): bridges with kind weekly-menu', async () => {
		const monday = nextMondayIso();
		const recipe = makeRecipe();
		const plan = makePlan(monday);
		const household = makeHousehold({ members: ['user1'] });

		let savedPlanYaml = '';
		sharedStore.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path === 'meal-plans/current.yaml') return savedPlanYaml;
			if (path === 'pantry.yaml') return '';
			if (path.startsWith('recipes/')) return stringify(recipe);
			return '';
		});
		sharedStore.write.mockImplementation(async (path: string, content: string) => {
			if (path === 'meal-plans/current.yaml') savedPlanYaml = content;
		});
		sharedStore.list.mockImplementation(async (path: string) => {
			if (path === 'recipes') return ['r1.yaml'];
			return [];
		});
		vi.mocked(generatePlan).mockResolvedValue(plan);
		vi.mocked(analyzeBatchPrep).mockResolvedValue(null);

		await handleScheduledJob?.('generate-weekly-plan', undefined);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
		expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
		const [recorded] = recordOutboundMessage.mock.calls[0]!;
		expect(recorded).toMatchObject({
			userId: 'user1',
			appId: 'food',
			kind: 'weekly-menu',
			body: expect.any(String),
		});
		expect(Array.isArray(recorded.buttons)).toBe(true);
		// body matches telegram body
		const sendArgs = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(sendArgs[0]).toBe('user1');
		expect(sendArgs[1]).toBe(recorded.body);
		expect(sendArgs[2]).toBe(recorded.buttons);
	});

	it('generate-weekly-plan: batch-prep fan-out bridges one per member with kind batch-prep', async () => {
		const monday = nextMondayIso();
		const recipe = makeRecipe();
		const plan = makePlan(monday);
		const household = makeHousehold({ members: ['user1', 'user2'] });

		let savedPlanYaml = '';
		sharedStore.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path === 'meal-plans/current.yaml') return savedPlanYaml;
			if (path === 'pantry.yaml') return '';
			if (path.startsWith('recipes/')) return stringify(recipe);
			return '';
		});
		sharedStore.write.mockImplementation(async (path: string, content: string) => {
			if (path === 'meal-plans/current.yaml') savedPlanYaml = content;
		});
		sharedStore.list.mockImplementation(async (path: string) => {
			if (path === 'recipes') return ['r1.yaml'];
			return [];
		});
		vi.mocked(generatePlan).mockResolvedValue(plan);
		vi.mocked(analyzeBatchPrep).mockResolvedValue({
			sharedTasks: [
				{ task: 'Dice onions', recipes: ['Test Recipe'], estimatedMinutes: 5 },
			],
			totalPrepMinutes: 30,
			estimatedSavingsMinutes: 10,
			freezerFriendlyRecipes: ['Test Recipe'],
		});

		await handleScheduledJob?.('generate-weekly-plan', undefined);

		// Bridge calls: 2 weekly-menu (one per member) + 2 batch-prep (one per member)
		const calls = recordOutboundMessage.mock.calls.map((c) => c[0]);
		const batchCalls = calls.filter((c) => c.kind === 'batch-prep');
		expect(batchCalls).toHaveLength(2);
		const batchRecipients = batchCalls.map((c) => c.userId).sort();
		expect(batchRecipients).toEqual(['user1', 'user2']);
		for (const call of batchCalls) {
			expect(call).toMatchObject({
				appId: 'food',
				kind: 'batch-prep',
				body: expect.any(String),
			});
		}
	});
});
