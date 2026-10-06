/**
 * Markdown summary + REQ-REG-011 accuracy gate.
 *
 * `computeRoutingAccuracy` operates at the input level over food-shadow
 * routing cases. `pass` is the only verdict in the numerator; `fail` AND
 * `error` both count against the denominator — a parser regression that
 * makes the oracle fail or error is exactly the signal the gate exists to
 * catch.
 *
 * `FOOD_SHADOW_INPUT_FLOOR` prevents a trivially-passing run from masking
 * misconfiguration (e.g. an over-aggressive bucket filter). Below the floor
 * the gate returns `null` and the CLI exits 0 with a warning rather than 1.
 */

import {
	type RoutingTarget,
	type RunResult,
	type RunSummary,
	VERDICT,
} from '@core/types/regression.js';
import type { EstimateCall, EstimateUsdFn } from '../shared/types.js';

export const ACCURACY_GATE_THRESHOLD = 0.95;
export const FOOD_SHADOW_INPUT_FLOOR = 20;

export function computeRoutingAccuracy(
	results: readonly RunResult[],
	targets: ReadonlyMap<string, RoutingTarget>,
): number | null {
	let totalInputs = 0;
	let passInputs = 0;
	for (const r of results) {
		if (targets.get(r.caseId) !== 'food-shadow') continue;
		for (const ov of r.oracleVerdicts) {
			totalInputs++;
			if (ov.verdict === VERDICT.pass) passInputs++;
			// 'fail' and 'error' both count against the gate.
		}
	}
	if (totalInputs < FOOD_SHADOW_INPUT_FLOOR) return null;
	return passInputs / totalInputs;
}

export function buildSummary(
	results: readonly RunResult[],
	targets: ReadonlyMap<string, RoutingTarget>,
): RunSummary {
	const summary: RunSummary = {
		totalCases: results.length,
		pass: 0,
		fail: 0,
		error: 0,
		budgetExceeded: 0,
		routingAccuracy: null,
		routingInputsEvaluated: 0,
		totalCostUsd: 0,
		totalDurationMs: 0,
	};
	for (const r of results) {
		summary.totalCostUsd += r.costUsd;
		summary.totalDurationMs += r.durationMs;
		if (r.verdict === VERDICT.pass) summary.pass++;
		else if (r.verdict === VERDICT.fail) summary.fail++;
		else if (r.verdict === VERDICT.error) summary.error++;
		else if (r.verdict === VERDICT.budgetExceeded) summary.budgetExceeded++;
	}
	summary.routingAccuracy = computeRoutingAccuracy(results, targets);
	summary.routingInputsEvaluated = results
		.filter((r) => targets.get(r.caseId) === 'food-shadow')
		.reduce((n, r) => n + r.oracleVerdicts.length, 0);
	return summary;
}

/**
 * Format the dry-run preview: how many cases / inputs would dispatch,
 * estimated cost, what the operator would pay before pressing the
 * trigger. **Does NOT** report pass/fail counts — no oracle ran.
 */
export function formatDryRunMarkdown(
	results: readonly RunResult[],
	estimateUsd: EstimateUsdFn,
	perCaseUsd?: (r: RunResult) => number | undefined,
): string {
	const ESTIMATE_TOKENS = { tokenIn: 400, tokenOut: 80 };
	const totalCases = results.length;
	const totalInputs = results.reduce((n, r) => n + r.inputs.length, 0);
	// Price each case against the tier it would actually run on (recorded by
	// `makeDryRunResult`). A single fast-tier rate for every case both
	// under-charges receipt/chatbot and, on a mixed local/remote matrix,
	// quotes remote rates for buckets served by a local model.
	const estimatedCost = results.reduce((usd, r) => {
		const override = perCaseUsd?.(r);
		if (typeof override === 'number') return usd + override;
		const tier = r.evaluatedTier;
		const call: EstimateCall =
			tier === 'fast' || tier === 'standard' || tier === 'reasoning'
				? { ...ESTIMATE_TOKENS, tier }
				: ESTIMATE_TOKENS;
		return usd + estimateUsd(call) * r.inputs.length;
	}, 0);
	return [
		'DRY RUN — no LLM calls were made. The numbers below are estimates.',
		'',
		'| metric | value |',
		'|---|---|',
		`| cases that would dispatch | ${totalCases} |`,
		`| total inputs across selected cases | ${totalInputs} |`,
		`| estimated calls (cache misses only — cached cases skip dispatch) | ≤ ${totalInputs} |`,
		`| estimated cost upper-bound (USD) | ${estimatedCost.toFixed(6)} |`,
	].join('\n');
}

export function formatSummaryMarkdown(
	results: readonly RunResult[],
	targets: ReadonlyMap<string, RoutingTarget>,
): string {
	const s = buildSummary(results, targets);
	const acc =
		s.routingAccuracy === null
			? `(below floor — fewer than ${FOOD_SHADOW_INPUT_FLOOR} food-shadow inputs)`
			: `${(s.routingAccuracy * 100).toFixed(2)}%`;
	return [
		'| metric | value |',
		'|---|---|',
		`| total cases | ${s.totalCases} |`,
		`| pass | ${s.pass} |`,
		`| fail | ${s.fail} |`,
		`| error | ${s.error} |`,
		`| budget-exceeded | ${s.budgetExceeded} |`,
		`| food-shadow inputs evaluated | ${s.routingInputsEvaluated} |`,
		`| routing accuracy (REQ-REG-011) | ${acc} |`,
		`| total cost (USD) | ${s.totalCostUsd.toFixed(6)} |`,
		`| total wall time (ms) | ${s.totalDurationMs} |`,
	].join('\n');
}

/**
 * Agent bucket section (REQ-REG-AGENT-004): pass^k (tasks whose every trial
 * passed) and the per-trial pass rate, grouped by task set and by category.
 */
export function formatAgentSection(results: readonly RunResult[]): string {
	type Acc = { tasks: number; passK: number; trials: number; trialPass: number };
	const bySet = new Map<string, Acc>();
	const byCategory = new Map<string, Acc>();
	const add = (m: Map<string, Acc>, key: string, r: RunResult) => {
		const a = m.get(key) ?? { tasks: 0, passK: 0, trials: 0, trialPass: 0 };
		a.tasks++;
		if (r.verdict === VERDICT.pass) a.passK++;
		a.trials += r.oracleVerdicts.length;
		a.trialPass += r.oracleVerdicts.filter((v) => v.verdict === VERDICT.pass).length;
		m.set(key, a);
	};
	for (const r of results) {
		const exp = (r.inputs[0]?.expected ?? {}) as { set?: string; category?: string };
		add(bySet, exp.set ?? 'unknown', r);
		add(byCategory, exp.category ?? 'unknown', r);
	}
	const rows = (m: Map<string, Acc>) =>
		[...m.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, a]) => `| ${k} | ${a.passK}/${a.tasks} | ${a.trialPass}/${a.trials} |`);
	const perTrial = results
		.map((r) => r.durationMs / Math.max(1, r.oracleVerdicts.length))
		.sort((a, b) => a - b);
	const median = perTrial.length ? perTrial[Math.floor(perTrial.length / 2)]! : 0;
	return [
		'### Agent bucket',
		'',
		'| set | pass^k (tasks) | trial pass rate |',
		'|---|---|---|',
		...rows(bySet),
		'',
		'| category | pass^k (tasks) | trial pass rate |',
		'|---|---|---|',
		...rows(byCategory),
		'',
		`Median wall time per trial (includes worker start-up): ${(median / 1000).toFixed(1)} s`,
	].join('\n');
}
