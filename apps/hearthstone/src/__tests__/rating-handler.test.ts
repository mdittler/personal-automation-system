/**
 * Tests for the rating handler — post-meal rating Telegram flows.
 *
 * Covers: handleCookedCallback, handleRateCallback, handleNightlyRatingPromptJob
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleCookedCallback,
	handleNightlyRatingPromptJob,
	handleRateCallback,
} from '../handlers/rating.js';
import type { Household, MealPlan, PlannedMeal, Recipe } from '../types.js';

// ─── Mock store factory ───────────────────────────────────────────

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

// ─── Sample data factories ────────────────────────────────────────

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'hh1',
		name: 'Test Family',
		createdBy: 'user1',
		members: ['user1', 'user2'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeMeal(overrides: Partial<PlannedMeal> = {}): PlannedMeal {
	return {
		recipeId: 'pasta-abc',
		recipeTitle: 'Pasta Bolognese',
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
		id: 'plan-1',
		startDate: '2026-03-30',
		endDate: '2026-04-05',
		meals: [makeMeal()],
		status: 'active',
		createdAt: '2026-03-30T00:00:00.000Z',
		updatedAt: '2026-03-30T00:00:00.000Z',
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'pasta-abc',
		title: 'Pasta Bolognese',
		source: 'homemade',
		ingredients: [],
		instructions: [],
		servings: 4,
		tags: [],
		ratings: [],
		history: [],
		allergens: [],
		status: 'draft',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

// ─── Test suite ───────────────────────────────────────────────────

describe('handleCookedCallback', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		sharedStore = createMockScopedStore();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	it('marks meal as cooked and shows rate buttons', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household)) // household.yaml
			.mockResolvedValueOnce(stringify(plan)); // meal-plans/current.yaml

		await handleCookedCallback(services, '2026-03-31', 'user1', 12345, 99);

		// Plan was saved with cooked=true
		expect(sharedStore.write).toHaveBeenCalled();
		const writeCall = vi.mocked(sharedStore.write).mock.calls[0];
		expect(writeCall[0]).toBe('meal-plans/current.yaml');

		// Message was edited with rate buttons
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('Pasta Bolognese'),
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ callbackData: 'app:hearthstone:rate:up:2026-03-31' }),
				]),
			]),
		);
	});

	it('includes the day name in the edited message', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleCookedCallback(services, '2026-03-31', 'user1', 12345, 99);

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('Tuesday'), // 2026-03-31 is a Tuesday
			expect.anything(),
		);
	});

	it('does nothing when meal date is not found in plan', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		// Request for a date not in the plan
		await handleCookedCallback(services, '2026-04-10', 'user1', 12345, 99);

		expect(sharedStore.write).not.toHaveBeenCalled();
		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});

	it('does nothing when there is no plan', async () => {
		const household = makeHousehold();

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(null); // no plan

		await handleCookedCallback(services, '2026-03-31', 'user1', 12345, 99);

		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});

	it('does nothing when there is no household', async () => {
		sharedStore.read.mockResolvedValueOnce(null); // no household

		await handleCookedCallback(services, '2026-03-31', 'user1', 12345, 99);

		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});

	it('shows "already rated" when meal was already rated', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', rated: true, cooked: true })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleCookedCallback(services, '2026-03-31', 'user1', 12345, 99);

		// Should not save plan (no state change)
		expect(sharedStore.write).not.toHaveBeenCalled();
		// Should show already-rated message
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('already rated'),
		);
	});
});

describe('handleRateCallback', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		sharedStore = createMockScopedStore();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	it('thumbs-up adds rating score 5 and confirms a draft recipe', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', recipeId: 'pasta-abc' })] });
		const recipe = makeRecipe({ id: 'pasta-abc', status: 'draft' });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household)) // household.yaml
			.mockResolvedValueOnce(stringify(plan)) // meal-plans/current.yaml
			.mockResolvedValueOnce(stringify(recipe)); // recipes/pasta-abc.yaml

		await handleRateCallback(services, 'up:2026-03-31', 'user1', 12345, 99);

		// Find the recipe write call
		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const recipeWrite = writeCalls.find((c) => String(c[0]).includes('recipes/'));
		expect(recipeWrite).toBeDefined();

		// Parse the saved recipe YAML (strip frontmatter first)
		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const savedContent = stripFrontmatter(String(recipeWrite?.[1]));
		const savedRecipe = parse(savedContent) as Recipe;

		expect(savedRecipe.ratings).toHaveLength(1);
		expect(savedRecipe.ratings[0].score).toBe(5);
		expect(savedRecipe.ratings[0].userId).toBe('user1');
		expect(savedRecipe.status).toBe('confirmed');

		// Edit message shows thumbs up
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('👍'),
		);
	});

	it('thumbs-down adds rating score 1 and does not change draft status', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', recipeId: 'pasta-abc' })] });
		const recipe = makeRecipe({ id: 'pasta-abc', status: 'draft' });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan))
			.mockResolvedValueOnce(stringify(recipe));

		await handleRateCallback(services, 'down:2026-03-31', 'user1', 12345, 99);

		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const recipeWrite = writeCalls.find((c) => String(c[0]).includes('recipes/'));
		expect(recipeWrite).toBeDefined();

		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const savedContent = stripFrontmatter(String(recipeWrite?.[1]));
		const savedRecipe = parse(savedContent) as Recipe;

		expect(savedRecipe.ratings).toHaveLength(1);
		expect(savedRecipe.ratings[0].score).toBe(1);
		// Draft status NOT changed on thumbs down
		expect(savedRecipe.status).toBe('draft');

		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('👎'),
		);
	});

	it('thumbs-up on confirmed recipe does not re-confirm', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', recipeId: 'pasta-abc' })] });
		const recipe = makeRecipe({ id: 'pasta-abc', status: 'confirmed' });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan))
			.mockResolvedValueOnce(stringify(recipe));

		await handleRateCallback(services, 'up:2026-03-31', 'user1', 12345, 99);

		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const recipeWrite = writeCalls.find((c) => String(c[0]).includes('recipes/'));
		const { stripFrontmatter } = await import('@pas/core/utils/frontmatter');
		const { parse } = await import('yaml');
		const savedContent = stripFrontmatter(String(recipeWrite?.[1]));
		const savedRecipe = parse(savedContent) as Recipe;

		// No promotion message in editMessage when already confirmed
		expect(savedRecipe.status).toBe('confirmed');
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.not.stringContaining('added to your collection'),
		);
	});

	it('skip marks rated=true with no rating stored', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', recipeId: 'pasta-abc' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));
		// No third read call — recipe should not be loaded for skip

		await handleRateCallback(services, 'skip:2026-03-31', 'user1', 12345, 99);

		// Recipe file was NOT written
		const writeCalls = vi.mocked(sharedStore.write).mock.calls;
		const recipeWrite = writeCalls.find((c) => String(c[0]).includes('recipes/'));
		expect(recipeWrite).toBeUndefined();

		// Plan was saved
		expect(sharedStore.write).toHaveBeenCalledWith(
			'meal-plans/current.yaml',
			expect.any(String),
		);

		// Message was edited with skip text
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('⏭'),
		);

		// Recipe was NOT loaded
		expect(sharedStore.read).toHaveBeenCalledTimes(2); // only household + plan
	});

	it('handles missing recipe gracefully (still marks meal rated)', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31', recipeId: 'missing-id' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan))
			.mockResolvedValueOnce(null); // recipe not found

		await handleRateCallback(services, 'up:2026-03-31', 'user1', 12345, 99);

		// Plan still saved with rated=true
		expect(sharedStore.write).toHaveBeenCalledWith(
			'meal-plans/current.yaml',
			expect.any(String),
		);

		// Message still edited
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			12345,
			99,
			expect.stringContaining('👍'),
		);
	});

	it('does nothing when meal date is not found', async () => {
		const household = makeHousehold();
		const plan = makePlan({ meals: [makeMeal({ date: '2026-03-31' })] });

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleRateCallback(services, 'up:2026-04-10', 'user1', 12345, 99);

		expect(services.telegram.editMessage).not.toHaveBeenCalled();
	});
});

describe('handleNightlyRatingPromptJob', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		services = createMockCoreServices();
		sharedStore = createMockScopedStore();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	it('sends prompt to all household members for uncooked meals', async () => {
		const household = makeHousehold({ members: ['user1', 'user2'] });
		const plan = makePlan({
			status: 'active',
			meals: [makeMeal({ date: '2026-03-31', cooked: false })],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		// sendWithButtons called for each member
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2);
		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Pasta Bolognese'),
			expect.any(Array),
		);
		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user2',
			expect.any(String),
			expect.any(Array),
		);
	});

	it('is idempotent — skips if already sent today', async () => {
		const household = makeHousehold();
		const plan = makePlan({
			status: 'active',
			meals: [makeMeal({ date: '2026-03-31', cooked: false })],
			lastRatingPromptDate: '2026-03-31', // already sent
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('skips when there is no active plan', async () => {
		const household = makeHousehold();

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(null); // no plan

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('skips when plan status is draft or voting', async () => {
		const household = makeHousehold();
		const plan = makePlan({
			status: 'voting',
			meals: [makeMeal({ date: '2026-03-31', cooked: false })],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('skips when all meals are already cooked', async () => {
		const household = makeHousehold();
		const plan = makePlan({
			status: 'active',
			meals: [makeMeal({ date: '2026-03-31', cooked: true })],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('skips future meals not yet due', async () => {
		const household = makeHousehold();
		const plan = makePlan({
			status: 'active',
			meals: [
				makeMeal({ date: '2026-03-30', cooked: false }), // due — in past
				makeMeal({ date: '2026-04-01', cooked: false }), // future — not due
			],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		// Should only prompt for the past meal, not future
		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(2); // 2 members
		const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
		// Should contain the past meal (Mar 30) but not the future one (Apr 01)
		// The message is about the uncooked meals ≤ today
		expect(message).not.toContain('Apr');
	});

	it('saves plan with lastRatingPromptDate set to today before sending', async () => {
		const household = makeHousehold({ members: ['user1'] });
		const plan = makePlan({
			status: 'active',
			meals: [makeMeal({ date: '2026-03-31', cooked: false })],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		// Plan was written (to record lastRatingPromptDate)
		expect(sharedStore.write).toHaveBeenCalledWith(
			'meal-plans/current.yaml',
			expect.stringContaining('lastRatingPromptDate: 2026-03-31'),
		);
	});

	it('skips when there is no household', async () => {
		sharedStore.read.mockResolvedValueOnce(null); // no household

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('works for completed plans', async () => {
		const household = makeHousehold({ members: ['user1'] });
		const plan = makePlan({
			status: 'completed',
			meals: [makeMeal({ date: '2026-03-31', cooked: false })],
		});

		sharedStore.read
			.mockResolvedValueOnce(stringify(household))
			.mockResolvedValueOnce(stringify(plan));

		await handleNightlyRatingPromptJob(services, '2026-03-31');

		expect(services.telegram.sendWithButtons).toHaveBeenCalledTimes(1);
	});
});
