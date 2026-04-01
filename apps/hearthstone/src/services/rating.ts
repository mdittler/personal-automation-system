/**
 * Rating service — pure logic helpers for post-meal ratings.
 *
 * No side effects, no I/O. Used by the rating handler (Task 5) for
 * Telegram orchestration.
 */

import type { InlineButton } from '@pas/core/types';
import type { MealPlan, PlannedMeal, Rating } from '../types.js';
import { isoNow } from '../utils/date.js';

// ─── Meal selection ───────────────────────────────────────────────

/**
 * Get meals whose date is on or before todayStr and that are not yet cooked.
 *
 * Both `meal.date` and `todayStr` are YYYY-MM-DD strings — lexicographic
 * comparison is correct for ISO dates.
 */
export function getUncookedMeals(plan: MealPlan, todayStr: string): PlannedMeal[] {
	return plan.meals.filter((m) => m.date <= todayStr && !m.cooked);
}

// ─── Idempotency guard ────────────────────────────────────────────

/**
 * Check whether the nightly rating prompt has already been sent today.
 *
 * Compares plan.lastRatingPromptDate (YYYY-MM-DD) to todayStr.
 */
export function hasRatingPromptBeenSentToday(plan: MealPlan, todayStr: string): boolean {
	return plan.lastRatingPromptDate === todayStr;
}

// ─── Rating creation ──────────────────────────────────────────────

/** Create a Rating object stamped with the current ISO timestamp. */
export function createRating(userId: string, score: number): Rating {
	return { userId, score, date: isoNow() };
}

// ─── Formatting helpers ───────────────────────────────────────────

/** Format a short day abbreviation for a YYYY-MM-DD date string (UTC). */
function dayAbbrev(dateStr: string): string {
	return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', {
		weekday: 'short',
		timeZone: 'UTC',
	});
}

/**
 * Format the nightly "What did you cook?" prompt message.
 *
 * Lists uncooked meals with day abbreviations so the user can tap the
 * one they actually cooked.
 */
export function formatRatingPromptMessage(uncookedMeals: PlannedMeal[]): string {
	const lines = uncookedMeals.map((m) => `• ${dayAbbrev(m.date)}: ${m.recipeTitle}`);
	return `Which meal did you cook tonight?\n\n${lines.join('\n')}\n\nTap the one you made, or skip if you didn't cook.`;
}

// ─── Button builders ──────────────────────────────────────────────

/**
 * Build inline buttons for the nightly prompt: one button per uncooked meal.
 *
 * Callback pattern: app:hearthstone:cooked:<date>
 */
export function buildRatingPromptButtons(uncookedMeals: PlannedMeal[]): InlineButton[][] {
	return uncookedMeals.map((m) => [
		{
			text: `${dayAbbrev(m.date)}: ${m.recipeTitle}`,
			callbackData: `app:hearthstone:cooked:${m.date}`,
		},
	]);
}

/**
 * Build 👍 / 👎 / ⏭ Skip buttons for rating a specific meal.
 *
 * Row 0: thumbs-up and thumbs-down (side by side)
 * Row 1: skip
 *
 * Callback pattern: app:hearthstone:rate:<direction>:<date>
 */
export function buildRateButtons(mealDate: string): InlineButton[][] {
	return [
		[
			{ text: '👍 Yes!', callbackData: `app:hearthstone:rate:up:${mealDate}` },
			{ text: '👎 Not great', callbackData: `app:hearthstone:rate:down:${mealDate}` },
		],
		[{ text: '⏭ Skip', callbackData: `app:hearthstone:rate:skip:${mealDate}` }],
	];
}
