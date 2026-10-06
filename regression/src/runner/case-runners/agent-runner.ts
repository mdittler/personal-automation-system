/**
 * Agent bucket case-runner (REQ-REG-AGENT-002). Runs one task k times through
 * an injected `runTrial` (production: one worker process per trial) and
 * aggregates pass^k. Precedence error > budget-exceeded > fail > pass keeps
 * any infrastructure accident out of the cache (REQ-REG-023).
 */
import type { AgentTaskPayload } from '../../cases/agent/types.js';
import type { AgentExpectation } from '../../cases/agent/types.js';
import {
	type EstimateUsdFn,
	type OracleVerdict,
	type PersonaCase,
	type RunResult,
	type TierModelSnapshot,
	VERDICT,
	type Verdict,
} from '../../shared/types.js';
import type { AgentTrialOutcome, AgentTrialRequest } from '../agent-trial.js';
import type { MinimalLogger } from './routing-runner.js';

export interface TrialMeter {
	costUsd: number;
	tokenIn: number;
	tokenOut: number;
}

/** Live hooks a trial runner may call while the trial is running (production: relayed worker meters). */
export interface AgentTrialRunnerHooks {
	onMeter?: (m: TrialMeter) => void;
}

export type AgentTrialRunner = (
	req: AgentTrialRequest,
	hooks?: AgentTrialRunnerHooks,
) => Promise<AgentTrialOutcome>;

export interface AgentRunnerDeps {
	runTrial: AgentTrialRunner;
	repeats: number;
	modelIds: TierModelSnapshot;
	cacheKey: string;
	caseBudgetUsd: number;
	estimateUsd: EstimateUsdFn;
	logger: MinimalLogger;
	/** Called with every live meter a trial reports — the orchestrator turns these into heartbeats (review C25). */
	onMeter?: (trial: number, m: TrialMeter) => void;
}

/** Per-turn pre-charge. The old pipeline makes several standard-tier calls per turn; the agent loop 2–4. */
export const AGENT_ESTIMATE_TOKENS = { tokenIn: 6000, tokenOut: 600, tier: 'standard' } as const;

/**
 * Pre-dispatch price of one agent case: per-turn estimate × turns × repeats
 * (REQ-REG-AGENT-004). The orchestrator's run-budget pre-check and the CLI
 * dry-run both call this, so the two can never disagree (review C9).
 */
export function estimateAgentCaseUsd(
	turns: number,
	repeats: number,
	estimateUsd: EstimateUsdFn,
): number {
	return estimateUsd(AGENT_ESTIMATE_TOKENS) * Math.max(1, turns) * repeats;
}

export async function runAgentCase(c: PersonaCase, deps: AgentRunnerDeps): Promise<RunResult> {
	const input = c.inputs[0];
	if (!input) throw new Error(`agent-runner: case ${c.id} has no input`);
	const payload = input.payload as AgentTaskPayload;
	const expectation = input.expected as AgentExpectation;
	const start = Date.now();
	const trials: AgentTrialOutcome[] = [];
	let costUsd = 0;
	let tokenIn = 0;
	let tokenOut = 0;
	let aborted = false;

	for (let t = 1; t <= deps.repeats; t++) {
		const projected = deps.estimateUsd(AGENT_ESTIMATE_TOKENS) * payload.turns.length;
		if (costUsd + projected > deps.caseBudgetUsd) {
			aborted = true;
			deps.logger.warn(
				{ caseId: c.id, trial: t, costUsd, projected },
				'agent-runner: case budget exceeded',
			);
			break;
		}
		const out = await deps.runTrial(
			{ caseId: c.id, trial: t, repeats: deps.repeats, payload, expectation },
			{ onMeter: (m) => deps.onMeter?.(t, m) },
		);
		trials.push(out);
		costUsd += out.costUsd;
		tokenIn += out.tokenIn;
		tokenOut += out.tokenOut;
		// Actual spend can exceed the projection; stop as soon as it does —
		// even after the final trial — so an overrun is never reported as pass.
		if (costUsd > deps.caseBudgetUsd) {
			aborted = true;
			deps.logger.warn(
				{ caseId: c.id, trial: t, costUsd },
				'agent-runner: actual spend exceeded the case budget',
			);
			break;
		}
	}

	let verdict: Verdict;
	if (trials.some((x) => x.verdict === 'error')) verdict = VERDICT.error;
	else if (aborted) verdict = VERDICT.budgetExceeded;
	else if (trials.some((x) => x.verdict === 'fail')) verdict = VERDICT.fail;
	else verdict = VERDICT.pass;

	const oracleVerdicts: OracleVerdict[] = trials.map((x) => ({
		verdict: x.verdict,
		details: x.details,
	}));
	return {
		caseId: c.id,
		cacheKey: deps.cacheKey,
		source: 'fresh',
		verdict,
		inputs: c.inputs,
		actuals: trials.map((x) => x.transcript),
		oracleVerdicts,
		tokenCounts: { input: tokenIn, output: tokenOut },
		costUsd,
		modelIds: deps.modelIds,
		evaluatedTier: 'standard',
		timestamp: new Date().toISOString(),
		durationMs: Date.now() - start,
	};
}
