/**
 * Budget Reporter — generates weekly, monthly, and yearly cost history reports.
 *
 * Computes CostHistoryWeek/Month/Year summaries from meal plan estimates,
 * formats Telegram-ready messages, and persists/loads weekly history files.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { CostHistoryMonth, CostHistoryWeek, MealCostEstimate, MealPlan } from '../types.js';

const COST_HISTORY_DIR = 'cost-history';

// ─── ISO Week Helpers ─────────────────────────────────────────────────────────

/**
 * Compute the ISO 8601 week ID (e.g. "2026-W15") for a given YYYY-MM-DD date.
 * Uses the Thursday rule: a week belongs to the year containing its Thursday.
 */
export function getIsoWeekId(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	// Day of week: 0 = Sunday … 6 = Saturday. Shift to Mon=0 … Sun=6.
	const dayOfWeek = (d.getUTCDay() + 6) % 7;
	// Find Thursday of this week
	const thursday = new Date(d);
	thursday.setUTCDate(d.getUTCDate() - dayOfWeek + 3);
	// Jan 4 is always in week 1
	const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const jan4DayOfWeek = (jan4.getUTCDay() + 6) % 7;
	const week1Monday = new Date(jan4);
	week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayOfWeek);
	const weekNumber = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 24 * 3600 * 1000)) + 1;
	const year = thursday.getUTCFullYear();
	return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/** Format a YYYY-MM-DD date as e.g. "Apr 7" */
function formatShortDate(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Format a YYYY-MM-DD date as the day abbreviation e.g. "Mon" */
function formatDayAbbrev(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	return d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

// ─── generateWeeklyReport ─────────────────────────────────────────────────────

/**
 * Build a CostHistoryWeek from a MealPlan and its cost estimates.
 * Matches estimates to meals by recipeId; meals with no estimate are omitted.
 */
export function generateWeeklyReport(
	plan: MealPlan,
	estimates: MealCostEstimate[],
): CostHistoryWeek {
	const estimateMap = new Map(estimates.map((e) => [e.recipeId, e]));

	const meals: CostHistoryWeek['meals'] = [];

	for (const meal of plan.meals) {
		const estimate = estimateMap.get(meal.recipeId);
		if (!estimate) continue;
		meals.push({
			date: meal.date,
			recipeTitle: meal.recipeTitle,
			cost: estimate.totalCost,
			perServing: estimate.perServingCost,
		});
	}

	const totalCost = meals.reduce((sum, m) => sum + m.cost, 0);
	const mealCount = meals.length;
	const avgPerMeal = mealCount > 0 ? totalCost / mealCount : 0;
	const avgPerServing = mealCount > 0 ? meals.reduce((sum, m) => sum + m.perServing, 0) / mealCount : 0;

	return {
		weekId: getIsoWeekId(plan.startDate),
		startDate: plan.startDate,
		endDate: plan.endDate,
		meals,
		totalCost,
		avgPerMeal,
		avgPerServing,
		mealCount,
	};
}

// ─── generateMonthlyReport ────────────────────────────────────────────────────

/**
 * Aggregate CostHistoryWeeks into a CostHistoryMonth.
 */
export function generateMonthlyReport(monthId: string, weeks: CostHistoryWeek[]): CostHistoryMonth {
	const totalCost = weeks.reduce((sum, w) => sum + w.totalCost, 0);
	const mealCount = weeks.reduce((sum, w) => sum + w.mealCount, 0);
	const avgPerMeal = mealCount > 0 ? totalCost / mealCount : 0;
	const avgPerServing = mealCount > 0
		? weeks.reduce((sum, w) => sum + w.avgPerServing * w.mealCount, 0) / mealCount
		: 0;

	return {
		monthId,
		weeks: weeks.map((w) => ({ weekId: w.weekId, totalCost: w.totalCost, mealCount: w.mealCount })),
		totalCost,
		avgPerMeal,
		avgPerServing,
		mealCount,
	};
}

// ─── generateYearlyReport ─────────────────────────────────────────────────────

/**
 * Aggregate month summaries into a yearly report.
 */
export function generateYearlyReport(
	year: string,
	months: Array<{ monthLabel: string; totalCost: number; mealCount: number }>,
): { totalCost: number; avgPerMonth: number; months: typeof months } {
	const totalCost = months.reduce((sum, m) => sum + m.totalCost, 0);
	const avgPerMonth = months.length > 0 ? totalCost / months.length : 0;
	return { totalCost, avgPerMonth, months };
}

// ─── formatWeeklyReportMessage ────────────────────────────────────────────────

/**
 * Format a weekly cost history as a Telegram-ready message.
 */
export function formatWeeklyReportMessage(
	week: CostHistoryWeek,
	prevWeek: CostHistoryWeek | null,
): string {
	const lines: string[] = [];

	// Header
	lines.push(`📊 Food Budget — Week of ${formatShortDate(week.startDate)}`);
	lines.push('');

	// Meal breakdown
	if (week.meals.length > 0) {
		for (const meal of week.meals) {
			lines.push(`${formatDayAbbrev(meal.date)}: ${meal.recipeTitle} — **$${meal.cost.toFixed(2)}**`);
		}
		lines.push('');
	}

	// Totals
	lines.push(`**Weekly Total: $${week.totalCost.toFixed(2)}**`);
	lines.push(`Avg per meal: $${week.avgPerMeal.toFixed(2)} · Per person: $${week.avgPerServing.toFixed(2)}`);

	// Comparison to previous week
	if (prevWeek && prevWeek.totalCost > 0) {
		const diff = week.totalCost - prevWeek.totalCost;
		const pct = Math.abs(Math.round((diff / prevWeek.totalCost) * 100));
		const arrow = diff < 0 ? '↓' : '↑';
		lines.push(`${arrow} ${pct}% vs last week ($${prevWeek.totalCost.toFixed(2)})`);
	}

	// Most / least expensive meals
	if (week.meals.length > 1) {
		const sorted = [...week.meals].sort((a, b) => b.cost - a.cost);
		const most = sorted[0]!;
		const least = sorted[sorted.length - 1]!;
		lines.push('');
		lines.push(`Most expensive: ${most.recipeTitle} ($${most.cost.toFixed(2)})`);
		lines.push(`Least expensive: ${least.recipeTitle} ($${least.cost.toFixed(2)})`);
	}

	return lines.join('\n');
}

// ─── formatMonthlyReportMessage ───────────────────────────────────────────────

/**
 * Format a monthly cost summary as a Telegram-ready message.
 */
export function formatMonthlyReportMessage(
	monthLabel: string,
	weeks: CostHistoryWeek[],
	prevMonthTotal: number | null,
): string {
	const lines: string[] = [];

	const totalCost = weeks.reduce((sum, w) => sum + w.totalCost, 0);
	const mealCount = weeks.reduce((sum, w) => sum + w.mealCount, 0);
	const avgPerMeal = mealCount > 0 ? totalCost / mealCount : 0;

	lines.push(`📅 Food Budget — ${monthLabel}`);
	lines.push('');

	// Weekly breakdown
	if (weeks.length > 0) {
		for (const w of weeks) {
			lines.push(`Week ${w.weekId}: $${w.totalCost.toFixed(2)} (${w.mealCount} meals)`);
		}
		lines.push('');
	}

	lines.push(`**Monthly Total: $${totalCost.toFixed(2)}**`);
	lines.push(`Avg per meal: $${avgPerMeal.toFixed(2)} · ${mealCount} meals total`);

	// Comparison to previous month
	if (prevMonthTotal !== null && prevMonthTotal > 0) {
		const diff = totalCost - prevMonthTotal;
		const pct = Math.abs(Math.round((diff / prevMonthTotal) * 100));
		const arrow = diff < 0 ? '↓' : '↑';
		lines.push(`${arrow} ${pct}% vs last month ($${prevMonthTotal.toFixed(2)})`);
	}

	return lines.join('\n');
}

// ─── formatYearlyReportMessage ────────────────────────────────────────────────

/**
 * Format a yearly cost summary as a Telegram-ready message.
 */
export function formatYearlyReportMessage(
	yearLabel: string,
	months: Array<{ monthLabel: string; totalCost: number; mealCount: number }>,
): string {
	const lines: string[] = [];

	const totalCost = months.reduce((sum, m) => sum + m.totalCost, 0);

	lines.push(`📆 Food Budget — ${yearLabel} Annual Summary`);
	lines.push('');

	// Monthly breakdown
	for (const m of months) {
		lines.push(`${m.monthLabel}: $${m.totalCost.toFixed(2)} (${m.mealCount} meals)`);
	}

	lines.push('');
	lines.push(`**YTD Total: $${totalCost.toFixed(2)}**`);

	// Cheapest and priciest months
	if (months.length > 1) {
		const sorted = [...months].sort((a, b) => b.totalCost - a.totalCost);
		const priciest = sorted[0]!;
		const cheapest = sorted[sorted.length - 1]!;
		lines.push(`Priciest month: ${priciest.monthLabel} ($${priciest.totalCost.toFixed(2)})`);
		lines.push(`Cheapest month: ${cheapest.monthLabel} ($${cheapest.totalCost.toFixed(2)})`);
	}

	return lines.join('\n');
}

// ─── saveWeeklyHistory ────────────────────────────────────────────────────────

/**
 * Persist a CostHistoryWeek to `cost-history/{weekId}.md` with YAML frontmatter.
 */
export async function saveWeeklyHistory(
	store: ScopedDataStore,
	week: CostHistoryWeek,
): Promise<void> {
	const fm = generateFrontmatter({
		title: `Cost History — ${week.weekId}`,
		week_id: week.weekId,
		start_date: week.startDate,
		end_date: week.endDate,
		total_cost: week.totalCost,
		meal_count: week.mealCount,
		tags: buildAppTags('food', 'cost-history'),
		app: 'food',
	});

	const body = stringify(week);
	await store.write(`${COST_HISTORY_DIR}/${week.weekId}.md`, fm + '\n' + body);
}

// ─── loadWeeklyHistory ────────────────────────────────────────────────────────

/**
 * Load and parse a CostHistoryWeek from `cost-history/{weekId}.md`.
 * Returns null if the file does not exist.
 */
export async function loadWeeklyHistory(
	store: ScopedDataStore,
	weekId: string,
): Promise<CostHistoryWeek | null> {
	const raw = await store.read(`${COST_HISTORY_DIR}/${weekId}.md`);
	if (!raw) return null;

	try {
		const body = stripFrontmatter(raw);
		const parsed = parse(body) as CostHistoryWeek;
		if (!parsed || typeof parsed.weekId !== 'string') return null;
		return parsed;
	} catch {
		return null;
	}
}

// ─── listWeeklyHistories ──────────────────────────────────────────────────────

/**
 * List all weekId strings that have saved history files.
 */
export async function listWeeklyHistories(store: ScopedDataStore): Promise<string[]> {
	const files = await store.list(COST_HISTORY_DIR);
	return files
		.filter((f) => f.endsWith('.md'))
		.map((f) => f.replace(/\.md$/, ''));
}
