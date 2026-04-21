import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMCompletionOptions, LLMService } from '../../../types/llm.js';
import { CostTracker } from '../cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from '../errors.js';
import { LLMGuard, type LLMGuardConfig } from '../llm-guard.js';

const logger = pino({ level: 'silent' });

function createMockInner(): LLMService {
	return {
		// Default response is valid JSON so extractStructured can parse it
		complete: vi.fn().mockResolvedValue('{"category":"test","confidence":0.9}'),
		classify: vi.fn().mockResolvedValue({ category: 'test', confidence: 0.9 }),
		extractStructured: vi.fn().mockResolvedValue({ key: 'value' }),
	};
}

function createMockCostTracker(appCost = 0, totalCost = 0): CostTracker {
	return {
		getMonthlyAppCost: vi.fn().mockReturnValue(appCost),
		getMonthlyTotalCost: vi.fn().mockReturnValue(totalCost),
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
		loadMonthlyCache: vi.fn().mockResolvedValue(undefined),
		flush: vi.fn().mockResolvedValue(undefined),
	} as unknown as CostTracker;
}

const defaultConfig: LLMGuardConfig = {
	maxRequests: 10,
	windowSeconds: 60,
	monthlyCostCap: 10.0,
	globalMonthlyCostCap: 50.0,
};

describe('LLMGuard', () => {
	let inner: LLMService;
	let costTracker: CostTracker;
	let guard: LLMGuard;

	beforeEach(() => {
		inner = createMockInner();
		costTracker = createMockCostTracker();
		guard = new LLMGuard({
			inner,
			appId: 'test-app',
			costTracker,
			config: defaultConfig,
			logger,
		});
	});

	describe('complete()', () => {
		it('delegates to inner service with _appId injected', async () => {
			const result = await guard.complete('hello', { tier: 'standard' });

			expect(result).toBe('{"category":"test","confidence":0.9}');
			expect(inner.complete).toHaveBeenCalledWith('hello', {
				tier: 'standard',
				_appId: 'test-app',
			});
		});

		it('injects _appId even with no options', async () => {
			await guard.complete('hello');

			expect(inner.complete).toHaveBeenCalledWith('hello', {
				_appId: 'test-app',
			});
		});

		it('preserves all existing options', async () => {
			const opts: LLMCompletionOptions = {
				tier: 'fast',
				temperature: 0.5,
				maxTokens: 100,
				systemPrompt: 'Be helpful',
			};

			await guard.complete('hello', opts);

			expect(inner.complete).toHaveBeenCalledWith('hello', {
				...opts,
				_appId: 'test-app',
			});
		});

		it('throws LLMRateLimitError when rate limit exceeded', async () => {
			// Exhaust rate limit
			for (let i = 0; i < defaultConfig.maxRequests; i++) {
				await guard.complete('hello');
			}

			await expect(guard.complete('hello')).rejects.toThrow(LLMRateLimitError);
			await expect(guard.complete('hello')).rejects.toThrow(/exceeded LLM rate limit/);
		});

		it('throws LLMCostCapError when per-app cost cap exceeded', async () => {
			costTracker = createMockCostTracker(10.01, 10.01);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			await expect(guard.complete('hello')).rejects.toThrow(LLMCostCapError);
			const err = await guard.complete('hello').catch((e) => e);
			expect(err.scope).toBe('app');
			expect(err.appId).toBe('test-app');
		});

		it('throws LLMCostCapError when global cost cap exceeded', async () => {
			costTracker = createMockCostTracker(0, 50.0);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			await expect(guard.complete('hello')).rejects.toThrow(LLMCostCapError);
			const err = await guard.complete('hello').catch((e) => e);
			expect(err.scope).toBe('global');
		});

		it('checks per-app cap before global cap', async () => {
			costTracker = createMockCostTracker(10.01, 50.01);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			const err = await guard.complete('hello').catch((e) => e);
			expect(err.scope).toBe('app');
		});
	});

	describe('classify()', () => {
		it('checks rate limit and cost cap', async () => {
			// Exhaust rate limit
			for (let i = 0; i < defaultConfig.maxRequests; i++) {
				// Use complete to fill rate limit
				await guard.complete('hello');
			}

			await expect(guard.classify('text', ['a', 'b'])).rejects.toThrow(LLMRateLimitError);
		});

		it('routes through inner.complete with _appId (not inner.classify)', async () => {
			await guard.classify('classify this', ['cat1', 'cat2']);

			// classify() should use inner.complete (via the wrapped client),
			// NOT inner.classify directly
			expect(inner.classify).not.toHaveBeenCalled();
			// The wrapped client calls inner.complete
			expect(inner.complete).toHaveBeenCalled();
			// Verify _appId was injected
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('test-app');
		});

		it('counts as one rate limit request (not double-counted)', async () => {
			// Set rate limit to 2
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: { ...defaultConfig, maxRequests: 2 },
				logger,
			});

			// First call: should succeed (1 rate limit hit from classify, not 2)
			await guard.classify('text', ['a', 'b']);

			// Second call: should still succeed (only 1 used so far)
			await guard.classify('text', ['a', 'b']);

			// Third call: should fail (2 already used)
			await expect(guard.classify('text', ['a', 'b'])).rejects.toThrow(LLMRateLimitError);
		});
	});

	describe('extractStructured()', () => {
		it('checks rate limit and cost cap', async () => {
			costTracker = createMockCostTracker(10.01);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			await expect(guard.extractStructured('text', { type: 'object' })).rejects.toThrow(
				LLMCostCapError,
			);
		});

		it('routes through inner.complete with _appId', async () => {
			await guard.extractStructured('extract this', { type: 'object' });

			expect(inner.extractStructured).not.toHaveBeenCalled();
			expect(inner.complete).toHaveBeenCalled();
			const callArgs = (inner.complete as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(callArgs[1]?._appId).toBe('test-app');
		});
	});

	describe('dispose()', () => {
		it('stops the rate limiter cleanup timer', () => {
			// Should not throw
			guard.dispose();
		});

		it('is idempotent — double dispose does not throw', () => {
			guard.dispose();
			// Second dispose should also not throw
			guard.dispose();
		});
	});

	describe('boundary conditions', () => {
		it('blocks when cost is exactly at cap (>= not >)', async () => {
			costTracker = createMockCostTracker(10.0, 10.0);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			await expect(guard.complete('hello')).rejects.toThrow(LLMCostCapError);
		});

		it('allows when cost is just below cap', async () => {
			costTracker = createMockCostTracker(9.99, 9.99);
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
			});

			const result = await guard.complete('hello');
			expect(result).toBeDefined();
		});
	});

	describe('error propagation', () => {
		it('propagates inner service errors unchanged', async () => {
			const innerError = new Error('Provider unavailable');
			(inner.complete as ReturnType<typeof vi.fn>).mockRejectedValue(innerError);

			await expect(guard.complete('hello')).rejects.toThrow('Provider unavailable');
		});
	});

	describe('config validation', () => {
		it('accepts valid config without throwing', () => {
			const validGuard = new LLMGuard({
				inner,
				appId: 'valid-app',
				costTracker,
				config: {
					maxRequests: 5,
					windowSeconds: 30,
					monthlyCostCap: 5.0,
					globalMonthlyCostCap: 25.0,
				},
				logger,
			});
			expect(validGuard).toBeDefined();
			validGuard.dispose();
		});

		it('rejects NaN monthlyCostCap', () => {
			expect(
				() =>
					new LLMGuard({
						inner,
						appId: 'test-app',
						costTracker,
						config: { ...defaultConfig, monthlyCostCap: Number.NaN },
						logger,
					}),
			).toThrow(/invalid monthlyCostCap/);
		});

		it('rejects zero monthlyCostCap', () => {
			expect(
				() =>
					new LLMGuard({
						inner,
						appId: 'test-app',
						costTracker,
						config: { ...defaultConfig, monthlyCostCap: 0 },
						logger,
					}),
			).toThrow(/invalid monthlyCostCap/);
		});

		it('rejects negative globalMonthlyCostCap', () => {
			expect(
				() =>
					new LLMGuard({
						inner,
						appId: 'test-app',
						costTracker,
						config: { ...defaultConfig, globalMonthlyCostCap: -5 },
						logger,
					}),
			).toThrow(/invalid globalMonthlyCostCap/);
		});

		it('rejects zero maxRequests', () => {
			expect(
				() =>
					new LLMGuard({
						inner,
						appId: 'test-app',
						costTracker,
						config: { ...defaultConfig, maxRequests: 0 },
						logger,
					}),
			).toThrow(/invalid rate limit/);
		});
	});

	describe('error details', () => {
		it('LLMRateLimitError includes correct details', () => {
			const err = new LLMRateLimitError({ appId: 'my-app', maxRequests: 100, windowSeconds: 3600 });
			expect(err.name).toBe('LLMRateLimitError');
			expect(err.appId).toBe('my-app');
			expect(err.maxRequests).toBe(100);
			expect(err.windowSeconds).toBe(3600);
			expect(err.message).toContain('my-app');
			expect(err.message).toContain('100');
		});

		it('LLMCostCapError includes correct details for app scope', () => {
			const err = new LLMCostCapError({ scope: 'app', appId: 'my-app', currentCost: 11.5, cap: 10.0 });
			expect(err.name).toBe('LLMCostCapError');
			expect(err.scope).toBe('app');
			expect(err.currentCost).toBe(11.5);
			expect(err.cap).toBe(10.0);
			expect(err.appId).toBe('my-app');
			expect(err.message).toContain('my-app');
			expect(err.message).toContain('$11.50');
		});

		it('LLMCostCapError includes correct details for global scope', () => {
			const err = new LLMCostCapError({ scope: 'global', currentCost: 55.0, cap: 50.0 });
			expect(err.scope).toBe('global');
			expect(err.message).toContain('Global');
			expect(err.message).toContain('$55.00');
		});
	});
});

// Gap 8: integration test with real CostTracker — unknown-model conservative pricing blocks the guard
describe('LLMGuard + CostTracker — unknown-model cost cap integration (Gap 8)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-guard-cost-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('blocks calls after unknown-model usage accumulates conservative cost past the per-app cap', async () => {
		const realTracker = new CostTracker(tempDir, pino({ level: 'silent' }));
		await realTracker.loadMonthlyCache();

		// DEFAULT_REMOTE_PRICING = $3/M input + $15/M output.
		// 1000 in + 1000 out ≈ $0.018 — above the tiny $0.01 cap below.
		await realTracker.record({
			appId: 'unknown-app',
			model: 'unknown-remote-gpt-xyz',
			provider: 'openai',
			inputTokens: 1000,
			outputTokens: 1000,
		});

		// Accumulated cost should be non-zero (conservative fallback was applied)
		expect(realTracker.getMonthlyAppCost('unknown-app')).toBeGreaterThan(0);

		const inner: LLMService = {
			complete: vi.fn().mockResolvedValue('ok'),
			classify: vi.fn(),
			extractStructured: vi.fn(),
		};
		const guard = new LLMGuard({
			inner,
			appId: 'unknown-app',
			costTracker: realTracker,
			config: {
				maxRequests: 100,
				windowSeconds: 60,
				monthlyCostCap: 0.01, // below the ~$0.018 already accumulated
				globalMonthlyCostCap: 100.0,
			},
			logger: pino({ level: 'silent' }),
		});

		// Guard reads accumulated cost ≥ cap → blocks the call
		const err = await guard.complete('hello').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LLMCostCapError);
		expect((err as LLMCostCapError).scope).toBe('app');

		guard.dispose();
		await realTracker.flush();
	});
});
