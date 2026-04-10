/**
 * Cultural Calendar handler — scheduled job + on-demand NL intent.
 *
 * handleCulturalCalendarJob: Weekly job that checks for holidays in the next
 * 14 days and suggests themed recipes to the household.
 *
 * handleCulturalCalendarMessage: On-demand handler for messages like
 * "what should I cook for Thanksgiving" or "any upcoming holiday recipes".
 *
 * REQ-CULTURE-002, Phase H12b.
 */

import type { CoreServices, MessageContext } from '@pas/core/types';
import { loadHousehold } from '../utils/household-guard.js';
import { loadAllRecipes } from '../services/recipe-store.js';
import {
	ensureCalendar,
	getUpcomingHolidays,
	buildSuggestionPrompt,
	resolveHolidayDate,
} from '../services/cultural-calendar.js';

const WINDOW_DAYS = 14;

// ─── NL intent predicate ─────────────────────────────────────────────────

const CULTURAL_CALENDAR_PATTERNS = [
	// "holiday recipes" / "holiday food" / "holiday cooking"
	/\bholiday\s+(recipes?|food|cooking|ideas?|suggestions?|dish(?:es)?)\b/i,
	// "what should I cook/make for [holiday]" / "recipe for [holiday]"
	// Negative lookahead excludes common meal-time words ("dinner", "lunch", "tonight", etc.)
	// to prevent "what should we make for dinner" routing here instead of meal-planning intents.
	/\b(?:what\s+(?:should|can|could)\s+(?:i|we)\s+(?:cook|make|prepare|serve)\s+for|recipes?\s+for|cook(?:ing)?\s+for|mak(?:e|ing)\s+for)\s+(?!(?:dinner|lunch|breakfast|supper|brunch|tonight|today|tomorrow|this\s+week|the\s+week|us|them|everyone)\b)\w/i,
	// "any upcoming holidays" / "what holiday is coming up"
	/\b(?:upcoming\s+holidays?|holidays?\s+coming\s+up|what\s+holi?day\s+is\s+coming)\b/i,
	// "cultural calendar" — explicit
	/\bcultural\s+calendar\b/i,
	// "holiday food ideas" / "holiday meal suggestions"
	/\bholiday\s+(?:meal|dinner|lunch|breakfast)\b/i,
];

// Exclude hosting-related phrases — "host a holiday party" → hosting intent
const CULTURAL_CALENDAR_EXCLUSIONS = /\b(?:host(?:ing)?|party|parties|guests|event)\b/i;

/**
 * Returns true if the message is asking about holiday or cultural recipe suggestions.
 * Placed after isHostingIntent in handleMessage to avoid false-firing on "host a holiday party".
 */
export function isCulturalCalendarIntent(text: string): boolean {
	if (CULTURAL_CALENDAR_EXCLUSIONS.test(text)) return false;
	return CULTURAL_CALENDAR_PATTERNS.some(re => re.test(text));
}

// ─── Scheduled job ────────────────────────────────────────────────────────

/**
 * Weekly cultural calendar job — checks for holidays in the next 14 days
 * and sends themed recipe suggestions to all household members.
 *
 * Silent when no holidays upcoming, config disabled, or no household.
 */
export async function handleCulturalCalendarJob(services: CoreServices): Promise<void> {
	const enabled = await services.config.get<boolean>('cultural_calendar');
	if (enabled === false) return;

	const sharedStore = services.data.forShared('shared');
	const household = await loadHousehold(sharedStore);
	if (!household) return;

	try {
		const calendar = await ensureCalendar(sharedStore);
		const today = new Date().toISOString().slice(0, 10);
		const upcoming = getUpcomingHolidays(calendar, today, WINDOW_DAYS);

		if (upcoming.length === 0) return;

		const recipes = await loadAllRecipes(sharedStore);
		const rawLocation = await services.config.get<string>('location');
		const location = rawLocation ?? undefined;
		const prompt = buildSuggestionPrompt(upcoming, recipes, location);

		const message = await services.llm.complete(prompt, { tier: 'fast' });

		for (const memberId of household.members) {
			await services.telegram.send(memberId, message);
		}
	} catch (err) {
		services.logger.error('Cultural calendar job failed', err);
	}
}

// ─── On-demand message handler ────────────────────────────────────────────

/**
 * On-demand handler for cultural calendar NL queries.
 * If a specific holiday name is mentioned, the calendar is searched for it.
 * Otherwise, upcoming holidays within 14 days are shown.
 */
export async function handleCulturalCalendarMessage(
	services: CoreServices,
	ctx: MessageContext,
): Promise<void> {
	const userId = ctx.userId;
	const sharedStore = services.data.forShared('shared');

	try {
		const calendar = await ensureCalendar(sharedStore);
		const today = new Date().toISOString().slice(0, 10);

		// Try to find a specific holiday mentioned in the message
		const lowerText = (ctx.text ?? '').toLowerCase();
		const namedHolidays = calendar.holidays.filter(
			h => h.enabled && lowerText.includes(h.name.toLowerCase()),
		);

		let upcoming;
		if (namedHolidays.length > 0) {
			// Use the named holiday(s) — resolve dates for the next 365 days
			const results: Array<{ holiday: (typeof calendar.holidays)[0]; date: string }> = [];
			const year = new Date().getUTCFullYear();
			for (const holiday of namedHolidays) {
				// Try current year and next year to find the next occurrence
				for (const y of [year, year + 1]) {
					const date = resolveHolidayDate(holiday.dateRule, y);
					if (date && date >= today) {
						results.push({ holiday, date });
						break;
					}
				}
			}
			upcoming = results;
		} else {
			// General upcoming window
			upcoming = getUpcomingHolidays(calendar, today, WINDOW_DAYS);
		}

		if (upcoming.length === 0) {
			await services.telegram.send(
				userId,
				"No holidays are coming up in the next two weeks. Check back soon, or ask me about a specific holiday!",
			);
			return;
		}

		const recipes = await loadAllRecipes(sharedStore);
		const rawLocation = await services.config.get<string>('location');
		const location = rawLocation ?? undefined;
		const prompt = buildSuggestionPrompt(upcoming, recipes, location);

		const message = await services.llm.complete(prompt, { tier: 'fast' });
		await services.telegram.send(userId, message);
	} catch (err) {
		services.logger.error('Cultural calendar message handler failed', err);
		await services.telegram.send(
			userId,
			'Sorry, I ran into an issue fetching holiday suggestions. Please try again later.',
		);
	}
}
