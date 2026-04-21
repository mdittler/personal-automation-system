import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../../types/auth-actor.js';
import type { LLMCompletionOptions, LLMService } from '../../../types/llm.js';
import { requestContext } from '../../context/request-context.js';
import { LLMCostCapError, LLMRateLimitError } from '../errors.js';
import { SystemLLMGuard } from '../system-llm-guard.js';
import { createMockCostTracker } from './helpers/mock-cost-tracker.js';
import { createMockHouseholdLimiter } from './helpers/mock-household-limiter.js';

const logger = pino({ level: 'silent' });

function createMockInner(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('{"category":"test","confidence":0.9}'),
		classify: vi.fn().mockResolvedValue({ category: 'test', confidence: 0.9 }),
		extractStructured: vi.fn().mockResolvedValue({ key: 'value' }),
	};
}


describe('SystemLLMGuard', () => {
	let inner: LLMService;
	let costTracker: CostTracker;
	let guard: SystemLLMGuard;

	beforeEach(() => {
		inner = createMockInner();
		costTracker = createMockCostTracker(0, 0);
		guard = new SystemLLMGuard({
			inner,
			costTracker,
			globalMonthlyCostCap: 50.0,
			logger,
		});
	});

	describe('complete()', () => {
		it('delegates to inner service when under cap', async () => {
			const result = await guard.complete('hello', { tier: 'fast' });

			expect(result).toBe('{"category":"test","confidence":0.9}');
			expect(inner.complete).toHaveBeenCalledWith('hello', {
				tier: 'fast',
				_appId: 'system',
			});
		});

		it('injects _appId: system even with no options', async () => {
			await guard.complete('hello');

			expect(inner.complete).toHaveBeenCalledWith('hello', { _appId: 'system' });
		});

		it('preserves all existing options', async () => {
			const opts: LLMCompletionOptions = {
				tier: 'standard',
				temperature: 0.7,
				maxTokens: 200,
				systemPrompt: 'You are helpful',
			};

			await guard.complete('hello', opts);

			expect(inner.complete).toHaveBeenCalledWith('hello', {
				...opts,
				_appId: 'system',
			});
		});

		it('throws LLMCostCapError when global cap exceeded', async () => {
			costTracker = createMockCostTracker(0, 50.01);
			guard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
			});

			let caughtErr: unknown;
			try {
				await guard.complete('hello');
			} catch (e) {
				caughtErr = e;
			}
			expect(caughtErr).toBeInstanceOf(LLMCostCapError);
			expect((caughtErr as LLMCostCapError).scope).toBe('global');
		});

		it('blocks when cost is exactly at cap (>=)', async () => {
			costTracker = createMockCostTracker(0, 50.0);
			guard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
			});

			await expect(guard.complete('hello')).rejects.toThrow(LLMCostCapError);
		});

		it('allows when cost is just below cap', async () => {
			costTracker = createMockCostTracker(0, 49.99);
			guard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
			});

			const result = await guard.complete('hello');
			expect(result).toBeDefined();
		});
	});

	describe('classify()', () => {
		it('checks global cap before delegating', async () => {
			costTracker = createMockCostTracker(0, 50.0);
			guard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
			});

			await expect(guard.classify('text', ['a', 'b'])).rejects.toThrow(LLMCostCapError);
		});

		it('delegates via inner.complete with _appId: system', async () => {
			await guard.classify('classify this', ['cat1', 'cat2']);

			// classify() routes through inner.complete (not inner.classify)
			expect(inner.classify).not.toHaveBeenCalled();
			expect(inner.complete).toHaveBeenCalled();
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('system');
		});
	});

	describe('extractStructured()', () => {
		it('checks global cap before delegating', async () => {
			costTracker = createMockCostTracker(0, 50.0);
			guard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
			});

			await expect(guard.extractStructured('text', { type: 'object' })).rejects.toThrow(
				LLMCostCapError,
			);
		});

		it('delegates via inner.complete with _appId: system', async () => {
			await guard.extractStructured('extract this', { type: 'object' });

			expect(inner.extractStructured).not.toHaveBeenCalled();
			expect(inner.complete).toHaveBeenCalled();
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('system');
		});
	});

	describe('config validation', () => {
		it('rejects NaN globalMonthlyCostCap', () => {
			expect(
				() =>
					new SystemLLMGuard({
						inner,
						costTracker,
						globalMonthlyCostCap: Number.NaN,
						logger,
					}),
			).toThrow(/invalid globalMonthlyCostCap/);
		});

		it('rejects zero globalMonthlyCostCap', () => {
			expect(
				() =>
					new SystemLLMGuard({
						inner,
						costTracker,
						globalMonthlyCostCap: 0,
						logger,
					}),
			).toThrow(/invalid globalMonthlyCostCap/);
		});

		it('rejects negative globalMonthlyCostCap', () => {
			expect(
				() =>
					new SystemLLMGuard({
						inner,
						costTracker,
						globalMonthlyCostCap: -10,
						logger,
					}),
			).toThrow(/invalid globalMonthlyCostCap/);
		});
	});

	describe('error propagation', () => {
		it('propagates inner service errors unchanged', async () => {
			const innerError = new Error('Provider unavailable');
			(inner.complete as ReturnType<typeof vi.fn>).mockRejectedValue(innerError);

			await expect(guard.complete('hello')).rejects.toThrow('Provider unavailable');
		});
	});

	describe('attributionId', () => {
		it('defaults to system when attributionId not provided', async () => {
			await guard.complete('hello');
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('system');
		});

		it('uses custom attributionId in complete()', async () => {
			const apiGuard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
				attributionId: 'api',
			});

			await apiGuard.complete('hello', { tier: 'fast' });

			expect(inner.complete).toHaveBeenCalledWith('hello', {
				tier: 'fast',
				_appId: 'api',
			});
		});

		it('uses custom attributionId in classify()', async () => {
			const apiGuard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
				attributionId: 'api',
			});

			await apiGuard.classify('classify this', ['cat1', 'cat2']);

			expect(inner.complete).toHaveBeenCalled();
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('api');
		});

		it('uses custom attributionId in extractStructured()', async () => {
			const apiGuard = new SystemLLMGuard({
				inner,
				costTracker,
				globalMonthlyCostCap: 50.0,
				logger,
				attributionId: 'api',
			});

			await apiGuard.extractStructured('extract this', { type: 'object' });

			expect(inner.complete).toHaveBeenCalled();
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('api');
		});

		it('uses attributionId in cost cap log message', async () => {
			const warnSpy = vi.spyOn(logger, 'warn');
			const apiGuard = new SystemLLMGuard({
				inner,
				costTracker: createMockCostTracker(0, 50.0),
				globalMonthlyCostCap: 50.0,
				logger,
				attributionId: 'api',
			});

			await expect(apiGuard.complete('hello')).rejects.toThrow(LLMCostCapError);
			// Match '(api call)' specifically to verify attributionId appears in the log message
			// and to distinguish from the default 'system' attribution
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ totalCost: 50.0 }),
				expect.stringContaining('(api call)'),
			);
		});
	});
});

// ==========================================================================
// SystemLLMGuard + HouseholdLLMLimiter integration
// ==========================================================================
describe('SystemLLMGuard + HouseholdLLMLimiter integration', () => {
	const logger = pino({ level: 'silent' });

	function makeGuardWithHH(overrides: { hhLimiter?: ReturnType<typeof createMockHouseholdLimiter> } = {}) {
		const hhLimiter = overrides.hhLimiter ?? createMockHouseholdLimiter();
		const ct = createMockCostTracker();
		const inner: LLMService = {
			complete: vi.fn().mockResolvedValue('ok'),
			classify: vi.fn().mockResolvedValue({ category: 'a', confidence: 0.9 }),
			extractStructured: vi.fn().mockResolvedValue({ key: 'v' }),
		};
		const g = new SystemLLMGuard({
			inner,
			costTracker: ct,
			globalMonthlyCostCap: 50,
			logger,
			householdLimiter: hhLimiter,
		});
		return { guard: g, hhLimiter, costTracker: ct, inner };
	}

	it('household rate denied → LLMRateLimitError{scope:household}; inner NOT called', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			check: vi.fn().mockReturnValue({ allowed: false, commit: vi.fn(), limit: { maxRequests: 200, windowSeconds: 3600 } }),
		});
		const { guard, inner } = makeGuardWithHH({ hhLimiter });
		await expect(
			requestContext.run({ userId: 'u1', householdId: 'h1' }, () => guard.complete('hi')),
		).rejects.toThrow(LLMRateLimitError);
		expect(inner.complete).not.toHaveBeenCalled();
	});

	it('household cost denied → LLMCostCapError{scope:household}; inner NOT called', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			checkCost: vi.fn().mockImplementation(() => {
				throw new LLMCostCapError({ scope: 'household', householdId: 'h1', currentCost: 20, cap: 20 });
			}),
		});
		const { guard, inner } = makeGuardWithHH({ hhLimiter });
		await expect(
			requestContext.run({ userId: 'u1', householdId: 'h1' }, () => guard.complete('hi')),
		).rejects.toMatchObject({ scope: 'household' });
		expect(inner.complete).not.toHaveBeenCalled();
	});

	it('global cap exceeded → LLMCostCapError{scope:global}; household checks still happen first', async () => {
		const hhLimiter = createMockHouseholdLimiter();
		const ct = createMockCostTracker(0, 50.0);
		const inner: LLMService = { complete: vi.fn().mockResolvedValue('ok'), classify: vi.fn(), extractStructured: vi.fn() };
		const g = new SystemLLMGuard({ inner, costTracker: ct, globalMonthlyCostCap: 50, logger, householdLimiter: hhLimiter });
		await expect(
			requestContext.run({ userId: 'u1', householdId: 'h1' }, () => g.complete('hi')),
		).rejects.toMatchObject({ scope: 'global' });
		expect(inner.complete).not.toHaveBeenCalled();
	});

	it('success: releaseReservation called once with (id, null)', async () => {
		const { guard, hhLimiter } = makeGuardWithHH();
		(hhLimiter.reserveEstimated as ReturnType<typeof vi.fn>).mockReturnValue('res-99');
		await requestContext.run({ userId: 'u1', householdId: 'h1' }, () => guard.complete('hi'));
		expect(hhLimiter.releaseReservation).toHaveBeenCalledTimes(1);
		expect(hhLimiter.releaseReservation).toHaveBeenCalledWith('res-99', null);
	});

	it('platform householdId: household checks skipped; reserveEstimated returns noop', async () => {
		const { guard, hhLimiter, costTracker: ct } = makeGuardWithHH();
		await requestContext.run({ userId: 'u1', householdId: undefined }, () => guard.complete('hi'));
		// Platform attribution: checkCost not called on CostTracker for household cost
		expect(ct.getMonthlyHouseholdCost).not.toHaveBeenCalled();
		// releaseReservation still called (noop internally for PLATFORM_NOOP)
		expect(hhLimiter.releaseReservation).toHaveBeenCalledTimes(1);
	});

	it('requestContext householdId=PLATFORM_SYSTEM_HOUSEHOLD_ID: household checks skipped', async () => {
		const { guard, costTracker: ct } = makeGuardWithHH();
		await requestContext.run({ userId: 'u1', householdId: PLATFORM_SYSTEM_HOUSEHOLD_ID }, () => guard.complete('hi'));
		expect(ct.getMonthlyHouseholdCost).not.toHaveBeenCalled();
	});

	it('inner rejects: releaseReservation called once; error propagates', async () => {
		const hhLimiter = createMockHouseholdLimiter();
		(hhLimiter.reserveEstimated as ReturnType<typeof vi.fn>).mockReturnValue('res-err');
		const ct = createMockCostTracker();
		const inner: LLMService = { complete: vi.fn().mockRejectedValue(new Error('provider down')), classify: vi.fn(), extractStructured: vi.fn() };
		const g = new SystemLLMGuard({ inner, costTracker: ct, globalMonthlyCostCap: 50, logger, householdLimiter: hhLimiter });
		await expect(
			requestContext.run({ userId: 'u1', householdId: 'h1' }, () => g.complete('hi')),
		).rejects.toThrow('provider down');
		expect(hhLimiter.releaseReservation).toHaveBeenCalledWith('res-err', null);
	});
});
