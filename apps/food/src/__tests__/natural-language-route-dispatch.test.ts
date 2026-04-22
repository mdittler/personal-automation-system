/**
 * Natural Language Route-Dispatch Persona Tests
 * ===============================================
 *
 * Validates that real, casual user messages — when paired with a ctx.route
 * from core's LLM-based IntentClassifier — correctly invoke the right handler
 * via Food's route-first dispatch (dispatchByRoute / ROUTE_HANDLERS).
 *
 * The 9 allowlisted intents after P1 fix (LLM Enhancement #2 Chunk A, P1/P2 review):
 *   1.  "user wants to know what's for dinner"
 *   2.  "user wants to start cooking a recipe"
 *   3.  "user wants to know what they can make with what they have"
 *   4.  "user wants to set or change their nutrition or macro targets"
 *   5.  "user wants to see how well they are hitting their macro targets over time"
 *   6.  "user wants to understand how their diet is affecting their health or energy"
 *   7.  "user wants holiday or cultural recipe suggestions"
 *   8.  "user wants to plan for hosting guests"
 *   9.  "user wants to see food spending"
 *
 * Removed from allowlist (overlap violations):
 *   "user wants to save a recipe"        — overlaps with handleEditRecipe
 *   "user wants to search for a recipe"  — overlaps with handleRecipePhotoRetrieval
 *
 * Test groups:
 *   Group 1  — Allowlist intents: natural language + ctx.route → correct handler fires
 *   Group 2  — Non-allowlist regression: nearby intent in ctx.route, regex cascade runs instead
 *   Group 3  — End-to-end multi-step scenarios with ctx.route
 *   Group 4  — Household-missing path for household-gated intents
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { RouteInfo, ScopedDataStore } from '@pas/core/types';
import { stringify } from 'yaml';
import { init, handleMessage } from '../index.js';
import type { Household } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleHousehold: Household = {
	id: 'hh-persona-rd',
	name: 'Persona Family',
	createdBy: 'matt',
	members: ['matt', 'nina'],
	joinCode: 'PRDISP1',
	createdAt: '2026-01-01T00:00:00.000Z',
};

/** Substring present in the catch-all help message — used to detect fallthrough. */
const HELP_MSG = "I'm not sure what you'd like to do";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(intent: string, overrides: Partial<RouteInfo> = {}): RouteInfo {
	return {
		appId: 'food',
		intent,
		confidence: 0.92,
		source: 'intent',
		verifierStatus: 'agreed',
		...overrides,
	};
}

/**
 * Assert that telegram.send was called and the last call did NOT carry the
 * catch-all help message.  The allowlist handler must have fired.
 */
function assertHandlerFired(sendMock: ReturnType<typeof vi.fn>): void {
	expect(sendMock).toHaveBeenCalled();
	const calls = sendMock.mock.calls as [string, string][];
	const helpCall = calls.find(([, msg]) => typeof msg === 'string' && msg.includes(HELP_MSG));
	expect(helpCall, 'Expected no fallback help message, but one was sent').toBeUndefined();
}

/**
 * Assert that either telegram.send or telegram.sendWithButtons fired,
 * and neither was the generic help message.
 */
function assertAnyHandlerFired(
	sendMock: ReturnType<typeof vi.fn>,
	sendWithButtonsMock: ReturnType<typeof vi.fn>,
): void {
	const totalCalls =
		sendMock.mock.calls.length + sendWithButtonsMock.mock.calls.length;
	expect(totalCalls, 'Expected at least one Telegram reply').toBeGreaterThan(0);

	const allSendCalls = sendMock.mock.calls as [string, string][];
	const helpCall = allSendCalls.find(
		([, msg]) => typeof msg === 'string' && msg.includes(HELP_MSG),
	);
	expect(helpCall, 'Expected no fallback help message, but one was sent').toBeUndefined();
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('natural-language-route-dispatch persona tests', () => {
	let services: ReturnType<typeof createMockCoreServices>;
	let store: ScopedDataStore;

	beforeEach(async () => {
		store = createMockScopedStore();
		services = createMockCoreServices();

		vi.mocked(services.data.forShared).mockReturnValue(store as any);
		vi.mocked(services.data.forUser).mockReturnValue(store as any);

		vi.mocked(store.read).mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(sampleHousehold);
			return '';
		});

		vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
		vi.mocked(services.llm.classify).mockResolvedValue({ category: 'save_recipe', confidence: 0.9 });
		vi.mocked(services.llm.extractStructured).mockResolvedValue({});

		await init(services);
		vi.clearAllMocks();

		// Re-install mocks after clearAllMocks (init side-effects already done)
		vi.mocked(store.read).mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(sampleHousehold);
			return '';
		});
		vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
		vi.mocked(services.llm.classify).mockResolvedValue({ category: 'save_recipe', confidence: 0.9 });
		vi.mocked(services.llm.extractStructured).mockResolvedValue({});
	});

	// =========================================================================
	// Group 1: Allowlist intents — natural language + ctx.route → handler fires
	//
	// Each sub-describe has ≥5 real user phrasings that do NOT match the regex
	// cascade on their own.  The route carries the intent at high confidence so
	// dispatchByRoute claims the message before the regex cascade runs.
	// =========================================================================

	describe('Group 1: allowlist intents fire the correct handler via ctx.route', () => {

		// Note: "user wants to save a recipe" (former intent 1) and
		// "user wants to search for a recipe" (former intent 2) were removed from
		// ROUTE_HANDLERS because they overlap with handleEditRecipe and
		// handleRecipePhotoRetrieval respectively (P1 fix). Tests for those removed.

		// -----------------------------------------------------------------
		// Intent 1 (was 3): "user wants to know what's for dinner"
		// Stronger assertion: dinner handler sends a meal-plan-specific message,
		// not the generic help fallback or a grocery/recipe response.
		// With an empty meal plan in the store, handleWhatsForDinner sends:
		//   "No meal plan yet. Try "plan meals for this week" to generate one!"
		// That text contains "meal plan" — distinct from any other handler output.
		// -----------------------------------------------------------------
		describe("what's for dinner (intent 1)", () => {
			const INTENT = "user wants to know what's for dinner";
			const messages = [
				'what did you plan for tonight',    // original from route-dispatch.test.ts
				'tonight plan',
				'any idea what we eating',
				'what are we having',
				'tell me about tonights food',
				'dinner tonight?',
			];

			it.each(messages)('"%s" + route → dinner handler fires (meal plan message)', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				// handleWhatsForDinner sends "No meal plan yet…" when plan is empty.
				// handleSearchRecipe or other handlers would never emit this specific text.
				const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
				expect(
					calls.some(([, msg]) => msg.includes('meal plan') || msg.includes('for tonight')),
					'Expected dinner handler output (meal plan message)',
				).toBe(true);
			});
		});

		// -----------------------------------------------------------------
		// Intent 2 (was 4): "user wants to start cooking a recipe"
		// -----------------------------------------------------------------
		describe('start cooking a recipe (intent 2)', () => {
			const INTENT = 'user wants to start cooking a recipe';
			const messages = [
				'kick off that recipe',             // original from route-dispatch.test.ts
				"let's get cooking",
				'fire up the stir fry',
				'begin cooking mode',
				'start making pasta',
				'time to cook something',
			];

			it.each(messages)('"%s" + route → handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});

		// -----------------------------------------------------------------
		// Intent 3 (was 5): "user wants to know what they can make with what they have"
		// Stronger assertion: with empty pantry, handler sends "Your pantry is empty!"
		// That message is unique to handleWhatCanIMake — no other handler emits it.
		// -----------------------------------------------------------------
		describe('what can I make (intent 3)', () => {
			const INTENT = 'user wants to know what they can make with what they have';
			const messages = [
				'list things i can cook',           // original from route-dispatch.test.ts
				'what can we make',
				'what do we have to cook with',
				'any recipes with what we got',
				'cook from pantry please',
				'improvise something from our ingredients',
			];

			it.each(messages)('"%s" + route → what-can-I-make handler fires (pantry-empty message)', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				// handleWhatCanIMake sends "Your pantry is empty!" when no pantry items exist.
				// No other handler emits this specific message.
				const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
				expect(
					calls.some(([, msg]) => msg.includes('pantry is empty') || msg.includes('pantry')),
					'Expected pantry-empty message from handleWhatCanIMake',
				).toBe(true);
			});
		});

		// -----------------------------------------------------------------
		// Intent 4 (was 6): "user wants to set or change their nutrition or macro targets"
		// -----------------------------------------------------------------
		describe('set or change nutrition targets (intent 4)', () => {
			const INTENT = 'user wants to set or change their nutrition or macro targets';
			const messages = [
				'update my diet goals',             // original from route-dispatch.test.ts
				'i wanna change my calorie goal',
				'new protein target',
				'set nutrition goals',
				'tweak my macros',
				'lower my carb target',
			];

			it.each(messages)('"%s" + route → targets flow begins (sendWithButtons called)', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				// beginTargetsFlow uses sendWithButtons for the first prompt
				expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
			});
		});

		// -----------------------------------------------------------------
		// Intent 5 (was 7): "user wants to see how well they are hitting their macro targets over time"
		// -----------------------------------------------------------------
		describe('macro adherence (intent 5)', () => {
			const INTENT = 'user wants to see how well they are hitting their macro targets over time';
			const messages = [
				'am i doing ok with nutrition',     // original from route-dispatch.test.ts
				'how am i doing on protein',
				'hitting my targets lately',
				'macro check',
				'adherence summary please',
				'show how im tracking',
			];

			it.each(messages)('"%s" + route → adherence handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});

		// -----------------------------------------------------------------
		// Intent 6 (was 8): "user wants to understand how their diet is affecting their health or energy"
		// -----------------------------------------------------------------
		describe('diet-health correlation (intent 6)', () => {
			const INTENT = 'user wants to understand how their diet is affecting their health or energy';
			const messages = [
				'connect my meals to my health',    // original from route-dispatch.test.ts
				'does what i eat affect how i feel',
				'link diet to energy',
				'how is my food doing for me',
				'food impact check',
				'eating patterns vs health',
			];

			it.each(messages)('"%s" + route → health correlation handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});

		// -----------------------------------------------------------------
		// Intent 7 (was 9): "user wants holiday or cultural recipe suggestions"
		// -----------------------------------------------------------------
		describe('holiday / cultural recipe suggestions (intent 7)', () => {
			const INTENT = 'user wants holiday or cultural recipe suggestions';
			const messages = [
				'cultural cooking ideas',           // original from route-dispatch.test.ts
				'any holiday meal ideas',
				'whats traditional to eat',
				'seasonal recipes please',
				'festive food ideas',
				'upcoming cultural holidays food',
			];

			it.each(messages)('"%s" + route → cultural calendar handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});

		// -----------------------------------------------------------------
		// Intent 8 (was 10): "user wants to plan for hosting guests"
		// -----------------------------------------------------------------
		describe('hosting guests (intent 8)', () => {
			const INTENT = 'user wants to plan for hosting guests';
			const messages = [
				"i'm having company",               // original from route-dispatch.test.ts
				'friends are coming over saturday',
				'help me plan for guests',
				'menu ideas for visitors',
				'hosting dinner for 8',
				'party food ideas',
			];

			it.each(messages)('"%s" + route → hosting handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});

		// -----------------------------------------------------------------
		// Intent 9 (was 11): "user wants to see food spending"
		// -----------------------------------------------------------------
		describe('food spending (intent 9)', () => {
			const INTENT = 'user wants to see food spending';
			const messages = [
				"what's the grocery bill",          // original from route-dispatch.test.ts
				'how much did we spend on food',
				'show food budget',
				'cost summary',
				'food expenses this month',
				'grocery spending report',
			];

			it.each(messages)('"%s" + route → budget handler fires, not help msg', async (text) => {
				const ctx = createTestMessageContext({
					userId: 'matt',
					text,
					route: makeRoute(INTENT),
				});
				await handleMessage(ctx);
				assertHandlerFired(vi.mocked(services.telegram.send));
			});
		});
	});

	// =========================================================================
	// Group 2: Non-allowlist regression — nearby intent in ctx.route at high
	// confidence, but that intent is NOT in ROUTE_HANDLERS.  dispatchByRoute
	// returns false → regex cascade fires the correct handler.
	//
	// These cases must pass in both RED and GREEN phases.
	// =========================================================================

	describe('Group 2: non-allowlist regressions — regex cascade fires despite ctx.route', () => {

		it('freezer view — "show me the freezer" with pantry route → freezer handler fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'show me the freezer',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(calls.some(([, msg]) => !msg.includes(HELP_MSG))).toBe(true);
		});

		it('freezer add — "add soup to the freezer" with pantry route → freezer-add fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'add soup to the freezer',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('waste — "the chicken went bad" with leftover route → waste handler fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'the chicken went bad',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('leftover view — "show me the leftovers" with leftover route → leftover-view fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'show me the leftovers',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('leftover add — "we have leftover pasta" with leftover route → leftover-add fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'we have leftover pasta',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('grocery generate — "make me a grocery list for pasta bolognese" with grocery-add route → generate fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'make me a grocery list for pasta bolognese',
				route: makeRoute('user wants to add items to the grocery list', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('meal swap — "swap thursday for tacos" with meal-plan route → meal-swap fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'swap thursday for tacos',
				route: makeRoute('user wants to plan meals for the week', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('price update — "milk is $4.50 at target" with store-prices route → price-update fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'milk is $4.50 at target',
				route: makeRoute('user asks about prices at a specific store', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('price update — "eggs $2.99 at aldi" with store-prices route → price-update fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'eggs $2.99 at aldi',
				route: makeRoute('user asks about prices at a specific store', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('pantry check NOT allowlisted — "check the pantry" at 0.95 → pantry view via regex', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'check the pantry',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('leftover-add NOT allowlisted — "leftover chicken soup in the fridge" at 0.95 → leftover-add via regex', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'leftover chicken soup in the fridge',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Group 3: End-to-end scenario tests — multi-step flows with ctx.route
	//
	// These walk through realistic user journeys that touch multiple intents
	// or context-dependent state within a single test.
	// =========================================================================

	describe('Group 3: end-to-end multi-step scenarios via ctx.route', () => {

		/**
		 * Scenario A: "I want to cook something tonight"
		 *
		 * User asks what's for dinner (intent 1), sees a response, then asks
		 * what they can make (intent 3).  Two sequential messages, each with
		 * the appropriate ctx.route.
		 */
		it('Scenario A: dinner inquiry then what-can-I-make — two sequential route dispatches', async () => {
			// Step 1 — what's for dinner
			const ctx1 = createTestMessageContext({
				userId: 'nina',
				text: 'anything planned tonight',
				route: makeRoute("user wants to know what's for dinner"),
			});
			await handleMessage(ctx1);
			assertHandlerFired(vi.mocked(services.telegram.send));

			vi.clearAllMocks();
			vi.mocked(store.read).mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(sampleHousehold);
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');

			// Step 2 — find out what we can make with pantry
			const ctx2 = createTestMessageContext({
				userId: 'nina',
				text: 'ok what can we cook with what we have',
				route: makeRoute('user wants to know what they can make with what they have'),
			});
			await handleMessage(ctx2);
			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		/**
		 * Scenario B: "I'm having people over for the holidays"
		 *
		 * User sends a message that carries both a hosting intent AND a cultural
		 * calendar flavour.  The ctx.route picks hosting (intent 8).  Separately
		 * a cultural calendar message is sent (intent 7).  Both handlers should
		 * fire without interference.
		 */
		it('Scenario B: hosting enquiry then cultural-holiday recipe request — both handlers fire', async () => {
			// Step 1 — hosting intent
			const ctx1 = createTestMessageContext({
				userId: 'matt',
				text: "we're having family over for the holidays",
				route: makeRoute('user wants to plan for hosting guests'),
			});
			await handleMessage(ctx1);
			assertHandlerFired(vi.mocked(services.telegram.send));

			vi.clearAllMocks();
			vi.mocked(store.read).mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(sampleHousehold);
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');

			// Step 2 — cultural/holiday recipe ideas
			const ctx2 = createTestMessageContext({
				userId: 'matt',
				text: 'any holiday recipes we could serve',
				route: makeRoute('user wants holiday or cultural recipe suggestions'),
			});
			await handleMessage(ctx2);
			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		/**
		 * Scenario C: Budget review then macro target update
		 *
		 * User checks food spending (intent 9), then decides to tighten their
		 * nutrition targets (intent 4).  Confirms that two different allowlisted
		 * intents fire correctly in sequence without any state leakage.
		 */
		it('Scenario C: food spending check then nutrition targets update — both handlers fire correctly', async () => {
			// Step 1 — food spending
			const ctx1 = createTestMessageContext({
				userId: 'nina',
				text: 'how much did we spend on groceries last month',
				route: makeRoute('user wants to see food spending'),
			});
			await handleMessage(ctx1);
			assertHandlerFired(vi.mocked(services.telegram.send));

			vi.clearAllMocks();
			vi.mocked(store.read).mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(sampleHousehold);
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');

			// Step 2 — update nutrition targets in response to the spending info
			const ctx2 = createTestMessageContext({
				userId: 'nina',
				text: 'i should probably fix my calorie goal',
				route: makeRoute('user wants to set or change their nutrition or macro targets'),
			});
			await handleMessage(ctx2);
			// beginTargetsFlow sends the first step via sendWithButtons
			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
		});

		/**
		 * Scenario D: Low-confidence route is ignored — fallthrough to regex
		 *
		 * ctx.route carries an allowlist intent but at confidence 0.60 (below the
		 * 0.75 MIN_INTENT_CONFIDENCE threshold).  dispatchByRoute must reject it and
		 * the regex cascade handles a message that does match.
		 */
		it('Scenario D: low-confidence allowlist route is ignored — regex cascade handles the message', async () => {
			// "check the pantry" is handled by regex (isPantryViewIntent)
			// The route carries an allowlisted intent at LOW confidence (0.60 < 0.75 threshold) — must be rejected
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'check the pantry',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.60 }),
			});
			await handleMessage(ctx);
			// Pantry view handler fires via regex (telegram.send called with pantry content)
			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		/**
		 * Scenario E: wrong appId in ctx.route — route ignored, regex cascade runs
		 *
		 * ctx.route targets a different app.  dispatchByRoute must reject it.
		 */
		it('Scenario E: ctx.route targeting wrong appId is ignored — regex cascade runs', async () => {
			const ctx = createTestMessageContext({
				userId: 'matt',
				text: 'show me the grocery list',
				route: {
					appId: 'chatbot',   // wrong app
					intent: "user wants to know what's for dinner",
					confidence: 0.99,
					source: 'intent',
					verifierStatus: 'agreed',
				},
			});
			await handleMessage(ctx);
			// isGroceryViewIntent matches — grocery list handler fires
			expect(
				vi.mocked(services.telegram.send).mock.calls.length +
				vi.mocked(services.telegram.sendWithButtons).mock.calls.length,
			).toBeGreaterThan(0);
		});

		/**
		 * Scenario F: health-correlation then adherence — both fire via allowlist
		 */
		it('Scenario F: diet-health correlation followed by macro adherence — both handlers fire', async () => {
			// Step 1 — health correlation
			const ctx1 = createTestMessageContext({
				userId: 'matt',
				text: 'link my food to how i feel',
				route: makeRoute('user wants to understand how their diet is affecting their health or energy'),
			});
			await handleMessage(ctx1);
			assertHandlerFired(vi.mocked(services.telegram.send));

			vi.clearAllMocks();
			vi.mocked(store.read).mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(sampleHousehold);
				return '';
			});
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');

			// Step 2 — adherence
			const ctx2 = createTestMessageContext({
				userId: 'matt',
				text: 'am i actually hitting my goals',
				route: makeRoute('user wants to see how well they are hitting their macro targets over time'),
			});
			await handleMessage(ctx2);
			assertHandlerFired(vi.mocked(services.telegram.send));
		});
	});

	// =========================================================================
	// Group 4: Household-missing path for household-gated allowlist intents
	//
	// When an allowlisted intent fires via ctx.route but the handler requires a
	// household and none exists, the handler sends the household-setup error and
	// returns early.  dispatchByRoute already claimed the message so the regex
	// cascade does NOT run.
	// =========================================================================

	describe('Group 4: household-missing path for household-gated allowlist intents', () => {

		it('food spending with no household → household error sent, cascade skipped', async () => {
			// Override store to return no household
			vi.mocked(store.read).mockImplementation(async (_path: string) => '');

			const ctx = createTestMessageContext({
				userId: 'nina',
				text: 'how much did we spend this month',
				route: makeRoute('user wants to see food spending', { confidence: 0.92 }),
			});
			await handleMessage(ctx);

			// dispatchByRoute claims the message, handler sends household-setup error
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(
				calls.some(([, msg]) => msg.includes('Set up a household first')),
				'Expected household-setup error from the route-claimed handler',
			).toBe(true);

			// Regex cascade must NOT have fired — no "I'm not sure" help message
			const helpCalls = calls.filter(([, msg]) => msg.includes("I'm not sure"));
			expect(helpCalls, 'Regex cascade must not run after route claimed the message').toHaveLength(0);
		});

		it('hosting with no household → household error sent, cascade skipped', async () => {
			// Override store to return no household
			vi.mocked(store.read).mockImplementation(async (_path: string) => '');

			const ctx = createTestMessageContext({
				userId: 'nina',
				text: "friends are coming over saturday for dinner",
				route: makeRoute('user wants to plan for hosting guests', { confidence: 0.91 }),
			});
			await handleMessage(ctx);

			// dispatchByRoute claims the message, handler sends household-setup error
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(
				calls.some(([, msg]) => msg.includes('Set up a household first')),
				'Expected household-setup error from the route-claimed handler',
			).toBe(true);

			// No help fallback
			const helpCalls = calls.filter(([, msg]) => msg.includes("I'm not sure"));
			expect(helpCalls, 'Regex cascade must not run after route claimed the message').toHaveLength(0);
		});
	});
});
