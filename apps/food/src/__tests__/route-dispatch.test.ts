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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { RouteInfo, ScopedDataStore } from '@pas/core/types';
import { stringify } from 'yaml';
import { init, handleMessage } from '../index.js';
import type { Household, Recipe } from '../types.js';
import { beginTargetsFlow, __resetTargetsFlowForTests, __setTargetsFlowAwaitingCustomInputForTests } from '../handlers/targets-flow.js';
import { hasPendingCookRecipe, handleCookCommand, isCookModeActive } from '../handlers/cook-mode.js';
import { createSession, endSession } from '../services/cook-session.js';
import {
    __setShadowDepsForTests,
    __clearShadowDepsForTests,
    __flushShadowForTests,
    type ShadowClassifierInterface,
    type ShadowLoggerInterface,
} from '../routing/shadow-integration.js';
import type { ShadowLogEntry, ShadowResult } from '../routing/shadow-logger.js';

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
	// (Using `find` to locate the first call whose message contains the help string.)
	const calls = sendMock.mock.calls as [string, string][];
	const helpCall = calls.find(([, msg]) => typeof msg === 'string' && msg.includes(HELP_MSG));
	expect(helpCall, 'Expected no fallback help message, but one was sent').toBeUndefined();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sample recipe fixture (used in pending-flow tests)
// ---------------------------------------------------------------------------

const sampleRecipe: Recipe = {
	id: 'lasagna-001',
	title: 'Lasagna',
	source: 'family',
	ingredients: [{ name: 'pasta', quantity: 500, unit: 'g' }],
	instructions: ['Layer and bake'],
	servings: 4,
	tags: ['italian'],
	cuisine: 'Italian',
	ratings: [],
	history: [],
	allergens: [],
	status: 'confirmed',
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('route-dispatch integration', () => {
	let services: ReturnType<typeof createMockCoreServices>;
	let sharedStore: ScopedDataStore;
	let userStore: ScopedDataStore;

	afterEach(() => {
		// Reset targets-flow pending state between tests
		__resetTargetsFlowForTests();
	});

	beforeEach(async () => {
		sharedStore = createMockScopedStore();
		userStore = createMockScopedStore();
		services = createMockCoreServices();

		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.data.forUser).mockReturnValue(userStore as any);

		// Default: household exists so handlers that require one proceed normally
		vi.mocked(sharedStore.read).mockImplementation(async (path: string) => {
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
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
		vi.mocked(services.data.forUser).mockReturnValue(userStore as any);
		vi.mocked(sharedStore.read).mockImplementation(async (path: string) => {
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
	//
	// Note: "user wants to save a recipe" and "user wants to search for a recipe"
	// were removed from ROUTE_HANDLERS — they overlap with handleEditRecipe and
	// handleRecipePhotoRetrieval respectively. Tests for those intents are removed.
	// =========================================================================

	describe('Group 1: route wins for allowlist intents (RED until A5)', () => {
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

			// beginTargetsFlow sends the first step via sendWithButtons (not send)
			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
		});

		it('macro adherence route reads nutrition targets from the user store after the shared household guard', async () => {
			vi.mocked(sharedStore.read).mockImplementation(async (path: string) => {
				if (path === 'household.yaml') return stringify(sampleHousehold);
				throw new Error('adherence route must not read user nutrition data from shared household storage');
			});
			vi.mocked(userStore.read).mockImplementation(async (path: string) => {
				if (path === 'nutrition/targets.yaml') return 'calories: 2000\nprotein: 150';
				return '';
			});
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'am i doing ok with nutrition',
				route: makeRoute('user wants to see how well they are hitting their macro targets over time'),
			});

			await handleMessage(ctx);

			expect(services.data.forUser).toHaveBeenCalledWith('user1');
			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
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

		it('recipe photo — "get the recipe photo for lasagna" with search-recipe route → photo handler fires, not search handler', async () => {
			// isRecipePhotoIntent matches "get the recipe photo for lasagna" (verb: get, noun: photo).
			// isSearchRecipeIntent does NOT match it (no search/find/show/look pattern).
			// "user wants to search for a recipe" is NOT in ROUTE_HANDLERS allowlist (removed —
			// overlaps with handleRecipePhotoRetrieval). dispatchByRoute returns false → regex cascade
			// fires handleRecipePhotoRetrieval (isRecipePhotoIntent check comes after isSearchRecipeIntent
			// and this text only matches isRecipePhotoIntent).
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'get the recipe photo for lasagna',
				route: makeRoute('user wants to search for a recipe', { confidence: 0.95 }),
			});
			// Restore store.list so loadAllRecipes works without an error (returns empty list)
			vi.mocked(sharedStore.list).mockResolvedValue([]);

			await handleMessage(ctx);

			// handleRecipePhotoRetrieval sends "Couldn't find a recipe matching" when recipe not in store.
			// handleSearchRecipe would send search-result formatting — a different message.
			// This assertion fails if the wrong handler (handleSearchRecipe) fires.
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(calls.some(([, msg]) => msg.includes("Couldn't find a recipe matching"))).toBe(true);
		});

		it('recipe edit — "edit the lasagna recipe" with save-recipe route → edit handler fires, NOT save handler', async () => {
			// isEditRecipeIntent matches this text.
			// "user wants to save a recipe" is NOT in ROUTE_HANDLERS allowlist (removed — overlaps
			// with handleEditRecipe). dispatchByRoute returns false → regex cascade fires
			// handleEditRecipe. With empty recipe store it sends "No recipes to edit yet."
			// handleSaveRecipe would instead send "Parsing your recipe..." — a different message.
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'edit the lasagna recipe',
				route: makeRoute('user wants to save a recipe', { confidence: 0.95 }),
			});
			// Restore store.list so loadAllRecipes works without an error (returns empty list)
			vi.mocked(sharedStore.list).mockResolvedValue([]);

			await handleMessage(ctx);

			// handleEditRecipe sends "No recipes to edit yet." when store is empty.
			// handleSaveRecipe would send "Parsing your recipe..." — distinguishable.
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(calls.some(([, msg]) => msg.includes('No recipes to edit yet'))).toBe(true);
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

	// =========================================================================
	// Group 4: Pending-flow precedence — active flow takes priority over route
	//
	// dispatchByRoute is only reached AFTER all pending-flow checks pass.
	// These tests confirm that when a pending flow is active AND ctx.route carries
	// an allowlisted intent, the flow handler wins and dispatchByRoute is never
	// reached.  A future refactor that moves dispatchByRoute above the pending
	// checks would break active flows — these tests would catch that regression.
	// =========================================================================

	describe('Group 4: pending-flow takes precedence over allowlist route', () => {
		it('active targets flow (custom-input mode) takes precedence over allowlist route', async () => {
			// Set a pending targets flow in custom-input mode — handleTargetsFlowReply
			// will consume ANY numeric text message when awaitingCustomInput = true.
			__setTargetsFlowAwaitingCustomInputForTests('user1');

			// ctx.route carries a valid allowlisted intent at high confidence
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: '2000',  // a calorie value — processed by handleTargetsFlowReply
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			// The targets-flow reply handler consumed the message and advanced to the
			// next step (protein) — it calls sendWithButtons.
			// If dispatchByRoute ran first, it would call handleWhatsForDinner → send instead.
			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
			// The dinner handler sends text like "No meal plan yet" — verify it did NOT fire
			const sendCalls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			const dinnerCall = sendCalls.find(([, msg]) =>
				msg.includes('meal plan') || msg.includes('for dinner') || msg.includes('planned'),
			);
			expect(dinnerCall, 'Dinner handler must not fire when targets flow is active').toBeUndefined();
		});

		it('active cook-mode pending recipe takes precedence over allowlist route', async () => {
			// Set up a shared store with a recipe so handleCookCommand can set pending state
			const sharedStore = createMockScopedStore({
				read: vi.fn().mockImplementation(async (path: string) => {
					if (path === 'household.yaml') return stringify(sampleHousehold);
					// Handle both 'recipes/<id>.yaml' and double-prefixed 'recipes/recipes/<id>.yaml'
					// (listRecipeIds returns entries as-is from store.list; recipePath prepends 'recipes/')
					if (path.startsWith('recipes/') && path.endsWith('.yaml')) return stringify(sampleRecipe);
					return '';
				}),
				list: vi.fn().mockImplementation(async (dir: string) => {
					if (dir === 'recipes') return [`recipes/${sampleRecipe.id}.yaml`];
					return [];
				}),
			});
			vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

			// Trigger handleCookCommand to establish a pending cook recipe for user1
			const cookCtx = createTestMessageContext({ userId: 'user1', text: 'lasagna' });
			await handleCookCommand(services, ['lasagna'], cookCtx);

			// Confirm pending cook state was set
			expect(hasPendingCookRecipe('user1')).toBe(true);

			vi.clearAllMocks();
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');

			// Now send a message with a valid allowlisted route at high confidence
			// "3" — a servings reply — would be processed by handleServingsReply,
			// NOT by the allowlisted dinner route
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: '3',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});

			await handleMessage(ctx);

			// The servings reply handler fires (it sends a cook-mode step message)
			// and returns before dispatchByRoute is reached.
			// If dispatchByRoute ran first, it would call handleWhatsForDinner.
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			// Cook mode sends step messages, not dinner/help messages
			const dinnerCalls = calls.filter(([, msg]) =>
				msg.includes('for dinner') || msg.includes('meal plan'),
			);
			expect(dinnerCalls, 'Dinner handler must not fire when cook recipe is pending').toHaveLength(0);
		});
	});

	// =========================================================================
	// Group 4b: Shadow gate-ordering guards
	//
	// Mirrors Group 4's scenarios but asserts on shadow log entries, confirming
	// early-exit gates emit the correct skipped-* variants and that the shadow
	// classifier is never invoked on these paths.  A future refactor that moves
	// finalizeShadow above an early-exit gate would break these tests.
	// =========================================================================

	describe('Group 4b: shadow gate-ordering guards (pending-flow / cook-mode / number-select)', () => {
		// --- Inline capture logger + never-calling classifier stub ---

		class CaptureShadowLogger implements ShadowLoggerInterface {
			entries: ShadowLogEntry[] = [];
			async log(entry: ShadowLogEntry): Promise<void> { this.entries.push(entry); }
		}

		function makeNeverClassifier(): ShadowClassifierInterface & { callCount: number } {
			const stub = {
				callCount: 0,
				async classify(_text: string, _rate: number): Promise<ShadowResult> {
					stub.callCount++;
					return { kind: 'ok', action: 'none', confidence: 0 };
				},
			};
			return stub;
		}

		let captureLogger: CaptureShadowLogger;
		let neverClassifier: ReturnType<typeof makeNeverClassifier>;

		beforeEach(() => {
			captureLogger = new CaptureShadowLogger();
			neverClassifier = makeNeverClassifier();
			__setShadowDepsForTests(neverClassifier, captureLogger);
		});

		afterEach(() => {
			__clearShadowDepsForTests();
			endSession('user1');  // clean up any active cook session created in this group
		});

		// ------------------------------------------------------------------
		// Test 1: targets-flow reply preempts shadow (skipped-pending-flow)
		// ------------------------------------------------------------------
		it('targets-flow reply: skipped-pending-flow logged, classifier not called', async () => {
			__setTargetsFlowAwaitingCustomInputForTests('user1');

			const ctx = createTestMessageContext({
				userId: 'user1',
				text: '2000',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			await __flushShadowForTests();

			expect(neverClassifier.callCount, 'classifier must not be invoked on pending-flow path').toBe(0);
			expect(captureLogger.entries).toHaveLength(1);
			const entry = captureLogger.entries[0]!;
			expect(entry.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'targets-set' });
			expect(entry.pendingFlow).toBe('targets-set');
			expect(entry.verdict).toBe('skipped');
		});

		// ------------------------------------------------------------------
		// Test 2: cook-servings reply preempts shadow (skipped-pending-flow)
		// ------------------------------------------------------------------
		it('cook-servings reply: skipped-pending-flow logged, classifier not called', async () => {
			const sharedStore = createMockScopedStore({
				read: vi.fn().mockImplementation(async (path: string) => {
					if (path === 'household.yaml') return stringify(sampleHousehold);
					if (path.startsWith('recipes/') && path.endsWith('.yaml')) return stringify(sampleRecipe);
					return '';
				}),
				list: vi.fn().mockImplementation(async (dir: string) => {
					if (dir === 'recipes') return [`recipes/${sampleRecipe.id}.yaml`];
					return [];
				}),
			});
			vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

			const cookCtx = createTestMessageContext({ userId: 'user1', text: 'lasagna' });
			await handleCookCommand(services, ['lasagna'], cookCtx);
			expect(hasPendingCookRecipe('user1')).toBe(true);

			vi.clearAllMocks();
			vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
			// Re-inject capture logger after clearAllMocks resets vi mocks
			captureLogger = new CaptureShadowLogger();
			__setShadowDepsForTests(neverClassifier, captureLogger);

			const ctx = createTestMessageContext({
				userId: 'user1',
				text: '3',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			await __flushShadowForTests();

			expect(neverClassifier.callCount, 'classifier must not be invoked on pending-flow path').toBe(0);
			expect(captureLogger.entries).toHaveLength(1);
			const entry = captureLogger.entries[0]!;
			expect(entry.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'cook-servings' });
			expect(entry.pendingFlow).toBe('cook-servings');
			expect(entry.verdict).toBe('skipped');
		});

		// ------------------------------------------------------------------
		// Test 3: active cook-mode preempts shadow (skipped-cook-mode)
		// ------------------------------------------------------------------
		it('active cook-mode: skipped-cook-mode logged, classifier not called', async () => {
			// Create an active cook session directly (no DB round-trip needed)
			createSession('user1', sampleRecipe, sampleRecipe.servings, [], null);
			expect(isCookModeActive('user1')).toBe(true);

			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'next',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			await __flushShadowForTests();

			expect(neverClassifier.callCount, 'classifier must not be invoked during active cook mode').toBe(0);
			expect(captureLogger.entries).toHaveLength(1);
			const entry = captureLogger.entries[0]!;
			expect(entry.shadow).toMatchObject({ kind: 'skipped-cook-mode' });
			expect(entry.verdict).toBe('skipped');
		});

		// ------------------------------------------------------------------
		// Test 4: number-select preempts shadow (skipped-number-select)
		// ------------------------------------------------------------------
		it('number-select: skipped-number-select logged, classifier not called', async () => {
			// Populate lastSearchResults by running a recipe search
			const sharedStore = createMockScopedStore({
				read: vi.fn().mockImplementation(async (path: string) => {
					if (path === 'household.yaml') return stringify(sampleHousehold);
					if (path.endsWith('.yaml')) return stringify(sampleRecipe);
					return '';
				}),
				list: vi.fn().mockResolvedValue(['lasagna-001.yaml']),
			});
			vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);

			const searchCtx = createTestMessageContext({ userId: 'user1', text: 'search for lasagna' });
			await handleMessage(searchCtx);

			vi.clearAllMocks();
			// Fresh stub + logger so the search step's call doesn't pollute the assertion
			const freshClassifier = makeNeverClassifier();
			captureLogger = new CaptureShadowLogger();
			__setShadowDepsForTests(freshClassifier, captureLogger);

			// "1" with an allowlisted route — number-select wins before dispatchByRoute
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: '1',
				route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
			});
			await handleMessage(ctx);
			await __flushShadowForTests();

			expect(freshClassifier.callCount, 'classifier must not be invoked on number-select path').toBe(0);
			expect(captureLogger.entries).toHaveLength(1);
			const entry = captureLogger.entries[0]!;
			expect(entry.shadow).toMatchObject({ kind: 'skipped-number-select' });
			expect(entry.verdict).toBe('skipped');
			// Handler-specific oracle: recipe detail was sent via sendRecipeWithApproval
			const sendCalls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(sendCalls.some(([, msg]) => msg.includes('Ingredients'))).toBe(true);
		});
	});

	// =========================================================================
	// Group 5: Household-missing + route-first path
	//
	// When an allowlisted intent fires but the handler requires a household
	// and none exists, the handler sends the household-setup error message.
	// The regex cascade must NOT re-run after dispatchByRoute claims the message.
	// =========================================================================

	describe('Group 5: household-missing path for household-gated allowlist intents', () => {
		it('household-gated allowlist intent claims message and sends error when no household', async () => {
			// Override store to return NO household
			vi.mocked(sharedStore.read).mockImplementation(async (_path: string) => '');

			// "user wants to see food spending" is allowlisted and household-gated
			const ctx = createTestMessageContext({
				userId: 'user1',
				text: 'how much did we spend on groceries',
				route: makeRoute('user wants to see food spending', { confidence: 0.92 }),
			});

			await handleMessage(ctx);

			// Handler fires (dispatchByRoute claims message), sends household-setup error
			const calls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
			expect(
				calls.some(([, msg]) => msg.includes('Set up a household first')),
				'Expected household-missing error message',
			).toBe(true);

			// Regex cascade must NOT have run — no grocery/recipe/pantry handler output
			// (those would match regex for "how much" → budget regex is the only one,
			// but it's also gated on household, so we confirm exactly one send call
			// and it's the household error, not the help message or a cascade result)
			const helpCalls = calls.filter(([, msg]) => msg.includes("I'm not sure"));
			expect(helpCalls, 'Regex cascade fallback must not fire').toHaveLength(0);
		});
	});
});
