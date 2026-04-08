/**
 * Budget handler — Telegram orchestration for food cost tracking.
 *
 * Handles /foodbudget command: weekly, monthly, and yearly cost reports.
 * Also exports isBudgetViewIntent for free-text routing.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { estimatePlanCost } from '../services/cost-estimator.js';
import {
	formatMonthlyReportMessage,
	formatWeeklyReportMessage,
	formatYearlyReportMessage,
	generateWeeklyReport,
	listWeeklyHistories,
	loadWeeklyHistory,
	saveWeeklyHistory,
} from '../services/budget-reporter.js';
import { loadCurrentPlan } from '../services/meal-plan-store.js';
import { loadStorePrices, listStores } from '../services/price-store.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import { todayDate } from '../utils/date.js';

// Re-export for unified intent surface
export { isPriceUpdateIntent } from '../services/price-store.js';

// ─── Intent Detection ─────────────────────────────────────────────────────────

const BUDGET_KEYWORDS = /\b(budget|spend|spending|cost|costs|spent|expense)\b/i;
const FOOD_CONTEXT = /\b(food|meal|grocery|week|month|year)\b/i;
const HOW_MUCH = /\bhow much\b.{0,30}\b(spend|spent|cost)\b/i;

/**
 * Detect budget-related queries like "how much did we spend on food",
 * "food budget", "what did we spend this week", "show food costs".
 */
export function isBudgetViewIntent(text: string): boolean {
	const lower = text.toLowerCase();
	if (HOW_MUCH.test(lower)) return true;
	return BUDGET_KEYWORDS.test(lower) && FOOD_CONTEXT.test(lower);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the previous month string (e.g. "2026-04" → "2026-03", "2026-01" → "2025-12").
 */
function getPrevMonth(monthStr: string): string {
	const [yearStr, monthNumStr] = monthStr.split('-');
	const year = parseInt(yearStr ?? '2000', 10);
	const month = parseInt(monthNumStr ?? '1', 10);
	if (month === 1) {
		return `${year - 1}-12`;
	}
	return `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * Resolve the price store slug to use: first try config key `default_store`,
 * then fall back to the first available store file, or null if none exist.
 */
async function resolveStoreSlug(
	services: CoreServices,
	sharedStore: ScopedDataStore,
): Promise<string | null> {
	const configStore = (await services.config.get<string>('default_store')) as string | undefined;
	if (configStore) return configStore;
	const stores = await listStores(sharedStore);
	return stores[0] ?? null;
}

// ─── Weekly Report ────────────────────────────────────────────────────────────

async function handleWeeklyBudget(
	services: CoreServices,
	userId: string,
	store: ScopedDataStore,
): Promise<void> {
	const plan = await loadCurrentPlan(store);
	if (!plan) {
		await services.telegram.send(userId, 'No active meal plan found. Generate a meal plan first to track food costs.');
		return;
	}

	const sharedStore = services.data.forShared('shared');
	const storeSlug = await resolveStoreSlug(services, sharedStore);
	if (!storeSlug) {
		await services.telegram.send(userId, 'No price data available. Add a receipt photo or price update to start tracking costs.');
		return;
	}

	const priceData = await loadStorePrices(sharedStore, storeSlug);
	if (!priceData.items.length) {
		await services.telegram.send(userId, 'No price data available. Add a receipt photo or price update to start tracking costs.');
		return;
	}

	const recipes = await loadAllRecipes(store);
	const today = todayDate(services.timezone);

	const estimates = await estimatePlanCost(services, plan, recipes, priceData.items);
	const week = generateWeeklyReport(plan, estimates);

	// Load previous week for comparison
	const prevWeekId = getPrevWeekId(week.weekId);
	const prevWeek = await loadWeeklyHistory(store, prevWeekId);

	// Save this week's history
	await saveWeeklyHistory(store, week);

	const message = formatWeeklyReportMessage(week, prevWeek);
	await services.telegram.send(userId, message);
}

/**
 * Compute the ISO week ID for the week before the given weekId.
 * e.g. "2026-W15" → "2026-W14", "2026-W01" → "2025-W52" (approx)
 */
function getPrevWeekId(weekId: string): string {
	const match = weekId.match(/^(\d{4})-W(\d{2})$/);
	if (!match) return weekId;
	const year = parseInt(match[1]!, 10);
	const week = parseInt(match[2]!, 10);
	if (week > 1) {
		return `${year}-W${String(week - 1).padStart(2, '0')}`;
	}
	// Approximate: go back to week 52 of the prior year
	return `${year - 1}-W52`;
}

// ─── Monthly Report ───────────────────────────────────────────────────────────

async function handleMonthlyBudget(
	services: CoreServices,
	userId: string,
	store: ScopedDataStore,
): Promise<void> {
	const today = todayDate(services.timezone);
	const currentMonth = today.slice(0, 7); // "YYYY-MM"
	const prevMonth = getPrevMonth(currentMonth);

	const allWeekIds = await listWeeklyHistories(store);

	// Filter weeks belonging to current month
	const currentWeeks = await loadWeeksForMonth(store, allWeekIds, currentMonth);
	const prevWeeks = await loadWeeksForMonth(store, allWeekIds, prevMonth);

	if (currentWeeks.length === 0) {
		await services.telegram.send(userId, `No food budget data for ${formatMonthLabel(currentMonth)} yet. Run /foodbudget to generate this week's report first.`);
		return;
	}

	const prevMonthTotal = prevWeeks.length > 0
		? prevWeeks.reduce((sum, w) => sum + w.totalCost, 0)
		: null;

	const monthLabel = formatMonthLabel(currentMonth);
	const message = formatMonthlyReportMessage(monthLabel, currentWeeks, prevMonthTotal);
	await services.telegram.send(userId, message);
}

async function loadWeeksForMonth(
	store: ScopedDataStore,
	allWeekIds: string[],
	monthPrefix: string,
): Promise<import('../types.js').CostHistoryWeek[]> {
	const results: import('../types.js').CostHistoryWeek[] = [];
	for (const weekId of allWeekIds) {
		const week = await loadWeeklyHistory(store, weekId);
		if (!week) continue;
		// Include if startDate or endDate falls within the month
		if (week.startDate.startsWith(monthPrefix) || week.endDate.startsWith(monthPrefix)) {
			results.push(week);
		}
	}
	return results;
}

function formatMonthLabel(monthStr: string): string {
	const d = new Date(`${monthStr}-01T00:00:00Z`);
	return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// ─── Yearly Report ────────────────────────────────────────────────────────────

async function handleYearlyBudget(
	services: CoreServices,
	userId: string,
	store: ScopedDataStore,
): Promise<void> {
	const today = todayDate(services.timezone);
	const currentYear = today.slice(0, 4); // "YYYY"

	const allWeekIds = await listWeeklyHistories(store);
	const yearWeekIds = allWeekIds.filter((id) => id.startsWith(currentYear));

	if (yearWeekIds.length === 0) {
		await services.telegram.send(userId, `No food budget data for ${currentYear} yet. Run /foodbudget to generate weekly reports first.`);
		return;
	}

	// Load all weeks for the year and aggregate by month
	const monthMap = new Map<string, { totalCost: number; mealCount: number }>();

	for (const weekId of yearWeekIds) {
		const week = await loadWeeklyHistory(store, weekId);
		if (!week) continue;
		const monthKey = week.startDate.slice(0, 7);
		const existing = monthMap.get(monthKey) ?? { totalCost: 0, mealCount: 0 };
		monthMap.set(monthKey, {
			totalCost: existing.totalCost + week.totalCost,
			mealCount: existing.mealCount + week.mealCount,
		});
	}

	const months = Array.from(monthMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([monthKey, data]) => ({
			monthLabel: formatMonthLabel(monthKey),
			totalCost: data.totalCost,
			mealCount: data.mealCount,
		}));

	const message = formatYearlyReportMessage(currentYear, months);
	await services.telegram.send(userId, message);
}

// ─── Main Command Handler ─────────────────────────────────────────────────────

/**
 * Handle the /foodbudget command.
 *
 * Routes:
 * - no args / empty → weekly report
 * - "month" → monthly report
 * - "year" → yearly report
 */
export async function handleBudgetCommand(
	services: CoreServices,
	args: string[],
	userId: string,
	store: ScopedDataStore,
): Promise<void> {
	const subCommand = args[0]?.toLowerCase();

	try {
		if (subCommand === 'month') {
			await handleMonthlyBudget(services, userId, store);
		} else if (subCommand === 'year') {
			await handleYearlyBudget(services, userId, store);
		} else {
			await handleWeeklyBudget(services, userId, store);
		}
	} catch (err) {
		services.logger.error({ err }, 'handleBudgetCommand failed');
		await services.telegram.send(userId, 'Unable to generate budget report. Please try again.');
	}
}
