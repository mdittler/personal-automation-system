/**
 * Pediatrician report service — structured child eating habit summaries.
 *
 * Generates deterministic, structured reports from child food logs and macro data.
 * No LLM usage — all data aggregation is pure logic for reliability.
 */

import type { ScopedDataStore } from '@pas/core/types';
import type { ChildFoodLog, DailyMacroEntry, FoodIntroduction, MacroData, Recipe } from '../types.js';
import { addDays } from '../utils/date.js';
import { computeAgeDisplay } from './family-profiles.js';
import { averageMacros, loadMacrosForPeriod } from './macro-tracker.js';

export interface FoodVarietyResult {
	count: number;
	foods: string[];
}

export interface AllergenHistoryEntry {
	category: string;
	firstIntroduced: string;
	foods: string[];
	reactions: string[];
}

export interface ReactionEntry {
	food: string;
	severity: string;
	date: string;
	notes: string;
}

export interface ApprovalResult {
	approved: string[];
	rejected: string[];
}

export interface PediatricianReportData {
	childName: string;
	age: string;
	periodDays: number;
	foodVariety: FoodVarietyResult;
	allergenHistory: AllergenHistoryEntry[];
	reactions: ReactionEntry[];
	macroBalance: MacroData;
	approvals: ApprovalResult;
}

export function computeFoodVariety(
	introductions: FoodIntroduction[],
	periodDays: number,
	today: string,
): FoodVarietyResult {
	const cutoffStr = addDays(today, -periodDays);

	const recentFoods = introductions
		.filter(i => i.date >= cutoffStr)
		.map(i => i.food);

	const unique = [...new Set(recentFoods)];
	return { count: unique.length, foods: unique };
}

export function computeAllergenHistory(introductions: FoodIntroduction[]): AllergenHistoryEntry[] {
	const map = new Map<string, { foods: Set<string>; firstDate: string; reactions: string[] }>();

	for (const intro of introductions) {
		if (!intro.allergenCategory) continue;

		const existing = map.get(intro.allergenCategory);
		if (existing) {
			existing.foods.add(intro.food);
			if (intro.date < existing.firstDate) {
				existing.firstDate = intro.date;
			}
			if (intro.reaction !== 'none') {
				existing.reactions.push(`${intro.food}: ${intro.reaction}`);
			}
		} else {
			map.set(intro.allergenCategory, {
				foods: new Set([intro.food]),
				firstDate: intro.date,
				reactions: intro.reaction !== 'none' ? [`${intro.food}: ${intro.reaction}`] : [],
			});
		}
	}

	return [...map.entries()]
		.map(([category, data]) => ({
			category,
			firstIntroduced: data.firstDate,
			foods: [...data.foods],
			reactions: data.reactions,
		}))
		.sort((a, b) => a.firstIntroduced.localeCompare(b.firstIntroduced));
}

export function computeReactionSummary(introductions: FoodIntroduction[]): ReactionEntry[] {
	return introductions
		.filter(i => i.reaction !== 'none')
		.map(i => ({
			food: i.food,
			severity: i.reaction,
			date: i.date,
			notes: i.notes,
		}));
}

export function computeApprovalSummary(recipes: Recipe[], childSlug: string): ApprovalResult {
	const approved: string[] = [];
	const rejected: string[] = [];

	for (const recipe of recipes) {
		if (!recipe.childApprovals) continue;
		const status = recipe.childApprovals[childSlug];
		if (status === 'approved') approved.push(recipe.title);
		else if (status === 'rejected') rejected.push(recipe.title);
	}

	return { approved, rejected };
}

export function computeMacroBalance(entries: DailyMacroEntry[]): MacroData {
	if (entries.length === 0) {
		return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
	}
	return averageMacros(entries.map(e => e.totals), entries.length);
}

export function formatPediatricianReport(data: PediatricianReportData): string {
	const lines: string[] = [];

	lines.push(`**Pediatrician Report — ${data.childName}** (${data.age})`);
	lines.push(`Period: last ${data.periodDays} days`);
	lines.push('');

	// Food variety
	lines.push(`**Food Variety:** ${data.foodVariety.count} unique foods`);
	if (data.foodVariety.foods.length > 0) {
		lines.push(data.foodVariety.foods.join(', '));
	}
	lines.push('');

	// Allergen history
	lines.push('**Allergen Exposure:**');
	if (data.allergenHistory.length === 0) {
		lines.push('No allergen introductions recorded.');
	} else {
		for (const entry of data.allergenHistory) {
			lines.push(`- ${entry.category}: introduced ${entry.firstIntroduced} (${entry.foods.join(', ')})`);
		}
	}
	lines.push('');

	// Reactions
	lines.push('**Reactions:**');
	if (data.reactions.length === 0) {
		lines.push('No reactions recorded.');
	} else {
		for (const r of data.reactions) {
			lines.push(`- ${r.food}: ${r.severity} (${r.date})${r.notes ? ` — ${r.notes}` : ''}`);
		}
	}
	lines.push('');

	// Macro balance
	lines.push('**Nutrition (daily avg):**');
	const m = data.macroBalance;
	if ((m.calories ?? 0) > 0) {
		lines.push(`${m.calories} cal | ${m.protein ?? 0}g protein | ${m.carbs ?? 0}g carbs | ${m.fat ?? 0}g fat`);
	} else {
		lines.push('No macro data tracked.');
	}
	lines.push('');

	// Approvals
	lines.push('**Recipe Preferences:**');
	if (data.approvals.approved.length > 0) {
		lines.push(`Approved: ${data.approvals.approved.join(', ')}`);
	}
	if (data.approvals.rejected.length > 0) {
		lines.push(`Rejected: ${data.approvals.rejected.join(', ')}`);
	}
	if (data.approvals.approved.length === 0 && data.approvals.rejected.length === 0) {
		lines.push('No recipe preference data.');
	}

	return lines.join('\n');
}

export async function generatePediatricianReport(
	sharedStore: ScopedDataStore,
	userStore: ScopedDataStore,
	childLog: ChildFoodLog,
	recipes: Recipe[],
	periodDays: number,
	today: string,
): Promise<string> {
	const age = computeAgeDisplay(childLog.profile.birthDate, today);
	const foodVariety = computeFoodVariety(childLog.introductions, periodDays, today);
	const allergenHistory = computeAllergenHistory(childLog.introductions);
	const reactions = computeReactionSummary(childLog.introductions);
	const approvals = computeApprovalSummary(recipes, childLog.profile.slug);

	// Load macro data for the period
	const endDate = today;
	const startStr = addDays(today, -periodDays);

	const macroEntries = await loadMacrosForPeriod(userStore, startStr, endDate);
	const macroBalance = computeMacroBalance(macroEntries);

	return formatPediatricianReport({
		childName: childLog.profile.name,
		age,
		periodDays,
		foodVariety,
		allergenHistory,
		reactions,
		macroBalance,
		approvals,
	});
}
