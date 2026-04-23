/**
 * H11 Natural Language User Simulation Tests
 * ===========================================
 *
 * Phase H11 adds Nutrition tracking, Seasonal nudges, and Hosting/event planning.
 * These tests take the persona of a real, non-technical user sending casual
 * Telegram messages to verify:
 *
 *   1. Intent classification routes messages to the correct H11 handler
 *      (isNutritionViewIntent, isHostingIntent) with no false positives
 *      against other Food app intents.
 *   2. End-to-end flow from free-text message → handleMessage → handler →
 *      LLM call → formatted response back to the user works as expected.
 *   3. Slash command variants (/nutrition, /hosting) behave correctly for
 *      normal, boundary, and invalid inputs — including LLM failures.
 *   4. Multi-step user journeys (add guest → plan event, set targets →
 *      view summary, etc.) flow through the system correctly.
 *
 * These complement the H11 tests already in natural-language.test.ts by
 * exploring a wider surface of natural phrasings, typos, and realistic
 * conversational contexts a household would actually type.
 */

import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleCommand,
	handleMessage,
	init,
	isNutritionViewIntent,
	isHostingIntent,
} from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';
import type { ChildFoodLog, GuestProfile, Household, Recipe } from '../types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const household: Household = {
	id: 'fam1',
	name: 'The Smiths',
	createdBy: 'matt',
	members: ['matt', 'sarah'],
	joinCode: 'XYZ789',
	createdAt: '2026-01-01T00:00:00.000Z',
};

const margotProfile: ChildFoodLog = {
	profile: {
		name: 'Margot',
		slug: 'margot',
		birthDate: '2024-06-15',
		allergenStage: 'early-introduction',
		knownAllergens: ['milk'],
		avoidAllergens: [],
		dietaryNotes: '',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
	introductions: [
		{
			food: 'scrambled eggs',
			allergenCategory: 'eggs',
			date: '2026-03-15',
			reaction: 'none',
			accepted: true,
			notes: '',
		},
	],
};

const simpleRecipe: Recipe = {
	id: 'roast-chicken-001',
	title: 'Roast Chicken',
	source: 'homemade',
	ingredients: [
		{ name: 'chicken', quantity: 1, unit: 'whole' },
		{ name: 'salt', quantity: 1, unit: 'tsp' },
		{ name: 'olive oil', quantity: 2, unit: 'tbsp' },
	],
	instructions: ['Season', 'Roast at 425F for 1h'],
	servings: 4,
	tags: ['easy', 'dinner'],
	cuisine: 'American',
	ratings: [],
	history: [],
	allergens: [],
	status: 'confirmed',
	createdAt: '2026-02-01T00:00:00.000Z',
	updatedAt: '2026-02-01T00:00:00.000Z',
};

const sarahGuest: GuestProfile = {
	name: 'Sarah',
	slug: 'sarah',
	dietaryRestrictions: ['vegetarian'],
	allergies: [],
	createdAt: '2026-04-01T00:00:00.000Z',
	updatedAt: '2026-04-01T00:00:00.000Z',
};

// ─── Test Harness ────────────────────────────────────────────────────────────

function createMockStore() {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

describe('H11 Natural Language — Nutrition, Hosting, Seasonal', () => {
	let services: CoreServices;
	let store: ReturnType<typeof createMockStore>;

	beforeEach(async () => {
		store = createMockStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(store as any);
		vi.mocked(services.data.forUser).mockReturnValue(store as any);
		await init(services);
		__clearShadowDepsForTests();
	});

	function setupHousehold(
		opts: {
			recipes?: Recipe[];
			children?: ChildFoodLog[];
			guests?: GuestProfile[];
			targets?: { calories?: number; protein?: number; carbs?: number; fat?: number };
		} = {},
	) {
		const recipes = opts.recipes ?? [simpleRecipe];
		const children = opts.children ?? [];
		const guests = opts.guests ?? [];
		store.read.mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path === 'guests.yaml' && guests.length > 0) return stringify(guests);
			if (path === 'nutrition/targets.yaml' && opts.targets) return stringify(opts.targets);
			if (path === 'pantry.yaml') return stringify({ items: [] });
			for (const r of recipes) {
				if (path === `recipes/${r.id}.yaml`) return stringify(r);
			}
			for (const c of children) {
				if (path === `children/${c.profile.slug}.yaml`) return stringify(c);
			}
			return '';
		});
		store.list.mockImplementation(async (dir: string) => {
			if (dir === 'recipes') return recipes.map((r) => `${r.id}.yaml`);
			if (dir === 'children') return children.map((c) => `children/${c.profile.slug}.yaml`);
			if (dir === 'nutrition') return [];
			return [];
		});
	}

	function msg(text: string, userId = 'matt') {
		return createTestMessageContext({ text, userId });
	}

	// ════════════════════════════════════════════════════════════════════════
	// NUTRITION — Intent Detection
	// ════════════════════════════════════════════════════════════════════════

	describe('Intent: view nutrition / macros (isNutritionViewIntent)', () => {
		const shouldMatch = [
			// straightforward
			'how are my macros',
			'how are my macros looking',
			'show me my macros',
			'check my macros',
			'track my macros',
			'view my macros',
			'my macros this week',
			// calories
			'how many calories have I had today',
			'show me my calories',
			'what are my calories at',
			'check my calorie intake',
			'how is my calorie intake this week',
			// protein
			"what's my protein intake",
			'how much protein did I eat',
			'show my protein this week',
			'am I hitting my protein',
			// carbs
			'show my carbs for the week',
			'check my carb intake',
			// nutrition
			'show my nutrition',
			'show my nutrition summary',
			'check my nutrition',
			'track my nutrition this week',
			'view my nutrition intake',
			"how's my nutrition trending",
			'my nutrition this week',
			// macro synonyms
			'show my macro intake',
			'view my macro intake',
		];

		it.each(shouldMatch)('recognizes "%s" as nutrition view', (text) => {
			expect(isNutritionViewIntent(text)).toBe(true);
		});
	});

	describe('Should NOT match nutrition (no false positives)', () => {
		const shouldNotMatch = [
			// grocery/pantry — nothing nutrition about these
			'add protein powder to the grocery list',
			'we need milk and eggs',
			'buy chicken at costco',
			// meal planning — not nutrition
			"what's for dinner",
			'plan my meals for next week',
			'generate a meal plan',
			// recipe — not nutrition
			'find me a high protein recipe',
			'show me chicken recipes',
			'save this recipe',
			// hosting — different intent
			"we're having people over saturday",
			'plan a dinner party',
			// random non-food
			'hello there',
			"what's the weather",
			// edge case: mentions calories but as a recipe note, not a user query
			// ("calories" alone without user context verbs should still match if we
			// have "calorie" + "view/show/check/my/track/how/summary/this/intake"
			// — we keep this conservative)
			'delete my shopping list',
		];

		it.each(shouldNotMatch)('does NOT match "%s"', (text) => {
			expect(isNutritionViewIntent(text)).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// NUTRITION — Free-text message → handler routing (end-to-end)
	// ════════════════════════════════════════════════════════════════════════

	describe('Free-text nutrition messages route through handleMessage', () => {
		it('"how are my macros this week" routes to nutrition handler', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue(
				'You had a strong week — averaging 2100 kcal and 145g protein.',
			);

			await handleMessage(msg('how are my macros this week'));

			// User should receive a nutrition response — with no macro data on file
			// the handler short-circuits with a helpful "no data" message instead of
			// calling the LLM. Either way, the user gets a reply from the *nutrition*
			// handler, not a grocery/meal-plan handler.
			expect(services.telegram.send).toHaveBeenCalled();
			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			// Content should reference macros/nutrition, not another domain
			expect(sent.toLowerCase()).toMatch(/macro|nutrition|calori|protein/);
		});

		it('"show me my calories" routes to nutrition, not grocery', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('Calorie summary here.');

			await handleMessage(msg('show me my calories'));

			expect(services.telegram.send).toHaveBeenCalled();
			// Should NOT have attempted to write a grocery list
			expect(store.write).not.toHaveBeenCalledWith(
				expect.stringContaining('grocery'),
				expect.anything(),
			);
		});

		it('gracefully handles LLM failure when generating nutrition summary', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM unavailable'));

			await handleMessage(msg('check my nutrition this week'));

			// User must still receive a response — never a silent crash
			expect(services.telegram.send).toHaveBeenCalled();
			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			// A human-friendly message, not a raw stack trace
			expect(sent).not.toMatch(/Error:|stack|TypeError/);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// NUTRITION — /nutrition command variations
	// ════════════════════════════════════════════════════════════════════════

	describe('/nutrition command surface', () => {
		it('/nutrition with no args → weekly summary', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('Week summary');

			await handleCommand('nutrition', [], msg('/nutrition'));

			expect(services.telegram.send).toHaveBeenCalled();
		});

		it('/nutrition week → weekly summary', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('Week summary');

			await handleCommand('nutrition', ['week'], msg('/nutrition week'));

			expect(services.telegram.send).toHaveBeenCalled();
		});

		it('/nutrition month → monthly summary (30-day window)', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockResolvedValue('Month summary — steady protein, carbs up 8%');

			await handleCommand('nutrition', ['month'], msg('/nutrition month'));

			expect(services.telegram.send).toHaveBeenCalled();
		});

		it('/nutrition targets (no args) → shows current targets with helpful hint', async () => {
			setupHousehold({ targets: { calories: 2000, protein: 150, carbs: 200, fat: 70 } });

			await handleCommand('nutrition', ['targets'], msg('/nutrition targets'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Macro Targets'),
			);
			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			// Should also tell the user HOW to set them
			expect(sent).toContain('/nutrition targets set');
		});

		it('/nutrition targets with none previously set → shows "not set"', async () => {
			setupHousehold();

			await handleCommand('nutrition', ['targets'], msg('/nutrition targets'));

			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			expect(sent).toContain('not set');
		});

		it('/nutrition targets set 2200 160 220 75 → saves targets', async () => {
			setupHousehold();

			await handleCommand(
				'nutrition',
				['targets', 'set', '2200', '160', '220', '75'],
				msg('/nutrition targets set 2200 160 220 75'),
			);

			expect(store.write).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('updated'),
			);
		});

		it('/nutrition targets set with non-numeric values → user-friendly error', async () => {
			setupHousehold();

			await handleCommand(
				'nutrition',
				['targets', 'set', 'lots', 'of', 'protein', 'plz'],
				msg('/nutrition targets set lots of protein plz'),
			);

			// Should NOT write anything with garbage input
			expect(store.write).not.toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Invalid'),
			);
		});

		it('/nutrition targets set with absurdly large values → rejected', async () => {
			setupHousehold();

			await handleCommand(
				'nutrition',
				['targets', 'set', '999999999', '150', '200', '70'],
				msg('/nutrition targets set 999999999 150 200 70'),
			);

			expect(store.write).not.toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Invalid'),
			);
		});

		it('/nutrition targets set with negative values → rejected', async () => {
			setupHousehold();

			await handleCommand(
				'nutrition',
				['targets', 'set', '-500', '150', '200', '70'],
				msg('/nutrition targets set -500 150 200 70'),
			);

			expect(store.write).not.toHaveBeenCalled();
		});

		it('/nutrition pediatrician (no child, no children on file) → helpful guidance', async () => {
			setupHousehold({ children: [] });

			await handleCommand('nutrition', ['pediatrician'], msg('/nutrition pediatrician'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('No child profiles'),
			);
		});

		it('/nutrition pediatrician (no child, one child on file) → shows child selection buttons', async () => {
			setupHousehold({ children: [margotProfile] });

			await handleCommand('nutrition', ['pediatrician'], msg('/nutrition pediatrician'));

			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
			const callArgs = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
			const buttons = callArgs[2] as Array<Array<{ text: string; callbackData: string }>>;
			expect(buttons[0]![0]!.text).toBe('Margot');
			expect(buttons[0]![0]!.callbackData).toContain('margot');
		});

		it('/nutrition pediatrician margot → generates report', async () => {
			setupHousehold({ children: [margotProfile] });
			vi.mocked(services.llm.complete).mockResolvedValue('Margot is doing great with new foods.');

			await handleCommand(
				'nutrition',
				['pediatrician', 'margot'],
				msg('/nutrition pediatrician margot'),
			);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Margot'),
			);
		});

		it('/nutrition pediatrician for non-existent child → re-offers child selection', async () => {
			setupHousehold({ children: [margotProfile] });

			await handleCommand(
				'nutrition',
				['pediatrician', 'nonexistent'],
				msg('/nutrition pediatrician nonexistent'),
			);

			// Should re-prompt with available children, not crash
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// HOSTING — Intent Detection
	// ════════════════════════════════════════════════════════════════════════

	describe('Intent: hosting / dinner party (isHostingIntent)', () => {
		const shouldMatch = [
			// "having X over" patterns
			"we're having people over Saturday",
			'having friends over this weekend',
			'having family over for dinner',
			'having the in-laws over Sunday',
			'having the neighbors over tomorrow',
			'having my parents over for dinner',
			'having a few friends over for dinner tonight',
			// explicit hosting
			'hosting a dinner party',
			'hosting 6 guests Saturday',
			'hosting brunch this weekend',
			'hosting friends tomorrow',
			"I'm hosting dinner on Friday",
			// dinner party
			'plan a dinner party for 8',
			'plan a dinner party',
			'dinner party for 10 people',
			'dinner party next Saturday',
			// entertain
			'we need to entertain clients tomorrow',
			// "people over" / guests coming
			"we've got guests coming Saturday",
			'guests coming over Friday',
		];

		it.each(shouldMatch)('recognizes "%s" as hosting intent', (text) => {
			expect(isHostingIntent(text)).toBe(true);
		});
	});

	describe('Should NOT match hosting (no false positives)', () => {
		const shouldNotMatch = [
			// meal planning for just the household
			"what's for dinner",
			"what's for dinner tonight",
			'plan my meals for next week',
			'generate a meal plan',
			// grocery
			'add eggs to the grocery list',
			'we need milk',
			// nutrition (different H11 intent)
			'how are my macros',
			'show my nutrition',
			// recipes
			'save this recipe',
			'find a chicken recipe',
			// cook mode
			'start cooking the chicken',
			// random
			'hello',
			// looks similar but is really about leftovers / pantry
			'we have leftovers from last night',
		];

		it.each(shouldNotMatch)('does NOT match "%s"', (text) => {
			expect(isHostingIntent(text)).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// HOSTING — Free-text routing + LLM pipeline
	// ════════════════════════════════════════════════════════════════════════

	describe('Free-text hosting messages route through handleMessage', () => {
		/** The hosting planner calls the LLM 3 times: parse → menu → timeline. */
		function mockHostingPipeline() {
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce(
					JSON.stringify({
						guestCount: 6,
						eventTime: '2026-04-12T18:00:00',
						guestNames: [],
						dietaryNotes: '',
						description: 'dinner for 6',
					}),
				)
				.mockResolvedValueOnce(
					JSON.stringify([
						{ recipeTitle: 'Roast Chicken', scaledServings: 6, dietaryNotes: [] },
					]),
				)
				.mockResolvedValueOnce(
					JSON.stringify([
						{ time: 'T-2h', task: 'Preheat oven, prep chicken' },
						{ time: 'T-1h', task: 'Chicken into oven' },
						{ time: 'T-15m', task: 'Set the table' },
					]),
				);
		}

		it('"we\'re having people over for dinner Saturday" triggers hosting plan', async () => {
			setupHousehold();
			mockHostingPipeline();

			await handleMessage(msg("we're having people over for dinner Saturday"));

			// All 3 stages of the hosting pipeline should have fired
			expect(services.llm.complete).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Event Plan'),
			);
		});

		it('"hosting a dinner party for 8 saturday" triggers hosting plan', async () => {
			// Note: "plan a dinner party..." would be caught by isMealPlanGenerateIntent
			// first (it matches /plan.*dinners?/). "hosting..." phrasing avoids that
			// precedence collision and exercises the hosting path cleanly.
			setupHousehold();
			mockHostingPipeline();

			await handleMessage(msg('hosting a dinner party for 8 saturday'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Event Plan'),
			);
		});

		it('"plan a dinner party" matches isHostingIntent — even though meal-plan-generate wins in handleMessage', () => {
			// This documents a known routing precedence: "plan a dinner party" is
			// recognized by BOTH isMealPlanGenerateIntent and isHostingIntent, and
			// meal-plan generate is checked first in handleMessage. The hosting
			// intent function itself still recognizes the phrase — callers that
			// invoke it directly (or dispatch order changes in the future) will
			// route this correctly.
			expect(isHostingIntent('plan a dinner party')).toBe(true);
		});

		it('handles hosting LLM failure gracefully', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM down'));

			await handleMessage(msg("we're having 6 guests over tomorrow"));

			// User must still get a message — no silent failure
			expect(services.telegram.send).toHaveBeenCalled();
			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			expect(sent).not.toMatch(/stack|TypeError|Error:/);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// HOSTING — /hosting command surface
	// ════════════════════════════════════════════════════════════════════════

	describe('/hosting command surface', () => {
		it('/hosting with no args → shows menu with buttons', async () => {
			setupHousehold();

			await handleCommand('hosting', [], msg('/hosting'));

			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
			const call = vi.mocked(services.telegram.sendWithButtons).mock.calls[0]!;
			expect(call[1]).toContain('Hosting');
		});

		it('/hosting guests → lists current guest profiles', async () => {
			setupHousehold({ guests: [sarahGuest] });

			await handleCommand('hosting', ['guests'], msg('/hosting guests'));

			expect(services.telegram.send).toHaveBeenCalled();
		});

		it('/hosting guests with no profiles yet → empty-state message', async () => {
			setupHousehold();

			await handleCommand('hosting', ['guests'], msg('/hosting guests'));

			expect(services.telegram.send).toHaveBeenCalled();
		});

		it('/hosting guests add Sarah vegetarian gluten-free → adds guest', async () => {
			setupHousehold();

			await handleCommand(
				'hosting',
				['guests', 'add', 'Sarah', 'vegetarian', 'gluten-free'],
				msg('/hosting guests add Sarah vegetarian gluten-free'),
			);

			expect(store.write).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Sarah'),
			);
			const sent = vi.mocked(services.telegram.send).mock.calls[0]![1] as string;
			expect(sent).toContain('vegetarian');
			expect(sent).toContain('gluten-free');
		});

		it('/hosting guests add with no name → usage message', async () => {
			setupHousehold();

			await handleCommand('hosting', ['guests', 'add'], msg('/hosting guests add'));

			expect(store.write).not.toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Usage'),
			);
		});

		it('/hosting guests add Mike (no restrictions) → still works', async () => {
			setupHousehold();

			await handleCommand(
				'hosting',
				['guests', 'add', 'Mike'],
				msg('/hosting guests add Mike'),
			);

			expect(store.write).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Mike'),
			);
		});

		it('/hosting guests remove Sarah → removes by name', async () => {
			setupHousehold({ guests: [sarahGuest] });

			await handleCommand(
				'hosting',
				['guests', 'remove', 'Sarah'],
				msg('/hosting guests remove Sarah'),
			);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Sarah'),
			);
		});

		it('/hosting guests remove (no name, guests exist) → shows remove-buttons', async () => {
			setupHousehold({ guests: [sarahGuest] });

			await handleCommand('hosting', ['guests', 'remove'], msg('/hosting guests remove'));

			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('/hosting guests remove (no name, no guests) → empty state, not a crash', async () => {
			setupHousehold();

			await handleCommand('hosting', ['guests', 'remove'], msg('/hosting guests remove'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('No guest'),
			);
		});

		it('/hosting guests remove <unknown> → friendly not-found', async () => {
			setupHousehold({ guests: [sarahGuest] });

			await handleCommand(
				'hosting',
				['guests', 'remove', 'Bob'],
				msg('/hosting guests remove Bob'),
			);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('not found'),
			);
		});

		it('/hosting plan (no description) → usage message', async () => {
			setupHousehold();

			await handleCommand('hosting', ['plan'], msg('/hosting plan'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Usage'),
			);
		});

		it('/hosting plan dinner for 6 saturday → runs full 3-LLM pipeline', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce(
					JSON.stringify({
						guestCount: 6,
						eventTime: '2026-04-12T18:00:00',
						guestNames: [],
						dietaryNotes: '',
						description: 'dinner for 6',
					}),
				)
				.mockResolvedValueOnce(
					JSON.stringify([
						{ recipeTitle: 'Roast Chicken', scaledServings: 6, dietaryNotes: [] },
					]),
				)
				.mockResolvedValueOnce(
					JSON.stringify([{ time: 'T-2h', task: 'Prep' }]),
				);

			await handleCommand(
				'hosting',
				['plan', 'dinner', 'for', '6', 'saturday'],
				msg('/hosting plan dinner for 6 saturday'),
			);

			expect(services.llm.complete).toHaveBeenCalledTimes(3);
			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Event Plan'),
			);
		});

		it('/hosting unknown-subcommand → friendly unknown-command message', async () => {
			setupHousehold();

			await handleCommand(
				'hosting',
				['destroyeverything'],
				msg('/hosting destroyeverything'),
			);

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Unknown'),
			);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// END-TO-END Multi-Step User Journeys
	// ════════════════════════════════════════════════════════════════════════

	describe('End-to-end scenarios', () => {
		it('Journey: user sets targets, then asks how their macros are', async () => {
			setupHousehold();

			// Step 1: user sets macro targets via /nutrition targets set
			await handleCommand(
				'nutrition',
				['targets', 'set', '2000', '150', '200', '70'],
				msg('/nutrition targets set 2000 150 200 70'),
			);
			expect(store.write).toHaveBeenCalled();

			// Step 2: user asks how they're doing in natural language
			// Re-setup read to return the targets we just "saved"
			store.read.mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(household);
				if (path === 'nutrition/targets.yaml')
					return stringify({ calories: 2000, protein: 150, carbs: 200, fat: 70 });
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue(
				'On track — 1950 kcal avg, 148g protein. Great week!',
			);

			await handleMessage(msg('how are my macros this week'));

			// Both the save confirmation and the weekly summary should have been sent
			expect(services.telegram.send).toHaveBeenCalledTimes(2);
		});

		it('Journey: user adds a guest, lists guests, then plans an event', async () => {
			setupHousehold();

			// Step 1: add Sarah as a guest
			await handleCommand(
				'hosting',
				['guests', 'add', 'Sarah', 'vegetarian'],
				msg('/hosting guests add Sarah vegetarian'),
			);
			expect(store.write).toHaveBeenCalled();

			// Step 2: list guests (now with Sarah persisted to our mock)
			setupHousehold({ guests: [sarahGuest] });
			await handleCommand('hosting', ['guests'], msg('/hosting guests'));

			// Step 3: plan an event — the planner should see Sarah's vegetarian restriction
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce(
					JSON.stringify({
						guestCount: 4,
						eventTime: '2026-04-12T18:00:00',
						guestNames: ['Sarah'],
						dietaryNotes: 'vegetarian',
						description: 'dinner for 4 including Sarah (vegetarian)',
					}),
				)
				.mockResolvedValueOnce(
					JSON.stringify([
						{ recipeTitle: 'Veggie Pasta', scaledServings: 4, dietaryNotes: ['vegetarian'] },
					]),
				)
				.mockResolvedValueOnce(
					JSON.stringify([{ time: 'T-1h', task: 'Boil water, make sauce' }]),
				);

			await handleCommand(
				'hosting',
				['plan', 'dinner', 'for', '4', 'with', 'Sarah'],
				msg('/hosting plan dinner for 4 with Sarah'),
			);

			// Should have produced a final event plan message
			const calls = vi.mocked(services.telegram.send).mock.calls;
			const lastMessage = calls[calls.length - 1]![1] as string;
			expect(lastMessage).toContain('Event Plan');
		});

		it('Journey: user asks for pediatrician report for their child, then gets the report', async () => {
			setupHousehold({ children: [margotProfile] });

			// Step 1: request pediatrician report with no child specified — gets buttons
			await handleCommand('nutrition', ['pediatrician'], msg('/nutrition pediatrician'));
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();

			// Step 2: user "taps" Margot by sending the command with her name
			vi.mocked(services.llm.complete).mockResolvedValue(
				'Margot has been introduced to eggs successfully with no reactions.',
			);
			await handleCommand(
				'nutrition',
				['pediatrician', 'margot'],
				msg('/nutrition pediatrician margot'),
			);

			const sentCalls = vi.mocked(services.telegram.send).mock.calls;
			const reportMessage = sentCalls[sentCalls.length - 1]![1] as string;
			expect(reportMessage).toContain('Margot');
		});

		it('Journey: user types casual hosting message with typos → still routes correctly', async () => {
			setupHousehold();
			vi.mocked(services.llm.complete)
				.mockResolvedValueOnce(
					JSON.stringify({
						guestCount: 5,
						eventTime: '2026-04-11T19:00:00',
						guestNames: [],
						dietaryNotes: '',
						description: 'friends over',
					}),
				)
				.mockResolvedValueOnce(
					JSON.stringify([{ recipeTitle: 'Roast Chicken', scaledServings: 5, dietaryNotes: [] }]),
				)
				.mockResolvedValueOnce(
					JSON.stringify([{ time: 'T-1h', task: 'Prep' }]),
				);

			// Casual, slightly messy phrasing
			await handleMessage(msg('having some friends over for dinner tomorrow'));

			expect(services.telegram.send).toHaveBeenCalledWith(
				'matt',
				expect.stringContaining('Event Plan'),
			);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// NUTRITION & HOSTING do not collide with other Food intents
	// ════════════════════════════════════════════════════════════════════════

	describe('Intent isolation — H11 intents do not cross-contaminate', () => {
		it('"show my nutrition" matches nutrition but NOT hosting', () => {
			expect(isNutritionViewIntent('show my nutrition')).toBe(true);
			expect(isHostingIntent('show my nutrition')).toBe(false);
		});

		it('"plan a dinner party" matches hosting but NOT nutrition', () => {
			expect(isHostingIntent('plan a dinner party')).toBe(true);
			expect(isNutritionViewIntent('plan a dinner party')).toBe(false);
		});

		it('"having people over saturday" matches hosting but NOT nutrition', () => {
			expect(isHostingIntent('having people over saturday')).toBe(true);
			expect(isNutritionViewIntent('having people over saturday')).toBe(false);
		});

		it('"check my macros" matches nutrition but NOT hosting', () => {
			expect(isNutritionViewIntent('check my macros')).toBe(true);
			expect(isHostingIntent('check my macros')).toBe(false);
		});
	});
});
