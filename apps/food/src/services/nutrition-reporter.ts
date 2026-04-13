/**
 * Nutrition reporter service — personal nutrition summaries with trend detection.
 *
 * Generates LLM-enhanced summaries from macro tracking data.
 * Used by the /nutrition command and weekly-nutrition-summary scheduled job.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import type { DailyMacroEntry, MacroTargets } from '../types.js';
import { addDays, todayDate } from '../utils/date.js';
import {
	loadMacrosForPeriod,
	computeProgress,
	formatMacroSummary,
	formatAdherenceSummary,
	sumMacros,
} from './macro-tracker.js';

export interface MacroTrend {
	field: string;
	direction: 'increasing' | 'decreasing' | 'stable';
	avgChange: number;
}

/**
 * Detect trends across daily macro entries. Requires at least 3 days of data.
 * Uses simple linear slope to determine direction.
 */
export function detectTrends(entries: DailyMacroEntry[]): MacroTrend[] {
	if (entries.length < 3) return [];

	const fields: Array<{ field: string; getter: (e: DailyMacroEntry) => number }> = [
		{ field: 'calories', getter: e => e.totals.calories ?? 0 },
		{ field: 'protein', getter: e => e.totals.protein ?? 0 },
		{ field: 'carbs', getter: e => e.totals.carbs ?? 0 },
		{ field: 'fat', getter: e => e.totals.fat ?? 0 },
		{ field: 'fiber', getter: e => e.totals.fiber ?? 0 },
	];

	const trends: MacroTrend[] = [];

	for (const { field, getter } of fields) {
		const values = entries.map(getter);
		const n = values.length;

		// Simple linear regression slope
		const xMean = (n - 1) / 2;
		const yMean = values.reduce((a, b) => a + b, 0) / n;
		let numerator = 0;
		let denominator = 0;
		for (let i = 0; i < n; i++) {
			numerator += (i - xMean) * (values[i]! - yMean);
			denominator += (i - xMean) ** 2;
		}
		const slope = denominator === 0 ? 0 : numerator / denominator;

		// Threshold: >5% of mean per day = trending
		const threshold = Math.abs(yMean) * 0.05;
		let direction: MacroTrend['direction'];
		if (slope > threshold) {
			direction = 'increasing';
		} else if (slope < -threshold) {
			direction = 'decreasing';
		} else {
			direction = 'stable';
		}

		trends.push({ field, direction, avgChange: Math.round(slope) });
	}

	return trends;
}

export function formatTrendSummary(trends: MacroTrend[]): string {
	if (trends.length === 0) return '';

	return trends
		.map(t => {
			const label = t.field.charAt(0).toUpperCase() + t.field.slice(1);
			return `${label}: ${t.direction}`;
		})
		.join('\n');
}

export async function generatePersonalSummary(
	services: CoreServices,
	store: ScopedDataStore,
	userId: string,
	startDate: string,
	endDate: string,
	targets: MacroTargets,
): Promise<string> {
	const entries = await loadMacrosForPeriod(store, startDate, endDate);

	if (entries.length === 0) {
		return 'No macro data recorded for this period. Macros are auto-logged when meals are marked as cooked.';
	}

	const progress = computeProgress(entries, targets, `${startDate} to ${endDate}`);
	const trends = detectTrends(entries);
	const trendSummary = formatTrendSummary(trends);

	const dataContext = [
		`Days tracked: ${progress.daysTracked}`,
		`Daily averages: ${progress.dailyAverage.calories ?? 0} cal, ${progress.dailyAverage.protein ?? 0}g protein, ${progress.dailyAverage.carbs ?? 0}g carbs, ${progress.dailyAverage.fat ?? 0}g fat, ${progress.dailyAverage.fiber ?? 0}g fiber`,
		`Totals: ${progress.current.calories ?? 0} cal, ${progress.current.protein ?? 0}g protein, ${progress.current.carbs ?? 0}g carbs, ${progress.current.fat ?? 0}g fat, ${progress.current.fiber ?? 0}g fiber`,
	];

	if (targets.calories || targets.protein || targets.carbs || targets.fat || targets.fiber) {
		dataContext.push(
			`Targets: ${targets.calories ?? 'none'} cal, ${targets.protein ?? 'none'}g protein, ${targets.carbs ?? 'none'}g carbs, ${targets.fat ?? 'none'}g fat, ${targets.fiber ?? 'none'}g fiber`,
		);
	}

	if (trendSummary) {
		dataContext.push(`Trends: ${trendSummary}`);
	}

	if (progress.adherence) {
		const adherenceBlock = formatAdherenceSummary(progress.adherence);
		if (adherenceBlock) {
			dataContext.push(`Adherence:\n${adherenceBlock}`);
		}
	}

	try {
		const prompt = `You are a friendly nutrition assistant. Summarize the following nutrition data in 2-3 concise sentences. Be encouraging and highlight any notable patterns. Do not give medical advice.

${dataContext.join('\n')}

Write a brief, friendly summary.`;

		const llmSummary = await services.llm.complete(prompt, { tier: 'fast' });
		return llmSummary;
	} catch {
		// Fallback to structured summary without LLM
		return formatMacroSummary(progress);
	}
}

export async function generateWeeklyDigest(
	services: CoreServices,
	store: ScopedDataStore,
	userId: string,
	targets: MacroTargets,
	today?: string,
): Promise<string> {
	const endDate = today ?? todayDate(services.timezone);
	const startDate = addDays(endDate, -7);

	return generatePersonalSummary(services, store, userId, startDate, endDate, targets);
}
