/**
 * Food event emitters — thin wrappers around services.eventBus.emit.
 *
 * Each emitter swallows errors so a failing EventBus never propagates
 * to the caller (fire-and-forget contract, see core/src/services/event-bus/index.ts).
 */

import type { CoreServices } from '@pas/core/types';
import type {
	GroceryListReadyPayload,
	MealCookedPayload,
	MealPlanFinalizedPayload,
	RecipeScheduledPayload,
	ShoppingCompletedPayload,
} from './types.js';

export async function emitMealPlanFinalized(
	services: CoreServices,
	payload: MealPlanFinalizedPayload,
): Promise<void> {
	try {
		services.eventBus!.emit('food:meal-plan-finalized', payload);
	} catch (err) {
		services.logger.warn('food:meal-plan-finalized emit failed: %s', err);
	}
}

export async function emitGroceryListReady(
	services: CoreServices,
	payload: GroceryListReadyPayload,
): Promise<void> {
	try {
		services.eventBus!.emit('food:grocery-list-ready', payload);
	} catch (err) {
		services.logger.warn('food:grocery-list-ready emit failed: %s', err);
	}
}

export async function emitRecipeScheduled(
	services: CoreServices,
	payload: RecipeScheduledPayload,
): Promise<void> {
	try {
		services.eventBus!.emit('food:recipe-scheduled', payload);
	} catch (err) {
		services.logger.warn('food:recipe-scheduled emit failed: %s', err);
	}
}

export async function emitMealCooked(
	services: CoreServices,
	payload: MealCookedPayload,
): Promise<void> {
	try {
		services.eventBus!.emit('food:meal-cooked', payload);
	} catch (err) {
		services.logger.warn('food:meal-cooked emit failed: %s', err);
	}
}

export async function emitShoppingCompleted(
	services: CoreServices,
	payload: ShoppingCompletedPayload,
): Promise<void> {
	try {
		services.eventBus!.emit('food:shopping-completed', payload);
	} catch (err) {
		services.logger.warn('food:shopping-completed emit failed: %s', err);
	}
}
