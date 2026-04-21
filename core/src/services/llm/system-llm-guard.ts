/**
 * System LLM Guard — global cost cap + household rate/cost governance for infrastructure calls.
 *
 * Wraps the LLM service for infrastructure-level callers (router, daily diff,
 * condition evaluator) that are not associated with any app. Unlike LLMGuard,
 * this has no per-app rate limiting, but enforces:
 *   - Household-wide rate limiting + cost cap (via HouseholdLLMLimiter)
 *   - Global monthly cost cap (kill switch)
 *   - Cost reservation (reserve on entry, release on completion)
 */

import type { Logger } from 'pino';
import { getCurrentHouseholdId } from '../../services/context/request-context.js';
import type { ClassifyResult, LLMCompletionOptions, LLMService, ModelTier } from '../../types/llm.js';
import { classify } from './classify.js';
import type { CostTracker } from './cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from './errors.js';
import { extractStructured } from './extract-structured.js';
import type { HouseholdLLMLimiter } from './household-llm-limiter.js';
import {
    estimateGuardCost,
    type GuardMethod,
    type PriceLookup,
} from './estimate-guard-cost.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../config/defaults.js';

/** Fallback PriceLookup that always returns undefined (triggers defaultReservationUsd). */
const NULL_PRICE_LOOKUP: PriceLookup = { priceFor: () => undefined };

export interface SystemLLMGuardOptions {
    /** The real LLM service to delegate to. */
    inner: LLMService;
    /** Cost tracker for monthly cost lookups. */
    costTracker: CostTracker;
    /** Global monthly cost cap in USD. */
    globalMonthlyCostCap: number;
    /** Logger instance. */
    logger: Logger;
    /** App ID to attribute costs to. Defaults to 'system'. */
    attributionId?: string;
    /** Shared household-wide limiter (optional; household checks skipped if absent). */
    householdLimiter?: HouseholdLLMLimiter;
    /** Price lookup for cost estimation (optional; falls back to defaultReservationUsd). */
    priceLookup?: PriceLookup;
    /** Default model tier for cost estimation (optional; defaults to 'fast'). */
    tier?: ModelTier;
}

export class SystemLLMGuard implements LLMService {
    private readonly inner: LLMService;
    private readonly costTracker: CostTracker;
    private readonly globalMonthlyCostCap: number;
    private readonly logger: Logger;
    private readonly attributionId: string;
    private readonly householdLimiter?: HouseholdLLMLimiter;
    private readonly priceLookup: PriceLookup;
    private readonly tier: ModelTier;

    constructor(options: SystemLLMGuardOptions) {
        if (!Number.isFinite(options.globalMonthlyCostCap) || options.globalMonthlyCostCap <= 0) {
            throw new Error(
                `SystemLLMGuard: invalid globalMonthlyCostCap: ${options.globalMonthlyCostCap}`,
            );
        }
        this.inner = options.inner;
        this.costTracker = options.costTracker;
        this.globalMonthlyCostCap = options.globalMonthlyCostCap;
        this.logger = options.logger;
        this.attributionId = options.attributionId ?? 'system';
        this.householdLimiter = options.householdLimiter;
        this.priceLookup = options.priceLookup ?? NULL_PRICE_LOOKUP;
        this.tier = options.tier ?? 'fast';
    }

    async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
        return this.guarded('complete', prompt, options?.maxTokens, () =>
            this.inner.complete(prompt, { ...options, _appId: this.attributionId }),
        );
    }

    async classify(text: string, categories: string[]): Promise<ClassifyResult> {
        return this.guarded('classify', text, undefined, () => {
            const client = {
                complete: (p: string, opts?: LLMCompletionOptions) =>
                    this.inner.complete(p, { ...opts, _appId: this.attributionId }),
            };
            return classify(text, categories, client, this.logger);
        });
    }

    async extractStructured<T>(text: string, schema: object): Promise<T> {
        return this.guarded('extractStructured', text, undefined, () => {
            const client = {
                complete: (p: string, opts?: LLMCompletionOptions) =>
                    this.inner.complete(p, { ...opts, _appId: this.attributionId }),
            };
            return extractStructured<T>(text, schema, client, this.logger);
        });
    }

    private async guarded<T>(
        method: GuardMethod,
        prompt: string,
        maxOutputTokens: number | undefined,
        run: () => Promise<T>,
    ): Promise<T> {
        const hhId = getCurrentHouseholdId();
        const estCost = estimateGuardCost(
            { method, tier: this.tier, prompt, maxOutputTokens },
            this.priceLookup,
            this.logger,
        );

        // 1. Household rate peek
        const hhR = this.householdLimiter?.check(hhId);
        if (hhR && !hhR.allowed) {
            this.logger.warn({ householdId: hhId }, 'Household LLM rate limit exceeded (system)');
            throw new LLMRateLimitError({
                scope: 'household',
                householdId: hhId ?? '',
                maxRequests: hhR.limit.maxRequests,
                windowSeconds: hhR.limit.windowSeconds,
            });
        }

        // 2. Household cost cap
        this.householdLimiter?.checkCost(hhId, estCost);

        // 3. Global cap
        const totalCost = this.costTracker.getMonthlyTotalCost();
        if (totalCost >= this.globalMonthlyCostCap) {
            this.logger.warn(
                { totalCost, cap: this.globalMonthlyCostCap },
                `Global monthly LLM cost cap exceeded (${this.attributionId} call)`,
            );
            throw new LLMCostCapError({ scope: 'global', currentCost: totalCost, cap: this.globalMonthlyCostCap });
        }

        // 4. Commit household rate
        hhR?.commit();

        // 5. Reserve estimated cost
        let reservationId = DEFAULT_LLM_SAFEGUARDS.reservationExpiryMs.toString();
        if (this.householdLimiter) {
            reservationId = this.householdLimiter.reserveEstimated(
                hhId,
                this.attributionId,
                undefined,
                estCost,
            );
        }

        // 6. Provider call
        try {
            return await run();
        } finally {
            // 7. Release reservation (actual cost flows via BaseProvider.record())
            if (this.householdLimiter) {
                this.householdLimiter.releaseReservation(reservationId, null);
            }
        }
    }
}
