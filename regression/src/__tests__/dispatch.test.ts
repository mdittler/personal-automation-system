import { describe, expect, it, vi } from 'vitest';
import {
	type CostMeterSource,
	MeteredError,
	buildClassifierAdapters,
	buildRecallAdapter,
} from '../runner/dispatch.js';
import { StubLLMService } from './_stub-provider.js';

const MODEL_IDS = {
	fast: 'claude-fast-1',
	standard: 'claude-standard-1',
	reasoning: null,
};

const makeLogger = () => ({
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost tracker helpers — extended to satisfy the widened CostMeterSource which
// now requires both getMonthlyTotalCost() and getTokenUsageTotals().
// ─────────────────────────────────────────────────────────────────────────────

/** Queued snapshots: each element is { cost, tokens }. Both counters advance
 *  together through the same queue position. */
interface TrackerSnapshot {
	cost: number;
	tokens: { input: number; output: number };
}

/**
 * Returns a CostMeterSource driven by a queue of { cost, tokens } snapshots.
 * The first call to any getter returns snapshot[0], the second snapshot[1], etc.
 * The two getters share the same queue position so a single call to
 * getMonthlyTotalCost() AND getTokenUsageTotals() both return from the same
 * snapshot (callers invoke them together in the before/after pattern).
 */
function queuedTracker(snapshots: TrackerSnapshot[]): CostMeterSource {
	const costQueue = snapshots.map((s) => s.cost);
	const tokenQueue = snapshots.map((s) => s.tokens);
	return {
		getMonthlyTotalCost(): number {
			const v = costQueue.shift();
			if (v === undefined) throw new Error('tracker cost queue empty');
			return v;
		},
		getTokenUsageTotals(): { input: number; output: number } {
			const v = tokenQueue.shift();
			if (v === undefined) throw new Error('tracker token queue empty');
			return v;
		},
	};
}

/**
 * Legacy shim: cost-only queued tracker for tests that only care about cost
 * and don't drive token assertions. Tokens are always { input:0, output:0 }.
 */
function queuedCostTracker(values: number[]): CostMeterSource {
	const queue = [...values];
	return {
		getMonthlyTotalCost(): number {
			const v = queue.shift();
			if (v === undefined) throw new Error('cost tracker queue empty');
			return v;
		},
		getTokenUsageTotals(): { input: number; output: number } {
			return { input: 0, output: 0 };
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-existing tests (unchanged behaviour)
// ─────────────────────────────────────────────────────────────────────────────

describe('foodShadow adapter — happy path', () => {
	it('returns {action, confidence} JSON when classifier kind is ok', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue(JSON.stringify({ action: 'none', confidence: 0.7 })),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0001]); // before, after
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('hi');
		expect(JSON.parse(r.raw)).toEqual({ action: 'none', confidence: 0.7 });
		expect(r.meter.costUsd).toBeCloseTo(0.0001, 7);
		expect(r.meter.model).toBe('claude-fast-1');
	});
});

describe('foodShadow adapter — parse-failed', () => {
	it('returns the raw output WITHOUT throwing', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue('this is not json'),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0001]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('hi');
		expect(r.raw).toBe('this is not json'); // raw preserved for the oracle to fail
		expect(r.meter.costUsd).toBeCloseTo(0.0001, 7);
	});

	it('returns raw output when JSON is valid but action is not in label set', async () => {
		const llm = {
			complete: vi
				.fn()
				.mockResolvedValue(JSON.stringify({ action: 'INVALID_LABEL', confidence: 0.5 })),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0001]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('hi');
		// FoodShadowClassifier returns kind='parse-failed' when action ∉ labels.
		expect(r.raw).toBe(JSON.stringify({ action: 'INVALID_LABEL', confidence: 0.5 }));
	});
});

describe('foodShadow adapter — throws on llm-error', () => {
	it('throws when the LLM call rejects', async () => {
		const llm = {
			complete: vi.fn().mockRejectedValue(new Error('network down')),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		await expect(adapters.foodShadow('hi')).rejects.toThrow(/food-shadow.*infrastructure error/i);
	});
});

describe('sessionControl adapter — prefilter zero-cost', () => {
	it('returns prefilter result for /newchat without LLM call; meter.costUsd=0', async () => {
		const llm = {
			complete: vi.fn(),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.sessionControl('/newchat');
		const parsed = JSON.parse(r.raw);
		expect(parsed).toMatchObject({ intent: 'new_session', source: 'prefilter' });
		expect(llm.complete).not.toHaveBeenCalled();
		expect(r.meter.costUsd).toBe(0);
	});

	it.each(['/newchat', '/new', '/reset'])('treats %s as a prefilter command', async (cmd) => {
		const llm = { complete: vi.fn(), classify: vi.fn() };
		const costTracker = queuedCostTracker([1.0, 1.0]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.sessionControl(cmd);
		expect(JSON.parse(r.raw).source).toBe('prefilter');
		expect(llm.complete).not.toHaveBeenCalled();
	});
});

describe('sessionControl adapter — NL path calls LLM and meters', () => {
	it('calls LLM and accrues cost for non-command phrasings', async () => {
		const llm = {
			complete: vi
				.fn()
				.mockResolvedValue(
					JSON.stringify({ intent: 'new_session', confidence: 0.9, reason: 'NL clear-new' }),
				),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.00005]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.sessionControl('lets start over');
		expect(JSON.parse(r.raw)).toMatchObject({ intent: 'new_session', source: 'llm' });
		expect(llm.complete).toHaveBeenCalledTimes(1);
		expect(r.meter.costUsd).toBeCloseTo(0.00005, 7);
	});
});

describe('pas adapter — DATA_QUERY_PREFILTER path', () => {
	it('returns prefilter result for "how much did we spend at Costco" without LLM call', async () => {
		const llm = {
			complete: vi.fn(),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.0]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.pas('how much did we spend at Costco');
		const parsed = JSON.parse(r.raw);
		expect(parsed.pasRelated).toBe(true);
		expect(parsed.dataQueryCandidate).toBe(true);
		expect(llm.complete).not.toHaveBeenCalled();
		expect(r.meter.costUsd).toBe(0);
	});

	it('LLM path: classifies non-prefilter messages via LLM', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue('YES_PAS NO_DATA NO_SETTINGS'),
			classify: vi.fn(),
		};
		const costTracker = queuedCostTracker([1.0, 1.00003]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.pas('what apps do I have?');
		expect(JSON.parse(r.raw).pasRelated).toBe(true);
		expect(llm.complete).toHaveBeenCalledTimes(1);
		expect(r.meter.costUsd).toBeCloseTo(0.00003, 7);
	});
});

const minLogger = {
	warn: () => {},
	info: () => {},
	debug: () => {},
	error: () => {},
};

describe('buildRecallAdapter', () => {
	it('forwards the per-call today to classifyRecallIntent and returns the verdict', async () => {
		const stub = new StubLLMService().queue(
			'{"shouldRecall": true, "query": "leak", "timeAnchor": null, "reason": "explicit"}',
		);
		let cost = 0;
		const tracker: CostMeterSource = {
			getMonthlyTotalCost: () => cost,
			getTokenUsageTotals: () => ({ input: 0, output: 0 }),
		};
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker: tracker,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		const originalComplete = stub.complete.bind(stub);
		stub.complete = async (p, o) => {
			cost = 0.0005;
			return originalComplete(p, o);
		};

		const r = await adapter.recall('what did we say about the leak earlier?', '2026-05-11');
		expect(JSON.parse(r.raw).shouldRecall).toBe(true);
		expect(r.meter.costUsd).toBeCloseTo(0.0005, 6);
		expect(r.meter.model).toBe('fast-m');
		// The forwarded `today` appears in the rendered system prompt.
		expect(stub.lastPrompt.length).toBeGreaterThan(0);
		const lastOpts = stub.lastOptions as { systemPrompt?: string };
		expect(lastOpts.systemPrompt).toContain('2026-05-11');
	});

	it('falls back to defaultToday when the caller passes undefined', async () => {
		const stub = new StubLLMService().queue(
			'{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "none"}',
		);
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker: {
				getMonthlyTotalCost: () => 0,
				getTokenUsageTotals: () => ({ input: 0, output: 0 }),
			},
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		await adapter.recall('a long enough message to bypass the prefilter', undefined);
		const lastOpts = stub.lastOptions as { systemPrompt?: string };
		expect(lastOpts.systemPrompt).toContain('2026-05-11');
	});

	it('zero-meters when the pre-filter skips the LLM call', async () => {
		const stub = new StubLLMService(); // queue empty — would throw if called
		const tracker: CostMeterSource = {
			getMonthlyTotalCost: () => 999,
			getTokenUsageTotals: () => ({ input: 0, output: 0 }),
		}; // even with non-zero delta, prefilter forces zero
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker: tracker,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		const r = await adapter.recall('hi', '2026-05-11');
		expect(r.meter.costUsd).toBe(0);
		const parsed = JSON.parse(r.raw);
		expect(parsed.shouldRecall).toBe(false);
		expect(parsed.reason).toMatch(/prefilter|short|greeting/i);
		expect(stub.calls).toBe(0);
	});

	it('surfaces classifier LLM failure as a fail-open verdict (matches production behaviour)', async () => {
		const stub = new StubLLMService(); // empty → complete() throws
		const tracker: CostMeterSource = {
			getMonthlyTotalCost: () => 0,
			getTokenUsageTotals: () => ({ input: 0, output: 0 }),
		};
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker: tracker,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		const r = await adapter.recall(
			'a long-enough message to bypass the prefilter and hit the LLM',
			'2026-05-11',
		);
		const parsed = JSON.parse(r.raw);
		expect(parsed.shouldRecall).toBe(false);
		expect(parsed.reason).toBe('llm-error');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch 2: token-metering tests
// ─────────────────────────────────────────────────────────────────────────────

// (1) Happy — foodShadow adapter reflects before/after token delta
describe('foodShadow adapter — meter reflects the before/after token delta', () => {
	it('tokenIn and tokenOut match the tracker before/after delta', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue(JSON.stringify({ action: 'none', confidence: 0.9 })),
			classify: vi.fn(),
		};
		// Tracker steps from {0,0} to {412,78} over the call.
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.001, tokens: { input: 412, output: 78 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('add milk to the grocery list');
		expect(r.meter.tokenIn).toBe(412);
		expect(r.meter.tokenOut).toBe(78);
	});
});

// (2) Happy — pas adapter LLM path populates meter token counts
describe('pas adapter — LLM path populates meter token counts', () => {
	it('non-prefilter input yields a non-zero meter', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue('YES_PAS NO_DATA NO_SETTINGS'),
			classify: vi.fn(),
		};
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.001, tokens: { input: 200, output: 30 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.pas('what apps do I have?');
		expect(r.meter.tokenIn).toBeGreaterThan(0);
		expect(r.meter.tokenOut).toBeGreaterThan(0);
	});
});

// (3) Happy — sessionControl NL path populates meter token counts
describe('sessionControl adapter — NL path populates meter token counts', () => {
	it('natural-language phrasing that hits the LLM yields a non-zero meter', async () => {
		const llm = {
			complete: vi
				.fn()
				.mockResolvedValue(
					JSON.stringify({ intent: 'new_session', confidence: 0.9, reason: 'explicit' }),
				),
			classify: vi.fn(),
		};
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.001, tokens: { input: 150, output: 20 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.sessionControl('lets start fresh');
		expect(r.meter.tokenIn).toBeGreaterThan(0);
		expect(r.meter.tokenOut).toBeGreaterThan(0);
	});
});

// (4) Happy — recall adapter LLM path reflects delta {300,45}
describe('recall adapter — LLM path populates meter token counts', () => {
	it('prefilter bypassed; token delta {300,45} reflected in meter', async () => {
		const stub = new StubLLMService().queue(
			'{"shouldRecall": true, "query": "budget", "timeAnchor": null, "reason": "explicit"}',
		);
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.001, tokens: { input: 300, output: 45 } },
		]);
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		const r = await adapter.recall(
			'what did we discuss about the budget last month?',
			'2026-05-11',
		);
		expect(r.meter.tokenIn).toBe(300);
		expect(r.meter.tokenOut).toBe(45);
	});
});

// (5) Edge — sessionControl prefilter path yields ZERO_METER tokenIn/tokenOut=0
describe('sessionControl adapter — prefilter path yields ZERO_METER', () => {
	it('/newchat short-circuits without an LLM call; tokenIn===tokenOut===0', async () => {
		const llm = { complete: vi.fn(), classify: vi.fn() };
		// Tracker has non-zero tokens to confirm they are clamped to zero by ZERO_METER.
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 999, output: 999 } },
			{ cost: 1.0, tokens: { input: 999, output: 999 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.sessionControl('/newchat');
		expect(r.meter.tokenIn).toBe(0);
		expect(r.meter.tokenOut).toBe(0);
	});
});

// (6) Edge — pas DATA_QUERY_PREFILTER short-circuit yields tokenIn/tokenOut=0
describe('pas adapter — DATA_QUERY_PREFILTER short-circuit yields tokenIn/tokenOut=0', () => {
	it('prefilter message; no LLM call; token delta naturally 0', async () => {
		const llm = { complete: vi.fn(), classify: vi.fn() };
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.pas('how much did we spend at Costco');
		expect(r.meter.tokenIn).toBe(0);
		expect(r.meter.tokenOut).toBe(0);
	});
});

// (7) Edge — recall adapter prefilter skip yields tokenIn/tokenOut=0
describe('recall adapter — prefilter skip yields tokenIn/tokenOut=0', () => {
	it('short greeting is skipped by recallPreFilter; ZERO_METER returned', async () => {
		const stub = new StubLLMService(); // should not be called
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 500, output: 100 } },
			{ cost: 1.0, tokens: { input: 500, output: 100 } },
		]);
		const adapter = buildRecallAdapter({
			llm: stub as never,
			logger: minLogger,
			costTracker,
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		const r = await adapter.recall('hi', '2026-05-11');
		expect(r.meter.tokenIn).toBe(0);
		expect(r.meter.tokenOut).toBe(0);
		expect(stub.calls).toBe(0);
	});
});

// (8) Security — meterCall clamps a negative token delta to 0
describe('meterCall — clamps negative token delta to 0', () => {
	it('tracker reports after < before; tokenIn and tokenOut are 0, never negative', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue(JSON.stringify({ action: 'none', confidence: 0.9 })),
			classify: vi.fn(),
		};
		// Tracker goes backwards (mis-reporting): after.input < before.input
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 500, output: 200 } },
			{ cost: 1.001, tokens: { input: 100, output: 50 } }, // after < before
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('add eggs');
		expect(r.meter.tokenIn).toBe(0);
		expect(r.meter.tokenOut).toBe(0);
	});
});

// (9) Security — meterCall produces finite token counts for non-finite deltas
describe('meterCall — non-finite token delta is clamped to 0', () => {
	it.each([
		{ label: 'NaN input', before: Number.NaN, after: 500 },
		{ label: 'Infinity after', before: 0, after: Number.POSITIVE_INFINITY },
		{ label: '-Infinity after', before: 0, after: Number.NEGATIVE_INFINITY },
	])('$label → tokenIn===0', async ({ before, after }) => {
		const llm = {
			complete: vi.fn().mockResolvedValue(JSON.stringify({ action: 'none', confidence: 0.9 })),
			classify: vi.fn(),
		};
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: before, output: 0 } },
			{ cost: 1.001, tokens: { input: after, output: 0 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('test');
		expect(Number.isFinite(r.meter.tokenIn)).toBe(true);
		expect(r.meter.tokenIn).toBe(0);
	});
});

// (10) Error — meterCall throws MeteredError carrying partial meter when fn() throws
describe('meterCall — throws MeteredError carrying the partial meter when fn() throws', () => {
	it('fn() throws after tracker advanced {50,10}; caught error is MeteredError with tokenIn===50', async () => {
		const llm = {
			complete: vi.fn().mockRejectedValue(new Error('network failure')),
			classify: vi.fn(),
		};
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.001, tokens: { input: 50, output: 10 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		let caught: unknown;
		try {
			await adapters.foodShadow('test');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(MeteredError);
		const meteredErr = caught as MeteredError;
		expect(meteredErr.meter.tokenIn).toBe(50);
		expect(meteredErr.meter.tokenOut).toBe(10);
	});
});

// (11) Error — meterCall throws MeteredError with zero meter when fn() throws before any LLM call
describe('meterCall — MeteredError with zero meter when fn() throws before any LLM call', () => {
	it('tracker did not advance; meter.tokenIn===0', async () => {
		const llm = {
			complete: vi.fn().mockRejectedValue(new Error('immediate failure')),
			classify: vi.fn(),
		};
		// Tracker does not advance — before and after are identical.
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		let caught: unknown;
		try {
			await adapters.foodShadow('test');
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(MeteredError);
		expect((caught as MeteredError).meter.tokenIn).toBe(0);
		expect((caught as MeteredError).meter.tokenOut).toBe(0);
	});
});

// (12) Config — provider with no usage object contributes 0 tokens
describe('meterCall — provider with no usage object contributes 0 tokens', () => {
	it('tracker returns identical before/after; tokenIn===0 while costUsd may be non-zero', async () => {
		const llm = {
			complete: vi.fn().mockResolvedValue(JSON.stringify({ action: 'none', confidence: 0.9 })),
			classify: vi.fn(),
		};
		// Same before/after tokens (provider never reported usage), but cost advanced.
		const costTracker = queuedTracker([
			{ cost: 1.0, tokens: { input: 0, output: 0 } },
			{ cost: 1.005, tokens: { input: 0, output: 0 } },
		]);
		const adapters = buildClassifierAdapters({
			llm: llm as never,
			logger: makeLogger(),
			costTracker,
			modelIds: MODEL_IDS,
		});
		const r = await adapters.foodShadow('add milk');
		expect(r.meter.tokenIn).toBe(0);
		expect(r.meter.tokenOut).toBe(0);
		expect(r.meter.costUsd).toBeGreaterThan(0); // cost is still recorded
	});
});
