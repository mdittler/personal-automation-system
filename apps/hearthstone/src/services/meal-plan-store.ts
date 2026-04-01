/**
 * Meal plan store — CRUD operations, formatting, and archival.
 *
 * Current plan stored at: meal-plans/current.yaml (shared scope)
 * Archive stored at: meal-plans/archive/YYYY-Www.yaml (ISO week)
 */

import type { InlineButton, ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { MealPlan, PlannedMeal, Recipe } from '../types.js';
import { isoNow } from '../utils/date.js';

const CURRENT_PATH = 'meal-plans/current.yaml';
const ARCHIVE_DIR = 'meal-plans/archive';

// ─── ISO Week Helpers ────────────────────────────────────────────────────────

/**
 * Compute ISO week number and year for a given date string (YYYY-MM-DD).
 * Returns { year, week } where week is 1-53 padded to 2 digits.
 */
function isoWeek(dateStr: string): { year: number; week: string } {
	const d = new Date(dateStr + 'T00:00:00Z');
	// ISO week: Thursday is the reference day
	const dayOfWeek = d.getUTCDay() || 7; // Mon=1 ... Sun=7
	d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // Set to Thursday of this week
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return {
		year: d.getUTCFullYear(),
		week: String(weekNum).padStart(2, '0'),
	};
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Load the current meal plan. Returns null if none exists or parse fails. */
export async function loadCurrentPlan(store: ScopedDataStore): Promise<MealPlan | null> {
	const raw = await store.read(CURRENT_PATH);
	if (!raw) return null;
	try {
		const content = stripFrontmatter(raw);
		return parse(content) as MealPlan;
	} catch {
		return null;
	}
}

/** Save the current meal plan, updating updatedAt. */
export async function savePlan(store: ScopedDataStore, plan: MealPlan): Promise<void> {
	plan.updatedAt = isoNow();
	const fm = generateFrontmatter({
		title: `Meal Plan ${plan.startDate} to ${plan.endDate}`,
		date: plan.createdAt,
		tags: buildAppTags('hearthstone', 'meal-plan'),
		app: 'hearthstone',
	});
	await store.write(CURRENT_PATH, fm + stringify(plan));
}

/** Archive the current plan to meal-plans/archive/YYYY-Www.yaml. */
export async function archivePlan(store: ScopedDataStore, plan: MealPlan): Promise<void> {
	const { year, week } = isoWeek(plan.startDate);
	const filename = `${year}-W${week}.yaml`;
	const archivePath = `${ARCHIVE_DIR}/${filename}`;
	const fm = generateFrontmatter({
		title: `Meal Plan Archive ${year}-W${week}`,
		date: plan.createdAt,
		tags: buildAppTags('hearthstone', 'meal-plan-archive'),
		app: 'hearthstone',
	});
	await store.write(archivePath, fm + stringify(plan));
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Find the meal scheduled for a given date string (YYYY-MM-DD). */
export function getTonightsMeal(plan: MealPlan, dateStr: string): PlannedMeal | null {
	return plan.meals.find((m) => m.date === dateStr) ?? null;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Format a date string (YYYY-MM-DD) as "Mon Mar 31" short form. */
function formatShortDate(dateStr: string): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	return d.toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

/** Format a date range for the plan header: "Mar 31 – Apr 6". */
function formatDateRange(startDate: string, endDate: string): string {
	const start = new Date(startDate + 'T00:00:00Z');
	const end = new Date(endDate + 'T00:00:00Z');
	const fmt = (d: Date) =>
		d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
	return `${fmt(start)} – ${fmt(end)}`;
}

/** Get the day-of-week abbreviation for a date string: "Mon", "Tue", etc. */
function dayAbbrev(dateStr: string): string {
	const d = new Date(dateStr + 'T00:00:00Z');
	return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

/** Calculate average rating from a recipe. */
function avgRating(recipe: Recipe): number | null {
	if (!recipe.ratings.length) return null;
	return recipe.ratings.reduce((s, r) => s + r.score, 0) / recipe.ratings.length;
}

/**
 * Format all meals in the plan as a detailed Telegram message.
 *
 * @param plan - The meal plan to format
 * @param recipes - Known recipes (used for existing recipe details)
 * @param location - Location for seasonal context (e.g. "Raleigh, NC")
 */
export function formatPlanMessage(plan: MealPlan, recipes: Recipe[], location: string): string {
	const recipeMap = new Map(recipes.map((r) => [r.id, r]));

	const lines: string[] = [];

	// Header
	const range = formatDateRange(plan.startDate, plan.endDate);
	lines.push(`🗓 Meal Plan: ${range}`);

	// Summary line
	const total = plan.meals.length;
	const newCount = plan.meals.filter((m) => m.isNew).length;
	const existingCount = total - newCount;
	const summaryParts: string[] = [`${total} dinner${total !== 1 ? 's' : ''}`];
	if (existingCount > 0) summaryParts.push(`${existingCount} from your recipes`);
	if (newCount > 0) summaryParts.push(`${newCount} new suggestion${newCount !== 1 ? 's' : ''}`);
	lines.push(summaryParts.join(' • '));
	lines.push('');

	// Each meal
	for (const meal of plan.meals) {
		const day = dayAbbrev(meal.date);
		const newTag = meal.isNew ? ' ✨' : '';
		const newLabel = meal.isNew ? ' (new)' : '';
		lines.push(`${day} —${newTag} ${meal.recipeTitle}${newLabel}`);

		if (!meal.isNew) {
			// Show recipe details from the library
			const recipe = recipeMap.get(meal.recipeId);
			if (recipe) {
				const parts: string[] = [];
				const totalMin = (recipe.prepTime ?? 0) + (recipe.cookTime ?? 0);
				if (totalMin > 0) parts.push(`🕒 ${totalMin} min`);
				if (recipe.cuisine) parts.push(recipe.cuisine);
				const rating = avgRating(recipe);
				if (rating !== null) parts.push(`⭐ ${rating.toFixed(1)}`);
				if (parts.length) lines.push(parts.join(' • '));
			}
		} else if (meal.description) {
			// Show LLM-provided description for new suggestions
			lines.push(meal.description);
		}

		lines.push('');
	}

	// Location / seasonal note
	lines.push(`🌱 In season (${location}): included in plan generation`);
	lines.push('');

	// Usage hints
	lines.push('• "swap [day]" to replace a meal');
	lines.push('• "show [recipe name]" for full recipe details');
	lines.push('• "generate grocery list" to shop for this plan');

	return lines.join('\n');
}

/**
 * Format tonight's dinner with prep summary.
 *
 * @param meal - The planned meal for tonight
 * @param recipe - The full recipe, or null for new suggestions
 */
export function formatTonightMessage(meal: PlannedMeal, recipe: Recipe | null): string {
	const lines: string[] = [];

	lines.push(`🍽 Tonight: ${meal.recipeTitle}`);

	if (recipe) {
		// Time and servings line
		const prep = recipe.prepTime ?? 0;
		const cook = recipe.cookTime ?? 0;
		const total = prep + cook;
		const timeParts: string[] = [];
		if (total > 0) {
			const breakdown = [prep > 0 ? `${prep} prep` : null, cook > 0 ? `${cook} cook` : null]
				.filter(Boolean)
				.join(' + ');
			timeParts.push(`🕒 ${total} min total (${breakdown})`);
		}
		timeParts.push(`Serves ${recipe.servings}`);
		lines.push(timeParts.join(' • '));

		// Quick prep hint: first instruction step, truncated at 120 chars
		const firstStep = recipe.instructions[0];
		if (firstStep) {
			const truncated = firstStep.length > 120 ? firstStep.slice(0, 119) + '…' : firstStep;
			lines.push(`Quick prep: ${truncated}`);
		}
	} else if (meal.description) {
		// New suggestion — show description
		lines.push(meal.description);
	}

	return lines.join('\n');
}

// ─── Buttons ─────────────────────────────────────────────────────────────────

/** Return inline buttons for the meal plan message. Includes Cooked buttons when plan is provided. */
export function buildPlanButtons(plan?: MealPlan): InlineButton[][] {
	const buttons: InlineButton[][] = [];

	// H4: Add "✅ Cooked!" button for each uncooked meal
	if (plan) {
		for (const meal of plan.meals) {
			if (!meal.cooked) {
				const day = dayAbbrev(meal.date);
				buttons.push([
					{
						text: `✅ ${day} — ${meal.recipeTitle}`,
						callbackData: `app:hearthstone:cooked:${meal.date}`,
					},
				]);
			}
		}
	}

	// Control row
	buttons.push([
		{ text: '🛒 Grocery List', callbackData: 'app:hearthstone:grocery-from-plan' },
		{ text: '🔄 Regenerate', callbackData: 'app:hearthstone:regenerate-plan' },
	]);

	return buttons;
}
