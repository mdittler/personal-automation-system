/**
 * Routing case-runner (REQ-REG-011).
 *
 * Dispatches a `PersonaCase` with `bucket: 'routing'` to one of three
 * adapter functions and evaluates the response through the structural
 * oracle. Adapters do not throw on classifier parse failures — they
 * surface the raw output so the oracle judges schema mismatch as a real
 * regression. Adapters DO throw on infrastructure errors (LLM network
 * failures); the runner catches those as `verdict: 'error'`.
 *
 * Budget: `deps.caseBudgetUsd` is authoritative (forwarded by the
 * orchestrator from `c.budgetUsd`). Verdict precedence: error > fail > pass.
 */

import type {
	CallMeter,
	EvaluatedTier,
	OracleVerdict,
	PersonaCase,
	RoutingTarget,
	RunResult,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';
import { VERDICT } from '@core/types/regression.js';
import { type StructuralExpectation, runStructuralOracle } from '../../oracles/structural.js';

export interface MinimalLogger {
	warn(...args: unknown[]): void;
	info(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

export interface AdapterResult {
	raw: string;
	meter: CallMeter;
}

export interface RoutingClassifierAdapter {
	foodShadow(text: string): Promise<AdapterResult>;
	sessionControl(text: string): Promise<AdapterResult>;
	pas(text: string): Promise<AdapterResult>;
}

export interface RoutingRunnerDeps {
	modelIds: TierModelSnapshot;
	cacheKey: string;
	/** Authoritative per-case budget. Orchestrator sets this from `c.budgetUsd`. */
	caseBudgetUsd: number;
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number;
	logger: MinimalLogger;
	classifiers: RoutingClassifierAdapter;
}

/** Conservative token budget used for the pre-charge gate. */
export const ESTIMATE_TOKENS = { tokenIn: 400, tokenOut: 80 } as const;

/**
 * Tier slot exercised by each routing classifier. All three production
 * classifiers (food-shadow, session-control, pas) currently call
 * `LLMService.complete()` with `tier: 'fast'`, so a routing case is
 * always a `'fast'` evaluation.
 *
 * If the routing-classifier tier ever changes, update this table — the
 * leaderboard's tier attribution depends on it.
 */
export const ROUTING_TARGET_TIER: Readonly<Record<RoutingTarget, EvaluatedTier>> = {
	'food-shadow': 'fast',
	'session-control': 'fast',
	pas: 'fast',
};

export async function runRoutingCase(c: PersonaCase, deps: RoutingRunnerDeps): Promise<RunResult> {
	if (c.bucket !== 'routing') {
		throw new Error(`routing-runner called with bucket="${c.bucket}" (case: ${c.id})`);
	}
	if (c.routingTarget === undefined) {
		throw new Error(`routing-runner: case "${c.id}" missing routingTarget`);
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
				'routing-runner: case budget exceeded — aborting input loop',
			);
			break;
		}

		let r: AdapterResult;
		try {
			r = await dispatchClassifier(c.routingTarget, String(input.payload), deps.classifiers);
		} catch (err) {
			deps.logger.warn(
				{ err: (err as Error).message, caseId: c.id, payload: input.payload },
				'routing-runner: classifier threw (infrastructure error)',
			);
			oracleVerdicts.push({
				verdict: VERDICT.error,
				details: `classifier error: ${(err as Error).message}`,
			});
			actuals.push(null);
			verdict = VERDICT.error;
			continue;
		}

		costUsd += r.meter.costUsd;
		tokenIn += r.meter.tokenIn;
		tokenOut += r.meter.tokenOut;
		actuals.push(r.raw);

		const expectation = input.expected as StructuralExpectation;
		const ov = runStructuralOracle(r.raw, expectation);
		oracleVerdicts.push(ov);

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
		evaluatedTier: ROUTING_TARGET_TIER[c.routingTarget],
		timestamp: new Date().toISOString(),
		durationMs: Date.now() - start,
	};
}

async function dispatchClassifier(
	target: RoutingTarget,
	payload: string,
	adapters: RoutingClassifierAdapter,
): Promise<AdapterResult> {
	switch (target) {
		case 'food-shadow':
			return adapters.foodShadow(payload);
		case 'session-control':
			return adapters.sessionControl(payload);
		case 'pas':
			return adapters.pas(payload);
	}
}
