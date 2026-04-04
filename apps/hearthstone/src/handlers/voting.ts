/**
 * Voting handler for Hearthstone meal plan voting.
 *
 * Orchestrates Telegram messaging for meal plan voting flows:
 * - Sending voting messages to household members
 * - Handling vote callbacks
 * - Finalizing votes after the voting window expires
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import type { Household, MealPlan } from '../types.js';
import {
	buildPlanButtons,
	formatPlanMessage,
	loadCurrentPlan,
	savePlan,
} from '../services/meal-plan-store.js';
import { swapMeal } from '../services/meal-planner.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import {
	allMembersVoted,
	buildVoteButtons,
	formatVotingMealMessage,
	getMealsNeedingReplacement,
	isVotingExpired,
	recordVote,
} from '../services/voting.js';
import { isoNow } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split a string on the first occurrence of separator.
 * Returns a tuple [before, after] where after may include additional separators.
 */
function splitFirst(str: string, sep = ':'): [string, string] {
	const idx = str.indexOf(sep);
	if (idx === -1) return [str, ''];
	return [str.slice(0, idx), str.slice(idx + 1)];
}

// ─── Internal finalization ────────────────────────────────────────────────────

/**
 * Finalize the meal plan after voting completes:
 * 1. Swap net-negative meals with LLM replacements
 * 2. Set plan status to 'active'
 * 3. Send the finalized plan to all household members
 */
async function finalizePlan(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	memberIds: string[],
): Promise<void> {
	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	const recipes = await loadAllRecipes(sharedStore);

	// Swap net-negative meals
	const mealsNeedingReplacement = getMealsNeedingReplacement(plan);
	for (const meal of mealsNeedingReplacement) {
		const replacement = await swapMeal(
			services,
			meal.date,
			'suggest a replacement, household voted this down',
			recipes,
		);
		// Replace the meal in the plan and reset votes on the replacement
		const idx = plan.meals.findIndex((m) => m.date === meal.date);
		if (idx !== -1) {
			replacement.votes = {};
			plan.meals[idx] = replacement;
		}
	}

	// Finalize the plan
	plan.status = 'active';
	await savePlan(sharedStore, plan);

	// Read location config for message formatting
	const location = ((await services.config.get<string>('location')) as string | undefined) ?? '';

	// Reload recipes after potential swaps (plan may now have new recipes)
	const updatedRecipes = await loadAllRecipes(sharedStore);
	const message = formatPlanMessage(plan, updatedRecipes, location);
	const buttons = buildPlanButtons(plan);

	// Send finalized plan to all household members
	for (const memberId of memberIds) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Set the plan to voting status and send individual meal voting messages
 * to all household members.
 */
export async function sendVotingMessages(
	services: CoreServices,
	sharedStore: ScopedDataStore,
	household: Household,
): Promise<void> {
	const plan = await loadCurrentPlan(sharedStore);
	if (!plan) return;

	// Transition to voting status
	plan.status = 'voting';
	plan.votingStartedAt = isoNow();
	await savePlan(sharedStore, plan);

	// Send one voting message per meal per member
	for (const meal of plan.meals) {
		const message = formatVotingMealMessage(meal);
		const buttons = buildVoteButtons(meal.date);
		for (const memberId of household.members) {
			await services.telegram.sendWithButtons(memberId, message, buttons);
		}
	}
}

/**
 * Handle a vote callback from a Telegram inline button.
 * Data format after prefix strip: "up:2026-04-01" or "down:2026-04-01" or "neutral:2026-04-01"
 */
export async function handleVoteCallback(
	services: CoreServices,
	data: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	const [voteType, mealDate] = splitFirst(data);

	// Validate vote type before processing
	if (voteType !== 'up' && voteType !== 'down' && voteType !== 'neutral') return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHousehold(sharedStore);
	if (!household) {
		await services.telegram.editMessage(chatId, messageId, 'Voting has ended');
		return;
	}

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan || plan.status !== 'voting') {
		await services.telegram.editMessage(chatId, messageId, 'Voting has ended');
		return;
	}

	const meal = plan.meals.find((m) => m.date === mealDate);
	if (!meal) return;

	// Record the vote (mutates meal in place)
	recordVote(meal, userId, voteType as 'up' | 'down' | 'neutral');
	await savePlan(sharedStore, plan);

	// Confirm the vote with an emoji (no buttons — consumed)
	const emoji = voteType === 'up' ? '👍' : voteType === 'down' ? '👎' : '😐';
	await services.telegram.editMessage(chatId, messageId, `${emoji} ${meal.recipeTitle}`);

	// Check if all members have voted — finalize if so
	if (allMembersVoted(plan, household.members)) {
		await finalizePlan(services, sharedStore, household.members);
	}
}

/**
 * Hourly cron job: check if the voting window has expired, finalize if so.
 * Idempotent — safe to call multiple times.
 */
export async function handleFinalizeVotesJob(services: CoreServices): Promise<boolean> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return false;

	const plan = await loadCurrentPlan(sharedStore);
	if (!plan || plan.status !== 'voting') return false;

	const windowHours =
		((await services.config.get<number>('voting_window_hours')) as number | undefined) ?? 12;

	if (isVotingExpired(plan, windowHours)) {
		await finalizePlan(services, sharedStore, household.members);
		return true;
	}
	return false;
}
