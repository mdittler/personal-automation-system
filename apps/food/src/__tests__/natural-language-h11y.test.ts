/**
 * H11.y Natural-Language Persona Tests
 * ======================================
 *
 * These tests take the perspective of a real non-technical household member
 * typing freely into the bot. They verify that the two new NL intent detectors
 * added in H11.y behave as expected across three layers:
 *
 *   1. **Classification** — `isTargetsSetIntent` and `isAdherenceIntent`
 *      correctly separate target-setting phrasings from adherence-check
 *      phrasings, nutrition-view phrasings, and meal-log phrasings.
 *
 *   2. **Extended isNutritionViewIntent** — the NUTRITION_TODAY_PATTERNS
 *      extension added in H11.y correctly matches new "what have I eaten"
 *      phrasings and does not regress existing patterns.
 *
 *   3. **End-to-end routing** — a free-text target-setting phrase reaches
 *      `beginTargetsFlow` and triggers the Step 1/5 button prompt.
 *
 *   4. **Intent collision prevention** — the three new predicates are mutually
 *      disjoint with each other and with `isLogMealNLIntent` / `isHostingIntent`.
 *
 * Companion to natural-language-h11w-persona.test.ts and natural-language-h11.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import {
	isAdherenceIntent,
	isLogMealNLIntent,
	isNutritionViewIntent,
	isTargetsSetIntent,
} from '../handlers/nutrition.js';
import { isHostingIntent } from '../handlers/hosting.js';
import { handleMessage, init } from '../index.js';

// ─── Section 1: isTargetsSetIntent — recognises target-setting phrasings ─────

describe('H11.y persona — isTargetsSetIntent', () => {
	describe('recognises target-setting phrasings', () => {
		const shouldMatch = [
			'set my calorie targets',
			'change my macro targets',
			'update my nutrition targets',
			'I want to set my protein target',
			'can you help me adjust my fat targets',
			'I need to update my carb target',
			'set my calorie target',
			'adjust my macro targets',
			'update my calorie targets',
		];
		for (const phrase of shouldMatch) {
			it(`"${phrase}" → targets-set intent`, () => {
				expect(isTargetsSetIntent(phrase)).toBe(true);
			});
		}
	});

	// ─── Section 2: isTargetsSetIntent — false positive prevention ───────────

	describe('rejects false positives', () => {
		const shouldNotMatch = [
			'I hit my calorie targets today',   // hit, not set
			'my targets look good',             // no mutation verb
			'how are my macro targets',         // query, not mutation
			'I had a good workout and hit my protein target', // hit, not set
			'show me my current targets',       // view, not set
			'what are my nutrition targets',    // query only
		];
		for (const phrase of shouldNotMatch) {
			it(`"${phrase}" → NOT targets-set intent`, () => {
				expect(isTargetsSetIntent(phrase)).toBe(false);
			});
		}
	});
});

// ─── Section 3: isAdherenceIntent — recognises adherence-query phrasings ─────

describe('H11.y persona — isAdherenceIntent', () => {
	describe('recognises adherence-query phrasings', () => {
		const shouldMatch = [
			'how am I doing on my macros',
			'am I hitting my macro targets',
			"what's my macro streak",
			'how well am I sticking to my nutrition targets',
			'how is my macro adherence',
			'am I on track with my macros',
			'meeting my targets this month',
		];
		for (const phrase of shouldMatch) {
			it(`"${phrase}" → adherence intent`, () => {
				expect(isAdherenceIntent(phrase)).toBe(true);
			});
		}
	});

	// ─── Section 4: isAdherenceIntent — false positive prevention ────────────

	describe('rejects false positives', () => {
		const shouldNotMatch = [
			'show me my macros',     // view, not adherence check
			'log my macros',         // log intent, not adherence
			'I had a good macro day', // past statement, not a query
			'what are my targets',   // targets view, not adherence
			'tell me my macro totals', // pure view query, not an adherence check
		];
		for (const phrase of shouldNotMatch) {
			it(`"${phrase}" → NOT adherence intent`, () => {
				expect(isAdherenceIntent(phrase)).toBe(false);
			});
		}
	});
});

// ─── Section 5: isNutritionViewIntent — extended NUTRITION_TODAY_PATTERNS ────

describe('H11.y persona — isNutritionViewIntent extended patterns', () => {
	describe('new NUTRITION_TODAY_PATTERNS phrases match', () => {
		const newPatterns = [
			'what have I eaten today',
			'what did I eat today',
			"show me today's nutrition",
			"today's macros",
			"today's calories",
		];
		for (const phrase of newPatterns) {
			it(`"${phrase}" → nutrition view intent (today pattern)`, () => {
				expect(isNutritionViewIntent(phrase)).toBe(true);
			});
		}
	});

	describe('pre-existing phrases still match (regression)', () => {
		const existingPatterns = [
			'how are my macros',
			'show my nutrition summary',
			'check my calorie intake',
		];
		for (const phrase of existingPatterns) {
			it(`"${phrase}" → nutrition view intent (regression)`, () => {
				expect(isNutritionViewIntent(phrase)).toBe(true);
			});
		}
	});
});

// ─── Section 6: End-to-end routing via handleMessage ─────────────────────────

describe('H11.y persona — end-to-end NL routing (handleMessage)', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue({
			read: vi.fn().mockResolvedValue(''),
			write: vi.fn().mockResolvedValue(undefined),
			append: vi.fn().mockResolvedValue(undefined),
			exists: vi.fn().mockResolvedValue(false),
			list: vi.fn().mockResolvedValue([]),
			archive: vi.fn().mockResolvedValue(undefined),
		} as never);
		vi.mocked(services.data.forUser).mockReturnValue({
			read: vi.fn().mockResolvedValue(''),
			write: vi.fn().mockResolvedValue(undefined),
			append: vi.fn().mockResolvedValue(undefined),
			exists: vi.fn().mockResolvedValue(false),
			list: vi.fn().mockResolvedValue([]),
			archive: vi.fn().mockResolvedValue(undefined),
		} as never);
		await init(services);
	});

	function msg(text: string, userId = 'matt') {
		return createTestMessageContext({ text, userId });
	}

	it('"set my calorie targets" → beginTargetsFlow sends Step 1/5 buttons', async () => {
		await handleMessage(msg('set my calorie targets'));

		// beginTargetsFlow calls sendCaloriesStep which uses sendWithButtons
		expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		const [, text] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(text).toMatch(/Step 1\/5/);
		expect(text).toMatch(/calorie target/i);
	});

	it('"change my macro targets" → also triggers beginTargetsFlow', async () => {
		await handleMessage(msg('change my macro targets'));

		expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		const [, text] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
		expect(text).toMatch(/Step 1\/5/);
	});

	it('"I hit my calorie targets today" → targets flow NOT triggered', async () => {
		// This phrase must not activate isTargetsSetIntent. It may still be
		// handled by another intent (e.g. isNutritionViewIntent or fallback),
		// but crucially it must NOT produce the targets-flow Step 1/5 prompt.
		await handleMessage(msg('I hit my calorie targets today'));

		// If sendWithButtons was called at all, confirm it was NOT the targets flow.
		const withButtonsCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		for (const [, text] of withButtonsCalls) {
			expect(text).not.toMatch(/Step 1\/5/);
		}
	});

	it('"how am I doing on my macros" → adherence path: household-missing message sent', async () => {
		// No household is seeded in the mock store (read returns ''), so
		// requireHousehold returns null and the route sends the setup prompt.
		// This fences that isAdherenceIntent correctly routes to the adherence
		// path rather than falling through to an unrelated handler.
		await handleMessage(msg('how am I doing on my macros'));

		// Period-picker buttons must NOT have been sent (no household).
		const withButtonsCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		for (const [, text] of withButtonsCalls) {
			expect(text).not.toMatch(/period/i);
		}

		// The household-missing message must have been sent via send().
		expect(services.telegram.send).toHaveBeenCalled();
		const sendCalls = vi.mocked(services.telegram.send).mock.calls;
		const texts = sendCalls.map(([, t]) => t as string);
		expect(texts.some(t => t.toLowerCase().includes('household'))).toBe(true);
	});
});

// ─── Section 7: No false collision between intents ───────────────────────────

describe('H11.y persona — intent collision prevention', () => {
	it('"I had some macro-heavy pasta for lunch" → log intent only', () => {
		const text = 'I had some macro-heavy pasta for lunch';
		expect(isLogMealNLIntent(text)).toBe(true);
		expect(isTargetsSetIntent(text)).toBe(false);
		expect(isAdherenceIntent(text)).toBe(false);
	});

	it('"set my calorie targets" → targets-set only, not log/hosting', () => {
		const text = 'set my calorie targets';
		expect(isTargetsSetIntent(text)).toBe(true);
		expect(isLogMealNLIntent(text)).toBe(false);
		expect(isHostingIntent(text)).toBe(false);
	});

	it('"how am I doing on my macros" → adherence only, not log/hosting', () => {
		const text = 'how am I doing on my macros';
		expect(isAdherenceIntent(text)).toBe(true);
		expect(isLogMealNLIntent(text)).toBe(false);
		expect(isHostingIntent(text)).toBe(false);
	});

	it('"what have I eaten today" → nutrition view, not targets-set, not log', () => {
		const text = 'what have I eaten today';
		expect(isNutritionViewIntent(text)).toBe(true);
		expect(isTargetsSetIntent(text)).toBe(false);
		// isLogMealNLIntent checks for "I had/I ate/just had" — "what have I eaten"
		// starts with "what", so it must not match the meal-log path.
		expect(isLogMealNLIntent(text)).toBe(false);
	});

	it('"how am I doing on my macros" — adherence intent, NOT nutrition view intent', () => {
		expect(isAdherenceIntent('how am I doing on my macros')).toBe(true);
		expect(isNutritionViewIntent('how am I doing on my macros')).toBe(false);
	});

	it('"log my calories against my target" → log intent only, NOT targets-set', () => {
		// Mixed phrase: "log" triggers meal-log; "target" alone (no mutation verb) must not
		// trigger targets-set. Documents intentional routing boundary.
		expect(isLogMealNLIntent('log my calories against my target')).toBe(true);
		expect(isTargetsSetIntent('log my calories against my target')).toBe(false);
	});
});

// ─── Section 8: Persona phrases — vocabulary extensions from H11.y review ───
//
// These tests verify the regex extensions added in the H11.y review pass:
// "goal" as synonym for "target", "lower/raise/bump" as mutation verbs,
// "calories today" word-order variant, and "what have I had today".

describe('H11.y persona — vocabulary extension coverage', () => {
	describe('isTargetsSetIntent — "goal" synonym and raise/lower/bump verbs', () => {
		const extended = [
			'I want to lower my calorie goal',
			'can you raise my protein goal',
			'bump my fat goal up a bit',
			'lower my carb goal for this week',
			'change my calorie goals',
		];
		for (const phrase of extended) {
			it(`"${phrase}" → targets-set intent`, () => {
				expect(isTargetsSetIntent(phrase)).toBe(true);
			});
		}
	});

	describe('isAdherenceIntent — calorie-flavoured on-track phrases', () => {
		it('"am I on track with my calories" → adherence intent', () => {
			expect(isAdherenceIntent('am I on track with my calories')).toBe(true);
		});
		it('"on track with my calorie goals" → adherence intent', () => {
			expect(isAdherenceIntent('on track with my calorie goals')).toBe(true);
		});
	});

	describe('isNutritionViewIntent — word-order variants', () => {
		it('"what have I had today" → nutrition view intent', () => {
			expect(isNutritionViewIntent('what have I had today')).toBe(true);
		});
		it('"calories today" → nutrition view intent', () => {
			expect(isNutritionViewIntent('calories today')).toBe(true);
		});
		it('"macros today" → nutrition view intent', () => {
			expect(isNutritionViewIntent('macros today')).toBe(true);
		});
	});
});
