import { describe, expect, it, vi } from 'vitest';
import type { AgentTrialOutcome } from '../runner/agent-trial.js';
import {
	AGENT_ESTIMATE_TOKENS,
	type AgentTrialRunner,
	estimateAgentCaseUsd,
	runAgentCase,
} from '../runner/case-runners/agent-runner.js';
import type { PersonaCase } from '../shared/types.js';
import { VERDICT } from '../shared/types.js';

const agentCase: PersonaCase = {
	id: 'agent-t',
	description: 'd',
	bucket: 'agent',
	coverage: ['x.ts'],
	inputs: [
		{ payload: { turns: [{ text: 'q' }] }, expected: { set: 'regression', category: 'no-tool' } },
	],
	oracle: 'outcome',
	budgetUsd: 1,
};
const outcome = (verdict: AgentTrialOutcome['verdict'], costUsd = 0): AgentTrialOutcome => ({
	verdict,
	details: `trial: ${verdict}`,
	transcript: 't',
	costUsd,
	tokenIn: 1,
	tokenOut: 1,
	durationMs: 10,
});
const deps = (runTrial: AgentTrialRunner, over = {}) => ({
	runTrial,
	repeats: 3,
	modelIds: { fast: 'f', standard: 's', reasoning: null },
	cacheKey: 'a'.repeat(64),
	caseBudgetUsd: 1,
	estimateUsd: () => 0.001,
	logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
	...over,
});

describe('runAgentCase (REQ-REG-AGENT-002)', () => {
	it('passes only when all k trials pass, numbering trials 1..k', async () => {
		const seen: number[] = [];
		const r = await runAgentCase(
			agentCase,
			deps(async (req) => {
				seen.push(req.trial);
				return outcome('pass');
			}),
		);
		expect(r.verdict).toBe(VERDICT.pass);
		expect(seen).toEqual([1, 2, 3]);
		expect(r.oracleVerdicts).toHaveLength(3);
		expect(r.evaluatedTier).toBe('standard');
	});

	it('fails pass^k when any trial fails', async () => {
		const verdicts: AgentTrialOutcome['verdict'][] = ['pass', 'fail', 'pass'];
		const r = await runAgentCase(
			agentCase,
			deps(async (req) => outcome(verdicts[req.trial - 1]!)),
		);
		expect(r.verdict).toBe(VERDICT.fail);
	});

	it('an infrastructure error outranks a graded failure (never cached as a grade)', async () => {
		const verdicts: AgentTrialOutcome['verdict'][] = ['fail', 'error', 'pass'];
		const r = await runAgentCase(
			agentCase,
			deps(async (req) => outcome(verdicts[req.trial - 1]!)),
		);
		expect(r.verdict).toBe(VERDICT.error);
	});

	it('an actual overrun on the final trial is budget-exceeded, not pass', async () => {
		const r = await runAgentCase(
			agentCase,
			deps(async () => outcome('pass', 1), { repeats: 1, caseBudgetUsd: 0.75 }),
		);
		expect(r.verdict).toBe(VERDICT.budgetExceeded);
	});

	it('stops dispatching once the case budget would be exceeded; budget-exceeded outranks fail', async () => {
		const runTrial = vi.fn(async () => outcome('fail', 0.001));
		const r = await runAgentCase(agentCase, deps(runTrial, { caseBudgetUsd: 0.0015 }));
		expect(runTrial).toHaveBeenCalledTimes(1);
		expect(r.verdict).toBe(VERDICT.budgetExceeded);
		expect(r.costUsd).toBeCloseTo(0.001);
	});

	it('forwards each trial meter to deps.onMeter with the trial number (heartbeat source; review C25)', async () => {
		const seen: Array<[number, number]> = [];
		await runAgentCase(
			agentCase,
			deps(
				async (_req, hooks) => {
					hooks?.onMeter?.({ costUsd: 0.01, tokenIn: 1, tokenOut: 1 });
					return outcome('pass');
				},
				{ onMeter: (trial: number, m: { costUsd: number }) => seen.push([trial, m.costUsd]) },
			),
		);
		expect(seen).toEqual([
			[1, 0.01],
			[2, 0.01],
			[3, 0.01],
		]);
	});
});

describe('estimateAgentCaseUsd (REQ-REG-AGENT-004; review C9)', () => {
	it('prices a case as per-turn estimate × turns × repeats', () => {
		const estimateUsd = vi.fn(() => 0.001);
		expect(estimateAgentCaseUsd(2, 3, estimateUsd)).toBeCloseTo(0.006);
		expect(estimateUsd).toHaveBeenCalledWith(AGENT_ESTIMATE_TOKENS);
	});
	it('treats a payload with no turns as one turn', () => {
		expect(estimateAgentCaseUsd(0, 3, () => 0.001)).toBeCloseTo(0.003);
	});
});
