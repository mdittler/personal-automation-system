/**
 * Recall case-runner — wraps `classifyRecallIntent` via the recall adapter
 * and evaluates each verdict through the structural oracle.
 *
 * Mirrors the routing-runner contract: pre-charge budget gate, sequential
 * dispatch (CostTracker delta is only correct under serial flow), verdict
 * precedence error > fail > pass.
 *
 * Observational inputs (`input.observational === true`) record their oracle
 * verdict but never escalate the case verdict past 'pass'. Task 5 fixtures
 * with genuinely ambiguous prompts use this flag so they surface for analyst
 * review without gating REQ-REG-011 accuracy or chunk completion.
 */

import type {
	OracleVerdict,
	PersonaCase,
	PersonaInput,
	RunResult,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';
import { VERDICT } from '@core/types/regression.js';
import { type StructuralExpectation, runStructuralOracle } from '../../oracles/structural.js';
import type { EstimateUsdFn } from '../../shared/types.js';
import { MeteredError, type RecallAdapter } from '../dispatch.js';
import { type AdapterResult, ESTIMATE_TOKENS, type MinimalLogger } from './routing-runner.js';

export interface RecallRunnerDeps {
	adapter: RecallAdapter;
	modelIds: TierModelSnapshot;
	cacheKey: string;
	caseBudgetUsd: number;
	estimateUsd: EstimateUsdFn;
	logger: MinimalLogger;
}

export async function runRecallCase(c: PersonaCase, deps: RecallRunnerDeps): Promise<RunResult> {
	if (c.bucket !== 'recall') {
		throw new Error(`recall-runner called with bucket="${c.bucket}" (case: ${c.id})`);
	}

	const start = Date.now();
	const actuals: unknown[] = [];
	const oracleVerdicts: OracleVerdict[] = [];
	let costUsd = 0;
	let tokenIn = 0;
	let tokenOut = 0;
	let verdict: Verdict = VERDICT.pass;

	for (const input of c.inputs) {
		const projected = deps.estimateUsd(ESTIMATE_TOKENS);
		if (costUsd + projected > deps.caseBudgetUsd) {
			if (verdict === VERDICT.pass) verdict = VERDICT.budgetExceeded;
			deps.logger.warn(
				{ caseId: c.id, costUsd, projected, budget: deps.caseBudgetUsd },
				'recall-runner: case budget exceeded — aborting input loop',
			);
			break;
		}

		const observational =
			(input as PersonaInput & { observational?: boolean }).observational === true;

		let r: AdapterResult;
		try {
			// `today` is an optional per-input override (Codex C4 follow-up); if
			// absent the adapter falls back to its `defaultToday`. Cast through
			// PersonaInput because the public schema is intentionally loose.
			const perInputToday = (input as PersonaInput & { today?: string }).today;
			r = await deps.adapter.recall(String(input.payload), perInputToday);
		} catch (err) {
			deps.logger.warn(
				{ err: (err as Error).message, caseId: c.id, payload: input.payload },
				'recall-runner: adapter threw (infrastructure error)',
			);
			if (err instanceof MeteredError) {
				tokenIn += err.meter.tokenIn;
				tokenOut += err.meter.tokenOut;
				costUsd += err.meter.costUsd;
			}
			oracleVerdicts.push({
				verdict: VERDICT.error,
				details: `recall adapter error: ${(err as Error).message}`,
			});
			actuals.push(null);
			if (!observational) verdict = VERDICT.error;
			continue;
		}

		costUsd += r.meter.costUsd;
		tokenIn += r.meter.tokenIn;
		tokenOut += r.meter.tokenOut;
		actuals.push(r.raw);

		const ov = runStructuralOracle(r.raw, input.expected as StructuralExpectation);
		oracleVerdicts.push(ov);
		if (observational) continue; // observational inputs never escalate the case verdict
		if (ov.verdict === VERDICT.fail && verdict === VERDICT.pass) verdict = VERDICT.fail;
		if (ov.verdict === VERDICT.error) verdict = VERDICT.error;
	}

	return {
		caseId: c.id,
		cacheKey: deps.cacheKey,
		source: 'fresh',
		verdict,
		inputs: c.inputs,
		actuals,
		oracleVerdicts,
		tokenCounts: { input: tokenIn, output: tokenOut },
		costUsd,
		modelIds: deps.modelIds,
		evaluatedTier: 'fast',
		timestamp: new Date().toISOString(),
		durationMs: Date.now() - start,
	};
}
