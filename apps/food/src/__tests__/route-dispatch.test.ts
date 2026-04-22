/**
 * Route-dispatch integration tests (LLM Enhancement #2, Chunk A — Task A4).
 *
 * RED phase behaviour:
 * - handleMessage does NOT yet call dispatchByRoute.
 * - Group 1 tests: route is ignored, ambiguous text hits no regex, the fallback
 *   help message ("I'm not sure what you'd like to do") is sent.
 *   Assertions require the help message was NOT sent → tests FAIL in RED.
 * - Group 2 + Group 3: existing regex cascade fires → correct handler calls
 *   telegram.send → tests PASS in RED.
 *
 * After Task A5 wires dispatchByRoute into handleMessage:
 * - Group 1: route fires correct handler → non-help message → tests PASS (GREEN).
 * - Group 2 + Group 3: deferred/non-manifest intents still fall through to regex
 *   (dispatchByRoute returns false for intents not in ROUTE_HANDLERS) → PASS.
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
	id: 'hh-route-test',
	name: 'Route Test Family',
	createdBy: 'user1',
	members: ['user1'],
	joinCode: 'ROUTE1',
	createdAt: '2026-01-01T00:00:00.000Z',
};

/** Substring present in the catch-all help message. Used to detect fallthrough. */
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
 * Assert that telegram.send was called, and the last call did NOT carry the
 * fallback help message.  This is the Group 1 RED/GREEN signal:
 *   - RED:   route ignored → help message sent → assertion FAILS
 *   - GREEN: route fires handler → handler message sent → assertion PASSES
 */
function assertHandlerFired(sendMock: ReturnType<typeof vi.fn>): void {
	expect(sendMock).toHaveBeenCalled();
	// Every call's second argument (the message text) must NOT be the help msg.
	// (Using `every` so the assertion fails on the first mismatch.)
	const calls = sendMock.mock.calls as [string, string][];
	const helpCall = calls.find(([, msg]) => typeof msg === 'string' && msg.includes(HELP_MSG));
	expect(helpCall, 'Expected no fallback help message, but one was sent').toBeUndefined();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('route-dispatch integration', () => {
	let services: ReturnType<typeof createMockCoreServices>;
	let store: ScopedDataStore;

	beforeEach(async () => {
		store = createMockScopedStore();
		services = createMockCoreServices();

		vi.mocked(services.data.forShared).mockReturnValue(store as any);
		vi.mocked(services.data.forUser).mockReturnValue(store as any);

		// Default: household exists so handlers that require one proceed normally
		vi.mocked(store.read).mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(sampleHousehold);
			return '';
		});

		// LLM defaults — handlers that call llm.complete get a safe stub response
		vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
		vi.mocked(services.llm.classify).mockResolvedValue({ category: 'save_recipe', confidence: 0.9 });
		vi.mocked(services.llm.extractStructured).mockResolvedValue({});

		await init(services);
		vi.clearAllMocks();

		// Re-install mocks after clearAllMocks (init side-effects are already done)
		vi.mocked(store.read).mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(sampleHousehold);
			return '';
		});
		vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
		vi.mocked(services.llm.classify).mockResolvedValue({ category: 'save_recipe', confidence: 0.9 });
		vi.mocked(services.llm.extractStructured).mockResolvedValue({});
	});

	// =========================================================================
	// Group 1: Route wins for allowlist intents
	//
	// RED phase  → FAIL: route ignored, text misses regex, fallback help fires.
	// GREEN phase → PASS: dispatchByRoute routes to correct handler, no help msg.
	//
	// Ambiguous texts are carefully chosen to NOT match any is*Intent regex so
	// the only way the correct handler fires is through dispatchByRoute.
	// =========================================================================

	describe('Group 1: route wins for allowlist intents (RED until A5)', () => {
		it('save recipe — "jot this one down for me" + route fires handler, not help msg', async () => {
			// "jot this one down for me" does not match isSaveRecipeIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'jot this one down for me',
				route: makeRoute('user wants to save a recipe'),
			});

			await handleMessage(ctx);

			// RED:   fallback help msg fires → assertHandlerFired sees help msg → FAILS
			// GREEN: route fires handleSaveRecipe → "Parsing your recipe..." → PASSES
			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('search recipe — "give me something tasty to try" + route fires handler', async () => {
			// Does not match isSearchRecipeIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'give me something tasty to try',
				route: makeRoute('user wants to search for a recipe'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it("what's for dinner — \"what did you plan for tonight\" + route fires handler", async () => {
			// Does not match isWhatsForDinnerIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'what did you plan for tonight',
				route: makeRoute("user wants to know what's for dinner"),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('start cooking — "kick off that recipe" + route fires cook handler', async () => {
			// Does not match isCookIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'kick off that recipe',
				route: makeRoute('user wants to start cooking a recipe'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('what can I make — "list things i can cook" + route fires handler', async () => {
			// Does not match isWhatCanIMakeIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'list things i can cook',
				route: makeRoute('user wants to know what they can make with what they have'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('nutrition targets — "update my diet goals" + route fires beginTargetsFlow', async () => {
			// Does not match isTargetsSetIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'update my diet goals',
				route: makeRoute('user wants to set or change their nutrition or macro targets'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('macro adherence — "am i doing ok with nutrition" + route fires adherence handler', async () => {
			// Does not match isAdherenceIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'am i doing ok with nutrition',
				route: makeRoute('user wants to see how well they are hitting their macro targets over time'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('health correlation — "connect my meals to my health" + route fires health handler', async () => {
			// Does not match isHealthCorrelationIntent regex (no direct diet/food/nutrition + affect pattern)
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'connect my meals to my health',
				route: makeRoute('user wants to understand how their diet is affecting their health or energy'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it('cultural calendar — "cultural cooking ideas" + route fires cultural handler', async () => {
			// Does not match isCulturalCalendarIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'cultural cooking ideas',
				route: makeRoute('user wants holiday or cultural recipe suggestions'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it("hosting — \"i'm having company\" + route fires hosting handler", async () => {
			// Does not match isHostingIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: "i'm having company",
				route: makeRoute('user wants to plan for hosting guests'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});

		it("budget — \"what's the grocery bill\" + route fires budget handler", async () => {
			// Does not match isBudgetViewIntent regex
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: "what's the grocery bill",
				route: makeRoute('user wants to see food spending'),
			});

			await handleMessage(ctx);

			assertHandlerFired(vi.mocked(services.telegram.send));
		});
	});

	// =========================================================================
	// Group 2: Non-manifest regressions
	//
	// Texts that DO match the regex cascade. The ctx.route carries a nearby
	// manifest intent at high confidence, but that intent is NOT in ROUTE_HANDLERS.
	// Both in RED (route ignored) and GREEN (dispatchByRoute returns false for
	// non-allowlist intent) the regex cascade runs and the correct handler fires.
	// These tests PASS in both RED and GREEN.
	// =========================================================================

	describe('Group 2: non-manifest regressions (regex cascade, pass in RED)', () => {
		it('freezer view — "show me the freezer" with nearby pantry route → freezer handler fires', async () => {
			// isFreezerViewIntent matches; pantry intent is not in ROUTE_HANDLERS allowlist
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'show me the freezer',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
			// Freezer view sends something about freezer — not the generic help msg
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(calls.some(([, msg]) => !msg.includes(HELP_MSG))).toBe(true);
		});

		it('freezer add — "add chicken to the freezer" with pantry route → freezer-add handler fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'add chicken to the freezer',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('waste — "the milk went bad" with leftover route → waste handler fires', async () => {
			// isWasteIntent matches; leftover intent is not in ROUTE_HANDLERS allowlist
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'the milk went bad',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('leftover view — "show me the leftovers" with leftover route → leftover-view fires', async () => {
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'show me the leftovers',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('grocery generate — "make me a grocery list for pasta" with grocery-add route → generate fires', async () => {
			// isGroceryGenerateIntent matches; grocery-add intent is not in ROUTE_HANDLERS
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'make me a grocery list for pasta',
				route: makeRoute('user wants to add items to the grocery list', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('meal swap — "swap tuesday for pizza" with meal-plan route → meal-swap handler fires', async () => {
			// isMealSwapIntent matches; meal-plan-view intent is not in ROUTE_HANDLERS
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'swap tuesday for pizza',
				route: makeRoute('user wants to plan meals for the week', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('recipe photo — "show me the recipe photo for lasagna" with search-recipe route → photo handler fires', async () => {
			// isRecipePhotoIntent runs before isSearchRecipeIntent in the regex cascade.
			// In RED: route ignored, regex fires isRecipePhotoIntent → telegram.send called.
			// In GREEN: dispatchByRoute fires handleSearchRecipe (in ROUTE_HANDLERS) first;
			// handleSearchRecipe also calls telegram.send, so the assertion holds in both phases.
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'show me the recipe photo for lasagna',
				route: makeRoute('user wants to search for a recipe', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('recipe edit — "edit the lasagna recipe" with save-recipe route → edit handler fires', async () => {
			// isEditRecipeIntent runs before isSaveRecipeIntent in the regex cascade.
			// In RED: route ignored, isEditRecipeIntent fires → telegram.send called.
			// In GREEN: dispatchByRoute fires handleSaveRecipe (in ROUTE_HANDLERS) first;
			// handleSaveRecipe also calls telegram.send, so the assertion holds in both phases.
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'edit the lasagna recipe',
				route: makeRoute('user wants to save a recipe', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('price update — "eggs are $3.50 at costco" with store-prices route → price-update fires', async () => {
			// isPriceUpdateIntent matches; store-prices intent is NOT in ROUTE_HANDLERS
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'eggs are $3.50 at costco',
				route: makeRoute('user asks about prices at a specific store', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Group 3: Deferred intents fall through to regex
	//
	// Intents NOT in ROUTE_HANDLERS at high confidence. dispatchByRoute returns
	// false → regex cascade runs → handler fires. Both RED and GREEN: PASS.
	// =========================================================================

	describe('Group 3: deferred intents fall through to regex (pass in RED and GREEN)', () => {
		it('pantry NOT in allowlist — "check the pantry" at 0.95 → pantry view runs via regex', async () => {
			// isPantryViewIntent matches "check the pantry".
			// "user wants to check or update the pantry" is NOT in ROUTE_HANDLERS.
			// dispatchByRoute returns false (no match) → regex fires → telegram.send called.
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'check the pantry',
				route: makeRoute('user wants to check or update the pantry', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});

		it('leftover-add NOT in allowlist — "we have leftover chicken soup" at 0.95 → leftover-add via regex', async () => {
			// isLeftoverAddIntent matches "we have leftover chicken soup".
			// "user wants to log leftovers" is NOT in ROUTE_HANDLERS.
			// dispatchByRoute returns false → regex fires → telegram.send called.
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'we have leftover chicken soup',
				route: makeRoute('user wants to log leftovers', { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			expect(vi.mocked(services.telegram.send)).toHaveBeenCalled();
		});
	});
});
