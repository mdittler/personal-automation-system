import { describe, expect, it, vi } from 'vitest';
import { runRoutingCase } from '../runner/case-runners/routing-runner.js';
import { MeteredError } from '../runner/dispatch.js';
import type { PersonaCase, TierModelSnapshot } from '../shared/types.js';
import { VERDICT } from '../shared/types.js';

const MODEL_IDS: TierModelSnapshot = {
	fast: 'claude-fast-1',
	standard: 'claude-standard-1',
	reasoning: null,
};

const meter = (
	overrides: Partial<{ model: string; tokenIn: number; tokenOut: number; costUsd: number }> = {},
) => ({
	model: 'claude-fast-1',
	tokenIn: 50,
	tokenOut: 30,
	costUsd: 0.00005,
	...overrides,
});

const baseDeps = () => ({
	modelIds: MODEL_IDS,
	cacheKey: 'a'.repeat(64),
	caseBudgetUsd: 0.5,
	estimateUsd: () => 0.0001,
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
	classifiers: {
		foodShadow: vi.fn(),
		sessionControl: vi.fn(),
		pas: vi.fn(),
	},
});

const baseCase = (
	target: 'food-shadow' | 'session-control' | 'pas',
	expected: unknown,
	payloads: string[] = ['x'],
): PersonaCase => ({
	id: `routing-${target}-happy`,
	description: 'happy',
	bucket: 'routing',
	routingTarget: target,
	coverage: ['apps/food/src/routing/shadow-classifier.ts'],
	inputs: payloads.map((payload) => ({ payload, expected })),
	oracle: 'structural',
	budgetUsd: 0.05,
});

describe('runRoutingCase — food-shadow happy path', () => {
	it('verdict=pass when classifier action matches expected label', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockResolvedValueOnce({
			raw: JSON.stringify({ action: 'user wants to save a recipe', confidence: 0.92 }),
			meter: meter(),
		});
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action', 'confidence'],
					properties: {
						action: { type: 'string' },
						confidence: { type: 'number' },
					},
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
			},
			['save this recipe'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.pass);
		expect(result.oracleVerdicts[0]!.verdict).toBe(VERDICT.pass);
		expect(result.costUsd).toBeCloseTo(0.00005, 7);
		expect(result.tokenCounts).toEqual({ input: 50, output: 30 });
		expect(result.modelIds).toEqual(MODEL_IDS);
		expect(result.source).toBe('fresh');
	});
});

describe('runRoutingCase — session-control happy path', () => {
	it('verdict=pass when detectSessionControl intent matches expected', async () => {
		const deps = baseDeps();
		deps.classifiers.sessionControl.mockResolvedValueOnce({
			raw: JSON.stringify({
				intent: 'new_session',
				confidence: 1.0,
				reason: 'command: /newchat',
				source: 'prefilter',
			}),
			meter: meter({ model: 'prefilter', tokenIn: 0, tokenOut: 0, costUsd: 0 }),
		});
		const c = baseCase(
			'session-control',
			{
				schema: {
					type: 'object',
					required: ['intent'],
					properties: { intent: { type: 'string' } },
				},
				strings: [{ path: 'intent', expectedCaseInsensitive: 'new_session' }],
			},
			['/newchat'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.pass);
		expect(result.costUsd).toBe(0); // prefilter — no LLM hit
	});
});

describe('runRoutingCase — pas happy path', () => {
	it('verdict=pass when pasRelated matches', async () => {
		const deps = baseDeps();
		deps.classifiers.pas.mockResolvedValueOnce({
			raw: JSON.stringify({
				pasRelated: true,
				dataQueryCandidate: false,
				settingsCandidate: false,
			}),
			meter: meter(),
		});
		const c = baseCase(
			'pas',
			{
				schema: {
					type: 'object',
					required: ['pasRelated'],
					properties: { pasRelated: { type: 'boolean', const: true } },
				},
			},
			['what apps do I have?'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.pass);
	});
});

describe('runRoutingCase — verdict=fail when expected label disagrees', () => {
	it('food-shadow wrong label → fail', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockResolvedValueOnce({
			raw: JSON.stringify({ action: 'none', confidence: 0.4 }),
			meter: meter(),
		});
		const c = baseCase('food-shadow', {
			schema: {
				type: 'object',
				required: ['action'],
				properties: { action: { type: 'string' } },
			},
			strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
		});
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.fail);
	});
});

describe('runRoutingCase — deps.caseBudgetUsd authority', () => {
	it('honours deps.caseBudgetUsd over c.budgetUsd when smaller', async () => {
		const deps = { ...baseDeps(), caseBudgetUsd: 0.00005, estimateUsd: () => 0.0001 };
		const c: PersonaCase = {
			...baseCase('food-shadow', { schema: { type: 'object' } }),
			budgetUsd: 99.0, // huge — must be ignored
			inputs: [{ payload: 'a', expected: { schema: { type: 'object' } } }],
		};
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.budgetExceeded);
		expect(deps.classifiers.foodShadow).not.toHaveBeenCalled();
	});
});

describe('runRoutingCase — parse-failed surfaces as fail/error', () => {
	it('non-JSON raw output → oracle verdict=error (not adapter throw)', async () => {
		const deps = baseDeps();
		// Adapter does NOT throw on parse-failed; it returns the raw output.
		deps.classifiers.foodShadow.mockResolvedValueOnce({
			raw: 'I think the user wants to save a recipe but I am not sure',
			meter: meter(),
		});
		const c = baseCase('food-shadow', {
			schema: {
				type: 'object',
				required: ['action', 'confidence'],
				properties: { action: { type: 'string' }, confidence: { type: 'number' } },
			},
			strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
		});
		const result = await runRoutingCase(c, deps);
		// Non-parseable JSON is treated as an oracle error by the structural oracle.
		// REQ-REG-011 accuracy gate counts this against the gate.
		expect(result.oracleVerdicts[0]!.verdict).toBe(VERDICT.error);
		expect(result.verdict).toBe(VERDICT.error);
	});

	it('schema-valid but wrong action → verdict=fail', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockResolvedValueOnce({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: meter(),
		});
		const c = baseCase('food-shadow', {
			schema: {
				type: 'object',
				required: ['action', 'confidence'],
				properties: { action: { type: 'string' }, confidence: { type: 'number' } },
			},
			strings: [{ path: 'action', expectedCaseInsensitive: 'user wants to save a recipe' }],
		});
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.fail);
	});
});

describe('runRoutingCase — trust-boundary table (testing-standards rule 1)', () => {
	it.each([
		['confidence > 1', JSON.stringify({ action: 'none', confidence: 1.5 })],
		['confidence < 0', JSON.stringify({ action: 'none', confidence: -0.1 })],
		['action missing', JSON.stringify({ confidence: 0.9 })],
		['array root', '[]'],
		['null root', 'null'],
		['string root', '"just a string"'],
	])('rejects malformed output: %s', async (_name, raw) => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockResolvedValueOnce({ raw, meter: meter() });
		const c = baseCase('food-shadow', {
			schema: {
				type: 'object',
				required: ['action', 'confidence'],
				properties: {
					action: { type: 'string', enum: ['user wants to save a recipe', 'none'] },
					confidence: { type: 'number', minimum: 0, maximum: 1 },
				},
			},
			strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
		});
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toMatch(/^(fail|error)$/);
	});
});

describe('runRoutingCase — classifier throw is infra error', () => {
	it('LLM-error → verdict=error, costUsd=0', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockRejectedValueOnce(new Error('LLM timeout'));
		const c = baseCase('food-shadow', { schema: { type: 'object' } });
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.error);
		expect(result.costUsd).toBe(0);
		expect(result.tokenCounts).toEqual({ input: 0, output: 0 });
	});
});

describe('runRoutingCase — budget abort precision', () => {
	it('stops dispatching mid-case when pre-charge would exceed deps.caseBudgetUsd', async () => {
		const deps = { ...baseDeps(), caseBudgetUsd: 0.00015, estimateUsd: () => 0.0001 };
		deps.classifiers.foodShadow.mockResolvedValue({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: meter({ costUsd: 0.0001 }),
		});
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['a', 'b', 'c', 'd'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.budgetExceeded);
		// After first call: costUsd=0.0001; next projected (0.0001) would push to 0.0002 > 0.00015 → abort.
		expect(deps.classifiers.foodShadow).toHaveBeenCalledTimes(1);
	});
});

describe('runRoutingCase — verdict precedence (matches receipt-runner)', () => {
	it('error trumps fail; fail trumps pass', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
				meter: meter(),
			}) // pass
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'wrong', confidence: 0.5 }),
				meter: meter(),
			}) // fail
			.mockRejectedValueOnce(new Error('boom')); // error
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['a', 'b', 'c'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.error);
	});
});

describe('runRoutingCase — token + cost aggregation across inputs', () => {
	it('sums meter.tokenIn/tokenOut/costUsd across all dispatched inputs', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
				meter: { model: 'm', tokenIn: 10, tokenOut: 5, costUsd: 0.0001 },
			})
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.6 }),
				meter: { model: 'm', tokenIn: 20, tokenOut: 8, costUsd: 0.0002 },
			});
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['x', 'y'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.pass);
		expect(result.tokenCounts).toEqual({ input: 30, output: 13 });
		expect(result.costUsd).toBeCloseTo(0.0003, 7);
	});
});

describe('runRoutingCase — invalid case shape', () => {
	it('throws when bucket !== routing', async () => {
		const c: PersonaCase = {
			...baseCase('food-shadow', { schema: { type: 'object' } }),
			bucket: 'receipt',
		};
		await expect(runRoutingCase(c, baseDeps())).rejects.toThrow(/bucket/i);
	});

	it('throws when routingTarget missing', async () => {
		const c: PersonaCase = {
			...baseCase('food-shadow', { schema: { type: 'object' } }),
			routingTarget: undefined,
		};
		await expect(runRoutingCase(c, baseDeps())).rejects.toThrow(/routingTarget/i);
	});
});

describe('runRoutingCase — token propagation', () => {
	it('sums meter token counts into RunResult.tokenCounts', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow.mockResolvedValueOnce({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: { model: 'm', tokenIn: 100, tokenOut: 20, costUsd: 0.0001 },
		});
		const c = baseCase('food-shadow', {
			schema: {
				type: 'object',
				required: ['action'],
				properties: { action: { type: 'string' } },
			},
			strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
		});
		const result = await runRoutingCase(c, deps);
		expect(result.tokenCounts).toEqual({ input: 100, output: 20 });
	});

	it('multi-input routing case sums token counts across inputs', async () => {
		const deps = baseDeps();
		deps.classifiers.foodShadow
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
				meter: { model: 'm', tokenIn: 100, tokenOut: 20, costUsd: 0.0001 },
			})
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
				meter: { model: 'm', tokenIn: 150, tokenOut: 30, costUsd: 0.0001 },
			})
			.mockResolvedValueOnce({
				raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
				meter: { model: 'm', tokenIn: 50, tokenOut: 10, costUsd: 0.0001 },
			});
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['a', 'b', 'c'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.tokenCounts).toEqual({ input: 300, output: 60 });
	});

	it('dispatches inputs sequentially so token deltas do not interleave', async () => {
		// Assert sequential dispatch: second adapter call must not start until
		// first resolves — the invariant that CostTracker deltas depend on.
		const callOrder: string[] = [];
		let resolveFirst!: () => void;
		const firstStarted = new Promise<void>((res) => {
			resolveFirst = res;
		});
		let firstResolve!: () => void;
		const firstDone = new Promise<void>((res) => {
			firstResolve = res;
		});

		const deps = baseDeps();
		deps.classifiers.foodShadow
			.mockImplementationOnce(async () => {
				callOrder.push('start-1');
				resolveFirst();
				await firstDone;
				callOrder.push('end-1');
				return {
					raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
					meter: { model: 'm', tokenIn: 10, tokenOut: 2, costUsd: 0 },
				};
			})
			.mockImplementationOnce(async () => {
				callOrder.push('start-2');
				return {
					raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
					meter: { model: 'm', tokenIn: 20, tokenOut: 4, costUsd: 0 },
				};
			});

		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['x', 'y'],
		);

		const runPromise = runRoutingCase(c, deps);
		// Wait for the first call to start, then release it.
		await firstStarted;
		firstResolve();
		const result = await runPromise;

		// end-1 must appear before start-2 — sequential, not concurrent.
		expect(callOrder.indexOf('end-1')).toBeLessThan(callOrder.indexOf('start-2'));
		expect(result.tokenCounts).toEqual({ input: 30, output: 6 });
	});

	it('classifier error before any LLM call contributes 0 tokens for that input', async () => {
		const deps = baseDeps();
		const zeroMeter = { model: 'm', tokenIn: 0, tokenOut: 0, costUsd: 0 };
		deps.classifiers.foodShadow.mockRejectedValueOnce(new MeteredError('infra error', zeroMeter));
		const c = baseCase('food-shadow', { schema: { type: 'object' } });
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.error);
		expect(result.tokenCounts).toEqual({ input: 0, output: 0 });
	});

	it('classifier error after the tracker advanced still counts the spent tokens', async () => {
		const deps = baseDeps();
		const partialMeter = { model: 'm', tokenIn: 80, tokenOut: 15, costUsd: 0.00008 };
		deps.classifiers.foodShadow.mockRejectedValueOnce(
			new MeteredError('infra error mid-call', partialMeter),
		);
		const c = baseCase('food-shadow', { schema: { type: 'object' } });
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.error);
		expect(result.tokenCounts).toEqual({ input: 80, output: 15 });
	});

	it('all-prefilter routing case yields tokenCounts {0,0}', async () => {
		const deps = baseDeps();
		deps.classifiers.sessionControl.mockResolvedValueOnce({
			raw: JSON.stringify({ intent: 'none', confidence: 1.0, source: 'prefilter' }),
			meter: { model: 'prefilter', tokenIn: 0, tokenOut: 0, costUsd: 0 },
		});
		const c = baseCase('session-control', {
			schema: {
				type: 'object',
				required: ['intent'],
				properties: { intent: { type: 'string' } },
			},
		});
		const result = await runRoutingCase(c, deps);
		expect(result.tokenCounts).toEqual({ input: 0, output: 0 });
	});

	it('budget-exceeded abort excludes unmetered inputs', async () => {
		// Budget is exhausted after first input; second input never dispatched.
		const deps = { ...baseDeps(), caseBudgetUsd: 0.00015, estimateUsd: () => 0.0001 };
		deps.classifiers.foodShadow.mockResolvedValue({
			raw: JSON.stringify({ action: 'none', confidence: 0.5 }),
			meter: { model: 'm', tokenIn: 40, tokenOut: 8, costUsd: 0.0001 },
		});
		const c = baseCase(
			'food-shadow',
			{
				schema: {
					type: 'object',
					required: ['action'],
					properties: { action: { type: 'string' } },
				},
				strings: [{ path: 'action', expectedCaseInsensitive: 'none' }],
			},
			['a', 'b', 'c'],
		);
		const result = await runRoutingCase(c, deps);
		expect(result.verdict).toBe(VERDICT.budgetExceeded);
		// Only one input was dispatched before the budget gate fired.
		expect(deps.classifiers.foodShadow).toHaveBeenCalledTimes(1);
		expect(result.tokenCounts).toEqual({ input: 40, output: 8 });
	});
});
