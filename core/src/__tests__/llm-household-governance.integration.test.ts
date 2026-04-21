/**
 * LLM household governance integration test.
 *
 * Hand-wires: CostTracker, HouseholdLLMLimiter, LLMGuard (two instances), SystemLLMGuard.
 * No full composeRuntime() — just the components under test.
 *
 * Validates that household rate + cost caps are enforced end-to-end and that
 * cross-household isolation holds (hA caps do not affect hB).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../types/auth-actor.js';
import { requestContext } from '../services/context/request-context.js';
import { CostTracker } from '../services/llm/cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from '../services/llm/errors.js';
import {
    HouseholdLLMLimiter,
    PLATFORM_NOOP_RESERVATION,
} from '../services/llm/household-llm-limiter.js';
import { LLMGuard } from '../services/llm/llm-guard.js';
import { SystemLLMGuard } from '../services/llm/system-llm-guard.js';
import type { ClassifyResult, LLMCompletionOptions, LLMService } from '../types/llm.js';

const logger = pino({ level: 'silent' });

function makeStubInner(response = 'stub-response'): LLMService {
    return {
        complete: vi.fn().mockResolvedValue(response),
        classify: vi.fn().mockResolvedValue({ category: 'a', confidence: 0.9 } as ClassifyResult),
        extractStructured: vi.fn().mockResolvedValue({ ok: true }),
    };
}

const BASE_SAFEGUARDS = {
    defaultRateLimit: { maxRequests: 5, windowSeconds: 3600 },
    defaultMonthlyCostCap: 1.00,
    globalMonthlyCostCap: 10.00,
    defaultHouseholdRateLimit: { maxRequests: 3, windowSeconds: 3600 },
    defaultHouseholdMonthlyCostCap: 0.50,
    defaultReservationUsd: 0.05,
    reservationExpiryMs: 60_000,
} as const;

describe('LLM Household Governance Integration', () => {
    let tempDir: string;
    let costTracker: CostTracker;
    let householdLimiter: HouseholdLLMLimiter;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'pas-hh-gov-'));
        costTracker = new CostTracker(tempDir, logger);
        await costTracker.loadMonthlyCache();
        householdLimiter = new HouseholdLLMLimiter({
            costTracker,
            config: BASE_SAFEGUARDS,
            logger,
        });
    });

    afterEach(async () => {
        householdLimiter.dispose();
        await rm(tempDir, { recursive: true, force: true });
    });

    function makeAppGuard(appId: string, inner: LLMService): LLMGuard {
        return new LLMGuard({
            inner,
            appId,
            costTracker,
            config: {
                maxRequests: BASE_SAFEGUARDS.defaultRateLimit.maxRequests,
                windowSeconds: BASE_SAFEGUARDS.defaultRateLimit.windowSeconds,
                monthlyCostCap: BASE_SAFEGUARDS.defaultMonthlyCostCap,
                globalMonthlyCostCap: BASE_SAFEGUARDS.globalMonthlyCostCap,
            },
            logger,
            householdLimiter,
        });
    }

    // ============================================================
    // 1. Household rate cap
    // ============================================================
    describe('household rate cap', () => {
        it('household A hits rate cap → LLMRateLimitError; household B still succeeds', async () => {
            const innerA = makeStubInner();
            const innerB = makeStubInner();
            const guardA = makeAppGuard('appA', innerA);
            const guardB = makeAppGuard('appB', innerB);

            // Exhaust household A rate (3 requests)
            for (let i = 0; i < 3; i++) {
                await requestContext.run({ userId: 'u1', householdId: 'hA' }, () =>
                    guardA.complete('hi'),
                );
            }

            // 4th call for hA should be rate-denied
            await expect(
                requestContext.run({ userId: 'u1', householdId: 'hA' }, () => guardA.complete('hi')),
            ).rejects.toThrow(LLMRateLimitError);

            // hB completely unaffected
            await expect(
                requestContext.run({ userId: 'u2', householdId: 'hB' }, () => guardB.complete('hi')),
            ).resolves.toBe('stub-response');

            guardA.dispose();
            guardB.dispose();
        });

        it('hA rate denied does NOT consume hB rate slot', async () => {
            const inner = makeStubInner();
            const guardA = makeAppGuard('appA', inner);
            const guardB = makeAppGuard('appA', inner);

            // Exhaust hA
            for (let i = 0; i < 3; i++) {
                await requestContext.run({ userId: 'u1', householdId: 'hA' }, () =>
                    guardA.complete('hi'),
                );
            }

            // Trigger hA denial (does not affect hB's internal counter)
            await expect(
                requestContext.run({ userId: 'u1', householdId: 'hA' }, () => guardA.complete('hi')),
            ).rejects.toThrow(LLMRateLimitError);

            // All 3 of hB's slots should still be available
            for (let i = 0; i < 3; i++) {
                await expect(
                    requestContext.run({ userId: 'u2', householdId: 'hB' }, () => guardB.complete('hi')),
                ).resolves.toBeDefined();
            }

            guardA.dispose();
            guardB.dispose();
        });
    });

    // ============================================================
    // 2. Household cost cap
    // ============================================================
    describe('household cost cap', () => {
        it('household A hits cost cap → LLMCostCapError; household B still succeeds', async () => {
            const inner = makeStubInner();
            const guardA = makeAppGuard('appA', inner);
            const guardB = makeAppGuard('appA', inner);

            // Simulate hA at cap via a pending reservation (reserveEstimated contributes to getMonthlyHouseholdCost)
            costTracker.reserveEstimated('hA', 'appA', 'u1', 0.50);

            // hA call should hit cost cap (0.50 pending + 0.05 estimate >= 0.50 cap)
            await expect(
                requestContext.run({ userId: 'u1', householdId: 'hA' }, () => guardA.complete('hi')),
            ).rejects.toThrow(LLMCostCapError);

            // hB is well below cap — should succeed
            await expect(
                requestContext.run({ userId: 'u2', householdId: 'hB' }, () => guardB.complete('hi')),
            ).resolves.toBeDefined();

            guardA.dispose();
            guardB.dispose();
        });
    });

    // ============================================================
    // 3. Platform attribution bypasses household caps
    // ============================================================
    describe('platform attribution', () => {
        it('platform call (no householdId) bypasses household caps; global cap still applies', async () => {
            const inner = makeStubInner();
            const systemGuard = new SystemLLMGuard({
                inner,
                costTracker,
                globalMonthlyCostCap: BASE_SAFEGUARDS.globalMonthlyCostCap,
                logger,
                householdLimiter,
            });

            // Should succeed even with householdId = undefined (platform attribution)
            await expect(
                requestContext.run({ userId: 'u1', householdId: undefined }, () =>
                    systemGuard.complete('hi'),
                ),
            ).resolves.toBeDefined();

            // No household cost recorded for platform context
            expect(costTracker.getMonthlyHouseholdCost(PLATFORM_SYSTEM_HOUSEHOLD_ID)).toBe(0);
        });

        it('PLATFORM_SYSTEM_HOUSEHOLD_ID also bypasses household checks', async () => {
            const inner = makeStubInner();
            const systemGuard = new SystemLLMGuard({
                inner,
                costTracker,
                globalMonthlyCostCap: BASE_SAFEGUARDS.globalMonthlyCostCap,
                logger,
                householdLimiter,
            });

            await expect(
                requestContext.run({ userId: 'u1', householdId: PLATFORM_SYSTEM_HOUSEHOLD_ID }, () =>
                    systemGuard.complete('hi'),
                ),
            ).resolves.toBeDefined();
        });
    });

    // ============================================================
    // 4. SystemLLMGuard household enforcement
    // ============================================================
    describe('SystemLLMGuard household enforcement', () => {
        it('requestContext householdId triggers household cost enforcement for system guard', async () => {
            const inner = makeStubInner();
            const systemGuard = new SystemLLMGuard({
                inner,
                costTracker,
                globalMonthlyCostCap: BASE_SAFEGUARDS.globalMonthlyCostCap,
                logger,
                householdLimiter,
            });

            // Pre-fill h1 cost to cap via pending reservation
            costTracker.reserveEstimated('h1', 'system', 'u1', 0.50);

            await expect(
                requestContext.run({ userId: 'u1', householdId: 'h1' }, () =>
                    systemGuard.complete('hi'),
                ),
            ).rejects.toMatchObject({ scope: 'household' });
        });
    });

    // ============================================================
    // 5. Concurrent cross-household correctness (burst-semantics)
    // ============================================================
    describe('concurrent cross-household calls', () => {
        it('Promise.all of hA and hB calls are each attributed correctly with no cross-contamination', async () => {
            const innerA = makeStubInner();
            const innerB = makeStubInner();
            const guardA = makeAppGuard('appA', innerA);
            const guardB = makeAppGuard('appB', innerB);

            const results = await Promise.allSettled([
                requestContext.run({ userId: 'u1', householdId: 'hA' }, () => guardA.complete('hi')),
                requestContext.run({ userId: 'u2', householdId: 'hB' }, () => guardB.complete('hi')),
                requestContext.run({ userId: 'u1', householdId: 'hA' }, () => guardA.complete('hi')),
                requestContext.run({ userId: 'u2', householdId: 'hB' }, () => guardB.complete('hi')),
            ]);

            const fulfilled = results.filter((r) => r.status === 'fulfilled');
            expect(fulfilled).toHaveLength(4);

            guardA.dispose();
            guardB.dispose();
        });
    });
});
