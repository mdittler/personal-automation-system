/**
 * Macro tracker service — daily macro nutrient logging and progress tracking.
 *
 * Per-user monthly YAML files at nutrition/YYYY-MM.yaml store daily macro logs.
 * Auto-logging from cooked meals provides the primary data pipeline.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import type {
	DailyMacroEntry,
	MacroAdherence,
	MacroData,
	MacroFieldAdherence,
	MacroProgress,
	MacroTargets,
	MealMacroEntry,
	MonthlyMacroLog,
	Recipe,
} from '../types.js';

/** A day "hits" a macro target if the day's total is within ±this fraction of the target. */
export const ADHERENCE_TOLERANCE = 0.10;

const MACRO_FIELDS: Array<keyof MacroData & keyof MacroTargets> = [
	'calories',
	'protein',
	'carbs',
	'fat',
	'fiber',
];

function nutritionPath(month: string): string {
	// Validate YYYY-MM format to prevent path traversal
	if (!/^\d{4}-\d{2}$/.test(month)) {
		throw new Error(`Invalid month format: expected YYYY-MM`);
	}
	return `nutrition/${month}.yaml`;
}

/** Zod schema for write-time validation of MealMacroEntry (M2). */
const MacroDataSchema = z.object({
	calories: z.number().nonnegative().max(99999).optional().default(0),
	protein: z.number().nonnegative().max(99999).optional().default(0),
	carbs: z.number().nonnegative().max(99999).optional().default(0),
	fat: z.number().nonnegative().max(99999).optional().default(0),
	fiber: z.number().nonnegative().max(99999).optional().default(0),
});

const MealMacroEntrySchema = z.object({
	recipeId: z.string().min(1).max(200),
	recipeTitle: z.string().min(1).max(200),
	mealType: z.string().min(1).max(50),
	servingsEaten: z.number().positive().max(100),
	macros: MacroDataSchema,
	estimationKind: z.enum(['recipe', 'quick-meal', 'llm-ad-hoc', 'manual']).optional(),
	confidence: z.number().min(0).max(1).optional(),
	sourceId: z.string().max(200).optional(),
});

/**
 * Preserve a corrupt nutrition file as a sidecar in `corrupt/` so it can be
 * recovered manually. Returns without throwing — the caller always gets null.
 * H3 fix: prevents silent data loss when YAML is malformed or schema-invalid.
 *
 * NOTE: ScopedDataStore has no rename/delete operation, so the original corrupt
 * file is not quarantined — it remains in place. Each subsequent loadMonthlyLog
 * call on the same corrupt month will write another sidecar with a new timestamp.
 * Sidecars accumulate until the corrupt original is manually removed. This is a
 * known limitation; true quarantine would require extending ScopedDataStore.
 */
async function preserveCorruptFile(
	store: ScopedDataStore,
	raw: string,
	month: string,
	err: unknown,
): Promise<void> {
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	const corruptPath = `corrupt/nutrition-${month}-${ts}.yaml`;
	try {
		await store.write(corruptPath, raw);
	} catch {
		// If we cannot preserve, swallow — surfacing this would obscure the original error.
	}
	// eslint-disable-next-line no-console
	console.error(
		`[macro-tracker] Corrupt YAML for ${month} preserved as ${corruptPath}:`,
		(err as Error)?.message ?? err,
	);
}

export function sumMacros(...entries: MacroData[]): MacroData {
	const result: MacroData = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
	for (const e of entries) {
		result.calories = (result.calories ?? 0) + (e.calories ?? 0);
		result.protein = (result.protein ?? 0) + (e.protein ?? 0);
		result.carbs = (result.carbs ?? 0) + (e.carbs ?? 0);
		result.fat = (result.fat ?? 0) + (e.fat ?? 0);
		result.fiber = (result.fiber ?? 0) + (e.fiber ?? 0);
	}
	return result;
}

export function averageMacros(entries: MacroData[], count: number): MacroData {
	if (count === 0) return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
	const total = sumMacros(...entries);
	return {
		calories: Math.round((total.calories ?? 0) / count),
		protein: Math.round((total.protein ?? 0) / count),
		carbs: Math.round((total.carbs ?? 0) / count),
		fat: Math.round((total.fat ?? 0) / count),
		fiber: Math.round((total.fiber ?? 0) / count),
	};
}

export function macrosFromRecipe(recipe: Recipe, servingsEaten: number): MacroData {
	if (!recipe.macros || recipe.servings <= 0) {
		return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
	}
	const factor = servingsEaten / recipe.servings;
	return {
		calories: Math.round((recipe.macros.calories ?? 0) * factor),
		protein: Math.round((recipe.macros.protein ?? 0) * factor),
		carbs: Math.round((recipe.macros.carbs ?? 0) * factor),
		fat: Math.round((recipe.macros.fat ?? 0) * factor),
		fiber: Math.round((recipe.macros.fiber ?? 0) * factor),
	};
}

export async function loadMonthlyLog(
	store: ScopedDataStore,
	month: string,
): Promise<MonthlyMacroLog | null> {
	const raw = await store.read(nutritionPath(month));
	if (!raw) return null;

	try {
		const content = stripFrontmatter(raw);
		if (!content.trim()) return null;
		const data = parse(content) as MonthlyMacroLog;
		// Schema-invalid but non-empty YAML: preserve before discarding (H3).
		if (!data?.month) {
			await preserveCorruptFile(store, raw, month, new Error('parsed YAML missing required "month" field'));
			return null;
		}
		return {
			month: data.month,
			userId: data.userId,
			days: data.days ?? [],
		};
	} catch (err) {
		await preserveCorruptFile(store, raw, month, err);
		return null;
	}
}

export async function saveMonthlyLog(
	store: ScopedDataStore,
	log: MonthlyMacroLog,
): Promise<void> {
	const fm = generateFrontmatter({
		title: `Nutrition ${log.month}`,
		date: new Date().toISOString(),
		tags: buildAppTags('food', 'nutrition'),
		type: 'nutrition-log',
		app: 'food',
	});
	const body = stringify({
		month: log.month,
		userId: log.userId,
		days: log.days,
	});
	await store.write(nutritionPath(log.month), fm + body);
}

export function getDailyMacros(log: MonthlyMacroLog, date: string): DailyMacroEntry | null {
	return log.days.find(d => d.date === date) ?? null;
}

export async function logMealMacros(
	store: ScopedDataStore,
	userId: string,
	entry: MealMacroEntry,
	date: string,
): Promise<void> {
	// M2: validate and normalize the entry before persisting
	const parsed = MealMacroEntrySchema.safeParse(entry);
	if (!parsed.success) {
		// eslint-disable-next-line no-console
		console.error('[macro-tracker] logMealMacros: invalid entry, skipping write:', parsed.error.flatten());
		return;
	}
	const validEntry = parsed.data as MealMacroEntry;

	const month = date.slice(0, 7); // YYYY-MM
	let log = await loadMonthlyLog(store, month);
	if (!log) {
		log = { month, userId, days: [] };
	}

	let day = log.days.find(d => d.date === date);
	if (!day) {
		day = { date, meals: [], totals: { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } };
		log.days.push(day);
	}

	day.meals.push(validEntry);
	day.totals = sumMacros(...day.meals.map(m => m.macros));

	await saveMonthlyLog(store, log);
}

export async function loadMacrosForPeriod(
	store: ScopedDataStore,
	startDate: string,
	endDate: string,
): Promise<DailyMacroEntry[]> {
	const start = new Date(startDate);
	const end = new Date(endDate);
	const months = new Set<string>();

	// Collect all months in the range — use day 1 (UTC) to avoid setMonth skipping months
	const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
	while (cursor <= end) {
		months.add(cursor.toISOString().slice(0, 7));
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}
	// Ensure the end month is included
	months.add(end.toISOString().slice(0, 7));

	const entries: DailyMacroEntry[] = [];
	for (const month of months) {
		const log = await loadMonthlyLog(store, month);
		if (!log) continue;
		for (const day of log.days) {
			if (day.date >= startDate && day.date <= endDate) {
				entries.push(day);
			}
		}
	}

	return entries.sort((a, b) => a.date.localeCompare(b.date));
}

export function computeProgress(
	entries: DailyMacroEntry[],
	targets: MacroTargets,
	period: string,
): MacroProgress {
	const totals = entries.map(e => e.totals);
	const current = sumMacros(...totals);
	const dailyAverage = averageMacros(totals, entries.length);

	const hasAnyTarget = MACRO_FIELDS.some(f => (targets[f] ?? 0) > 0);
	const adherence = hasAnyTarget && entries.length > 0
		? computeAdherence(entries, targets)
		: undefined;

	return {
		current,
		targets,
		period,
		daysTracked: entries.length,
		dailyAverage,
		adherence,
	};
}

/**
 * Compute per-macro adherence over a list of daily entries.
 *
 * For each macro with a non-zero target, a day "hits" if the day's total is within
 * ±ADHERENCE_TOLERANCE of the target. Days where the target is unset are skipped.
 * Entries are expected to be sorted chronologically; currentStreak reflects the tail.
 */
export function computeAdherence(
	entries: DailyMacroEntry[],
	targets: MacroTargets,
): MacroAdherence {
	const result: MacroAdherence = {};

	for (const field of MACRO_FIELDS) {
		const target = targets[field] ?? 0;
		if (target <= 0) continue;

		const lo = target * (1 - ADHERENCE_TOLERANCE);
		const hi = target * (1 + ADHERENCE_TOLERANCE);

		let daysHit = 0;
		let currentStreak = 0;
		let longestStreak = 0;
		let runningStreak = 0;

		for (const day of entries) {
			const value = day.totals[field] ?? 0;
			const hit = value >= lo && value <= hi;
			if (hit) {
				daysHit++;
				runningStreak++;
				if (runningStreak > longestStreak) longestStreak = runningStreak;
			} else {
				runningStreak = 0;
			}
			currentStreak = runningStreak;
		}

		const daysTracked = entries.length;
		const percentHit = daysTracked === 0 ? 0 : Math.round((daysHit / daysTracked) * 100);

		const fieldResult: MacroFieldAdherence = {
			daysTracked,
			daysHit,
			percentHit,
			currentStreak,
			longestStreak,
		};
		result[field] = fieldResult;
	}

	return result;
}

export function formatAdherenceSummary(adherence: MacroAdherence): string {
	const lines: string[] = [];
	const order: Array<keyof MacroAdherence> = ['calories', 'protein', 'carbs', 'fat', 'fiber'];
	const labels: Record<keyof MacroAdherence, string> = {
		calories: 'Calories',
		protein: 'Protein',
		carbs: 'Carbs',
		fat: 'Fat',
		fiber: 'Fiber',
	};
	for (const field of order) {
		const f = adherence[field];
		if (!f) continue;
		lines.push(
			`${labels[field]}: ${f.daysHit} / ${f.daysTracked} days on target (${f.percentHit}%)  •  streak: ${f.currentStreak}${f.longestStreak > f.currentStreak ? ` (best ${f.longestStreak})` : ''}`,
		);
	}
	return lines.join('\n');
}

export function formatMacroSummary(progress: MacroProgress, dailyEntry?: DailyMacroEntry): string {
	if (progress.daysTracked === 0) {
		return `No macro data tracked for ${progress.period}.`;
	}

	const lines: string[] = [`**Nutrition — ${progress.period}** (${progress.daysTracked} day${progress.daysTracked === 1 ? '' : 's'})`];
	lines.push('');

	// H11.w: If daily entry is provided and has meals, list them
	if (dailyEntry && dailyEntry.meals.length > 0) {
		const hasLowConfidence = dailyEntry.meals.some(
			m => m.confidence !== undefined && m.confidence < 0.5,
		);

		for (const meal of dailyEntry.meals) {
			const isLowConf = meal.confidence !== undefined && meal.confidence < 0.5;
			const flag = isLowConf ? ' *' : '';
			lines.push(`- **${escapeMarkdown(meal.recipeTitle)}**${flag}`);
		}

		if (hasLowConfidence) {
			lines.push('_* low-confidence estimate_');
		}

		lines.push('');
	}

	const hasTargets = Object.values(progress.targets).some(v => v !== undefined && v > 0);

	const formatField = (label: string, value: number | undefined, target: number | undefined): string => {
		const val = value ?? 0;
		if (hasTargets && target && target > 0) {
			return `${label}: ${val} / ${target}`;
		}
		return `${label}: ${val}`;
	};

	lines.push(formatField('Calories', progress.dailyAverage.calories, progress.targets.calories));
	lines.push(formatField('Protein', progress.dailyAverage.protein, progress.targets.protein));
	lines.push(formatField('Carbs', progress.dailyAverage.carbs, progress.targets.carbs));
	lines.push(formatField('Fat', progress.dailyAverage.fat, progress.targets.fat));
	lines.push(formatField('Fiber', progress.dailyAverage.fiber, progress.targets.fiber));

	if (progress.daysTracked > 1) {
		lines.push('');
		lines.push(`Total: ${progress.current.calories ?? 0} cal over ${progress.daysTracked} days`);
	}

	if (progress.adherence) {
		const adherenceBlock = formatAdherenceSummary(progress.adherence);
		if (adherenceBlock) {
			lines.push('');
			lines.push('**Adherence**');
			lines.push(adherenceBlock);
		}
	}

	return lines.join('\n');
}

export async function autoLogFromCookedMeal(
	store: ScopedDataStore,
	userId: string,
	recipe: Recipe,
	servingsEaten: number,
	date: string,
	mealType: string,
): Promise<void> {
	const macros = macrosFromRecipe(recipe, servingsEaten);
	const entry: MealMacroEntry = {
		recipeId: recipe.id,
		recipeTitle: recipe.title,
		mealType,
		servingsEaten,
		macros,
	};
	await logMealMacros(store, userId, entry, date);
}
