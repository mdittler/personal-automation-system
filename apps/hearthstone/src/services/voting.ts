/**
 * Voting service for Hearthstone meal plans.
 *
 * Pure logic module — no side effects, no service calls.
 * Operates on plan/meal objects and returns results.
 */

import type { InlineButton } from '@pas/core/types';
import type { MealPlan, PlannedMeal } from '../types.js';

/** Day abbreviations for formatting. */
const DAY_ABBREVS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Record a vote on a planned meal. Mutates meal in place.
 * Returns true if the vote was new or changed, false if unchanged.
 */
export function recordVote(meal: PlannedMeal, userId: string, vote: 'up' | 'down' | 'neutral'): boolean {
	if (meal.votes[userId] === vote) {
		return false;
	}
	meal.votes[userId] = vote;
	return true;
}

/**
 * Compute net score: +1 per up vote, -1 per down vote, 0 per neutral.
 */
export function netScore(meal: PlannedMeal): number {
	let score = 0;
	for (const vote of Object.values(meal.votes)) {
		if (vote === 'up') score += 1;
		else if (vote === 'down') score -= 1;
	}
	return score;
}

/**
 * Check if the voting window has expired.
 * Returns false if votingStartedAt is not set.
 */
export function isVotingExpired(plan: MealPlan, windowHours: number): boolean {
	if (!plan.votingStartedAt) {
		return false;
	}
	const startedAt = new Date(plan.votingStartedAt).getTime();
	const expiresAt = startedAt + windowHours * 60 * 60 * 1000;
	return Date.now() >= expiresAt;
}

/**
 * Check if every member has voted on every meal in the plan.
 */
export function allMembersVoted(plan: MealPlan, memberIds: string[]): boolean {
	if (memberIds.length === 0 || plan.meals.length === 0) {
		return true;
	}
	for (const meal of plan.meals) {
		for (const memberId of memberIds) {
			if (!(memberId in meal.votes)) {
				return false;
			}
		}
	}
	return true;
}

/**
 * Return meals with net-negative scores (score < 0).
 */
export function getMealsNeedingReplacement(plan: MealPlan): PlannedMeal[] {
	return plan.meals.filter((meal) => netScore(meal) < 0);
}

/**
 * Format a single meal for a voting message.
 * Includes day abbreviation, recipe title, and a "New" tag if isNew.
 */
export function formatVotingMealMessage(meal: PlannedMeal): string {
	// Parse the ISO date as local date to get correct day of week
	const parts = meal.date.split('-').map(Number);
	const year = parts[0] ?? 2000;
	const month = parts[1] ?? 1;
	const day = parts[2] ?? 1;
	const date = new Date(year, month - 1, day);
	const dayAbbrev = DAY_ABBREVS[date.getDay()];
	const newTag = meal.isNew ? ' (New)' : '';
	return `${dayAbbrev}: ${meal.recipeTitle}${newTag}`;
}

/**
 * Build 👍/👎/😐 inline buttons for a meal voting message.
 * Callback data format: app:hearthstone:vote:<direction>:<meal.date>
 */
export function buildVoteButtons(mealDate: string): InlineButton[][] {
	return [
		[
			{ text: '👍', callbackData: `app:hearthstone:vote:up:${mealDate}` },
			{ text: '😐', callbackData: `app:hearthstone:vote:neutral:${mealDate}` },
			{ text: '👎', callbackData: `app:hearthstone:vote:down:${mealDate}` },
		],
	];
}
