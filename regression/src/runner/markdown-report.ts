/**
 * Markdown summary + REQ-REG-011 accuracy gate.
 *
 * The accuracy gate (`computeRoutingAccuracy`) operates at the **input**
 * level for food-shadow routing cases — every oracle verdict counts toward
 * the denominator. `pass` is the only verdict in the numerator.
 *
 * Per Codex C-2: `fail` AND `error` BOTH count against the gate. A parser
 * regression that converts `kind: 'ok'` into `kind: 'parse-failed'` shows
 * up as `verdict: 'error'` from the oracle — exactly the regression signal
 * we want the gate to catch.
 *
 * The floor (`FOOD_SHADOW_INPUT_FLOOR`) prevents a trivially-passing run
 * from masking misconfiguration (e.g. a bucket filter that excludes
 * everything). Below the floor the gate returns `null` and the CLI exits 0
 * with a warning rather than 1.
 */

import type { RoutingTarget, RunResult, RunSummary } from '@core/types/regression.js';

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
			if (ov.verdict === 'pass') passInputs++;
			// 'fail' and 'error' both count against the gate (Codex C-2).
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
		if (r.verdict === 'pass') summary.pass++;
		else if (r.verdict === 'fail') summary.fail++;
		else if (r.verdict === 'error') summary.error++;
		else if (r.verdict === 'budget-exceeded') summary.budgetExceeded++;
	}
	summary.routingAccuracy = computeRoutingAccuracy(results, targets);
	summary.routingInputsEvaluated = results
		.filter((r) => targets.get(r.caseId) === 'food-shadow')
		.reduce((n, r) => n + r.oracleVerdicts.length, 0);
	return summary;
}

export function formatSummaryMarkdown(
	results: readonly RunResult[],
	targets: ReadonlyMap<string, RoutingTarget>,
): string {
	const s = buildSummary(results, targets);
	const acc =
		s.routingAccuracy === null
			? '(below floor — fewer than ' +
				FOOD_SHADOW_INPUT_FLOOR +
				' food-shadow inputs)'
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
