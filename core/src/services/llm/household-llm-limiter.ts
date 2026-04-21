import type pino from 'pino';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../types/auth-actor.js';
import type { LLMSafeguardsConfig } from '../../types/config.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../config/defaults.js';
import type { CostTracker } from './cost-tracker.js';
import { LLMCostCapError } from './errors.js';

export interface HouseholdLLMLimiterOptions {
	costTracker: CostTracker;
	config: LLMSafeguardsConfig;
	logger: pino.Logger;
}

export type HouseholdAttribution = 'platform' | 'enforced';

export const PLATFORM_LIMIT_METADATA: Readonly<{ maxRequests: number; windowSeconds: number }> =
	Object.freeze({
		maxRequests: Number.POSITIVE_INFINITY,
		windowSeconds: Number.POSITIVE_INFINITY,
	});

export const PLATFORM_NOOP_RESERVATION = 'PLATFORM_NOOP' as const;

export class HouseholdLLMLimiter {
	private readonly costTracker: CostTracker;
	private readonly config: LLMSafeguardsConfig;
	private readonly logger: pino.Logger;
	private readonly rateLimiters = new Map<string, RateLimiter>();
	private disposed = false;

	constructor(opts: HouseholdLLMLimiterOptions) {
		const { config } = opts;
		this.validateConfig(config);
		this.costTracker = opts.costTracker;
		this.config = config;
		this.logger = opts.logger;
	}

	private validateConfig(config: LLMSafeguardsConfig): void {
		const rl = config.defaultHouseholdRateLimit ?? DEFAULT_LLM_SAFEGUARDS.defaultHouseholdRateLimit;
		if (
			!Number.isFinite(rl.maxRequests) ||
			!Number.isInteger(rl.maxRequests) ||
			rl.maxRequests <= 0
		) {
			throw new Error(
				`HouseholdLLMLimiter: defaultHouseholdRateLimit.maxRequests must be a positive integer, got ${rl.maxRequests}`,
			);
		}
		if (!Number.isFinite(rl.windowSeconds) || rl.windowSeconds <= 0) {
			throw new Error(
				`HouseholdLLMLimiter: defaultHouseholdRateLimit.windowSeconds must be a positive finite number, got ${rl.windowSeconds}`,
			);
		}

		const cap =
			config.defaultHouseholdMonthlyCostCap ??
			DEFAULT_LLM_SAFEGUARDS.defaultHouseholdMonthlyCostCap;
		if (!Number.isFinite(cap) || cap < 0) {
			throw new Error(
				`HouseholdLLMLimiter: defaultHouseholdMonthlyCostCap must be >= 0, got ${cap}`,
			);
		}

		if (config.householdOverrides) {
			for (const [id, override] of Object.entries(config.householdOverrides)) {
				if (override.monthlyCostCap !== undefined) {
					if (!Number.isFinite(override.monthlyCostCap) || override.monthlyCostCap < 0) {
						throw new Error(
							`HouseholdLLMLimiter: householdOverrides[${id}].monthlyCostCap must be >= 0, got ${override.monthlyCostCap}`,
						);
					}
				}
				if (override.rateLimit) {
					if (
						!Number.isFinite(override.rateLimit.maxRequests) ||
						!Number.isInteger(override.rateLimit.maxRequests) ||
						override.rateLimit.maxRequests <= 0
					) {
						throw new Error(
							`HouseholdLLMLimiter: householdOverrides[${id}].rateLimit.maxRequests must be a positive integer`,
						);
					}
					if (
						!Number.isFinite(override.rateLimit.windowSeconds) ||
						override.rateLimit.windowSeconds <= 0
					) {
						throw new Error(
							`HouseholdLLMLimiter: householdOverrides[${id}].rateLimit.windowSeconds must be positive`,
						);
					}
				}
			}
		}
	}

	attribute(householdId: string | undefined): HouseholdAttribution {
		if (!householdId || householdId === PLATFORM_SYSTEM_HOUSEHOLD_ID) {
			return 'platform';
		}
		return 'enforced';
	}

	check(householdId: string | undefined): {
		allowed: boolean;
		commit: () => void;
		limit: { maxRequests: number; windowSeconds: number };
	} {
		if (this.disposed) throw new Error('HouseholdLLMLimiter disposed');

		if (this.attribute(householdId) === 'platform') {
			return { allowed: true, commit: () => {}, limit: { ...PLATFORM_LIMIT_METADATA } };
		}

		const rl = this.getRateLimiter(householdId!);
		const result = rl.check(householdId!);
		const overrideRl = this.config.householdOverrides?.[householdId!]?.rateLimit;
		const defaultRl =
			this.config.defaultHouseholdRateLimit ?? DEFAULT_LLM_SAFEGUARDS.defaultHouseholdRateLimit;
		const effectiveRl = overrideRl ?? defaultRl;
		return {
			allowed: result.allowed,
			commit: result.commit,
			limit: { maxRequests: effectiveRl.maxRequests, windowSeconds: effectiveRl.windowSeconds },
		};
	}

	checkCost(householdId: string | undefined, estimatedCost: number): void {
		if (this.disposed) throw new Error('HouseholdLLMLimiter disposed');
		if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
			throw new TypeError(
				`HouseholdLLMLimiter.checkCost: estimatedCost must be >= 0 and finite, got ${estimatedCost}`,
			);
		}

		if (this.attribute(householdId) === 'platform') return;

		const cap = this.resolveHouseholdCostCap(householdId!);
		const current = this.costTracker.getMonthlyHouseholdCost(householdId!);
		if (current + estimatedCost >= cap) {
			this.logger.warn(
				{ householdId, current, estimatedCost, cap },
				'Household monthly LLM cost cap exceeded',
			);
			throw new LLMCostCapError({
				scope: 'household',
				householdId: householdId!,
				currentCost: current,
				cap,
			});
		}
	}

	reserveEstimated(
		householdId: string | undefined,
		appId: string | undefined,
		userId: string | undefined,
		est: number,
	): string {
		if (this.disposed) throw new Error('HouseholdLLMLimiter disposed');
		if (!Number.isFinite(est) || est < 0) {
			throw new TypeError(
				`HouseholdLLMLimiter.reserveEstimated: est must be >= 0 and finite, got ${est}`,
			);
		}

		if (this.attribute(householdId) === 'platform') {
			return PLATFORM_NOOP_RESERVATION;
		}

		return this.costTracker.reserveEstimated(householdId!, appId, userId, est);
	}

	releaseReservation(reservationId: string, actual: number | null): void {
		if (this.disposed) throw new Error('HouseholdLLMLimiter disposed');
		if (reservationId === PLATFORM_NOOP_RESERVATION) return;
		this.costTracker.releaseReservation(reservationId, actual);
	}

	revokeLastCheckCommit(householdId: string | undefined): void {
		if (this.attribute(householdId) === 'platform') return;
		const rl = this.rateLimiters.get(householdId!);
		if (!rl) return;
		rl.revokeLastCommit(householdId!);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const rl of this.rateLimiters.values()) {
			rl.dispose();
		}
		this.rateLimiters.clear();
	}

	private getRateLimiter(householdId: string): RateLimiter {
		let rl = this.rateLimiters.get(householdId);
		if (!rl) {
			const overrideRl = this.config.householdOverrides?.[householdId]?.rateLimit;
			const defaultRl =
				this.config.defaultHouseholdRateLimit ?? DEFAULT_LLM_SAFEGUARDS.defaultHouseholdRateLimit;
			const effectiveRl = overrideRl ?? defaultRl;
			rl = new RateLimiter({
				maxAttempts: effectiveRl.maxRequests,
				windowMs: effectiveRl.windowSeconds * 1000,
			});
			this.rateLimiters.set(householdId, rl);
		}
		return rl;
	}

	private resolveHouseholdCostCap(householdId: string): number {
		return (
			this.config.householdOverrides?.[householdId]?.monthlyCostCap ??
			this.config.defaultHouseholdMonthlyCostCap ??
			DEFAULT_LLM_SAFEGUARDS.defaultHouseholdMonthlyCostCap
		);
	}
}
