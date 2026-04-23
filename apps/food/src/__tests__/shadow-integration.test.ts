/**
 * Shadow-classifier integration tests — LLM Enhancement #2 Chunk C (B.3).
 *
 * Layer 2: end-to-end through handleMessage with a real regex cascade.
 * Layer 4: one persona-driven unmapped-label case.
 *
 * The shadow classifier stub is injected via __setShadowDepsForTests so
 * handler-path LLM calls (pantry-store, grocery-dedup) never collide with the
 * shadow stub.  __flushShadowForTests() drains fire-and-forget before assertions.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { RouteInfo, ScopedDataStore } from '@pas/core/types';

import { handleMessage, init } from '../index.js';
import {
    __setShadowDepsForTests,
    __clearShadowDepsForTests,
    __flushShadowForTests,
    type ShadowClassifierInterface,
    type ShadowLoggerInterface,
} from '../routing/shadow-integration.js';
import type { ShadowLogEntry, ShadowResult } from '../routing/shadow-logger.js';
import { FoodShadowLogger } from '../routing/shadow-logger.js';
import { INTENTIONALLY_UNMAPPED_LABELS } from '../routing/shadow-taxonomy.js';
import type { Household } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleHousehold: Household = {
    id: 'hh-shadow-test',
    name: 'Shadow Test Family',
    createdBy: 'user1',
    members: ['user1'],
    joinCode: 'SHADOW1',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const GROCERY_VIEW_LABEL = 'user wants to see or modify the grocery list';
const PANTRY_LABEL = 'user wants to check or update the pantry';
const HELP_MSG = "I'm not sure what you'd like to do";

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

// ---------------------------------------------------------------------------
// Capture logger — in-memory test double
// ---------------------------------------------------------------------------

class CaptureLogger implements ShadowLoggerInterface {
    entries: ShadowLogEntry[] = [];
    shouldThrow = false;

    async log(entry: ShadowLogEntry): Promise<void> {
        if (this.shouldThrow) throw new Error('capture logger forced failure');
        this.entries.push(entry);
    }
}

// ---------------------------------------------------------------------------
// Stub classifier factory
// ---------------------------------------------------------------------------

function makeStubClassifier(result: ShadowResult): ShadowClassifierInterface & { callCount: number } {
    const stub = {
        callCount: 0,
        async classify(_text: string, _sampleRate: number): Promise<ShadowResult> {
            stub.callCount++;
            return result;
        },
    };
    return stub;
}

function makeThrowingClassifier(): ShadowClassifierInterface & { callCount: number } {
    const stub = {
        callCount: 0,
        async classify(_text: string, _sampleRate: number): Promise<ShadowResult> {
            stub.callCount++;
            throw new Error('stub classifier network error');
        },
    };
    return stub;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('Shadow classifier integration (Chunk C)', () => {
    let services: ReturnType<typeof createMockCoreServices>;
    let store: ScopedDataStore;
    let captureLogger: CaptureLogger;

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
        // shadow_sample_rate = 1 by default
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 1 as never;
            return undefined as never;
        });

        await init(services);
        // init wires real shadow deps — replace with test doubles
        captureLogger = new CaptureLogger();
    });

    afterEach(() => {
        __clearShadowDepsForTests();
    });

    // =========================================================================
    // Test 1 — Regex + shadow agree
    // =========================================================================

    it('agree: grocery_view regex fires and shadow agrees', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.95 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx);
        await __flushShadowForTests();

        // Handler-specific oracle: grocery view sends telegram (not help message)
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => !msg.startsWith(HELP_MSG)), 'grocery view handler must fire').toBe(true);

        // Shadow log
        expect(captureLogger.entries).toHaveLength(1);
        const entry = captureLogger.entries[0]!;
        expect(entry.regexWinner).toBe('grocery_view');
        expect(entry.verdict).toBe('agree');
        expect(entry.userId).toBe('user1');
        expect(entry.shadow).toEqual({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.95 });
        expect(stubClassifier.callCount).toBe(1);
    });

    // =========================================================================
    // Test 2 — Regex + shadow disagree
    // =========================================================================

    it('disagree: grocery_view regex fires but shadow says pantry', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: PANTRY_LABEL, confidence: 0.7 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx);
        await __flushShadowForTests();

        // User path unchanged — grocery view still fires
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => !msg.startsWith(HELP_MSG))).toBe(true);

        expect(captureLogger.entries).toHaveLength(1);
        const entry = captureLogger.entries[0]!;
        expect(entry.verdict).toBe('disagree');
        expect(entry.regexWinner).toBe('grocery_view');
    });

    // =========================================================================
    // Test 3 — Help fallback + both-none
    // =========================================================================

    it('both-none: unrecognised text falls to help, shadow also says none', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: 'none', confidence: 0.3 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: 'zxcvbnmasdfghjkl' });
        await handleMessage(ctx);
        await __flushShadowForTests();

        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => msg.startsWith(HELP_MSG))).toBe(true);

        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.verdict).toBe('both-none');
        expect(captureLogger.entries[0]!.regexWinner).toBe('help_fallthrough');
    });

    // =========================================================================
    // Test 4 — Help fallback + one-side-none
    // =========================================================================

    it('one-side-none: unrecognised text falls to help but shadow returns real label', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.6 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: 'zxcvbnmasdfghjkl' });
        await handleMessage(ctx);
        await __flushShadowForTests();

        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.verdict).toBe('one-side-none');
    });

    // =========================================================================
    // Test 5 — data_query_fallback path
    // =========================================================================

    it('data_query_fallback: DataQuery returns result → regexWinner set correctly', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: 'none', confidence: 0.5 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        // Wire up dataQuery service to return a non-empty result
        const mockDataQuery = {
            query: vi.fn().mockResolvedValue({
                empty: false,
                files: [{ path: 'users/user1/food/recipes.md', appId: 'food', type: 'recipe', title: 'Recipes', content: 'Taco Tuesday recipe.' }],
            }),
        };
        (services as any).dataQuery = mockDataQuery;
        (services as any).interactionContext = {
            record: vi.fn(),
            getRecent: vi.fn().mockReturnValue([{ appId: 'food', action: 'view', timestamp: Date.now() }]),
        };
        // formatDataAnswer uses llm.complete
        vi.mocked(services.llm.complete).mockResolvedValue('You have 3 recipes saved.');

        // Text won't match any food regex; hasRecentFoodContext=true puts us in the dataQuery block
        const ctx = createTestMessageContext({ userId: 'user1', text: 'blorp bleep data query test xzxz' });
        await handleMessage(ctx);
        await __flushShadowForTests();

        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.regexWinner).toBe('data_query_fallback');
        // Shadow was called once (data_query_fallback is inside the regex-cascade try block)
        expect(stubClassifier.callCount).toBe(1);
    });

    // =========================================================================
    // Test 6 — Route-dispatched path (Chunk A allowlist)
    // =========================================================================

    it('legacy-skipped: Chunk A allowlist route fires → shadow classify NOT invoked', async () => {
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.9 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        // ctx.route carries an allowlisted intent at high confidence
        // Text does NOT match isWhatsForDinnerIntent so if route is ignored, help fires
        const ctx = createTestMessageContext({
            userId: 'user1',
            text: 'what is planned for tonight',
            route: makeRoute("user wants to know what's for dinner", { confidence: 0.95 }),
        });
        await handleMessage(ctx);
        await __flushShadowForTests();

        // Stub classify was NOT called — synthetic promise was used instead
        expect(stubClassifier.callCount, 'classify must not be called on Chunk A route paths').toBe(0);

        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.verdict).toBe('legacy-skipped');
        expect(captureLogger.entries[0]!.regexWinner).toBe('(route-dispatched)');
    });

    // =========================================================================
    // Test 7 — Classifier throws
    // =========================================================================

    it('error: classifier rejects → user path succeeds, warn logged, verdict is error', async () => {
        const throwingClassifier = makeThrowingClassifier();
        __setShadowDepsForTests(throwingClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx);
        await __flushShadowForTests();

        // User path unaffected
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => !msg.startsWith(HELP_MSG))).toBe(true);

        // Log entry recorded with error verdict
        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.verdict).toBe('error');

        // services.logger.warn called once for the classifier failure
        expect(vi.mocked(services.logger.warn)).toHaveBeenCalledOnce();
    });

    // =========================================================================
    // Test 8 — Logger throws
    // =========================================================================

    it('error: logger rejects → user path succeeds, warn logged', async () => {
        captureLogger.shouldThrow = true;
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.9 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx);
        await __flushShadowForTests();

        // User path unaffected
        const sends = vi.mocked(services.telegram.send).mock.calls as [string, string][];
        expect(sends.some(([, msg]) => !msg.startsWith(HELP_MSG))).toBe(true);

        // Logger failure surfaced only as a warn
        expect(vi.mocked(services.logger.warn)).toHaveBeenCalledOnce();
    });

    // =========================================================================
    // Test 9 — shadow_sample_rate = 0 disables shadow
    // The sampling decision lives inside classify(), so the stub must mirror
    // the real classifier's sampling logic to produce skipped-sample.
    // =========================================================================

    it('skipped-sample: shadow_sample_rate = 0 → verdict is skipped', async () => {
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return 0 as never;
            return undefined as never;
        });

        // Stub that mirrors real sampling: sampleRate=0 always skips
        const sampleAwareClassifier: ShadowClassifierInterface = {
            async classify(_text: string, sampleRate: number): Promise<ShadowResult> {
                if (sampleRate === 0) return { kind: 'skipped-sample' };
                return { kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.9 };
            },
        };
        __setShadowDepsForTests(sampleAwareClassifier, captureLogger);

        const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx);
        await __flushShadowForTests();

        expect(captureLogger.entries).toHaveLength(1);
        expect(captureLogger.entries[0]!.verdict).toBe('skipped');
        expect(captureLogger.entries[0]!.shadow).toEqual({ kind: 'skipped-sample' });
    });

    // =========================================================================
    // Test 10 — shadow_sample_rate live re-read
    // =========================================================================

    it('sample_rate re-read per message — rate change takes effect immediately', async () => {
        let currentRate = 1;
        vi.mocked(services.config.get).mockImplementation(async (key: string) => {
            if (key === 'shadow_sample_rate') return currentRate as never;
            return undefined as never;
        });

        // Stub that mirrors real sampling
        const sampleAwareClassifier: ShadowClassifierInterface = {
            async classify(_text: string, sampleRate: number): Promise<ShadowResult> {
                if (sampleRate === 0) return { kind: 'skipped-sample' };
                return { kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.9 };
            },
        };
        __setShadowDepsForTests(sampleAwareClassifier, captureLogger);

        // First message: rate = 1 → ok result
        const ctx1 = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx1);
        await __flushShadowForTests();
        expect(captureLogger.entries[0]!.verdict).toBe('agree');

        // Change rate to 0
        currentRate = 0;

        // Second message: rate = 0 → skipped-sample
        const ctx2 = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
        await handleMessage(ctx2);
        await __flushShadowForTests();
        expect(captureLogger.entries).toHaveLength(2);
        expect(captureLogger.entries[1]!.verdict).toBe('skipped');
        expect(captureLogger.entries[1]!.shadow).toEqual({ kind: 'skipped-sample' });
    });

    // =========================================================================
    // Test 11 — Default wiring smoke (live classifier + live logger to disk)
    // =========================================================================

    it('smoke: real FoodShadowLogger writes entry to disk', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'pas-shadow-smoke-'));
        try {
            const realLogger = new FoodShadowLogger(tempDir);
            const stubClassifier = makeStubClassifier({ kind: 'ok', action: GROCERY_VIEW_LABEL, confidence: 0.9 });
            __setShadowDepsForTests(stubClassifier, realLogger);

            const ctx = createTestMessageContext({ userId: 'user1', text: "what's on my grocery list" });
            await handleMessage(ctx);
            await __flushShadowForTests();

            const logContent = await readFile(join(tempDir, 'shadow-classifier-log.md'), 'utf-8');
            expect(logContent).toContain('grocery_view');
            expect(logContent).toContain('user1');
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    // =========================================================================
    // Test 12 — Unmapped-label persona (Layer 4)
    // =========================================================================

    it('persona — unmapped label: LLM classifies into label the regex cannot reach', async () => {
        const unmappedLabel = INTENTIONALLY_UNMAPPED_LABELS[0]!;
        const stubClassifier = makeStubClassifier({ kind: 'ok', action: unmappedLabel, confidence: 0.85 });
        __setShadowDepsForTests(stubClassifier, captureLogger);

        // Any text that doesn't match any regex → help_fallthrough → regexWinnerLabel = 'none'
        // Shadow returns an unmapped non-none label → one-side-none
        const ctx = createTestMessageContext({
            userId: 'user1',
            text: 'zxcvbnmasdfghjkl unmapped template test',
        });
        await handleMessage(ctx);
        await __flushShadowForTests();

        expect(captureLogger.entries).toHaveLength(1);
        const entry = captureLogger.entries[0]!;
        expect(entry.verdict).toBe('one-side-none');
        expect((entry.shadow as { kind: 'ok'; action: string }).action).toBe(unmappedLabel);
    });
});
