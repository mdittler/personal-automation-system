/**
 * Weekly nutrition summary handler — Sunday 8pm scheduled job sending personalized macro digests.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse } from 'yaml';
import { generateWeeklyDigest } from '../services/nutrition-reporter.js';
import { loadHousehold } from '../utils/household-guard.js';
import { todayDate } from '../utils/date.js';
import type { MacroTargets } from '../types.js';

const TARGETS_FILE = 'nutrition/targets.yaml';

const CONFIG_TARGET_KEYS: Array<[keyof MacroTargets, string]> = [
	['calories', 'macro_target_calories'],
	['protein', 'macro_target_protein'],
	['carbs', 'macro_target_carbs'],
	['fat', 'macro_target_fat'],
	['fiber', 'macro_target_fiber'],
];

async function loadUserTargets(
	services: CoreServices,
	userStore: ScopedDataStore,
): Promise<MacroTargets> {
	const fromConfig: MacroTargets = {};
	let hasConfigValue = false;
	for (const [field, key] of CONFIG_TARGET_KEYS) {
		try {
			const val = await services.config.get<number>(key);
			if (typeof val === 'number' && val > 0) {
				fromConfig[field] = val;
				hasConfigValue = true;
			}
		} catch {
			// ignore
		}
	}
	if (hasConfigValue) return fromConfig;

	try {
		const raw = await userStore.read(TARGETS_FILE);
		if (!raw) return {};
		const content = stripFrontmatter(raw);
		if (!content.trim()) return {};
		return (parse(content) as MacroTargets) ?? {};
	} catch {
		return {};
	}
}

/**
 * Weekly nutrition summary handler for a single user.
 *
 * The scheduler now iterates registered users at the infrastructure level
 * for `user_scope: all` schedules and invokes this handler once per user
 * inside a requestContext scope, so `services.config.get` automatically
 * returns the correct per-user macro targets.
 *
 * This function filters to household members — any system user who
 * isn't currently in the food household is a no-op.
 */
export async function handleWeeklyNutritionSummaryJob(
	services: CoreServices,
	userId: string | undefined,
): Promise<void> {
	if (!userId) {
		services.logger.warn(
			'weekly-nutrition-summary invoked without a userId — expected user_scope: all dispatch',
		);
		return;
	}

	const sharedStore = services.data.forShared('shared');
	const household = await loadHousehold(sharedStore);
	if (!household) return;

	if (!household.members.includes(userId)) {
		// System user is not in the food household — nothing to summarize.
		return;
	}

	try {
		const userStore = services.data.forUser(userId);
		const targets = await loadUserTargets(services, userStore);

		const today = todayDate(services.timezone);
		const summary = await generateWeeklyDigest(services, userStore, userId, targets, today);
		await services.telegram.send(userId, summary);
	} catch (err) {
		services.logger.error(`Weekly nutrition summary failed for user ${userId}`, err);
	}
}
