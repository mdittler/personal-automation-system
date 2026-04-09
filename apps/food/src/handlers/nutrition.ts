/**
 * Nutrition handler — /nutrition command for macro tracking, summaries, and pediatrician reports.
 */

import type { CoreServices, InlineButton, ScopedDataStore } from '@pas/core/types';
import { generateFrontmatter, stripFrontmatter, buildAppTags } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import { generateWeeklyDigest, generatePersonalSummary } from '../services/nutrition-reporter.js';
import { generatePediatricianReport } from '../services/pediatrician-report.js';
import { loadChildProfile, loadAllChildren } from '../services/family-profiles.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import { matchRecipes } from '../services/recipe-matcher.js';
import { parsePortion } from '../services/portion-parser.js';
import {
	loadQuickMeals,
	archiveQuickMeal,
	slugifyLabel,
} from '../services/quick-meals-store.js';
import {
	loadMonthlyLog,
	getDailyMacros,
	computeProgress,
	computeAdherence,
	formatMacroSummary,
	formatAdherenceSummary,
	logMealMacros,
	loadMacrosForPeriod,
} from '../services/macro-tracker.js';
import { todayDate } from '../utils/date.js';
import type { MacroTargets, MealMacroEntry } from '../types.js';

// ─── Intent Detection ────��──────────────────────────��─────────────────────────

const NUTRITION_KEYWORDS = /\b(nutrition|macros?|calories?|calorie|protein|carbs?|intake|macro)\b/i;
const NUTRITION_CONTEXT = /\b(track|show|summary|how|view|check|my|intake|this)\b/i;

export function isNutritionViewIntent(text: string): boolean {
	const lower = text.toLowerCase();
	return NUTRITION_KEYWORDS.test(lower) && NUTRITION_CONTEXT.test(lower);
}

// ─── Helpers ────���───────────────────��──────────────────────────────────��──────

const TARGETS_FILE = 'nutrition/targets.yaml';

const CONFIG_TARGET_KEYS: Array<[keyof MacroTargets, string]> = [
	['calories', 'macro_target_calories'],
	['protein', 'macro_target_protein'],
	['carbs', 'macro_target_carbs'],
	['fat', 'macro_target_fat'],
	['fiber', 'macro_target_fiber'],
];

async function loadTargets(
	services: CoreServices,
	userStore: ScopedDataStore,
): Promise<MacroTargets> {
	// Base layer: YAML file (CLI source of truth for users who set
	// targets via `/nutrition targets set`).
	let base: MacroTargets = {};
	const raw = await userStore.read(TARGETS_FILE);
	if (raw) {
		try {
			const content = stripFrontmatter(raw);
			if (content.trim()) {
				base = (parse(content) as MacroTargets) ?? {};
			}
		} catch {
			// ignore — corrupt YAML falls through to an empty base
		}
	}

	// Overlay: any non-zero user_config values (GUI overrides). Keys
	// the user has not explicitly set in the GUI stay at the base YAML
	// value instead of being clobbered to undefined / "not set".
	for (const [field, key] of CONFIG_TARGET_KEYS) {
		try {
			const val = await services.config.get<number>(key);
			if (typeof val === 'number' && val > 0) base[field] = val;
		} catch {
			// ignore — a failing config read leaves the YAML base intact
		}
	}
	return base;
}

async function saveTargets(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	targets: MacroTargets,
): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Macro Targets',
		date: new Date().toISOString(),
		tags: buildAppTags('food', 'nutrition'),
	});
	await userStore.write(TARGETS_FILE, fm + stringify(targets));

	// Mirror to user_config so the GUI editor stays in sync.
	// setAll exists on AppConfigServiceImpl but isn't part of the public interface.
	const configImpl = services.config as unknown as {
		getAll?: (userId?: string) => Promise<Record<string, unknown>>;
		setAll?: (userId: string, values: Record<string, unknown>) => Promise<void>;
	};
	if (typeof configImpl.setAll === 'function' && typeof configImpl.getAll === 'function') {
		try {
			const existing = await configImpl.getAll(userId);
			const merged = { ...existing };
			for (const [field, key] of CONFIG_TARGET_KEYS) {
				merged[key] = targets[field] ?? 0;
			}
			await configImpl.setAll(userId, merged);
		} catch (err) {
			services.logger.warn('Failed to mirror macro targets to user_config', err);
		}
	}
}

// ─���─ Main Handler ────���────────────────────────────────────────────────────────

export async function handleNutritionCommand(
	services: CoreServices,
	args: string[],
	userId: string,
	sharedStore: ScopedDataStore,
): Promise<void> {
	const subCommand = args[0]?.toLowerCase();
	const userStore = services.data.forUser(userId);

	try {
		if (!subCommand || subCommand === 'today' || subCommand === 'day' || subCommand === 'daily') {
			const targets = await loadTargets(services, userStore);
			const today = todayDate(services.timezone);
			const month = today.slice(0, 7);
			const log = await loadMonthlyLog(userStore, month);
			const day = log ? getDailyMacros(log, today) : null;

			if (!day) {
				await services.telegram.send(userId,
					`No macro data tracked for today (${today}).\nLog meals with "Cooked!" on planned meals, or use \`/nutrition log <label> <cal> <protein> <carbs> <fat> [fiber]\`.`);
				return;
			}

			const progress = computeProgress([day], targets, 'today');
			await services.telegram.send(userId, formatMacroSummary(progress));
			return;
		}

		if (subCommand === 'week') {
			const targets = await loadTargets(services, userStore);
			const today = todayDate(services.timezone);
			const summary = await generateWeeklyDigest(services, userStore, userId, targets, today);
			await services.telegram.send(userId, summary);
			return;
		}

		if (subCommand === 'month') {
			const targets = await loadTargets(services, userStore);
			const today = todayDate(services.timezone);
			const endDate = today;
			const start = new Date(today);
			start.setDate(start.getDate() - 30);
			const startDate = start.toISOString().slice(0, 10);

			const summary = await generatePersonalSummary(services, userStore, userId, startDate, endDate, targets);
			await services.telegram.send(userId, summary);
			return;
		}

		if (subCommand === 'meals') {
			const mealsSub = args[1]?.toLowerCase();

			if (!mealsSub || mealsSub === 'list') {
				const list = await loadQuickMeals(userStore);
				if (list.length === 0) {
					await services.telegram.send(userId,
						'No quick-meals saved yet. Use `/nutrition meals add` to create one.');
					return;
				}
				const byKind: Record<'home' | 'restaurant' | 'other', typeof list> = {
					home: [], restaurant: [], other: [],
				};
				for (const t of list) byKind[t.kind].push(t);
				for (const k of Object.keys(byKind) as Array<keyof typeof byKind>) {
					byKind[k].sort((a, b) => b.usageCount - a.usageCount);
				}
				const lines: string[] = ['**Quick Meals**'];
				for (const k of ['home', 'restaurant', 'other'] as const) {
					if (byKind[k].length === 0) continue;
					lines.push('', `_${k}_`);
					for (const t of byKind[k]) {
						lines.push(`- **${t.label}** — ${t.estimatedMacros.calories ?? 0} cal (${t.usageCount}× used)`);
					}
				}
				await services.telegram.send(userId, lines.join('\n'));
				return;
			}

			if (mealsSub === 'remove') {
				const label = args.slice(2).join(' ').trim();
				if (!label) {
					await services.telegram.send(userId, 'Usage: `/nutrition meals remove <label>`');
					return;
				}
				const id = slugifyLabel(label);
				await archiveQuickMeal(userStore, id);
				await services.telegram.send(userId, `Removed quick-meal: ${label}`);
				return;
			}

			if (mealsSub === 'add' || mealsSub === 'edit') {
				// Scaffolded in Tasks 10b / 10c — do NOT implement here.
				await services.telegram.send(userId,
					`meals ${mealsSub} arrives in the next H11.w sub-task.`);
				return;
			}

			await services.telegram.send(userId,
				'Unknown: `/nutrition meals <add|list|edit|remove>`');
			return;
		}

		if (subCommand === 'log') {
			// Path 1: Legacy numeric form — preserved verbatim for back-compat.
			// Triggered when the caller supplies a label plus at least four
			// following tokens (calories, protein, carbs, fat) — i.e. args.length >= 6.
			// This matches the historical shape `/nutrition log <label> <cal> <p> <c> <f> [fiber]`
			// and keeps the existing per-field error messages that legacy tests pin on.
			// Recipe-reference calls use at most 4 args (`log <word> <word> <portion>`)
			// so this 6-arg heuristic avoids colliding with the smart-log path.
			if (args.length >= 6) {
				const label = args[1];
				if (!label) {
					await services.telegram.send(userId,
						'Usage: `/nutrition log <label> <cal> <protein> <carbs> <fat> [fiber]`\nExample: `/nutrition log lunch 600 40 50 20 8`');
					return;
				}
				if (label.length > 100) {
					await services.telegram.send(userId,
						'Invalid label: must be 100 characters or fewer.');
					return;
				}
				type FieldSpec = { name: string; raw: string | undefined; optional?: boolean };
				const specs: FieldSpec[] = [
					{ name: 'calories', raw: args[2] },
					{ name: 'protein', raw: args[3] },
					{ name: 'carbs', raw: args[4] },
					{ name: 'fat', raw: args[5] },
					{ name: 'fiber', raw: args[6], optional: true },
				];
				const parsed: Record<string, number> = {};
				for (const spec of specs) {
					if (spec.raw === undefined) {
						if (spec.optional) {
							parsed[spec.name] = 0;
							continue;
						}
						await services.telegram.send(userId,
							`Invalid ${spec.name} value: ''. Must be a number between 0 and 99999.`);
						return;
					}
					const val = parseInt(spec.raw, 10);
					if (isNaN(val) || val < 0 || val > 99999) {
						await services.telegram.send(userId,
							`Invalid ${spec.name} value: '${spec.raw}'. Must be a number between 0 and 99999.`);
						return;
					}
					parsed[spec.name] = val;
				}
				const calories = parsed.calories ?? 0;
				const protein = parsed.protein ?? 0;
				const carbs = parsed.carbs ?? 0;
				const fat = parsed.fat ?? 0;
				const fiber = parsed.fiber ?? 0;

				const entry: MealMacroEntry = {
					recipeId: 'manual',
					recipeTitle: label,
					mealType: 'manual',
					servingsEaten: 1,
					macros: { calories, protein, carbs, fat, fiber },
				};
				const today = todayDate(services.timezone);
				await logMealMacros(userStore, userId, entry, today);
				await services.telegram.send(userId,
					`Logged: **${label}** — ${calories} cal, ${protein}g protein`);
				return;
			}

			// Path 2+: Smart log — recipe reference (quick-meal / ad-hoc fallthroughs
			// arrive in H11.w Tasks 10/12).
			const rawArgs = args.slice(1);
			if (rawArgs.length === 0) {
				await services.telegram.send(userId,
					'Usage: `/nutrition log <meal name> [portion]`\n' +
					'Examples:\n' +
					'  `/nutrition log lasagna half`\n' +
					'  `/nutrition log chicken curry 1.5`');
				return;
			}

			// If the last token parses as a portion, peel it off; otherwise
			// treat everything as the label and default portion to 1.
			let portionRaw = '1';
			let labelText = rawArgs.join(' ');
			if (rawArgs.length >= 2) {
				const maybePortion = parsePortion(rawArgs[rawArgs.length - 1]!);
				if (maybePortion.ok) {
					portionRaw = rawArgs[rawArgs.length - 1]!;
					labelText = rawArgs.slice(0, -1).join(' ');
				}
			}
			const portion = parsePortion(portionRaw);
			if (!portion.ok) {
				await services.telegram.send(userId, `Invalid portion: ${portion.error}`);
				return;
			}
			if (labelText.length === 0) {
				await services.telegram.send(userId,
					'Usage: `/nutrition log <meal name> [portion]`');
				return;
			}
			if (labelText.length > 100) {
				await services.telegram.send(userId,
					'Invalid label: must be 100 characters or fewer.');
				return;
			}

			const recipes = await loadAllRecipes(sharedStore);
			const match = matchRecipes(labelText, recipes);

			if (match.kind === 'unique') {
				const r = match.recipe;
				const per = r.macros ?? {};
				const scale = portion.value;
				const scaled = {
					calories: Math.round((per.calories ?? 0) * scale),
					protein: Math.round((per.protein ?? 0) * scale),
					carbs: Math.round((per.carbs ?? 0) * scale),
					fat: Math.round((per.fat ?? 0) * scale),
					fiber: Math.round((per.fiber ?? 0) * scale),
				};
				const entry: MealMacroEntry = {
					recipeId: r.id,
					recipeTitle: r.title,
					mealType: 'logged',
					servingsEaten: scale,
					macros: scaled,
					estimationKind: 'recipe',
					sourceId: r.id,
				};
				const today = todayDate(services.timezone);
				await logMealMacros(userStore, userId, entry, today);
				await services.telegram.send(userId,
					`Logged: **${r.title}** × ${scale} — ${scaled.calories} cal, ${scaled.protein}g protein`);
				return;
			}

			if (match.kind === 'ambiguous') {
				const buttons: InlineButton[][] = match.candidates.map(c => [{
					text: c.title,
					callbackData: `app:food:nut:log:recipe:${c.id}:${portion.value}`,
				}]);
				buttons.push([{ text: 'None of these', callbackData: 'app:food:nut:log:none' }]);
				await services.telegram.sendWithButtons(
					userId,
					`Which recipe did you mean?`,
					buttons,
				);
				return;
			}

			// match.kind === 'none' — placeholder until Tasks 10/12 wire
			// quick-meal + ad-hoc fallthroughs.
			await services.telegram.send(userId,
				`No recipe matched '${labelText}'. (Quick-meal and ad-hoc paths arrive in later H11.w tasks.)`);
			return;
		}

		if (subCommand === 'adherence') {
			const targets = await loadTargets(services, userStore);
			const hasTarget = [targets.calories, targets.protein, targets.carbs, targets.fat, targets.fiber].some(v => v && v > 0);
			if (!hasTarget) {
				await services.telegram.send(userId,
					'No macro targets set. Use `/nutrition targets set <cal> <protein> <carbs> <fat> [fiber]` first.');
				return;
			}

			const periodDays = parseInt(args[1] ?? '30', 10);
			if (isNaN(periodDays) || periodDays < 1 || periodDays > 365) {
				await services.telegram.send(userId, 'Period must be between 1 and 365 days.');
				return;
			}
			const today = todayDate(services.timezone);
			const end = new Date(today);
			const start = new Date(today);
			start.setDate(start.getDate() - (periodDays - 1));
			const startDate = start.toISOString().slice(0, 10);
			const endDate = end.toISOString().slice(0, 10);

			const entries = await loadMacrosForPeriod(userStore, startDate, endDate);
			if (entries.length === 0) {
				await services.telegram.send(userId, `No macro data tracked in the last ${periodDays} days.`);
				return;
			}
			const adherence = computeAdherence(entries, targets);
			const block = formatAdherenceSummary(adherence);
			const header = `**Adherence — last ${periodDays} days** (${entries.length} day${entries.length === 1 ? '' : 's'} of data)`;
			await services.telegram.send(userId, block ? `${header}\n\n${block}` : header);
			return;
		}

		if (subCommand === 'targets') {
			if (args[1]?.toLowerCase() === 'set') {
				const calories = parseInt(args[2] ?? '0', 10);
				const protein = parseInt(args[3] ?? '0', 10);
				const carbs = parseInt(args[4] ?? '0', 10);
				const fat = parseInt(args[5] ?? '0', 10);
				const fiber = args[6] !== undefined ? parseInt(args[6], 10) : 0;

				if ([calories, protein, carbs, fat, fiber].some(v => isNaN(v) || v < 0 || v > 99999)) {
					await services.telegram.send(userId, 'Invalid targets. Values must be numbers between 0 and 99999.');
					return;
				}

				await saveTargets(services, userStore, userId, { calories, protein, carbs, fat, fiber });

				await services.telegram.send(userId,
					`Macro targets updated:\nCalories: ${calories}\nProtein: ${protein}g\nCarbs: ${carbs}g\nFat: ${fat}g\nFiber: ${fiber}g`);
				return;
			}

			// Show current targets
			const targets = await loadTargets(services, userStore);
			const lines = ['**Macro Targets:**'];
			lines.push(`Calories: ${targets.calories ?? 'not set'}`);
			lines.push(`Protein: ${targets.protein ? `${targets.protein}g` : 'not set'}`);
			lines.push(`Carbs: ${targets.carbs ? `${targets.carbs}g` : 'not set'}`);
			lines.push(`Fat: ${targets.fat ? `${targets.fat}g` : 'not set'}`);
			lines.push(`Fiber: ${targets.fiber ? `${targets.fiber}g` : 'not set'}`);
			lines.push('');
			lines.push('To set targets: `/nutrition targets set <cal> <protein> <carbs> <fat> [fiber]`');
			await services.telegram.send(userId, lines.join('\n'));
			return;
		}

		if (subCommand === 'pediatrician') {
			const childName = args[1];
			if (!childName) {
				// Show child selection buttons instead of raw usage text
				const children = await loadAllChildren(sharedStore);
				if (children.length === 0) {
					await services.telegram.send(userId, 'No child profiles found. Use `/family add` to add a child first.');
					return;
				}
				const buttons: InlineButton[][] = children.map(c => ([
					{ text: c.profile.name, callbackData: `app:food:nut:ped:${c.profile.slug}` },
				]));
				await services.telegram.sendWithButtons(
					userId,
					'Select a child for the pediatrician report:',
					buttons,
				);
				return;
			}

			const periodDays = parseInt(args[2] ?? '90', 10);
			const childLog = await loadChildProfile(sharedStore, childName.toLowerCase());

			if (!childLog) {
				const children = await loadAllChildren(sharedStore);
				if (children.length === 0) {
					await services.telegram.send(userId, 'No child profiles found. Use `/family add` to add a child first.');
				} else {
					const buttons: InlineButton[][] = children.map(c => ([
						{ text: c.profile.name, callbackData: `app:food:nut:ped:${c.profile.slug}` },
					]));
					await services.telegram.sendWithButtons(
						userId,
						`Child "${childName}" not found. Select one:`,
						buttons,
					);
				}
				return;
			}

			const recipes = await loadAllRecipes(sharedStore);
			const today = todayDate(services.timezone);
			const report = await generatePediatricianReport(sharedStore, userStore, childLog, recipes, periodDays, today);
			await services.telegram.send(userId, report);
			return;
		}

		// Unknown subcommand — show help
		await services.telegram.send(userId,
			'**Nutrition Commands:**\n' +
			'`/nutrition` — Today\'s summary\n' +
			'`/nutrition week` — Weekly macros\n' +
			'`/nutrition month` — Monthly macros\n' +
			'`/nutrition log <label> <cal> <protein> <carbs> <fat> [fiber]` — Manual macro entry\n' +
			'`/nutrition log <meal name> [portion]` — Log a recipe or quick-meal\n' +
			'`/nutrition meals list` — List saved quick-meals\n' +
			'`/nutrition meals remove <label>` — Remove a saved quick-meal\n' +
			'`/nutrition adherence [days]` — Adherence vs targets over period (default 30)\n' +
			'`/nutrition targets` — View/set macro targets\n' +
			'`/nutrition pediatrician <child> [days]` — Child nutrition report');
	} catch (err) {
		services.logger.error('handleNutritionCommand failed', err);
		await services.telegram.send(userId, 'Unable to generate nutrition report. Please try again.');
	}
}
