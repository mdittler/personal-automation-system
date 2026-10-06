import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ChatMessage,
	LLMCompletionOptions,
	LLMService,
	ModelRef,
} from '../../../types/llm.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../../config/defaults.js';
import { requestContext } from '../../context/request-context.js';
import { CostTracker } from '../cost-tracker.js';
import { LLMCostCapError, LLMRateLimitError } from '../errors.js';
import type { PriceLookup } from '../estimate-guard-cost.js';
import { HouseholdLLMLimiter } from '../household-llm-limiter.js';
import { LLMGuard, type LLMGuardConfig, type LLMGuardOptions } from '../llm-guard.js';
import { createMockCostTracker } from './helpers/mock-cost-tracker.js';
import {
	PLATFORM_NOOP_RESERVATION,
	createMockHouseholdLimiter,
} from './helpers/mock-household-limiter.js';

const logger = pino({ level: 'silent' });

function createMockInner(): LLMService {
	return {
		// Default response is valid JSON so extractStructured can parse it
		complete: vi.fn().mockResolvedValue('{"category":"test","confidence":0.9}'),
		classify: vi.fn().mockResolvedValue({ category: 'test', confidence: 0.9 }),
		extractStructured: vi.fn().mockResolvedValue({ key: 'value' }),
		chat: vi.fn().mockResolvedValue({
			message: { role: 'assistant', content: 'ok' },
			finishReason: 'stop',
			model: 'm',
			provider: 'p',
		}),
		supportsTools: vi.fn(),
		supportsVision: vi.fn(),
	};
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

		it('uses per-call tier override for reservation estimation', async () => {
			const hhLimiter = createMockHouseholdLimiter();
			guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker,
				config: defaultConfig,
				logger,
				householdLimiter: hhLimiter,
				tier: 'fast',
				priceLookup: {
					priceFor: (tier) =>
						tier === 'standard'
							? { inputUsdPer1k: 10, outputUsdPer1k: 10 }
							: { inputUsdPer1k: 1, outputUsdPer1k: 1 },
				},
			});

			await requestContext.run({ userId: 'u1', householdId: 'h1' }, () =>
				guard.complete('x'.repeat(4000), { tier: 'standard', maxTokens: 1000 }),
			);

			expect(hhLimiter.reserveEstimated).toHaveBeenCalledWith('h1', 'test-app', 'u1', 20);
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
			const err = new LLMCostCapError({
				scope: 'app',
				appId: 'my-app',
				currentCost: 11.5,
				cap: 10.0,
			});
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
			chat: vi.fn(),
			supportsTools: vi.fn(),
			supportsVision: vi.fn(),
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

// ==========================================================================
// LLMGuard + HouseholdLLMLimiter integration tests
// ==========================================================================
describe('LLMGuard + HouseholdLLMLimiter integration', () => {
	function makeGuardWithHH(
		overrides: { hhLimiter?: ReturnType<typeof createMockHouseholdLimiter> } = {},
	) {
		const hhLimiter = overrides.hhLimiter ?? createMockHouseholdLimiter();
		const ct = createMockCostTracker();
		const innerSvc = createMockInner();
		const g = new LLMGuard({
			inner: innerSvc,
			appId: 'chatbot',
			costTracker: ct,
			config: defaultConfig,
			logger,
			householdLimiter: hhLimiter,
		});
		return { guard: g, hhLimiter, costTracker: ct, inner: innerSvc };
	}

	it('app rate denied: household check NOT called; nothing committed; nothing reserved', async () => {
		const { guard, hhLimiter } = makeGuardWithHH();
		// Exhaust app rate
		for (let i = 0; i < defaultConfig.maxRequests; i++) await guard.complete('hi');
		vi.clearAllMocks();

		await expect(guard.complete('hi')).rejects.toThrow(LLMRateLimitError);
		expect(hhLimiter.check).not.toHaveBeenCalled();
		expect(hhLimiter.reserveEstimated).not.toHaveBeenCalled();
	});

	it('household rate denied: no app rate slot committed on either', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			check: vi.fn().mockReturnValue({
				allowed: false,
				commit: vi.fn(),
				limit: { maxRequests: 200, windowSeconds: 3600 },
			}),
		});
		const { guard } = makeGuardWithHH({ hhLimiter });
		await expect(guard.complete('hi')).rejects.toThrow(LLMRateLimitError);
		expect(hhLimiter.reserveEstimated).not.toHaveBeenCalled();
	});

	it('household cost denied: no rate commits; no reserve; inner NOT called', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			checkCost: vi.fn().mockImplementation(() => {
				throw new LLMCostCapError({
					scope: 'household',
					householdId: 'h1',
					currentCost: 20,
					cap: 20,
				});
			}),
		});
		const { guard, inner } = makeGuardWithHH({ hhLimiter });
		await expect(guard.complete('hi')).rejects.toMatchObject({ scope: 'household' });
		expect(hhLimiter.reserveEstimated).not.toHaveBeenCalled();
		expect(inner.complete).not.toHaveBeenCalled();
	});

	it('success path: releaseReservation called exactly once with (id, null)', async () => {
		const { guard, hhLimiter } = makeGuardWithHH();
		(hhLimiter.reserveEstimated as any).mockReturnValue('res-42');
		await guard.complete('hi');
		expect(hhLimiter.releaseReservation).toHaveBeenCalledTimes(1);
		expect(hhLimiter.releaseReservation).toHaveBeenCalledWith('res-42', null);
	});

	it('inner rejects: releaseReservation called once; original error propagates', async () => {
		const hhLimiter = createMockHouseholdLimiter();
		(hhLimiter.reserveEstimated as any).mockReturnValue('res-42');
		const innerSvc = createMockInner();
		(innerSvc.complete as any).mockRejectedValue(new Error('provider down'));
		const ct = createMockCostTracker();
		const g = new LLMGuard({
			inner: innerSvc,
			appId: 'chatbot',
			costTracker: ct,
			config: defaultConfig,
			logger,
			householdLimiter: hhLimiter,
		});

		await expect(g.complete('hi')).rejects.toThrow('provider down');
		expect(hhLimiter.releaseReservation).toHaveBeenCalledTimes(1);
		expect(hhLimiter.releaseReservation).toHaveBeenCalledWith('res-42', null);
	});

	it('reserveEstimated throws unexpectedly → both rate slots rolled back; LLMCostCapError(reservation-exceeded)', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			reserveEstimated: vi.fn().mockImplementation(() => {
				throw new Error('cost tracker blew up');
			}),
			revokeLastCheckCommit: vi.fn(),
		});
		const { guard } = makeGuardWithHH({ hhLimiter });
		await expect(guard.complete('hi')).rejects.toMatchObject({ scope: 'reservation-exceeded' });
		expect(hhLimiter.revokeLastCheckCommit).toHaveBeenCalled();
		expect(hhLimiter.releaseReservation).not.toHaveBeenCalled();
	});

	it('platform context: PLATFORM_NOOP returned; costTracker.reserveEstimated never called', async () => {
		const { guard, hhLimiter, costTracker: ct } = makeGuardWithHH();
		(hhLimiter.reserveEstimated as any).mockReturnValue(PLATFORM_NOOP_RESERVATION);
		await requestContext.run({ userId: 'u1', householdId: undefined }, async () => {
			await guard.complete('hi');
		});
		expect(ct.reserveEstimated).not.toHaveBeenCalled();
	});

	it('household rate error carries override limit metadata from check().limit', async () => {
		const hhLimiter = createMockHouseholdLimiter({
			check: vi.fn().mockReturnValue({
				allowed: false,
				commit: vi.fn(),
				limit: { maxRequests: 400, windowSeconds: 1800 },
			}),
		});
		const { guard } = makeGuardWithHH({ hhLimiter });
		const err = (await guard.complete('hi').catch((e: unknown) => e)) as LLMRateLimitError;
		expect(err.scope).toBe('household');
		expect(err.maxRequests).toBe(400);
		expect(err.windowSeconds).toBe(1800);
	});
});

describe('LLMGuard.chat (REQ-LLM-045)', () => {
	const USER: ChatMessage[] = [{ role: 'user', content: 'hi' }];

	function makeGuard(inner: LLMService, overrides: Partial<LLMGuardOptions> = {}) {
		return new LLMGuard({
			inner,
			appId: 'test-app',
			costTracker: createMockCostTracker(),
			config: defaultConfig,
			logger: pino({ level: 'silent' }),
			...overrides,
		});
	}

	it('runs chat through the guard: rate slot committed, _appId injected, result passed through', async () => {
		const inner = createMockInner();
		const guard = makeGuard(inner);
		const result = await guard.chat(USER, { maxTokens: 10 });
		expect(result.message.content).toBe('ok');
		expect(inner.chat).toHaveBeenCalledWith(
			USER,
			expect.objectContaining({ maxTokens: 10, _appId: 'test-app' }),
		);
		expect(guard.rateLimiter.getRemainingAttempts('test-app')).toBe(defaultConfig.maxRequests - 1);
		guard.dispose();
	});

	it('refuses chat when the app monthly cost cap is reached (same gate as complete), without calling inner', async () => {
		const inner = createMockInner();
		const guard = makeGuard(inner, {
			costTracker: createMockCostTracker(defaultConfig.monthlyCostCap),
		});
		await expect(guard.chat(USER)).rejects.toBeInstanceOf(LLMCostCapError);
		expect(inner.chat).not.toHaveBeenCalled();
		guard.dispose();
	});

	it('reserves an estimate that grows with the tool list (message text + tool JSON)', async () => {
		const inner = createMockInner();
		const priceLookup = { priceFor: () => ({ inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 }) };
		const small = createMockHouseholdLimiter();
		await makeGuard(inner, {
			householdLimiter: small as unknown as HouseholdLLMLimiter,
			priceLookup,
		}).chat(USER);
		const big = createMockHouseholdLimiter();
		const bigTool = { name: 't', description: 'x'.repeat(8000), inputSchema: { type: 'object' } };
		await makeGuard(inner, {
			householdLimiter: big as unknown as HouseholdLLMLimiter,
			priceLookup,
		}).chat(USER, { tools: [bigTool] });
		const estSmall = (small.reserveEstimated as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[3] as number;
		const estBig = (big.reserveEstimated as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as number;
		expect(estBig).toBeGreaterThan(estSmall);
	});

	it('supportsTools / supportsVision delegate to the inner service', async () => {
		const inner = createMockInner();
		(inner.supportsTools as ReturnType<typeof vi.fn>).mockResolvedValue(true);
		const guard = makeGuard(inner);
		await expect(guard.supportsTools({ provider: 'p', model: 'm' })).resolves.toBe(true);
		expect(inner.supportsTools).toHaveBeenCalledWith({ provider: 'p', model: 'm' });
		guard.dispose();
	});

	// R1-5 at the guard boundary — the estimate must see tool-call history, not
	// just content. Lives INSIDE this describe so `makeGuard` and `USER` are in
	// scope (P2-3: an earlier draft placed it after the closing brace -> TS2304).
	it('reserves an estimate that grows with replayed tool-call arguments (R1-5: 100k chars of tool-call history)', async () => {
		const inner = createMockInner();
		const priceLookup = { priceFor: () => ({ inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 }) };
		const small = createMockHouseholdLimiter();
		await makeGuard(inner, {
			householdLimiter: small as unknown as HouseholdLLMLimiter,
			priceLookup,
		}).chat(USER);
		const big = createMockHouseholdLimiter();
		const history: ChatMessage[] = [
			...USER,
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 't', arguments: { blob: 'x'.repeat(100_000) } }],
			},
			{ role: 'tool', content: 'ok', toolCallId: 'call_1' },
		];
		await makeGuard(inner, {
			householdLimiter: big as unknown as HouseholdLLMLimiter,
			priceLookup,
		}).chat(history);
		const estSmall = (small.reserveEstimated as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[3] as number;
		const estBig = (big.reserveEstimated as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as number;
		// 100k chars ~ 25k tokens at $0.001/1k ~ $0.025 more than the two-word prompt.
		expect(estBig - estSmall).toBeGreaterThan(0.02);
	});
});

describe('LLMGuard prices the model that serves the request, not the default tier (P2-1)', () => {
	const USER: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(40_000) }]; // ~10k tokens
	const PROMPT = 'x'.repeat(40_000);
	const HAIKU: ModelRef = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
	const HOUSEHOLD = 'h1';
	/** Fast tier is local ($0); an explicit Claude ref is paid. Mirrors createGuardPriceLookup's contract. */
	const localFastPaidClaude: PriceLookup = {
		hasBillableProvider: () => true,
		priceFor: (tier) =>
			tier === 'fast'
				? { inputUsdPer1k: 0, outputUsdPer1k: 0 }
				: { inputUsdPer1k: 0.003, outputUsdPer1k: 0.015 },
		priceForRef: (ref) =>
			ref.provider === 'anthropic'
				? { inputUsdPer1k: 0.001, outputUsdPer1k: 0.005 }
				: { inputUsdPer1k: 0, outputUsdPer1k: 0 },
	};

	/** Real HouseholdLLMLimiter so checkCost's arithmetic is the production one; household already at $9.99 of a $10 cap. */
	function makeGuardNearCap(inner: LLMService) {
		const costTracker = createMockCostTracker(0, 0, 9.99);
		const householdLimiter = new HouseholdLLMLimiter({
			costTracker,
			config: { ...DEFAULT_LLM_SAFEGUARDS, defaultHouseholdMonthlyCostCap: 10 },
			logger: pino({ level: 'silent' }),
		});
		return new LLMGuard({
			inner,
			appId: 'test-app',
			costTracker,
			config: defaultConfig,
			logger: pino({ level: 'silent' }),
			householdLimiter,
			priceLookup: localFastPaidClaude,
		});
	}

	it('household budget — chat: a paid explicit modelRef on a local fast tier is refused by HouseholdLLMLimiter.checkCost when the household is just under its cap (the fast-tier estimate would have been $0 and admitted it)', async () => {
		const inner = createMockInner();
		const guard = makeGuardNearCap(inner);
		await requestContext.run({ userId: 'u1', householdId: HOUSEHOLD }, async () => {
			// Control: no modelRef -> fast tier -> local -> $0 estimate -> admitted.
			await expect(guard.chat(USER)).resolves.toBeDefined();
			// The paid model: ~10k input tokens x $0.001/1k + 1024 x $0.005/1k ~ $0.015 -> 9.99 + 0.015 >= 10 -> refused.
			await expect(guard.chat(USER, { modelRef: HAIKU })).rejects.toMatchObject({
				scope: 'household',
			});
		});
		expect(inner.chat).toHaveBeenCalledTimes(1);
		guard.dispose();
	});

	it('household budget — complete(): the same bypass existed at HEAD on the completion path and is closed too', async () => {
		const inner = createMockInner();
		const guard = makeGuardNearCap(inner);
		await requestContext.run({ userId: 'u1', householdId: HOUSEHOLD }, async () => {
			await expect(guard.complete(PROMPT)).resolves.toBeDefined();
			await expect(guard.complete(PROMPT, { modelRef: HAIKU })).rejects.toMatchObject({
				scope: 'household',
			});
			await expect(guard.completeWithMeta(PROMPT, { modelRef: HAIKU })).rejects.toMatchObject({
				scope: 'household',
			});
		});
		expect(inner.complete).toHaveBeenCalledTimes(1);
		guard.dispose();
	});

	it("legacy `model: 'claude'` routes to the standard tier in LLMServiceImpl, so the guard prices it as standard, not fast", async () => {
		const inner = createMockInner();
		const hh = createMockHouseholdLimiter();
		const guard = new LLMGuard({
			inner,
			appId: 'test-app',
			costTracker: createMockCostTracker(),
			config: defaultConfig,
			logger: pino({ level: 'silent' }),
			householdLimiter: hh as unknown as HouseholdLLMLimiter,
			priceLookup: localFastPaidClaude,
		});
		await requestContext.run({ userId: 'u1', householdId: HOUSEHOLD }, () =>
			guard.complete(PROMPT, { model: 'claude' }),
		);
		const est = (hh.reserveEstimated as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as number;
		expect(est).toBeGreaterThan(0); // standard tier price, not the $0 local fast tier
		guard.dispose();
	});

	it('an explicit modelRef the lookup cannot price falls back to the default reservation, never to the tier price', async () => {
		const inner = createMockInner();
		const hh = createMockHouseholdLimiter();
		const cannotPriceRef: PriceLookup = { ...localFastPaidClaude, priceForRef: () => undefined };
		const guard = new LLMGuard({
			inner,
			appId: 'test-app',
			costTracker: createMockCostTracker(),
			config: defaultConfig,
			logger: pino({ level: 'silent' }),
			householdLimiter: hh as unknown as HouseholdLLMLimiter,
			priceLookup: cannotPriceRef,
		});
		await requestContext.run({ userId: 'u1', householdId: HOUSEHOLD }, () =>
			guard.chat(USER, { modelRef: { provider: 'ghost', model: 'm' } }),
		);
		const est = (hh.reserveEstimated as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as number;
		expect(est).toBe(DEFAULT_LLM_SAFEGUARDS.defaultReservationUsd);
		guard.dispose();
	});
});
