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
	findQuickMealById,
	slugifyLabel,
} from '../services/quick-meals-store.js';
import {
	beginQuickMealAdd,
	beginQuickMealEdit,
	beginQuickMealAddPrefilled,
} from './quick-meal-flow.js';
import { beginTargetsFlow } from './targets-flow.js';
import { logQuickMeal } from './quick-meal-log.js';
import { estimateMacros } from '../services/macro-estimator.js';
import { recordAdHocLog, findSimilarAdHoc } from '../services/ad-hoc-history.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';
import { parseStrictInt } from '../utils/parse-int-strict.js';

// ─── Task 14: Ad-hoc dedup promotion pending state ──────────────────────────

interface PendingPromotion {
	label: string;
	ingredients: string[];
	expiresAt: number;
}

const PROMO_TTL_MS = 5 * 60 * 1000;
const pendingPromotion = new Map<string, PendingPromotion>();

function setPendingPromotion(userId: string, label: string, ingredients: string[]): void {
	pendingPromotion.set(userId, {
		label,
		ingredients,
		expiresAt: Date.now() + PROMO_TTL_MS,
	});
	// Time-based sweep — never evict another user's still-valid promotion.
	if (pendingPromotion.size > 100) {
		const now = Date.now();
		for (const [k, v] of pendingPromotion) {
			if (v.expiresAt < now) pendingPromotion.delete(k);
		}
	}
}

function consumePendingPromotion(userId: string): PendingPromotion | undefined {
	const entry = pendingPromotion.get(userId);
	pendingPromotion.delete(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) return undefined;
	return entry;
}

/**
 * Callback handler for the Task 14 "save as quick-meal?" prompt.
 * Invoked from index.ts when the callback data matches
 * `app:food:nut:log:promote:yes` or `:no`.
 */
export async function handleAdHocPromotionCallback(
	services: CoreServices,
	userId: string,
	data: string,
): Promise<void> {
	if (data === 'app:food:nut:log:promote:no') {
		consumePendingPromotion(userId);
		await services.telegram.send(
			userId,
			'Ok. Use `/nutrition meals add` later if you change your mind.',
		);
		return;
	}
	if (data === 'app:food:nut:log:promote:yes') {
		const pending = consumePendingPromotion(userId);
		if (!pending) {
			await services.telegram.send(
				userId,
				'Promotion expired — use `/nutrition meals add` to save it manually.',
			);
			return;
		}
		await beginQuickMealAddPrefilled(services, userId, pending.label, pending.ingredients);
		return;
	}
}

/** Test-only reset for the Task 14 pending-promotion map. */
export function __resetAdHocPromotionForTests(): void {
	pendingPromotion.clear();
}

/**
 * Callback handler for the ambiguous-recipe picker emitted by
 * dispatchSmartLog. Matches `app:food:nut:log:recipe:<id>:<portion>` and
 * `app:food:nut:log:none`. Returns true if the callback was consumed.
 *
 * On a recipe selection, loads the recipe from the shared store, scales
 * its per-serving macros by the portion value, and logs the entry.
 * On `log:none`, sends a gentle fallthrough message pointing the user at
 * `/nutrition meals add` or rephrasing the request.
 */
export async function handleRecipeLogCallback(
	services: CoreServices,
	userStore: ScopedDataStore,
	sharedStore: ScopedDataStore,
	userId: string,
	data: string,
): Promise<boolean> {
	if (data === 'app:food:nut:log:none') {
		await services.telegram.send(
			userId,
			'Ok — none of those. Try rephrasing, or use `/nutrition meals add` to save a new quick-meal.',
		);
		return true;
	}

	const match = data.match(/^app:food:nut:log:recipe:([a-z0-9][a-z0-9-]*):(\d+(?:\.\d+)?)$/);
	if (!match) return false;

	const recipeId = match[1]!;
	const portion = parseFloat(match[2]!);
	if (!Number.isFinite(portion) || portion <= 0) {
		await services.telegram.send(userId, 'Invalid portion on that button.');
		return true;
	}

	const recipes = await loadAllRecipes(sharedStore);
	const recipe = recipes.find(r => r.id === recipeId);
	if (!recipe) {
		await services.telegram.send(userId, 'That recipe no longer exists.');
		return true;
	}

	const per = recipe.macros ?? {};
	const scaled = {
		calories: Math.round((per.calories ?? 0) * portion),
		protein: Math.round((per.protein ?? 0) * portion),
		carbs: Math.round((per.carbs ?? 0) * portion),
		fat: Math.round((per.fat ?? 0) * portion),
		fiber: Math.round((per.fiber ?? 0) * portion),
	};
	const entry: MealMacroEntry = {
		recipeId: recipe.id,
		recipeTitle: recipe.title,
		mealType: 'logged',
		servingsEaten: portion,
		macros: scaled,
		estimationKind: 'recipe',
		sourceId: recipe.id,
	};
	await logMealMacros(userStore, userId, entry, todayDate(services.timezone));
	await services.telegram.send(
		userId,
		`Logged: **${escapeMarkdown(recipe.title)}** × ${portion} — ${scaled.calories} cal, ${scaled.protein}g protein`,
	);
	return true;
}
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
import { addDays, todayDate } from '../utils/date.js';
import type { MacroTargets, MealMacroEntry } from '../types.js';

// ─── Intent Detection ────��──────────────────────────��─────────────────────────

const NUTRITION_KEYWORDS = /\b(nutrition|macros?|calories?|calorie|protein|carbs?|intake|macro)\b/i;
const NUTRITION_CONTEXT = /\b(track|show|summary|how|view|check|my|intake|this)\b/i;
const NUTRITION_TODAY_PATTERNS = /\b(what have i eaten|what did i eat|what have i had.*today|show.*today.*nutrition|today.*macros?|today.*calories?|macros?.*today|calories?.*today)\b/i;

// H12a: health-correlation phrasings overlap with NUTRITION_KEYWORDS + NUTRITION_CONTEXT
// (e.g. "how does my nutrition affect my sleep"). Exclude them here so
// isHealthCorrelationIntent (checked after isAdherenceIntent) handles them exclusively.
const HEALTH_CORRELATION_GUARD =
	/how\s+is\s+(my\s+)?(diet|eating|food|nutrition)\s+(affect|impact)|how\s+does\s+(my\s+)?(diet|eating|food|nutrition)\s+affect|(health\s+correlation|diet.*health|food.*health|nutrition.*health)|diet\s+health\s+check|\bcorrelate\s+(my\s+)?(diet|food|eating|nutrition)/i;

export function isNutritionViewIntent(text: string): boolean {
	const lower = text.toLowerCase();
	// Adherence-check phrasings ("how am I doing on my macros", "am I hitting
	// my targets") overlap with NUTRITION_KEYWORDS + NUTRITION_CONTEXT. Exclude
	// them here so the router's adherence branch (checked first) handles them
	// exclusively.
	if (isAdherenceIntent(text)) return false;
	// Health-correlation phrasings ("how does my nutrition affect my sleep")
	// also overlap. Exclude them so isHealthCorrelationIntent handles them.
	if (HEALTH_CORRELATION_GUARD.test(text)) return false;
	return (NUTRITION_KEYWORDS.test(lower) && NUTRITION_CONTEXT.test(lower))
		|| NUTRITION_TODAY_PATTERNS.test(lower);
}

// ─── H11.w Task 15: Natural-language meal-log intent ────────────────────────
//
// Matches free-text phrasings that look like the user is *reporting* a
// meal they just ate ("I had / I ate / I just finished / log / tracking ...")
// but explicitly excludes nutrition-query phrasings so that
// isNutritionViewIntent keeps handling "how are my macros", "show my
// nutrition summary", etc. Used by apps/food/src/index.ts#handleMessage
// to dispatch into handleNutritionLogNL, which bypasses the legacy
// 6-arg numeric guard in /nutrition log.

const LOG_MEAL_NL_RE =
	/^\s*(i\s+(?:just\s+)?(?:had|ate|finished)|(?:just\s+)?(?:had|ate|finished)|log(?:ged)?|i'?m\s+logging|tracking)\b/i;

const LOG_MEAL_NL_EXCLUSION_RE =
	/\b(how\s+are|how\s+much|how'?s|what\s+(?:did|should|can)|show|summary|report|adherence|on\s+track|my\s+macros|my\s+nutrition|am\s+i|progress)\b/i;

// Non-food objects that commonly follow "I had" / "I ate" / "I finished" —
// if the direct object of the verb is one of these, the user is NOT
// reporting a meal. Anchored to the immediate verb object so phrases like
// "I had chicken after my walk" still classify as a meal log.
const LOG_MEAL_NL_NON_FOOD_OBJECT_RE =
	/^\s*(?:i\s+(?:just\s+)?(?:had|ate|finished)|(?:just\s+)?(?:had|ate|finished))\s+(?:a\s+|an\s+|some\s+|my\s+|the\s+)?(fun|nap|rest|shower|bath|meeting|call|day|morning|afternoon|evening|night|walk|run|workout|nothing|dream|conversation|argument|fight|chat|talk|thought|idea|minute|moment|second|break|laugh|cry|cold|headache|cough|accident|baby|child|kid|dog|cat|pet|drink\s+of\s+water)\b/i;

export function isLogMealNLIntent(text: string): boolean {
	if (!LOG_MEAL_NL_RE.test(text)) return false;
	if (LOG_MEAL_NL_EXCLUSION_RE.test(text)) return false;
	if (LOG_MEAL_NL_NON_FOOD_OBJECT_RE.test(text)) return false;
	return true;
}

// ─── H11.y: Targets-set and adherence NL intent detectors ───────────────────

// Regex for "set my calorie targets", "change my macros", etc.
const TARGETS_SET_KEYWORDS = /\b(set|change|update|edit|adjust|configure|raise|lower|bump)\b.*\b(my\s+)?(calorie|macro|protein|carb|fat|fiber|nutrition)\s*(targets?|goals?)\b/i;
const TARGETS_SET_ALT = /\b(my\s+)?(calorie|macro|protein|carb|fat|fiber|nutrition)\s*(targets?|goals?)\b.*\b(set|change|update|edit|adjust|raise|lower)\b/i;

export function isTargetsSetIntent(text: string): boolean {
	return TARGETS_SET_KEYWORDS.test(text) || TARGETS_SET_ALT.test(text);
}

// Regex for "how am I doing on macros", "hitting my targets", "macro streak" etc.
const ADHERENCE_KEYWORDS = /\b(adherence|hitting.*targets?|how.*doing.*macro|on track.*(macros?|calories?)|macro.*streak|streak.*macro|macros?.*adherence|sticking to.*targets?|meeting.*targets?)\b/i;

export function isAdherenceIntent(text: string): boolean {
	return ADHERENCE_KEYWORDS.test(text) || (
		/\bmacros?\b/i.test(text) &&
		/\b(how am i doing|am i hitting|on track|streak|sticking|meeting)\b/i.test(text)
	);
}

/**
 * Strip the leading NL verb phrase + common fillers and return the
 * remaining text describing the meal. The result is handed to
 * `handleNutritionLogNL`, which portion-parses the tail and dispatches
 * through the shared smart-log pipeline.
 */
export function extractLogMealText(text: string): string {
	let rest = text.trim();
	rest = rest.replace(
		/^\s*(i\s+(?:just\s+)?(?:had|ate|finished)|(?:just\s+)?(?:had|ate|finished)|log(?:ged)?|i'?m\s+logging|tracking)\b[\s,:-]*/i,
		'',
	);
	rest = rest.replace(/^\s*(?:my\s+usual|a|an|the|some|my)\s+/i, '');
	rest = rest.replace(/\band\s+some\s+/gi, 'and ');
	rest = rest.replace(/\s{2,}/g, ' ').trim();
	return rest;
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

export async function saveTargets(
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
			await services.telegram.send(userId, formatMacroSummary(progress, day));
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
			const startDate = addDays(today, -30);

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
						lines.push(`- **${escapeMarkdown(t.label)}** — ${t.estimatedMacros.calories ?? 0} cal (${t.usageCount}× used)`);
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
				// Resolve by id (slug), then by case-insensitive label match, so
				// renamed templates stay reachable via their displayed label.
				const all = await loadQuickMeals(userStore);
				let targetId: string | null = null;
				try {
					const slug = slugifyLabel(label);
					if (all.some(t => t.id === slug)) targetId = slug;
				} catch { /* ignore — fall through to label match */ }
				if (!targetId) {
					const needle = label.toLowerCase();
					const byLabel = all.find(t => t.label.toLowerCase() === needle);
					if (byLabel) targetId = byLabel.id;
				}
				if (!targetId) {
					await services.telegram.send(userId, `No quick-meal matches '${escapeMarkdown(label)}'.`);
					return;
				}
				await archiveQuickMeal(userStore, targetId);
				await services.telegram.send(userId, `Removed quick-meal: ${escapeMarkdown(label)}`);
				return;
			}

			if (mealsSub === 'add') {
				await beginQuickMealAdd(services, userId);
				return;
			}

			if (mealsSub === 'edit') {
				const label = args.slice(2).join(' ').trim();
				if (!label) {
					await services.telegram.send(userId, 'Usage: `/nutrition meals edit <label>`');
					return;
				}
				// Try id (slug) first, then case-insensitive label match.
				const all = await loadQuickMeals(userStore);
				let existing: typeof all[number] | undefined;
				try {
					const slug = slugifyLabel(label);
					existing = all.find(t => t.id === slug);
				} catch { /* ignore */ }
				if (!existing) {
					const needle = label.toLowerCase();
					existing = all.find(t => t.label.toLowerCase() === needle);
				}
				if (!existing) {
					await services.telegram.send(userId, `No quick-meal matches '${escapeMarkdown(label)}'.`);
					return;
				}
				await beginQuickMealEdit(services, userId, existing);
				return;
			}

			await services.telegram.send(userId,
				'Unknown: `/nutrition meals <add|list|edit|remove>`');
			return;
		}

		if (subCommand === 'log') {
			// Path 0: No-args — show a quick-pick button grid of the user's
			// top-5 most-used quick-meals plus a "Something else…" escape.
			if (args.length === 1) {
				const meals = await loadQuickMeals(userStore);
				if (meals.length === 0) {
					await services.telegram.send(
						userId,
						'Usage: `/nutrition log <recipe or meal>`. Save frequent meals with `/nutrition meals add`.',
					);
					return;
				}
				const top = [...meals].sort((a, b) => b.usageCount - a.usageCount).slice(0, 5);
				const rows: InlineButton[][] = [];
				for (let i = 0; i < top.length; i += 2) {
					const row: InlineButton[] = [];
					for (const qm of top.slice(i, i + 2)) {
						const cal = qm.estimatedMacros.calories ?? 0;
						row.push({
							text: `${qm.label} (${cal} cal)`,
							callbackData: `app:food:nut:log:quickmeal:${qm.id}:1`,
						});
					}
					rows.push(row);
				}
				rows.push([
					{ text: 'Something else…', callbackData: 'app:food:nut:log:adhoc-prompt' },
				]);
				await services.telegram.sendWithButtons(
					userId,
					'What did you eat? Pick a quick-meal or choose "Something else…":',
					rows,
				);
				return;
			}

			// Path 1: Legacy numeric form — preserved verbatim for back-compat.
			// Shape: `/nutrition log <label> <cal> <p> <c> <f> [fiber]` (args.length >= 6).
			// To avoid colliding with multi-word free-text labels of the same length
			// (e.g. "chicken pasta with tomato sauce and cheese"), detect the user's
			// intent via a "contains a digit" quorum on the four mandatory macro fields
			// (args[2..5]). If at least 2 look numeric-ish the user is clearly
			// attempting the numeric form (with a possible typo in one field) and
			// should get per-field validation errors. If fewer than 2 are numeric the
			// tokens are a multi-word food label — fall through to the smart-log path.
			const looksNumericish = (t: string | undefined): boolean =>
				t !== undefined && /\d/.test(t);
			const numericHits = [args[2], args[3], args[4], args[5]].filter(looksNumericish).length;
			const legacyNumericShape = args.length >= 6 && numericHits >= 2;
			if (legacyNumericShape) {
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
					const val = parseStrictInt(spec.raw);
					if (val === null || val < 0 || val > 99999) {
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
					`Logged: **${escapeMarkdown(label)}** — ${calories} cal, ${protein}g protein`);
				return;
			}

			// Path 2+: Smart log — delegated to the shared dispatchSmartLog
			// helper so the NL path (handleNutritionLogNL) can reuse the
			// exact same recipe → quick-meal → ad-hoc pipeline without
			// the legacy 6-arg numeric guard above.
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

			await dispatchSmartLog(services, userStore, sharedStore, userId, labelText, portion.value);
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

			// No day argument — show period picker buttons.
			if (args[1] === undefined) {
				await services.telegram.sendWithButtons(
					userId,
					'Which period?',
					[
						[
							{ text: 'Last 7 days', callbackData: 'app:food:nut:adh:7' },
							{ text: 'Last 30 days', callbackData: 'app:food:nut:adh:30' },
							{ text: 'Last 90 days', callbackData: 'app:food:nut:adh:90' },
						],
					],
				);
				return;
			}

			const periodDays = parseStrictInt(args[1] ?? '');
			if (periodDays === null || periodDays < 1 || periodDays > 365) {
				await services.telegram.send(userId, 'Period must be between 1 and 365 days.');
				return;
			}
			const today = todayDate(services.timezone);
			const endDate = today;
			const startDate = addDays(today, -(periodDays - 1));

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
				// No numeric args — launch the guided button flow.
				if (args[2] === undefined) {
					await beginTargetsFlow(services, userId);
					return;
				}

				// Advanced shortcut: positional args provided.
				const calories = parseStrictInt(args[2] ?? '');
				const protein = parseStrictInt(args[3] ?? '0');
				const carbs = parseStrictInt(args[4] ?? '0');
				const fat = parseStrictInt(args[5] ?? '0');
				const fiber = args[6] !== undefined ? parseStrictInt(args[6]) : 0;

				if ([calories, protein, carbs, fat, fiber].some(v => v === null || (v as number) < 0 || (v as number) > 99999)) {
					await services.telegram.send(userId, 'Invalid targets. Values must be numbers between 0 and 99999.');
					return;
				}

				await saveTargets(services, userStore, userId, {
					calories: calories as number,
					protein: protein as number,
					carbs: carbs as number,
					fat: fat as number,
					fiber: fiber as number,
				});

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
			lines.push('Use `/nutrition targets set` to launch the guided setup, or `/nutrition targets set <cal> <protein> <carbs> <fat> [fiber]` as a shortcut.');
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

			const periodDays = parseStrictInt(args[2] ?? '') ?? 90;
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
			'`/nutrition adherence [days]` — Adherence vs targets; pick a period or pass a day count\n' +
			'`/nutrition targets` — View/set macro targets\n' +
			'`/nutrition pediatrician <child> [days]` — Child nutrition report');
	} catch (err) {
		services.logger.error('handleNutritionCommand failed', err);
		await services.telegram.send(userId, 'Unable to generate nutrition report. Please try again.');
	}
}

// ─── H11.w Task 15: Shared smart-log dispatcher ─────────────────────────────
//
// Extracted from handleNutritionCommand's /nutrition log subcommand so the
// NL path (handleNutritionLogNL) can reuse the same recipe → quick-meal →
// ad-hoc pipeline without going through the legacy 6-arg numeric guard.
async function dispatchSmartLog(
	services: CoreServices,
	userStore: ScopedDataStore,
	sharedStore: ScopedDataStore,
	userId: string,
	labelText: string,
	portionValue: number,
): Promise<void> {
	const recipes = await loadAllRecipes(sharedStore);
	const match = matchRecipes(labelText, recipes);

	if (match.kind === 'unique') {
		const r = match.recipe;
		const per = r.macros ?? {};
		const scale = portionValue;
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
			`Logged: **${escapeMarkdown(r.title)}** × ${scale} — ${scaled.calories} cal, ${scaled.protein}g protein`);
		return;
	}

	if (match.kind === 'ambiguous') {
		const buttons: InlineButton[][] = match.candidates.map(c => [{
			text: c.title,
			callbackData: `app:food:nut:log:recipe:${c.id}:${portionValue}`,
		}]);
		buttons.push([{ text: 'None of these', callbackData: 'app:food:nut:log:none' }]);
		await services.telegram.sendWithButtons(
			userId,
			`Which recipe did you mean?`,
			buttons,
		);
		return;
	}

	// match.kind === 'none' — quick-meal label fallthrough.
	const quickMeals = await loadQuickMeals(userStore);
	let wantedSlug: string | null = null;
	try {
		wantedSlug = slugifyLabel(labelText);
	} catch {
		wantedSlug = null;
	}
	const needle = labelText.toLowerCase();
	const qm = quickMeals.find(
		(m) => (wantedSlug && m.id === wantedSlug) || m.label.toLowerCase() === needle,
	);
	if (qm) {
		await logQuickMeal(userStore, userId, qm, portionValue, services);
		return;
	}

	// Ad-hoc LLM estimate — last resort.
	const est = await estimateMacros(
		{ label: labelText, ingredients: [labelText], kind: 'other' },
		services.llm,
	);
	if (!est.ok) {
		await services.telegram.send(
			userId,
			`Couldn't estimate macros for '${escapeMarkdown(labelText)}': ${est.error}. Try rephrasing or use \`/nutrition meals add\` to save a quick-meal.`,
		);
		return;
	}

	const scale = portionValue;
	const scaledAdHoc = {
		calories: Math.round((est.macros.calories ?? 0) * scale),
		protein: Math.round((est.macros.protein ?? 0) * scale),
		carbs: Math.round((est.macros.carbs ?? 0) * scale),
		fat: Math.round((est.macros.fat ?? 0) * scale),
		fiber: Math.round((est.macros.fiber ?? 0) * scale),
	};
	const adHocEntry: MealMacroEntry = {
		recipeId: 'adhoc',
		recipeTitle: labelText,
		mealType: 'logged',
		servingsEaten: scale,
		macros: scaledAdHoc,
		estimationKind: 'llm-ad-hoc',
		confidence: est.confidence,
		// sourceId intentionally omitted for ad-hoc entries.
	};
	const adHocToday = todayDate(services.timezone);
	await logMealMacros(userStore, userId, adHocEntry, adHocToday);

	const priorSimilar = await findSimilarAdHoc(userStore, labelText);
	await recordAdHocLog(userStore, labelText, adHocToday);

	const lowConf = est.confidence < 0.5;
	const flag = lowConf ? ' *' : '';
	const legend = lowConf ? '\n_* low-confidence estimate_' : '';
	await services.telegram.send(
		userId,
		`Logged${flag}: **${escapeMarkdown(labelText)}** — ${scaledAdHoc.calories} cal, confidence ${Math.round(est.confidence * 100)}%${legend}`,
	);

	if (priorSimilar) {
		setPendingPromotion(userId, labelText, [labelText]);
		await services.telegram.sendWithButtons(
			userId,
			`You've logged "${labelText}" before. Save it as a quick-meal for one-tap logging next time?`,
			[
				[
					{ text: 'Yes, save', callbackData: 'app:food:nut:log:promote:yes' },
					{ text: 'No thanks', callbackData: 'app:food:nut:log:promote:no' },
				],
			],
		);
	}
}

/**
 * Natural-language entry point for meal logging.
 *
 * Skips the legacy 6-arg numeric guard in /nutrition log and dispatches
 * straight into the shared smart-log pipeline (recipe → quick-meal →
 * ad-hoc LLM). The caller is expected to have already detected the
 * intent via `isLogMealNLIntent(text)`; this function parses an
 * optional trailing portion token from the cleaned meal text and
 * dispatches accordingly.
 */
export async function handleNutritionLogNL(
	services: CoreServices,
	text: string,
	userId: string,
	sharedStore: ScopedDataStore,
): Promise<void> {
	const userStore = services.data.forUser(userId);
	try {
		const cleaned = extractLogMealText(text);
		if (!cleaned) {
			await services.telegram.send(
				userId,
				'What did you eat? Try "I had chicken curry" or "I ate half the lasagna".',
			);
			return;
		}

		// Tokenize and peel off a leading OR trailing portion if present.
		// Leading: "half of the lasagna", "1/2 the lasagna", "a quarter
		// of the pizza". After peeling, also strip a trailing "of" / "of the"
		// connector so the matcher sees the bare label.
		const tokens = cleaned.split(/\s+/);
		let portionValue = 1;
		let labelText = cleaned;
		if (tokens.length >= 2) {
			const leading = parsePortion(tokens[0]!);
			if (leading.ok) {
				portionValue = leading.value;
				let rest = tokens.slice(1);
				// Strip a leading "of the" / "of" connector.
				if (rest[0]?.toLowerCase() === 'of') rest = rest.slice(1);
				if (rest[0]?.toLowerCase() === 'the') rest = rest.slice(1);
				labelText = rest.join(' ');
			} else {
				const trailing = parsePortion(tokens[tokens.length - 1]!);
				if (trailing.ok) {
					portionValue = trailing.value;
					labelText = tokens.slice(0, -1).join(' ');
				}
			}
		}

		if (labelText.length === 0) {
			await services.telegram.send(
				userId,
				'What did you eat? Try "I had chicken curry" or "I ate half the lasagna".',
			);
			return;
		}
		if (labelText.length > 100) {
			await services.telegram.send(userId, 'Invalid label: must be 100 characters or fewer.');
			return;
		}

		await dispatchSmartLog(services, userStore, sharedStore, userId, labelText, portionValue);
	} catch (err) {
		services.logger.error('handleNutritionLogNL failed', err);
		await services.telegram.send(userId, 'Unable to log meal. Please try again.');
	}
}

/**
 * Callback handler for the adherence period picker.
 * Invoked from index.ts when callback data matches `app:food:nut:adh:<days>`.
 */
export async function handleAdherencePeriodCallback(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	data: string,
): Promise<void> {
	const match = data.match(/^app:food:nut:adh:(\d+)$/);
	if (!match) return;

	const periodDays = parseInt(match[1]!, 10);
	if (isNaN(periodDays) || periodDays < 1 || periodDays > 365) {
		await services.telegram.send(userId, 'Period must be between 1 and 365 days.');
		return;
	}

	const targets = await loadTargets(services, userStore);
	const hasTarget = [targets.calories, targets.protein, targets.carbs, targets.fat, targets.fiber].some(v => v && v > 0);
	if (!hasTarget) {
		await services.telegram.send(userId,
			'No macro targets set. Use `/nutrition targets set` first.');
		return;
	}

	const today = todayDate(services.timezone);
	const endDate = today;
	const startDate = addDays(today, -(periodDays - 1));

	const entries = await loadMacrosForPeriod(userStore, startDate, endDate);
	if (entries.length === 0) {
		await services.telegram.send(userId, `No macro data tracked in the last ${periodDays} days.`);
		return;
	}
	const adherence = computeAdherence(entries, targets);
	const block = formatAdherenceSummary(adherence);
	const header = `**Adherence — last ${periodDays} days** (${entries.length} day${entries.length === 1 ? '' : 's'} of data)`;
	await services.telegram.send(userId, block ? `${header}\n\n${block}` : header);
}
