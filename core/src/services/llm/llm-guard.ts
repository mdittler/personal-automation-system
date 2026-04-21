/**
 * LLM Guard — per-app safeguard wrapper.
 *
 * Implements LLMService and wraps the real service with:
 *   - Per-app sliding-window rate limiting
 *   - Per-app monthly cost cap
 *   - Global monthly cost cap (kill switch)
 *   - Automatic _appId injection for cost attribution
 *
 * Each app gets its own LLMGuard instance, configured from the
 * manifest's requirements.llm and system-wide defaults.
 */

import type { Logger } from 'pino';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import type {
	ClassifyResult,
	LLMCompletionOptions,
	LLMService,
	ModelTier,
} from '../../types/llm.js';
import { classify } from './classify.js';
import type { CostTracker } from './cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from './errors.js';
import { extractStructured } from './extract-structured.js';

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
}

export class LLMGuard implements LLMService {
	private readonly inner: LLMService;
	private readonly appId: string;
	private readonly costTracker: CostTracker;
	private readonly guardConfig: LLMGuardConfig;
	private readonly logger: Logger;
	readonly rateLimiter: RateLimiter;

	constructor(options: LLMGuardOptions) {
		this.inner = options.inner;
		this.appId = options.appId;
		this.costTracker = options.costTracker;
		this.guardConfig = options.config;
		this.logger = options.logger;

		// Validate config to prevent silent enforcement bypass (e.g. NaN disables checks)
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
		this.checkCostCap();
		this.checkRateLimit();
		return this.inner.complete(prompt, { ...options, _appId: this.appId });
	}

	async classify(text: string, categories: string[]): Promise<ClassifyResult> {
		this.checkCostCap();
		this.checkRateLimit();

		// Route through a wrapped client so _appId flows to the provider
		const client = {
			complete: (prompt: string, opts?: LLMCompletionOptions) => this.completeRaw(prompt, opts),
		};
		return classify(text, categories, client, this.logger);
	}

	async extractStructured<T>(text: string, schema: object): Promise<T> {
		this.checkCostCap();
		this.checkRateLimit();

		const client = {
			complete: (prompt: string, opts?: LLMCompletionOptions) => this.completeRaw(prompt, opts),
		};
		return extractStructured<T>(text, schema, client, this.logger);
	}

	getModelForTier(tier: ModelTier): string {
		return this.inner.getModelForTier?.(tier) ?? 'unknown';
	}

	/**
	 * Dispose the rate limiter cleanup timer. Call on shutdown.
	 */
	dispose(): void {
		this.rateLimiter.dispose();
	}

	/**
	 * Internal complete that injects _appId but skips rate/cost checks.
	 * Used by classify/extractStructured to avoid double-counting.
	 */
	private completeRaw(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		return this.inner.complete(prompt, { ...options, _appId: this.appId });
	}

	private checkRateLimit(): void {
		if (!this.rateLimiter.isAllowed(this.appId)) {
			this.logger.warn({ appId: this.appId }, 'LLM rate limit exceeded');
			throw new LLMRateLimitError({
				scope: 'app',
				appId: this.appId,
				maxRequests: this.guardConfig.maxRequests,
				windowSeconds: this.guardConfig.windowSeconds,
			});
		}
	}

	private checkCostCap(): void {
		const appCost = this.costTracker.getMonthlyAppCost(this.appId);
		if (appCost >= this.guardConfig.monthlyCostCap) {
			this.logger.warn(
				{ appId: this.appId, cost: appCost, cap: this.guardConfig.monthlyCostCap },
				'Per-app monthly LLM cost cap exceeded',
			);
			throw new LLMCostCapError({ scope: 'app', appId: this.appId, currentCost: appCost, cap: this.guardConfig.monthlyCostCap });
		}

		const totalCost = this.costTracker.getMonthlyTotalCost();
		if (totalCost >= this.guardConfig.globalMonthlyCostCap) {
			this.logger.warn(
				{ totalCost, cap: this.guardConfig.globalMonthlyCostCap },
				'Global monthly LLM cost cap exceeded',
			);
			throw new LLMCostCapError({ scope: 'global', currentCost: totalCost, cap: this.guardConfig.globalMonthlyCostCap });
		}
	}
}
