/**
 * Routing case-runner (REQ-REG-011).
 *
 * Dispatches a `PersonaCase` with `bucket: 'routing'` to one of three
 * adapter functions and evaluates the response through the structural
 * oracle.
 *
 * The adapter contract is `(text: string) => Promise<{raw: string; meter}>`:
 *  - `raw` is the JSON-stringified classifier output. Adapters DO NOT throw
 *    on LLM parse failures — they surface the raw output so the structural
 *    oracle judges it as a regression (verdict: 'fail' on schema mismatch).
 *  - `meter` records `{model, tokenIn, tokenOut, costUsd}` from a
 *    `CostTracker` delta around the call.
 *  - Adapters DO throw on infrastructure errors (LLM network failures);
 *    the runner catches those as `verdict: 'error'` per the REQ-REG-011
 *    semantics defined in `markdown-report.ts`.
 *
 * Budget semantics:
 *  - `deps.caseBudgetUsd` is authoritative (passed by orchestrator from
 *    `c.budgetUsd`). Pre-charge gate aborts the input loop when the next
 *    estimated call would exceed the case budget.
 *  - Estimates are conservative; the real cost (from `meter.costUsd`) is
 *    used for the running total.
 *
 * Verdict precedence (matches `receipt-runner`): `error > fail > pass`.
 */

import type {
	CallMeter,
	OracleVerdict,
	PersonaCase,
	RoutingTarget,
	RunResult,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';
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

const ESTIMATE_TOKENS = { tokenIn: 400, tokenOut: 80 };

export async function runRoutingCase(
	c: PersonaCase,
	deps: RoutingRunnerDeps,
): Promise<RunResult> {
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
	let verdict: Verdict = 'pass';

	for (const input of c.inputs) {
		// Pre-charge gate (REQ-REG-008). deps.caseBudgetUsd is authoritative —
		// c.budgetUsd is read by the orchestrator and forwarded here.
		const projected = deps.estimateUsd(ESTIMATE_TOKENS);
		if (costUsd + projected > deps.caseBudgetUsd) {
			if (verdict === 'pass') verdict = 'budget-exceeded';
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
				verdict: 'error',
				details: `classifier error: ${(err as Error).message}`,
			});
			actuals.push(null);
			verdict = 'error';
			continue;
		}

		costUsd += r.meter.costUsd;
		tokenIn += r.meter.tokenIn;
		tokenOut += r.meter.tokenOut;
		actuals.push(r.raw);

		const expectation = input.expected as StructuralExpectation;
		const ov = runStructuralOracle(r.raw, expectation);
		oracleVerdicts.push(ov);

		if (ov.verdict === 'fail' && verdict === 'pass') verdict = 'fail';
		if (ov.verdict === 'error') verdict = 'error';
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
