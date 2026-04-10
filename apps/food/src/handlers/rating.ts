/**
 * Rating handler — Telegram orchestration for post-meal ratings.
 *
 * Handles the "cooked" callback (marking a meal as cooked and showing
 * rating buttons), the "rate" callback (recording a thumbs-up/down/skip),
 * and the nightly 8pm cron job that prompts household members to rate.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { loadCurrentPlan, savePlan } from '../services/meal-plan-store.js';
import {
	buildRateButtons,
	buildRatingPromptButtons,
	createRating,
	formatRatingPromptMessage,
	getUncookedMeals,
	hasRatingPromptBeenSentToday,
} from '../services/rating.js';
import { loadRecipe, updateRecipe } from '../services/recipe-store.js';
import type { Household } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';
import { emitMealCooked } from '../events/emitters.js';

// ─── Helpers ──────────────────────────────────────────────────────

/** Format a day name from a YYYY-MM-DD date string (UTC). */
function formatDay(dateStr: string): string {
	return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
		weekday: 'long',
		timeZone: 'UTC',
	});
}

// ─── Handlers ─────────────────────────────────────────────────────

/**
 * Handle "cooked:<date>" callback.
 * Marks the meal as cooked and shows 👍/👎/⏭ rating buttons.
 */
export async function handleCookedCallback(
	services: CoreServices,
	mealDate: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	// Guard against duplicate taps — already rated means don't show rate buttons again
	if (meal.rated) {
		await services.telegram.editMessage(
			chatId,
			messageId,
			`✅ ${formatDay(mealDate)} — ${meal.recipeTitle} (already rated)`,
		);
		return;
	}

	meal.cooked = true;
	await savePlan(sharedStore, plan);

	// Emit event after successful save
	await emitMealCooked(services, {
		planId: plan.id,
		recipeId: meal.recipeId,
		recipeTitle: meal.recipeTitle,
		date: mealDate,
		mealType: meal.mealType,
		householdId: household.id,
		cookedAt: isoNow(),
	});

	const day = formatDay(mealDate);
	await services.telegram.editMessage(
		chatId,
		messageId,
		`✅ ${day} — ${meal.recipeTitle}\n\nHow was it?`,
		buildRateButtons(mealDate),
	);
}

/**
 * Handle "rate:<up|down|skip>:<date>" callback.
 * Records the rating and optionally promotes draft recipes to confirmed.
 *
 * @param data - The portion after "rate:" e.g. "up:2026-03-31"
 */
export async function handleRateCallback(
	services: CoreServices,
	data: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	// Parse direction and date — split on first ':' only
	const colonIdx = data.indexOf(':');
	if (colonIdx === -1) return;
	const direction = data.slice(0, colonIdx);
	const mealDate = data.slice(colonIdx + 1);

	// Validate direction before processing
	if (direction !== 'up' && direction !== 'down' && direction !== 'skip') return;

	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	// Skip path — no rating stored
	if (direction === 'skip') {
		meal.rated = true;
		await savePlan(sharedStore, plan);
		await services.telegram.editMessage(chatId, messageId, '⏭ Skipped');
		return;
	}

	// Map binary thumbs to 1-5 scale: 👍=5 (loved), 👎=1 (disliked)
	const score = direction === 'up' ? 5 : 1;

	// Load recipe and record rating
	let promoted = false;
	if (meal.recipeId) {
		const recipe = await loadRecipe(sharedStore, meal.recipeId);
		if (recipe) {
			recipe.ratings.push(createRating(userId, score));

			// REQ-RECIPE-003: thumbs-up on a draft recipe promotes it to confirmed
			if (direction === 'up' && recipe.status === 'draft') {
				recipe.status = 'confirmed';
				promoted = true;
			}

			await updateRecipe(sharedStore, recipe);
		}
	}

	meal.rated = true;
	await savePlan(sharedStore, plan);

	const emoji = direction === 'up' ? '👍' : '👎';
	const confirmNote = promoted ? '\n\n✅ Recipe added to your collection!' : '';
	await services.telegram.editMessage(chatId, messageId, `${emoji} Rated${confirmNote}`);

	// H6: Ask about leftovers after rating
	if (meal.recipeTitle) {
		await services.telegram.sendWithButtons(
			userId,
			`Any leftovers from ${meal.recipeTitle}?`,
			[[
				{ text: 'Yes, log leftovers', callbackData: `app:food:lo:post-meal:yes:${encodeURIComponent(meal.recipeTitle)}` },
				{ text: 'No leftovers', callbackData: 'app:food:lo:post-meal:no' },
			]],
		);
	}
}

/**
 * Daily 8pm cron job: send "What did you cook?" to all household members.
 *
 * Idempotent — won't send again if already sent today.
 */
export async function handleNightlyRatingPromptJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	// Only send for active or completed plans
	if (plan.status !== 'active' && plan.status !== 'completed') return;

	const today = todayOverride ?? todayDate(services.timezone);

	// Idempotency guard
	if (hasRatingPromptBeenSentToday(plan, today)) return;

	// Only send if there are uncooked meals to rate
	const uncookedMeals = getUncookedMeals(plan, today);
	if (uncookedMeals.length === 0) return;

	// Mark as sent before delivering (avoids duplicate sends on partial failure)
	plan.lastRatingPromptDate = today;
	await savePlan(sharedStore, plan);

	const message = formatRatingPromptMessage(uncookedMeals);
	const buttons = buildRatingPromptButtons(uncookedMeals);

	for (const memberId of household.members) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}
}
