/**
 * Budget Alerts — detects meal plans that are projected to exceed historical averages.
 *
 * Compares the projected cost of current estimates against a rolling average
 * from recent weekly history. Triggers an alert when >15% above average.
 */

import type { CostHistoryWeek, MealCostEstimate } from '../types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BudgetAlert {
	projectedCost: number;
	averageCost: number;
	percentAbove: number;
	mostExpensiveMeal: { title: string; cost: number };
}

// ─── checkBudgetAlert ─────────────────────────────────────────────────────────

/**
 * Check whether the current plan's projected cost exceeds the rolling average
 * by more than 15%. Returns a BudgetAlert if so, or null otherwise.
 *
 * @param estimates   Cost estimates for the current plan's meals
 * @param recentWeeks Historical weekly summaries for rolling average
 */
export function checkBudgetAlert(
	estimates: MealCostEstimate[],
	recentWeeks: CostHistoryWeek[],
): BudgetAlert | null {
	if (estimates.length === 0 || recentWeeks.length === 0) return null;

	// Rolling average weekly cost from historical weeks
	const averageCost = recentWeeks.reduce((sum, w) => sum + w.totalCost, 0) / recentWeeks.length;

	// Projected cost = sum of all estimates in the current plan
	const projectedCost = estimates.reduce((sum, e) => sum + e.totalCost, 0);

	const percentAbove = ((projectedCost - averageCost) / averageCost) * 100;

	if (percentAbove <= 15) return null;

	// Find the most expensive meal
	const sorted = [...estimates].sort((a, b) => b.totalCost - a.totalCost);
	const top = sorted[0]!;

	return {
		projectedCost,
		averageCost,
		percentAbove: Math.round(percentAbove * 10) / 10,
		mostExpensiveMeal: { title: top.recipeTitle, cost: top.totalCost },
	};
}

// ─── formatBudgetAlert ────────────────────────────────────────────────────────

/**
 * Format a BudgetAlert as a Telegram-ready message.
 */
export function formatBudgetAlert(alert: BudgetAlert): string {
	const lines: string[] = [];

	lines.push(
		`⚠️ ${Math.round(alert.percentAbove)}% above your 4-week avg ($${alert.averageCost.toFixed(2)})`,
	);
	lines.push(
		`💡 Most expensive: ${alert.mostExpensiveMeal.title} ($${alert.mostExpensiveMeal.cost.toFixed(2)}) — consider a swap to lower the total`,
	);

	return lines.join('\n');
}
