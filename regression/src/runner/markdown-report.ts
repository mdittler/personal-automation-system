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
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number,
): string {
	const ESTIMATE_TOKENS = { tokenIn: 400, tokenOut: 80 };
	const totalCases = results.length;
	const totalInputs = results.reduce((n, r) => n + r.inputs.length, 0);
	const estimatedCost = estimateUsd(ESTIMATE_TOKENS) * totalInputs;
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
