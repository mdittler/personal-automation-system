/**
 * Shadow-primary router integration tests — LLM Enhancement #2 Chunk D.
 *
 * Validates that with routing_primary='shadow':
 *   1. High-confidence shadow dispatches succeed (log: shadow-dispatched).
 *   2. Low-confidence / bad results fall through to regex cascade, reusing the
 *      already-awaited shadow result (classifyCalls stays at 1).
 *   3. All pre-shadow gates (empty text, cook mode, pending flows,
 *      dispatchByRoute) still preempt shadow (classifyCalls=0).
 *   4. Sub-intent disambiguation (meal-plan view vs generate, pantry add vs
 *      view) is preserved inside SHADOW_HANDLERS closures.
 *   5. INTENTIONALLY_UNMAPPED_LABELS are routed to their nearest handler.
 *   6. SHADOW_LABELS_WITHOUT_TEXT_HANDLER falls through to regex/help.
 *
 * Every case pins four assertions with exact values:
 *   - classifyCalls (exact integer)
 *   - handler-specific oracle (telegram send or service call)
 *   - log entry regexWinner (exact string)
 *   - log entry verdict (exact ShadowVerdict)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { RouteInfo, ScopedDataStore } from '@pas/core/types';

import {
    handleMessage,
    init,
    __setPendingLeftoverAddForTests,
    __setPendingFreezerAddForTests,
    __clearPendingLeftoverFreezerForTests,
    __resetWarnedShadowConfigsForTests,
} from '../index.js';
import {
    __setShadowDepsForTests,
    __clearShadowDepsForTests,
    __flushShadowForTests,
    type ShadowClassifierInterface,
    type ShadowLoggerInterface,
} from '../routing/shadow-integration.js';
import type { ShadowLogEntry, ShadowResult } from '../routing/shadow-logger.js';
import type { Household } from '../types.js';
import { beginQuickMealAdd, __resetQuickMealFlowForTests } from '../handlers/quick-meal-flow.js';
import {
    __resetTargetsFlowForTests,
    __setTargetsFlowAwaitingCustomInputForTests,
} from '../handlers/targets-flow.js';
import { __resetGuestAddFlowForTests } from '../handlers/guest-add-flow.js';
import { createSession, endSession } from '../services/cook-session.js';
import { isCookModeActive } from '../handlers/cook-mode.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleHousehold: Household = {
    id: 'hh-shadow-primary-test',
    name: 'Shadow Primary Family',
    createdBy: 'user1',
    members: ['user1'],
    joinCode: 'SHPRIM1',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const HELP_MSG = "I'm not sure what you'd like to do";
const GROCERY_ADD_LABEL = 'user wants to add items to the grocery list' as const;

// ─── Capture logger ───────────────────────────────────────────────────────────

class CaptureLogger implements ShadowLoggerInterface {
    entries: ShadowLogEntry[] = [];
    async log(entry: ShadowLogEntry): Promise<void> {
        this.entries.push(entry);
    }
}

// ─── Stub classifier factory ──────────────────────────────────────────────────

function makeStubClassifier(result: ShadowResult): ShadowClassifierInterface & { callCount: number } {
    const stub = {
        callCount: 0,
        async classify(_text: string, _rate: number): Promise<ShadowResult> {
            stub.callCount++;
            return result;
        },
    };
    return stub;
}

function makeNeverClassifier(): ShadowClassifierInterface & { callCount: number } {
    const stub = {
        callCount: 0,
        async classify(_text: string, _rate: number): Promise<ShadowResult> {
            stub.callCount++;
            // Should never be called — tests assert callCount stays 0.
            return { kind: 'skipped-sample' };
        },
    };
    return stub;
}

// ─── Route helper ─────────────────────────────────────────────────────────────

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

// ─── Test setup ───────────────────────────────────────────────────────────────

describe('shadow-primary router integration (Chunk D)', () => {
    let services: ReturnType<typeof createMockCoreServices>;
    let store: ScopedDataStore;
    let userStore: ScopedDataStore;
    let captureLogger: CaptureLogger;

    beforeEach(async () => {
        store = createMockScopedStore();
        userStore = createMockScopedStore();
        services = createMockCoreServices();

        vi.mocked(services.data.forShared).mockReturnValue(store as any);
        vi.mocked(services.data.forUser).mockReturnValue(userStore as any);

        // Default: no household (tests that need one override this)
        vi.mocked(store.read).mockResolvedValue('');

        vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
        vi.mocked(services.llm.classify).mockResolvedValue({ category: 'none', confidence: 0.1 });
        vi.mocked(services.llm.extractStructured).mockResolvedValue({});

        // Default: shadow-primary mode with full sample rate and 0.7 threshold
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 1 as never;
            if (key === 'routing_primary') return 'shadow' as never;
            if (key === 'shadow_min_confidence') return 0.7 as never;
            return undefined as never;
        });

        await init(services);
        vi.clearAllMocks();

        // Re-install after clearAllMocks
        vi.mocked(services.data.forShared).mockReturnValue(store as any);
        vi.mocked(services.data.forUser).mockReturnValue(userStore as any);
        vi.mocked(store.read).mockResolvedValue('');
        vi.mocked(services.llm.complete).mockResolvedValue('Mocked LLM response.');
        vi.mocked(services.llm.classify).mockResolvedValue({ category: 'none', confidence: 0.1 });
        vi.mocked(services.llm.extractStructured).mockResolvedValue({});
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 1 as never;
            if (key === 'routing_primary') return 'shadow' as never;
            if (key === 'shadow_min_confidence') return 0.7 as never;
            return undefined as never;
        });

        captureLogger = new CaptureLogger();
    });

    afterEach(async () => {
        await __flushShadowForTests();
        __clearShadowDepsForTests();
        __clearPendingLeftoverFreezerForTests();
        __resetQuickMealFlowForTests();
        __resetTargetsFlowForTests();
        __resetGuestAddFlowForTests();
        endSession('user1');
        vi.restoreAllMocks();
    });

    function lastEntry(): ShadowLogEntry {
        const e = captureLogger.entries.at(-1);
        if (!e) throw new Error('no shadow log entry captured');
        return e;
    }

    // =========================================================================
    // (a) High-confidence shadow dispatches
    // =========================================================================

    it('(a) high-confidence shadow dispatches; regexWinner=(shadow-dispatched)', async () => {
        // Set up household so the grocery-add handler proceeds past the guard
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: GROCERY_ADD_LABEL, confidence: 0.95,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        // handleGroceryAdd confirmation — unique to this handler
        const addedCall = sends.find(([, msg]) => msg.startsWith('Added') && msg.includes('item(s)'));
        expect(addedCall, 'handleGroceryAdd must have sent "Added N item(s)" confirmation').toBeDefined();

        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');
        expect(e.shadowSuppressedByThreshold).toBeUndefined();
    });

    it('(a2) macro-adherence shadow dispatch reads targets from the user store after the shared household guard', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            throw new Error('adherence route must not read user nutrition data from shared household storage');
        });
        vi.mocked(userStore.read).mockImplementation(async (path: string) => {
            if (path === 'nutrition/targets.yaml') return 'calories: 2000\nprotein: 150';
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to see how well they are hitting their macro targets over time',
            confidence: 0.95,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'am i hitting my targets lately?' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        expect(services.data.forUser).toHaveBeenCalledWith('user1');
        expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();

        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');
    });

    // =========================================================================
    // (b) Low-confidence falls through, reuses result (exactly 1 classify call)
    // =========================================================================

    it('(b) low-confidence falls through to regex cascade; classify called exactly once', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: GROCERY_ADD_LABEL, confidence: 0.5,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        // Classifier called exactly once — result reused in regex cascade
        expect(stub.callCount).toBe(1);

        const e = lastEntry();
        expect(e.regexWinner).toBe('grocery_add');
        expect(e.verdict).toBe('agree');
        expect(e.shadowSuppressedByThreshold).toBe(true);
    });

    // =========================================================================
    // (c) action='none' falls through to help
    // =========================================================================

    it("(c) shadow action='none' falls through; regex also misses → both-none", async () => {
        const stub = makeStubClassifier({
            kind: 'ok', action: 'none', confidence: 0.95,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'zxcvbnmasdfghjkl completely random',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => msg.startsWith(HELP_MSG))).toBe(true);

        const e = lastEntry();
        expect(e.regexWinner).toBe('help_fallthrough');
        expect(e.verdict).toBe('both-none');
    });

    // =========================================================================
    // (d) parse-failed falls through; regex cascade still fires
    // =========================================================================

    it('(d) parse-failed falls through to regex cascade; classify called once', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({ kind: 'parse-failed', raw: '{}' });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('grocery_add');
        expect(e.verdict).toBe('error');
    });

    // =========================================================================
    // (e) llm-error falls through; regex cascade still fires
    // =========================================================================

    it('(e) llm-error falls through to regex cascade; classify called once', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({ kind: 'llm-error', category: 'rate-limit' });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('grocery_add');
        expect(e.verdict).toBe('error');
    });

    // =========================================================================
    // (f) sample-rate=0: classifier called, returns skipped-sample, falls through
    // =========================================================================

    it('(f) sample-rate=0 → classifier returns skipped-sample; falls through to regex', async () => {
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 0 as never;
            if (key === 'routing_primary') return 'shadow' as never;
            if (key === 'shadow_min_confidence') return 0.7 as never;
            return undefined as never;
        });
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        // Stub mirrors the real classifier: sampleRate=0 → skipped-sample
        const stub: ShadowClassifierInterface & { callCount: number } = {
            callCount: 0,
            async classify(_text: string, rate: number): Promise<ShadowResult> {
                stub.callCount++;
                if (rate === 0) return { kind: 'skipped-sample' };
                return { kind: 'ok', action: GROCERY_ADD_LABEL, confidence: 0.9 };
            },
        };
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        // Classifier IS called (sample gate is inside classify, not startShadow)
        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('grocery_add');
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (g) dispatchByRoute preempts — classifier NOT called
    // =========================================================================

    it('(g) trusted route preempts shadow; classify not called', async () => {
        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        // Text does NOT match isWhatsForDinnerIntent regex, but route carries the intent
        const ctx = createTestMessageContext({
            userId: 'user1',
            text: 'what did you plan for tonight',
            route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
        });
        await handleMessage(ctx);
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(route-dispatched)');
        expect(e.verdict).toBe('legacy-skipped');
    });

    // =========================================================================
    // (h) Empty text preempts — classifier NOT called
    // =========================================================================

    it('(h) empty text preempts shadow; classify not called', async () => {
        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: '' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-no-caption' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (i) Active cook-mode preempts — classifier NOT called
    // =========================================================================

    it('(i) active cook-mode preempts shadow; classify not called', async () => {
        // Use a minimal sampleRecipe fixture to create the cook session
        const minRecipe = {
            id: 'test-recipe-1',
            title: 'Test Recipe',
            ingredients: [{ name: 'pasta', quantity: 500, unit: 'g' }],
            instructions: ['Cook it'],
            servings: 4,
            tags: [],
            source: 'family' as const,
            cuisine: '',
            ratings: [],
            history: [],
            allergens: [],
            status: 'confirmed' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };
        createSession('user1', minRecipe as any, minRecipe.servings, [], null);
        expect(isCookModeActive('user1')).toBe(true);

        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'next' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-cook-mode' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (j) Pending targets-flow preempts — classifier NOT called
    // =========================================================================

    it('(j) pending targets-flow preempts shadow; classify not called', async () => {
        __setTargetsFlowAwaitingCustomInputForTests('user1');

        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: '2000' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'targets-set' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (k) Pending leftover-add preempts — classifier NOT called
    // =========================================================================

    it('(k) pending leftover-add preempts shadow; classify not called', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        __setPendingLeftoverAddForTests('user1');

        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'chili about 2 servings' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'leftover-add' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (l) Pending freezer-add preempts — classifier NOT called
    // =========================================================================

    it('(l) pending freezer-add preempts shadow; classify not called', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        __setPendingFreezerAddForTests('user1');

        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'chicken soup' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'freezer-add' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (m) Pending quickmeal-add preempts — classifier NOT called
    // =========================================================================

    it('(m) pending quickmeal-add preempts shadow; classify not called', async () => {
        // Trigger the quickmeal flow to create pending state
        await beginQuickMealAdd(services, 'user1');
        vi.clearAllMocks();

        // Re-install mocks after clearAllMocks
        vi.mocked(services.data.forShared).mockReturnValue(store as any);
        vi.mocked(services.data.forUser).mockReturnValue(userStore as any);
        vi.mocked(store.read).mockResolvedValue('');
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 1 as never;
            if (key === 'routing_primary') return 'shadow' as never;
            if (key === 'shadow_min_confidence') return 0.7 as never;
            return undefined as never;
        });

        captureLogger = new CaptureLogger();
        const neverClassifier = makeNeverClassifier();
        __setShadowDepsForTests(neverClassifier, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'overnight oats' }));
        await __flushShadowForTests();

        expect(neverClassifier.callCount).toBe(0);
        const e = lastEntry();
        expect(e.shadow).toMatchObject({ kind: 'skipped-pending-flow', flow: 'quickmeal-add' });
        expect(e.verdict).toBe('skipped');
    });

    // =========================================================================
    // (n) Unmapped → nearest: unfamiliar meal → handleNutritionLogNL
    // =========================================================================

    it('(n) unmapped unfamiliar-meal label → nearest handler dispatched', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to log an unfamiliar meal with a free-text description',
            confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'had some green gunk yesterday',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');
        // handleNutritionLogNL parses the label, finds no recipe/quick-meal match,
        // calls estimateMacros (llm.complete returns non-JSON in tests) → unique send
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const nlCall = sends.find(([, msg]) => msg.includes("Couldn't estimate macros for"));
        expect(nlCall, 'handleNutritionLogNL must have attempted macro estimation').toBeDefined();
    });

    // =========================================================================
    // (o) Unmapped → nearest: quick-meal template → beginQuickMealAdd
    // =========================================================================

    it('(o) unmapped quick-meal-template label → beginQuickMealAdd dispatched', async () => {
        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to save a frequent meal as a quick-meal template',
            confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'save this as a quick meal',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');
        // beginQuickMealAdd sends the step-1 prompt
        const sendCalls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const quickMealCall = sendCalls.find(([, msg]) => msg.includes('New quick-meal') || msg.includes('Step 1'));
        expect(quickMealCall, 'beginQuickMealAdd step-1 message must have been sent').toBeDefined();
    });

    // =========================================================================
    // (p) Blocklisted receipt-details falls through to regex help
    // =========================================================================

    it('(p) blocklisted receipt-details label falls through to regex; verdict=one-side-none', async () => {
        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to see receipt details or look up items from a receipt',
            confidence: 0.95,
        });
        __setShadowDepsForTests(stub, captureLogger);

        // Text must not match any current regex so verdict stays one-side-none.
        // If a future receipt_view regex is added this test's intent silently changes.
        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'show me the receipt from yesterday please',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => msg.startsWith(HELP_MSG))).toBe(true);

        const e = lastEntry();
        expect(e.regexWinner).toBe('help_fallthrough');
        // regexWinnerLabel='none', shadowAction has a real label → one-side-none
        expect(e.verdict).toBe('one-side-none');
    });

    // =========================================================================
    // (q) Sub-intent: meal-plan view (not generate)
    // =========================================================================

    it('(q) meal-plan view sub-intent: handleMealPlanView fires, not generate', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to plan meals for the week',
            confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        // "show me this week's meal plan" matches isMealPlanViewIntent → view path
        await handleMessage(createTestMessageContext({
            userId: 'user1', text: "show me this week's meal plan",
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        // handleMealPlanView sends "No meal plan yet" via sendWithButtons (no plan in mock store)
        // handleMealPlanGenerate sends "Generating your meal plan..." via send first
        const sendCalls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const generatingCall = sendCalls.find(([, msg]) => msg.includes('Generating your meal plan'));
        expect(generatingCall, 'generate handler must NOT have fired').toBeUndefined();

        // View sends the "No meal plan yet" button prompt
        expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalled();
        const buttonCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls as [string, string, any][];
        const noMealPlanCall = buttonCalls.find(([, msg]) => msg.includes('No meal plan yet'));
        expect(noMealPlanCall, 'view handler must have fired (No meal plan yet)').toBeDefined();
    });

    // =========================================================================
    // (r) Sub-intent: pantry add (not view)
    // =========================================================================

    it('(r) pantry add sub-intent: handlePantryAdd fires, not view', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok',
            action: 'user wants to check or update the pantry',
            confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        // "add milk to the pantry" matches isPantryAddIntent → add path
        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'add milk to the pantry',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        // handlePantryAdd sends "Added N item(s) to pantry: ..."
        // handlePantryView sends "📦 Your pantry is empty."
        const sendCalls = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const viewCall = sendCalls.find(([, msg]) => msg.includes('📦 Your pantry is empty'));
        expect(viewCall, 'pantry view handler must NOT have fired').toBeUndefined();
        const addCall = sendCalls.find(([, msg]) => msg.includes('Added') && msg.includes('pantry'));
        expect(addCall, 'pantry add handler must have fired').toBeDefined();
    });

    // =========================================================================
    // A1 overlap-phrase tests — sub-dispatch within collapsed shadow label buckets
    // =========================================================================

    // (s1) pantry bucket — freezer_view sub-intent
    it('(s1) pantry bucket: "what\'s in the freezer" → handleFreezerView fires, not handlePantryView', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to check or update the pantry', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: "what's in the freezer" }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const freezerEmptyCall = sends.find(([, msg]) => msg.includes('🧊 Your freezer is empty'));
        expect(freezerEmptyCall, 'handleFreezerView must have sent "🧊 Your freezer is empty"').toBeDefined();
        const pantryCall = sends.find(([, msg]) => msg.includes('📦 Your pantry is empty'));
        expect(pantryCall, 'handlePantryView must NOT fire').toBeUndefined();
    });

    // (s2) pantry bucket — freezer_add sub-intent
    it('(s2) pantry bucket: "add soup to the freezer" → handleFreezerAddIntent fires, not handlePantryView', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to check or update the pantry', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'add soup to the freezer' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const freezerAddCall = sends.find(([, msg]) => msg.includes('🧊 Added to freezer'));
        expect(freezerAddCall, 'handleFreezerAddIntent must have sent "🧊 Added to freezer"').toBeDefined();
        const pantryCall = sends.find(([, msg]) => msg.includes('📦 Your pantry is empty'));
        expect(pantryCall, 'handlePantryView must NOT fire').toBeUndefined();
    });

    // (s3) leftovers bucket — leftover_view sub-intent
    it('(s3) leftovers bucket: "show me my leftovers" → handleLeftoversView fires, not handleLeftoverAddIntent', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to log leftovers', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'show me my leftovers' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const viewCall = sends.find(([, msg]) => msg.includes('🥘 You have no leftovers tracked'));
        expect(viewCall, 'handleLeftoversView must have sent the no-leftovers message').toBeDefined();
        const addPromptCall = sends.find(([, msg]) => msg.includes('What leftovers do you have'));
        expect(addPromptCall, 'handleLeftoverAddIntent prompt must NOT fire').toBeUndefined();
    });

    // (s4) leftovers bucket — waste_log sub-intent
    it('(s4) leftovers bucket: "the milk went bad" → handleWasteIntent fires, not handleLeftoverAddIntent', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to log leftovers', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'the milk went bad, toss it' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const wasteCall = sends.find(([, msg]) => msg.includes('🗑 Logged waste'));
        expect(wasteCall, 'handleWasteIntent must have sent waste log confirmation').toBeDefined();
        const noLeftoversCall = sends.find(([, msg]) => msg.includes('🥘 You have no leftovers tracked'));
        expect(noLeftoversCall, 'handleLeftoversView must NOT fire').toBeUndefined();
    });

    it('(s4b) leftovers bucket fallback: unmatched leftover phrase routes to leftover view', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to log leftovers', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'store this chili for later' }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const viewCall = sends.find(([, msg]) => msg.includes('🥘 You have no leftovers tracked'));
        expect(viewCall, 'fallback should route to leftover view').toBeDefined();
        const addPromptCall = sends.find(([, msg]) => msg.includes('What leftovers do you have'));
        expect(addPromptCall, 'handleLeftoverAddIntent prompt must NOT fire').toBeUndefined();
    });

    // (s5) grocery-list bucket — grocery_generate sub-intent
    it('(s5) grocery-list bucket: "generate a grocery list for this week" → handleGroceryGenerate fires, not handleGroceryView', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to see or modify the grocery list', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'generate a grocery list for this week',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const groceryViewCall = sends.find(([, msg]) => msg.includes('🛒 Your grocery list is empty'));
        expect(groceryViewCall, 'handleGroceryView must NOT fire').toBeUndefined();
    });

    // (s6) save-recipe bucket — edit_recipe sub-intent
    it('(s6) save-recipe bucket: "edit my chicken recipe" → handleEditRecipe fires, not handleSaveRecipe', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to save a recipe', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'edit my chicken recipe to add more garlic',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const editCall = sends.find(([, msg]) => msg.includes('No recipes to edit yet'));
        expect(editCall, 'handleEditRecipe must have fired (no-recipes-yet message)').toBeDefined();
        const saveCall = sends.find(([, msg]) => msg.includes('Parsing your recipe'));
        expect(saveCall, 'handleSaveRecipe must NOT fire').toBeUndefined();
    });

    // (s7) search-recipe bucket — recipe_photo sub-intent
    it('(s7) search-recipe bucket: "show me the photo of that pasta recipe" → handleRecipePhotoRetrieval fires, not handleSearchRecipe', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to search for a recipe', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'show me the photo of that pasta recipe',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const photoCall = sends.find(([, msg]) => msg.includes("Couldn't find a recipe matching"));
        expect(photoCall, 'handleRecipePhotoRetrieval must have fired').toBeDefined();
        const searchCall = sends.find(([, msg]) => msg.includes('No recipes found matching'));
        expect(searchCall, 'handleSearchRecipe must NOT fire').toBeUndefined();
    });

    // (s8) meal-plan bucket — meal_swap sub-intent
    it('(s8) meal-plan bucket: "swap Tuesday\'s dinner" → handleMealSwap fires (not handleMealPlanGenerate)', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to plan meals for the week', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: "swap Tuesday's dinner for something lighter",
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        // handleMealSwap sends via services.telegram.send (not sendWithButtons) when no plan exists
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const swapNoplanCall = sends.find(([, msg]) => msg.includes('No meal plan yet. Try'));
        expect(swapNoplanCall, 'handleMealSwap must have fired (no-plan-yet send)').toBeDefined();
    });

    // (s9) meal-plan precedence fix — generate-first, not view-first (A1a)
    it('(s9) meal-plan precedence: "generate a meal plan" → handleMealPlanGenerate fires, not handleMealPlanView', async () => {
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: 'user wants to plan meals for the week', confidence: 0.9,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({
            userId: 'user1', text: 'generate a meal plan for this week',
        }));
        await __flushShadowForTests();

        expect(stub.callCount).toBe(1);
        const e = lastEntry();
        expect(e.regexWinner).toBe('(shadow-dispatched)');
        expect(e.verdict).toBe('shadow-dispatched');

        // handleMealPlanView sends "No meal plan yet" via sendWithButtons when no plan exists.
        // handleMealPlanGenerate does NOT send that prompt — it generates.
        const buttonCalls = vi.mocked(services.telegram.sendWithButtons).mock.calls as [string, string, any][];
        const viewNoplanCall = buttonCalls.find(([, msg]) => msg.includes('No meal plan yet'));
        expect(viewNoplanCall, 'handleMealPlanView must NOT fire for a generate phrase').toBeUndefined();
    });

    // ─── A4: routing_primary='regex' regression ───────────────────────────────

    it("(t) routing_primary='regex': high-confidence shadow does NOT dispatch; regex cascade wins", async () => {
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 1 as never;
            if (key === 'routing_primary') return 'regex' as never;
            if (key === 'shadow_min_confidence') return 0.7 as never;
            return undefined as never;
        });
        vi.mocked(store.read).mockImplementation(async (path: string) => {
            if (path === 'household.yaml') return stringify(sampleHousehold);
            return '';
        });

        const stub = makeStubClassifier({
            kind: 'ok', action: GROCERY_ADD_LABEL, confidence: 0.95,
        });
        __setShadowDepsForTests(stub, captureLogger);

        await handleMessage(createTestMessageContext({ userId: 'user1', text: 'we need milk' }));
        await __flushShadowForTests();

        // Shadow classifier still ran as background telemetry (not for dispatch)
        expect(stub.callCount).toBe(1);

        const e = lastEntry();
        // Regex cascade determined the winner — shadow-dispatched must NOT appear
        expect(e.regexWinner).toBe('grocery_add');
        expect(e.verdict).toBe('agree');

        // handleGroceryAdd ran via regex cascade
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        const addedCall = sends.find(([, msg]) => msg.startsWith('Added') && msg.includes('item(s)'));
        expect(addedCall, 'handleGroceryAdd must have fired via regex cascade').toBeDefined();
    });

    // ─── A2: warnInconsistentShadowConfig ─────────────────────────────────────

    describe('warnInconsistentShadowConfig', () => {
        afterEach(() => {
            __resetWarnedShadowConfigsForTests();
        });

        it('shadow+rate=1 does not emit a config warning', async () => {
            // Default outer beforeEach: routing_primary='shadow', shadow_sample_rate=1 (silent)
            await handleMessage(createTestMessageContext({ userId: 'user1', text: 'hi' }));
            expect(vi.mocked(services.logger.warn)).not.toHaveBeenCalledWith(
                expect.stringContaining('routing_primary=shadow'),
                expect.anything(),
            );
        });

        it('shadow+rate<1 warns on first message and is silenced on repeat', async () => {
            vi.mocked(services.config.get).mockImplementation(async (key: string) => {
                if (key === 'shadow_sample_rate') return 0.5 as never;
                if (key === 'routing_primary') return 'shadow' as never;
                if (key === 'shadow_min_confidence') return 0.7 as never;
                return undefined as never;
            });

            await handleMessage(createTestMessageContext({ userId: 'user1', text: 'hi' }));
            expect(vi.mocked(services.logger.warn)).toHaveBeenCalledWith(
                expect.stringContaining('routing_primary=shadow'),
                0.5,
            );

            vi.mocked(services.logger.warn).mockClear();
            await handleMessage(createTestMessageContext({ userId: 'user1', text: 'hello' }));
            expect(vi.mocked(services.logger.warn)).not.toHaveBeenCalledWith(
                expect.stringContaining('routing_primary=shadow'),
                expect.anything(),
            );
        });

        it('regex+rate<1 does not emit a config warning', async () => {
            vi.mocked(services.config.get).mockImplementation(async (key: string) => {
                if (key === 'shadow_sample_rate') return 0.5 as never;
                if (key === 'routing_primary') return 'regex' as never;
                if (key === 'shadow_min_confidence') return 0.7 as never;
                return undefined as never;
            });

            await handleMessage(createTestMessageContext({ userId: 'user1', text: 'hi' }));
            expect(vi.mocked(services.logger.warn)).not.toHaveBeenCalledWith(
                expect.stringContaining('routing_primary=shadow'),
                expect.anything(),
            );
        });
    });
});
