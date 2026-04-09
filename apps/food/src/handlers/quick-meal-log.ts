/**
 * Quick-meal log helper — H11.w Task 11.
 *
 * Extracted so both the /nutrition log command handler (free-text label
 * path) and the index.ts callback dispatcher (`app:food:nut:log:quickmeal:*`
 * button path) can log a saved quick-meal with a given portion, scaling
 * macros, propagating estimationKind/confidence/sourceId, and bumping
 * usageCount on the template.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { findQuickMealById, incrementUsage } from '../services/quick-meals-store.js';
import { logMealMacros } from '../services/macro-tracker.js';
import { todayDate } from '../utils/date.js';
import type { MacroData, MealMacroEntry, QuickMealTemplate } from '../types.js';

/** Logs a quick-meal against the user's monthly macro log, scaling by portion. */
export async function logQuickMeal(
	store: ScopedDataStore,
	userId: string,
	qm: QuickMealTemplate,
	portion: number,
	services: CoreServices,
): Promise<void> {
	const scaled: MacroData = {
		calories: Math.round((qm.estimatedMacros.calories ?? 0) * portion),
		protein: Math.round((qm.estimatedMacros.protein ?? 0) * portion),
		carbs: Math.round((qm.estimatedMacros.carbs ?? 0) * portion),
		fat: Math.round((qm.estimatedMacros.fat ?? 0) * portion),
		fiber: Math.round((qm.estimatedMacros.fiber ?? 0) * portion),
	};
	const entry: MealMacroEntry = {
		recipeId: qm.id,
		recipeTitle: qm.label,
		mealType: 'logged',
		servingsEaten: portion,
		macros: scaled,
		estimationKind: 'quick-meal',
		confidence: qm.confidence,
		sourceId: qm.id,
	};
	await logMealMacros(store, userId, entry, todayDate(services.timezone));
	await incrementUsage(store, qm.id);
	await services.telegram.send(
		userId,
		`Logged: **${qm.label}** × ${portion} — ${scaled.calories} cal`,
	);
}

/**
 * Callback handler for `app:food:nut:log:quickmeal:<id>:<portion>` and
 * `app:food:nut:log:adhoc-prompt`. Returns true if the callback was
 * consumed (including error paths).
 */
export async function handleQuickMealLogCallback(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	data: string,
): Promise<boolean> {
	if (data === 'app:food:nut:log:adhoc-prompt') {
		await services.telegram.send(
			userId,
			'Tell me what you ate in plain English — for example "I had half the lasagna" or "I ate a bunch of BBQ". I\'ll estimate the macros.',
		);
		return true;
	}

	const match = data.match(/^app:food:nut:log:quickmeal:([a-z0-9][a-z0-9-]*):(\d+(?:\.\d+)?)$/);
	if (!match) return false;

	const id = match[1]!;
	const portion = parseFloat(match[2]!);
	if (!Number.isFinite(portion) || portion <= 0) {
		await services.telegram.send(userId, 'Invalid portion on that button.');
		return true;
	}

	const qm = await findQuickMealById(userStore, id);
	if (!qm) {
		await services.telegram.send(userId, 'That quick-meal no longer exists.');
		return true;
	}

	await logQuickMeal(userStore, userId, qm, portion, services);
	return true;
}
