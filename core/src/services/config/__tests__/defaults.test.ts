import { describe, expect, it } from 'vitest';
import { DEFAULT_LLM_SAFEGUARDS } from '../defaults.js';

describe('DEFAULT_LLM_SAFEGUARDS', () => {
	it('exposes app + global + household + reservation defaults', () => {
		expect(DEFAULT_LLM_SAFEGUARDS).toEqual({
			defaultRateLimit: { maxRequests: 60, windowSeconds: 3600 },
			defaultMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
			defaultHouseholdRateLimit: { maxRequests: 200, windowSeconds: 3600 },
			defaultHouseholdMonthlyCostCap: 20,
			defaultReservationUsd: 0.05,
			reservationExpiryMs: 60_000,
		});
	});

	it('is frozen', () => {
		expect(() => {
			(DEFAULT_LLM_SAFEGUARDS as any).defaultMonthlyCostCap = 99;
		}).toThrow();
	});

	it('deep freeze: mutating defaultRateLimit.maxRequests throws in strict mode', () => {
		expect(() => {
			(DEFAULT_LLM_SAFEGUARDS.defaultRateLimit as any).maxRequests = 999;
		}).toThrow();
	});

	it('two separate import sites return the exact same reference', async () => {
		const { DEFAULT_LLM_SAFEGUARDS: same } = await import('../defaults.js');
		expect(same).toBe(DEFAULT_LLM_SAFEGUARDS);
	});
});
