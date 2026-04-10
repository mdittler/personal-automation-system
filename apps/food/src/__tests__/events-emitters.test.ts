/**
 * Event Emitters Tests
 *
 * Each emitter must:
 * - Call services.eventBus.emit with the correct event name and payload
 * - Swallow errors — a failing emit must never propagate to the caller
 */

import { createMockCoreServices } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	emitMealPlanFinalized,
	emitGroceryListReady,
	emitRecipeScheduled,
	emitMealCooked,
	emitShoppingCompleted,
} from '../events/emitters.js';
import type {
	GroceryListReadyPayload,
	MealCookedPayload,
	MealPlanFinalizedPayload,
	RecipeScheduledPayload,
	ShoppingCompletedPayload,
} from '../events/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const mealPlanPayload: MealPlanFinalizedPayload = {
	planId: 'plan-1',
	weekStart: '2026-04-07',
	householdId: 'hh-1',
	mealCount: 7,
	finalizedAt: '2026-04-07T09:00:00.000Z',
};

const groceryPayload: GroceryListReadyPayload = {
	listId: 'grocery-1',
	householdId: 'hh-1',
	itemCount: 14,
	source: 'recipes',
	generatedAt: '2026-04-07T09:00:00.000Z',
};

const recipePayload: RecipeScheduledPayload = {
	planId: 'plan-1',
	recipeId: 'r-42',
	recipeTitle: 'Pasta Bolognese',
	date: '2026-04-09',
	mealType: 'dinner',
	householdId: 'hh-1',
};

const cookedPayload: MealCookedPayload = {
	planId: 'plan-1',
	recipeId: 'r-42',
	recipeTitle: 'Pasta Bolognese',
	date: '2026-04-09',
	mealType: 'dinner',
	householdId: 'hh-1',
	cookedAt: '2026-04-09T19:30:00.000Z',
};

const shoppingPayload: ShoppingCompletedPayload = {
	listId: 'grocery-1',
	householdId: 'hh-1',
	itemsPurchased: 12,
	completedAt: '2026-04-09T14:00:00.000Z',
};

// ─── emitMealPlanFinalized ─────────────────────────────────────────────────

describe('emitMealPlanFinalized', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('emits food:meal-plan-finalized with the provided payload', async () => {
		await emitMealPlanFinalized(services, mealPlanPayload);
		expect(services.eventBus!.emit).toHaveBeenCalledWith('food:meal-plan-finalized', mealPlanPayload);
	});

	it('does not throw when eventBus.emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await expect(emitMealPlanFinalized(services, mealPlanPayload)).resolves.toBeUndefined();
	});

	it('logs a warning when emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await emitMealPlanFinalized(services, mealPlanPayload);
		expect(services.logger.warn).toHaveBeenCalled();
	});
});

// ─── emitGroceryListReady ──────────────────────────────────────────────────

describe('emitGroceryListReady', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('emits food:grocery-list-ready with the provided payload', async () => {
		await emitGroceryListReady(services, groceryPayload);
		expect(services.eventBus!.emit).toHaveBeenCalledWith('food:grocery-list-ready', groceryPayload);
	});

	it('does not throw when eventBus.emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await expect(emitGroceryListReady(services, groceryPayload)).resolves.toBeUndefined();
	});

	it('logs a warning when emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await emitGroceryListReady(services, groceryPayload);
		expect(services.logger.warn).toHaveBeenCalled();
	});
});

// ─── emitRecipeScheduled ───────────────────────────────────────────────────

describe('emitRecipeScheduled', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('emits food:recipe-scheduled with the provided payload', async () => {
		await emitRecipeScheduled(services, recipePayload);
		expect(services.eventBus!.emit).toHaveBeenCalledWith('food:recipe-scheduled', recipePayload);
	});

	it('does not throw when eventBus.emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await expect(emitRecipeScheduled(services, recipePayload)).resolves.toBeUndefined();
	});

	it('logs a warning when emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await emitRecipeScheduled(services, recipePayload);
		expect(services.logger.warn).toHaveBeenCalled();
	});
});

// ─── emitMealCooked ────────────────────────────────────────────────────────

describe('emitMealCooked', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('emits food:meal-cooked with the provided payload', async () => {
		await emitMealCooked(services, cookedPayload);
		expect(services.eventBus!.emit).toHaveBeenCalledWith('food:meal-cooked', cookedPayload);
	});

	it('does not throw when eventBus.emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await expect(emitMealCooked(services, cookedPayload)).resolves.toBeUndefined();
	});

	it('logs a warning when emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await emitMealCooked(services, cookedPayload);
		expect(services.logger.warn).toHaveBeenCalled();
	});
});

// ─── emitShoppingCompleted ─────────────────────────────────────────────────

describe('emitShoppingCompleted', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('emits food:shopping-completed with the provided payload', async () => {
		await emitShoppingCompleted(services, shoppingPayload);
		expect(services.eventBus!.emit).toHaveBeenCalledWith('food:shopping-completed', shoppingPayload);
	});

	it('does not throw when eventBus.emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await expect(emitShoppingCompleted(services, shoppingPayload)).resolves.toBeUndefined();
	});

	it('logs a warning when emit throws', async () => {
		vi.mocked(services.eventBus!.emit).mockImplementation(() => { throw new Error('bus down'); });
		await emitShoppingCompleted(services, shoppingPayload);
		expect(services.logger.warn).toHaveBeenCalled();
	});
});
