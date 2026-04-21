/**
 * LLM Guard — per-app safeguard wrapper.
 *
 * Implements LLMService and wraps the real service with:
 *   - Per-app sliding-window rate limiting (peek/commit)
 *   - Household-wide rate limiting + cost cap (via HouseholdLLMLimiter)
 *   - Per-app monthly cost cap
 *   - Global monthly cost cap (kill switch)
 *   - Automatic _appId injection for cost attribution
 *   - Cost reservation (reserve on entry, release on completion)
 *
 * Each app gets its own LLMGuard instance, configured from the
 * manifest's requirements.llm and system-wide defaults.
 */

import type { Logger } from 'pino';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import {
	getCurrentHouseholdId,
	getCurrentUserId,
} from '../../services/context/request-context.js';
import type {
	ClassifyResult,
	LLMCompletionOptions,
	LLMService,
	ModelTier,
} from '../../types/llm.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../config/defaults.js';
import { classify } from './classify.js';
import type { CostTracker } from './cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from './errors.js';
import { type GuardMethod, type PriceLookup, estimateGuardCost } from './estimate-guard-cost.js';
import { extractStructured } from './extract-structured.js';
import type { HouseholdLLMLimiter } from './household-llm-limiter.js';

export interface LLMGuardConfig {
	/** Maximum requests in the sliding window. */
	maxRequests: number;
	/** Sliding window duration in seconds. */
	windowSeconds: number;
	/** Per-app monthly cost cap in USD. */
	monthlyCostCap: number;
	/** Global monthly cost cap in USD. */
	globalMonthlyCostCap: number;
}

export interface LLMGuardOptions {
	/** The real LLM service to delegate to. */
	inner: LLMService;
	/** App ID this guard is scoped to. */
	appId: string;
	/** Cost tracker for monthly cost lookups. */
	costTracker: CostTracker;
	/** Safeguard configuration. */
	config: LLMGuardConfig;
	/** Logger instance. */
	logger: Logger;
	/** Shared household-wide limiter (optional; household checks skipped if absent). */
	householdLimiter?: HouseholdLLMLimiter;
	/** Price lookup for cost estimation (optional; falls back to defaultReservationUsd). */
	priceLookup?: PriceLookup;
	/** Default model tier for cost estimation (optional; defaults to 'fast'). */
	tier?: ModelTier;
}

/** Fallback PriceLookup that always returns undefined (triggers defaultReservationUsd). */
const NULL_PRICE_LOOKUP: PriceLookup = { priceFor: () => undefined };

export class LLMGuard implements LLMService {
	private readonly inner: LLMService;
	private readonly appId: string;
	private readonly costTracker: CostTracker;
	private readonly guardConfig: LLMGuardConfig;
	private readonly logger: Logger;
	private readonly householdLimiter?: HouseholdLLMLimiter;
	private readonly priceLookup: PriceLookup;
	private readonly tier: ModelTier;
	readonly rateLimiter: RateLimiter;

	constructor(options: LLMGuardOptions) {
		this.inner = options.inner;
		this.appId = options.appId;
		this.costTracker = options.costTracker;
		this.guardConfig = options.config;
		this.logger = options.logger;
		this.householdLimiter = options.householdLimiter;
		this.priceLookup = options.priceLookup ?? NULL_PRICE_LOOKUP;
		this.tier = options.tier ?? 'fast';

		const { maxRequests, windowSeconds, monthlyCostCap, globalMonthlyCostCap } = options.config;
		if (!Number.isFinite(monthlyCostCap) || monthlyCostCap <= 0) {
			throw new Error(`LLMGuard(${options.appId}): invalid monthlyCostCap: ${monthlyCostCap}`);
		}
		if (!Number.isFinite(globalMonthlyCostCap) || globalMonthlyCostCap <= 0) {
			throw new Error(
				`LLMGuard(${options.appId}): invalid globalMonthlyCostCap: ${globalMonthlyCostCap}`,
			);
		}
		if (
			!Number.isFinite(maxRequests) ||
			maxRequests < 1 ||
			!Number.isFinite(windowSeconds) ||
			windowSeconds < 1
		) {
			throw new Error(
				`LLMGuard(${options.appId}): invalid rate limit: ${maxRequests}/${windowSeconds}s`,
			);
		}

		this.rateLimiter = new RateLimiter({
			maxAttempts: options.config.maxRequests,
			windowMs: options.config.windowSeconds * 1000,
		});
		this.rateLimiter.startCleanup();
	}

	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		return this.guarded('complete', prompt, options?.maxTokens, () =>
			this.inner.complete(prompt, { ...options, _appId: this.appId }),
		);
	}

	async classify(text: string, categories: string[]): Promise<ClassifyResult> {
		return this.guarded('classify', text, undefined, () => {
			const client = {
				complete: (p: string, opts?: LLMCompletionOptions) => this.completeRaw(p, opts),
			};
			return classify(text, categories, client, this.logger);
		});
	}

	async extractStructured<T>(text: string, schema: object): Promise<T> {
		return this.guarded('extractStructured', text, undefined, () => {
			const client = {
				complete: (p: string, opts?: LLMCompletionOptions) => this.completeRaw(p, opts),
			};
			return extractStructured<T>(text, schema, client, this.logger);
		});
	}

	getModelForTier(tier: ModelTier): string {
		return this.inner.getModelForTier?.(tier) ?? 'unknown';
	}

	dispose(): void {
		this.rateLimiter.dispose();
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

		// 1. App rate peek
		const appR = this.rateLimiter.check(this.appId);
		if (!appR.allowed) {
			this.logger.warn({ appId: this.appId }, 'LLM rate limit exceeded');
			throw new LLMRateLimitError({
				scope: 'app',
				appId: this.appId,
				maxRequests: appR.limit.maxAttempts,
				windowSeconds: appR.limit.windowMs / 1000,
			});
		}

		// 2. Household rate peek
		const hhR = this.householdLimiter?.check(hhId);
		if (hhR && !hhR.allowed) {
			this.logger.warn({ householdId: hhId }, 'Household LLM rate limit exceeded');
			throw new LLMRateLimitError({
				scope: 'household',
				householdId: hhId ?? '',
				maxRequests: hhR.limit.maxRequests,
				windowSeconds: hhR.limit.windowSeconds,
			});
		}

		// 3. App cost cap
		const appCost = this.costTracker.getMonthlyAppCost(this.appId);
		if (appCost >= this.guardConfig.monthlyCostCap) {
			this.logger.warn({ appId: this.appId }, 'Per-app monthly LLM cost cap exceeded');
			throw new LLMCostCapError({
				scope: 'app',
				appId: this.appId,
				currentCost: appCost,
				cap: this.guardConfig.monthlyCostCap,
			});
		}

		// 4. Household cost cap
		this.householdLimiter?.checkCost(hhId, estCost);

		// 5. Global cap
		const totalCost = this.costTracker.getMonthlyTotalCost();
		if (totalCost >= this.guardConfig.globalMonthlyCostCap) {
			this.logger.warn({ totalCost }, 'Global monthly LLM cost cap exceeded');
			throw new LLMCostCapError({
				scope: 'global',
				currentCost: totalCost,
				cap: this.guardConfig.globalMonthlyCostCap,
			});
		}

		// 6. Commit both rate slots
		appR.commit();
		hhR?.commit();

		// 7. Reserve estimated cost
		let reservationId = DEFAULT_LLM_SAFEGUARDS.reservationExpiryMs.toString(); // placeholder
		if (this.householdLimiter) {
			try {
				reservationId = this.householdLimiter.reserveEstimated(
					hhId,
					this.appId,
					getCurrentUserId(),
					estCost,
				);
			} catch (err) {
				this.rateLimiter.revokeLastCommit(this.appId);
				this.householdLimiter.revokeLastCheckCommit(hhId);
				throw new LLMCostCapError({
					scope: 'reservation-exceeded',
					currentCost: 0,
					cap: 0,
					cause: err,
				});
			}
		}

		// 8. Provider call
		try {
			return await run();
		} finally {
			// 9. Release reservation (actual cost flows via BaseProvider.record())
			if (this.householdLimiter) {
				this.householdLimiter.releaseReservation(reservationId, null);
			}
		}
	}

	private completeRaw(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		return this.inner.complete(prompt, { ...options, _appId: this.appId });
	}
}
