import type { PersonaCase, PersonaInput, TierModelSnapshot } from '@core/types/regression.js';
import { describe, expect, it } from 'vitest';
import { runRecallCase } from '../runner/case-runners/recall-runner.js';
import type { RecallAdapter } from '../runner/dispatch.js';

const modelIds: TierModelSnapshot = { fast: 'fast-m', standard: 'std-m', reasoning: null };
const noopLogger = {
	warn: () => {},
	info: () => {},
	debug: () => {},
	error: () => {},
};

function fakeAdapter(replies: string[]): RecallAdapter & { todays: Array<string | undefined> } {
	let i = 0;
	const todays: Array<string | undefined> = [];
	return {
		todays,
		recall: async (_msg: string, today?: string) => {
			todays.push(today);
			const raw = replies[i++] ?? '{}';
			return { raw, meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0.0001 } };
		},
	};
}

const caseSchema = {
	type: 'object',
	required: ['shouldRecall', 'query', 'timeAnchor'],
	properties: {
		shouldRecall: { type: 'boolean' },
		query: { type: ['string', 'null'] },
		timeAnchor: { type: ['object', 'null'] },
	},
};

function caseFixture(overrides: Partial<PersonaCase> = {}): PersonaCase {
	return {
		id: 'recall-test',
		description: 'test',
		bucket: 'recall',
		coverage: ['core/src/services/conversation-retrieval/recall-classifier.ts'],
		inputs: [
			{
				payload: 'what did we say about taxes?',
				expected: {
					schema: caseSchema,
				},
			},
		],
		oracle: 'structural',
		budgetUsd: 0.05,
		...overrides,
	};
}

describe('runRecallCase', () => {
	it('passes when every input matches its structural expectation', async () => {
		const adapter = fakeAdapter([
			'{"shouldRecall": true, "query": "taxes", "timeAnchor": null, "reason": "explicit"}',
		]);
		const r = await runRecallCase(caseFixture(), {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe('pass');
		expect(r.oracleVerdicts).toHaveLength(1);
	});

	it('fails when an input violates its structural expectation', async () => {
		const adapter = fakeAdapter([
			'{"shouldRecall": "yes", "query": null, "timeAnchor": null, "reason": ""}',
		]);
		const r = await runRecallCase(caseFixture(), {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe('fail');
	});

	it('errors when the classifier returns unparseable JSON', async () => {
		const adapter = fakeAdapter(['NOT JSON AT ALL']);
		const r = await runRecallCase(caseFixture(), {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		expect(r.verdict).toBe('error');
	});

	it('budget equality is ALLOWED (estimate === remaining budget proceeds with dispatch)', async () => {
		// Verdict precedence guard against Codex I1: the runner uses `>` not `>=`,
		// so spending the EXACT remaining budget must NOT abort.
		let calls = 0;
		const adapter: RecallAdapter = {
			recall: async () => {
				calls++;
				return {
					raw: '{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "r"}',
					meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0.04 },
				};
			},
		};
		const c = caseFixture({
			inputs: [
				{
					payload: 'long enough message for the prefilter to pass',
					expected: { schema: caseSchema },
				},
			],
			budgetUsd: 0.04,
		});
		const r = await runRecallCase(c, {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.04,
			estimateUsd: () => 0.04, // equality with budget — still affordable
			logger: noopLogger,
		});
		expect(calls).toBe(1);
		expect(r.verdict).toBe('pass');
	});

	it('aborts with budget-exceeded when projected > remaining budget (no calls dispatched)', async () => {
		let calls = 0;
		const adapter: RecallAdapter = {
			recall: async () => {
				calls++;
				return {
					raw: '{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "r"}',
					meter: { model: 'fast-m', tokenIn: 0, tokenOut: 0, costUsd: 0.05 },
				};
			},
		};
		const c = caseFixture({
			inputs: [
				{
					payload: 'a long enough message for the prefilter to pass',
					expected: { schema: caseSchema },
				},
				{
					payload: 'another long enough message for the prefilter',
					expected: { schema: caseSchema },
				},
				{
					payload: 'a third long enough message for the prefilter',
					expected: { schema: caseSchema },
				},
			],
			budgetUsd: 0.04,
		});
		const r = await runRecallCase(c, {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.04,
			estimateUsd: () => 0.0401, // 1 cent over the budget — first call blocked
			logger: noopLogger,
		});
		expect(r.verdict).toBe('budget-exceeded');
		expect(calls).toBe(0); // pre-charge gate fires before first call
	});

	it('threads per-input `today` from PersonaInput to the recall adapter', async () => {
		const adapter = fakeAdapter([
			'{"shouldRecall": true, "query": "leak", "timeAnchor": {"type":"absolute","on":"2026-05-10"}, "reason": "x"}',
		]);
		const c = caseFixture({
			inputs: [
				{
					payload: 'what did we talk about yesterday?',
					today: '2026-05-11',
					expected: { schema: caseSchema },
				} as PersonaInput & { today?: string },
			],
		});
		await runRecallCase(c, {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		expect(adapter.todays).toEqual(['2026-05-11']);
	});

	it('aggregates costUsd across inputs', async () => {
		const adapter = fakeAdapter([
			'{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "r"}',
			'{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "r"}',
		]);
		const c = caseFixture({
			inputs: [
				{ payload: 'p1', expected: { schema: caseSchema } },
				{ payload: 'p2', expected: { schema: caseSchema } },
			],
		});
		const r = await runRecallCase(c, {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		expect(r.costUsd).toBeCloseTo(0.0002, 6);
	});

	it('rejects calls with bucket !== "recall"', async () => {
		await expect(
			runRecallCase(caseFixture({ bucket: 'routing', routingTarget: 'food-shadow' }), {
				adapter: fakeAdapter([]),
				modelIds,
				cacheKey: 'k'.repeat(64),
				caseBudgetUsd: 0.05,
				estimateUsd: () => 0.0001,
				logger: noopLogger,
			}),
		).rejects.toThrow(/bucket/);
	});

	// Observational input behavior — Task 5 footnote rule. Observational inputs
	// record their oracle verdict in oracleVerdicts but never escalate the case
	// verdict past 'pass'. This lets the suite track genuinely ambiguous prompts
	// without gating REQ-REG-011 or chunk completion on them.
	it('records observational verdict but does not escalate verdict past pass', async () => {
		const adapter = fakeAdapter([
			// This payload would normally FAIL the structural oracle (shouldRecall:false but expected:true via casing).
			'{"shouldRecall": false, "query": null, "timeAnchor": null, "reason": "x"}',
		]);
		const c = caseFixture({
			inputs: [
				{
					payload: 'genuinely ambiguous bare pronoun',
					expected: {
						schema: {
							type: 'object',
							required: ['shouldRecall'],
							properties: { shouldRecall: { const: true } }, // disagrees with adapter output → would fail
						},
					},
					observational: true,
				} as PersonaInput & { observational?: boolean },
			],
		});
		const r = await runRecallCase(c, {
			adapter,
			modelIds,
			cacheKey: 'k'.repeat(64),
			caseBudgetUsd: 0.05,
			estimateUsd: () => 0.0001,
			logger: noopLogger,
		});
		// Verdict stays 'pass' even though the structural oracle would have failed.
		expect(r.verdict).toBe('pass');
		// The actual structural verdict is preserved in oracleVerdicts for review.
		expect(r.oracleVerdicts).toHaveLength(1);
		expect(r.oracleVerdicts[0]?.verdict).toBe('fail');
	});
});
