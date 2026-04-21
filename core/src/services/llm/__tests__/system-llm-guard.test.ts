import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMCompletionOptions, LLMService } from '../../../types/llm.js';
import { LLMCostCapError } from '../errors.js';
import { SystemLLMGuard } from '../system-llm-guard.js';
import { createMockCostTracker } from './helpers/mock-cost-tracker.js';

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
