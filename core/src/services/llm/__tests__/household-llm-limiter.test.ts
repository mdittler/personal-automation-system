import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../../types/auth-actor.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../../config/defaults.js';
import { LLMCostCapError } from '../errors.js';
import {
	HouseholdLLMLimiter,
	PLATFORM_LIMIT_METADATA,
	PLATFORM_NOOP_RESERVATION,
} from '../household-llm-limiter.js';
import { createMockCostTracker } from './helpers/mock-cost-tracker.js';

const logger = pino({ level: 'silent' });

function makeConfig(overrides: Record<string, unknown> = {}) {
	return {
		defaultRateLimit: DEFAULT_LLM_SAFEGUARDS.defaultRateLimit,
		defaultMonthlyCostCap: DEFAULT_LLM_SAFEGUARDS.defaultMonthlyCostCap,
		globalMonthlyCostCap: DEFAULT_LLM_SAFEGUARDS.globalMonthlyCostCap,
		defaultHouseholdRateLimit: DEFAULT_LLM_SAFEGUARDS.defaultHouseholdRateLimit,
		defaultHouseholdMonthlyCostCap: DEFAULT_LLM_SAFEGUARDS.defaultHouseholdMonthlyCostCap,
		...overrides,
	} as any;
}

describe('HouseholdLLMLimiter', () => {
	let costTracker: ReturnType<typeof createMockCostTracker>;
	let limiter: HouseholdLLMLimiter;

	beforeEach(() => {
		costTracker = createMockCostTracker();
		limiter = new HouseholdLLMLimiter({ costTracker, config: makeConfig(), logger });
	});

	afterEach(() => {
		limiter.dispose();
	});

	// ============================================================
	// attribute()
	// ============================================================
	describe('attribute()', () => {
		it.each([undefined, '', PLATFORM_SYSTEM_HOUSEHOLD_ID])('returns "platform" for %s', (v) => {
			expect(limiter.attribute(v)).toBe('platform');
		});

		it('returns "enforced" for a real household id', () => {
			expect(limiter.attribute('h1')).toBe('enforced');
		});

		it('treats extremely long string as opaque "enforced" (no OOM)', () => {
			expect(limiter.attribute('x'.repeat(10_000))).toBe('enforced');
		});

		it('does not pollute Object.prototype when given "__proto__"', () => {
			limiter.attribute('__proto__');
			expect((Object.prototype as any).foo).toBeUndefined();
		});
	});

	// ============================================================
	// check() — enforced
	// ============================================================
	describe('check() enforced', () => {
		it('allowed + limit metadata matches default config', () => {
			const r = limiter.check('h1');
			expect(r.allowed).toBe(true);
			expect(r.limit).toEqual({ maxRequests: 200, windowSeconds: 3600 });
		});

		it('commit() records a slot; after 200 commits, denied', () => {
			for (let i = 0; i < 200; i++) limiter.check('h1').commit();
			expect(limiter.check('h1').allowed).toBe(false);
		});

		it('isolation: exhausting hA does not affect hB', () => {
			for (let i = 0; i < 200; i++) limiter.check('hA').commit();
			expect(limiter.check('hA').allowed).toBe(false);
			expect(limiter.check('hB').allowed).toBe(true);
		});
	});

	// ============================================================
	// check() — platform
	// ============================================================
	describe('check() platform', () => {
		it.each([undefined, '', PLATFORM_SYSTEM_HOUSEHOLD_ID])(
			'returns PLATFORM_LIMIT_METADATA sentinel for %s',
			(v) => {
				const r = limiter.check(v);
				expect(r.allowed).toBe(true);
				expect(r.limit).toEqual(PLATFORM_LIMIT_METADATA);
				expect(typeof r.commit).toBe('function');
				r.commit(); // must not throw
			},
		);

		it('platform commit never consumes rate slots (1000 commits still allowed)', () => {
			const r = limiter.check(undefined);
			for (let i = 0; i < 1000; i++) r.commit();
			expect(limiter.check('h1').allowed).toBe(true);
		});
	});

	// ============================================================
	// check() — overrides
	// ============================================================
	describe('check() with overrides', () => {
		it('per-household override surfaces via check().limit', () => {
			limiter.dispose();
			limiter = new HouseholdLLMLimiter({
				costTracker,
				logger,
				config: makeConfig({
					householdOverrides: { h1: { rateLimit: { maxRequests: 400, windowSeconds: 1800 } } },
				}),
			});
			expect(limiter.check('h1').limit).toEqual({ maxRequests: 400, windowSeconds: 1800 });
			expect(limiter.check('h2').limit).toEqual({ maxRequests: 200, windowSeconds: 3600 });
		});
	});

	// ============================================================
	// checkCost()
	// ============================================================
	describe('checkCost()', () => {
		it('allows when persisted + estimate < cap', () => {
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(19.98);
			expect(() => limiter.checkCost('h1', 0.01)).not.toThrow();
		});

		it('denies when persisted + estimate >= cap (exact equality = deny)', () => {
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(19.99);
			expect(() => limiter.checkCost('h1', 0.01)).toThrow(LLMCostCapError);
		});

		it('thrown error carries scope, householdId, cap', () => {
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(21);
			try {
				limiter.checkCost('h1', 0);
				expect.fail('should have thrown');
			} catch (e: any) {
				expect(e.scope).toBe('household');
				expect(e.householdId).toBe('h1');
				expect(e.cap).toBe(20);
			}
		});

		it.each([undefined, '', PLATFORM_SYSTEM_HOUSEHOLD_ID])(
			'platform %s: no-op even for huge estimate',
			(v) => {
				expect(() => limiter.checkCost(v, 1_000_000)).not.toThrow();
				expect(costTracker.getMonthlyHouseholdCost).not.toHaveBeenCalled();
			},
		);

		it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01])(
			'rejects invalid estimatedCost = %s',
			(v) => {
				expect(() => limiter.checkCost('h1', v as number)).toThrow();
			},
		);

		it('accepts estimatedCost = 0', () => {
			expect(() => limiter.checkCost('h1', 0)).not.toThrow();
		});

		it('override: denies against override cap (40) not default (20)', () => {
			limiter.dispose();
			limiter = new HouseholdLLMLimiter({
				costTracker,
				logger,
				config: makeConfig({ householdOverrides: { h1: { monthlyCostCap: 40 } } }),
			});
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(30);
			expect(() => limiter.checkCost('h1', 5)).not.toThrow();
			expect(() => limiter.checkCost('h1', 10)).toThrow(LLMCostCapError);
		});
	});

	// ============================================================
	// reserveEstimated() — SIDE-EFFECT ONLY
	// ============================================================
	describe('reserveEstimated() — side-effect only, does NOT enforce cap', () => {
		it('delegates to CostTracker for enforced household (returns the tracker id)', () => {
			(costTracker.reserveEstimated as any).mockReturnValue('ct-res-42');
			const id = limiter.reserveEstimated('h1', 'chatbot', 'u1', 0.05);
			expect(id).toBe('ct-res-42');
			expect(costTracker.reserveEstimated).toHaveBeenCalledWith('h1', 'chatbot', 'u1', 0.05);
		});

		it('does NOT re-check cap (wildly over cap still delegates)', () => {
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(1_000_000);
			(costTracker.reserveEstimated as any).mockReturnValue('ct-res-42');
			expect(() => limiter.reserveEstimated('h1', 'chatbot', 'u1', 0.05)).not.toThrow();
		});

		it.each([undefined, '', PLATFORM_SYSTEM_HOUSEHOLD_ID])(
			'returns PLATFORM_NOOP_RESERVATION for platform id = %s; CostTracker untouched',
			(v) => {
				const id = limiter.reserveEstimated(v, 'chatbot', 'u1', 0.05);
				expect(id).toBe(PLATFORM_NOOP_RESERVATION);
				expect(costTracker.reserveEstimated).not.toHaveBeenCalled();
			},
		);

		it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])('rejects invalid est = %s', (v) => {
			expect(() => limiter.reserveEstimated('h1', 'chatbot', 'u1', v as number)).toThrow();
		});

		it('est = 0 accepted — CostTracker called with 0', () => {
			(costTracker.reserveEstimated as any).mockReturnValue('ct-res-0');
			expect(limiter.reserveEstimated('h1', 'chatbot', 'u1', 0)).toBe('ct-res-0');
		});
	});

	// ============================================================
	// releaseReservation()
	// ============================================================
	describe('releaseReservation()', () => {
		it('delegates to CostTracker for real reservation ids', () => {
			limiter.releaseReservation('ct-res-42', 0.03);
			expect(costTracker.releaseReservation).toHaveBeenCalledWith('ct-res-42', 0.03);
		});

		it('no-op for PLATFORM_NOOP_RESERVATION even with non-null actual', () => {
			limiter.releaseReservation(PLATFORM_NOOP_RESERVATION, 0.1);
			expect(costTracker.releaseReservation).not.toHaveBeenCalled();
		});

		it('null actual delegated', () => {
			limiter.releaseReservation('ct-res-42', null);
			expect(costTracker.releaseReservation).toHaveBeenCalledWith('ct-res-42', null);
		});
	});

	// ============================================================
	// revokeLastCheckCommit()
	// ============================================================
	describe('revokeLastCheckCommit()', () => {
		it('revokes last committed slot for an enforced household', () => {
			limiter.check('h1').commit();
			limiter.check('h1').commit();
			limiter.revokeLastCheckCommit('h1');
			// Fill remaining 199 slots then check one more — should succeed (199 used, not 200)
			for (let i = 0; i < 198; i++) limiter.check('h1').commit();
			expect(limiter.check('h1').allowed).toBe(true);
		});

		it('no-op for platform householdId (does not throw)', () => {
			expect(() => limiter.revokeLastCheckCommit(undefined)).not.toThrow();
			expect(() => limiter.revokeLastCheckCommit(PLATFORM_SYSTEM_HOUSEHOLD_ID)).not.toThrow();
		});
	});

	// ============================================================
	// dispose()
	// ============================================================
	describe('dispose()', () => {
		it('subsequent check() throws "disposed"', () => {
			limiter.dispose();
			expect(() => limiter.check('h1')).toThrow(/disposed/i);
		});

		it('subsequent checkCost() throws', () => {
			limiter.dispose();
			expect(() => limiter.checkCost('h1', 0.05)).toThrow(/disposed/i);
		});

		it('subsequent reserveEstimated() throws', () => {
			limiter.dispose();
			expect(() => limiter.reserveEstimated('h1', 'chatbot', 'u1', 0.05)).toThrow(/disposed/i);
		});

		it('subsequent releaseReservation() throws', () => {
			limiter.dispose();
			expect(() => limiter.releaseReservation('ct-res-42', 0.05)).toThrow(/disposed/i);
		});

		it('dispose() is idempotent', () => {
			limiter.dispose();
			expect(() => limiter.dispose()).not.toThrow();
		});
	});

	// ============================================================
	// Configuration (rule #7)
	// ============================================================
	describe('constructor validation', () => {
		const build = (override: Record<string, unknown>) =>
			new HouseholdLLMLimiter({ costTracker, logger, config: makeConfig(override) });

		it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
			'rejects defaultHouseholdMonthlyCostCap = %s',
			(v) => {
				expect(() => build({ defaultHouseholdMonthlyCostCap: v })).toThrow();
			},
		);

		it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
			'rejects defaultHouseholdRateLimit.maxRequests = %s',
			(v) => {
				expect(() =>
					build({ defaultHouseholdRateLimit: { maxRequests: v, windowSeconds: 3600 } }),
				).toThrow();
			},
		);

		it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
			'rejects defaultHouseholdRateLimit.windowSeconds = %s',
			(v) => {
				expect(() =>
					build({ defaultHouseholdRateLimit: { maxRequests: 200, windowSeconds: v } }),
				).toThrow();
			},
		);

		it('accepts empty householdOverrides: {}', () => {
			expect(() => build({ householdOverrides: {} })).not.toThrow();
		});

		it('override with only rateLimit uses default cost cap', () => {
			const l = build({
				householdOverrides: { h1: { rateLimit: { maxRequests: 400, windowSeconds: 1800 } } },
			});
			(costTracker.getMonthlyHouseholdCost as any).mockReturnValue(20);
			expect(() => l.checkCost('h1', 0)).toThrow(LLMCostCapError);
			l.dispose();
		});

		it('override with only monthlyCostCap uses default rate', () => {
			const l = build({ householdOverrides: { h1: { monthlyCostCap: 40 } } });
			expect(l.check('h1').limit).toEqual({ maxRequests: 200, windowSeconds: 3600 });
			l.dispose();
		});

		it('override with negative monthlyCostCap rejected', () => {
			expect(() => build({ householdOverrides: { h1: { monthlyCostCap: -1 } } })).toThrow();
		});
	});

	// ============================================================
	// State transitions — window expiry
	// ============================================================
	describe('window expiry', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('rate slots restored after windowSeconds elapses', () => {
			vi.setSystemTime(1_000);
			for (let i = 0; i < 200; i++) limiter.check('h1').commit();
			expect(limiter.check('h1').allowed).toBe(false);
			vi.setSystemTime(1_000 + 3_600_000);
			expect(limiter.check('h1').allowed).toBe(true);
		});
	});

	// ============================================================
	// Burst-semantics (sync re-entry) — NOT async concurrency
	// ============================================================
	describe('burst-semantics (sync re-entry)', () => {
		it('Promise.all over synchronous check()+commit() respects cap', async () => {
			await Promise.all(
				Array.from({ length: 500 }, () =>
					Promise.resolve().then(() => {
						const r = limiter.check('h1');
						if (r.allowed) r.commit();
					}),
				),
			);
			expect(limiter.check('h1').allowed).toBe(false);
		});
	});
});
