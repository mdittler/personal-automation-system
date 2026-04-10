/**
 * H12b User-Persona NL Tests — Cultural Calendar
 * ================================================
 *
 * These tests simulate a REAL household member typing freely into the Telegram bot.
 * No technical jargon. No exact field names. Just the way people actually talk.
 *
 * Persona: Matt, 38, home cook who loves exploring seasonal and cultural foods.
 *          He wants recipe ideas tied to upcoming holidays without being a planner.
 *
 * Coverage:
 *   A. How real users ASK about cultural/holiday recipes (should match)
 *   B. Phrases that look similar but should NOT route to cultural calendar
 *   C. Disjointness from hosting, nutrition, and health correlation intents
 *   D. End-to-end routing — message reaches handler and returns
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { isCulturalCalendarIntent } from '../handlers/cultural-calendar-handler.js';
import { isHostingIntent } from '../handlers/hosting.js';
import { isHealthCorrelationIntent } from '../handlers/health.js';
import { isNutritionViewIntent } from '../handlers/nutrition.js';
import { handleMessage, init } from '../index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockStore() {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

// ─── A. Natural user phrases that should trigger cultural calendar ────────

describe('Persona — real user cultural calendar phrasings (should match)', () => {
	const shouldMatchPhrases = [
		'holiday recipes',
		'holiday food ideas',
		'what should I cook for Thanksgiving',
		'what can I cook for Christmas',
		'any upcoming holidays',
		'cultural calendar',
		'recipe for Easter',
		'what should I make for Diwali',
		'any holiday meal ideas',
		'holiday dinner ideas',
	];

	it.each(shouldMatchPhrases)('isCulturalCalendarIntent: "%s"', (phrase) => {
		expect(isCulturalCalendarIntent(phrase)).toBe(true);
	});
});

// ─── B. Phrases that should NOT route to cultural calendar ───────────────

describe('Persona — phrases that should NOT trigger cultural calendar (should not match)', () => {
	const shouldNotMatchPhrases = [
		// Hosting intent territory
		'host a holiday party',
		'plan a Christmas party for guests',
		// General dinner / meal planning
		"what's for dinner tonight",
		'plan meals for this week',
		'generate a meal plan',
		// Nutrition territory
		'how are my macros',
		'show me my nutrition',
		// Health territory
		'how is my diet affecting my health',
		// Grocery / pantry
		'show me my grocery list',
		'what do I have in the pantry',
		// Food questions about technique
		'how do I make a roux',
		// Irrelevant
		'set a timer for 20 minutes',
	];

	it.each(shouldNotMatchPhrases)('isCulturalCalendarIntent: "%s"', (phrase) => {
		expect(isCulturalCalendarIntent(phrase)).toBe(false);
	});
});

// ─── C. Disjointness from other intents ──────────────────────────────────

describe('Persona — disjointness: cultural calendar phrases should not match other intents', () => {
	const culturalPhrases = [
		'holiday recipes',
		'what should I cook for Thanksgiving',
		'any upcoming holidays',
		'cultural calendar',
		'holiday food ideas',
	];

	it.each(culturalPhrases)('"%s" does not match isHostingIntent', (phrase) => {
		expect(isHostingIntent(phrase.toLowerCase())).toBe(false);
	});

	it.each(culturalPhrases)('"%s" does not match isNutritionViewIntent', (phrase) => {
		expect(isNutritionViewIntent(phrase)).toBe(false);
	});

	it.each(culturalPhrases)('"%s" does not match isHealthCorrelationIntent', (phrase) => {
		expect(isHealthCorrelationIntent(phrase)).toBe(false);
	});
});

// ─── D. End-to-end routing ───────────────────────────────────────────────

describe('Persona — end-to-end: cultural calendar phrases route to the handler', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		const mockStore = createMockStore();
		vi.mocked(services.data.forShared).mockReturnValue(mockStore as unknown as ScopedDataStore);
		vi.mocked(services.data.forUser).mockReturnValue(mockStore as unknown as ScopedDataStore);
		vi.mocked(services.llm.complete).mockResolvedValue('Try making a cranberry glazed turkey for Thanksgiving!');
		await init(services);
	});

	it('"holiday recipes" reaches the handler and sends a Telegram message', async () => {
		const ctx = createTestMessageContext({ text: 'holiday recipes', userId: 'user1' });
		await handleMessage?.(ctx);
		expect(services.telegram.send).toHaveBeenCalledWith('user1', expect.any(String));
	});

	it('"what should I cook for Christmas" reaches the handler and sends a Telegram message', async () => {
		const ctx = createTestMessageContext({ text: 'what should I cook for Christmas', userId: 'user1' });
		await handleMessage?.(ctx);
		expect(services.telegram.send).toHaveBeenCalledWith('user1', expect.any(String));
	});

	it('"holiday recipes" does NOT route to the hosting handler', async () => {
		// The hosting handler sends a different response; since no household is set up,
		// hosting would reply with a "Set up a household first" message.
		// Cultural calendar should not require a household — it sends LLM suggestions directly.
		vi.mocked(services.llm.complete).mockResolvedValue('Holiday recipe suggestion here.');
		const ctx = createTestMessageContext({ text: 'holiday recipes', userId: 'user1' });
		await handleMessage?.(ctx);
		// Should NOT send a "Set up a household first" type message
		const message = vi.mocked(services.telegram.send).mock.calls[0]?.[1] ?? '';
		expect(message).not.toMatch(/household/i);
	});
});
