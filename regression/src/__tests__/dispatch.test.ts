import { describe, expect, it, vi } from 'vitest';
import {
	type CostMeterSource,
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

function fixedCostTracker(initialTotal: number, perCallDelta = 0): CostMeterSource {
	let total = initialTotal;
	let firstCall = true;
	return {
		getMonthlyTotalCost(): number {
			const v = total;
			if (firstCall) {
				firstCall = false;
			} else {
				// Second sample (after the call) returns initial + delta.
				total = initialTotal + perCallDelta;
			}
			return v;
		},
	};
}

// Helper that returns a "real" cost tracker mock where the caller controls
// both before/after snapshots manually via a queue.
function queuedCostTracker(values: number[]): CostMeterSource {
	const queue = [...values];
	return {
		getMonthlyTotalCost(): number {
			const v = queue.shift();
			if (v === undefined) throw new Error('cost tracker queue empty');
			return v;
		},
	};
}

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
		const tracker = { getMonthlyTotalCost: () => cost };
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
			costTracker: { getMonthlyTotalCost: () => 0 },
			modelIds: { fast: 'fast-m', standard: 'std-m', reasoning: null },
			defaultToday: '2026-05-11',
		});
		await adapter.recall('a long enough message to bypass the prefilter', undefined);
		const lastOpts = stub.lastOptions as { systemPrompt?: string };
		expect(lastOpts.systemPrompt).toContain('2026-05-11');
	});

	it('zero-meters when the pre-filter skips the LLM call', async () => {
		const stub = new StubLLMService(); // queue empty — would throw if called
		const tracker = { getMonthlyTotalCost: () => 999 }; // even with non-zero delta, prefilter forces zero
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
		const tracker = { getMonthlyTotalCost: () => 0 };
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
