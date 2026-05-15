/**
 * Server-side formatting for the regression GUI's terminal (run-finished)
 * banner. The `.eta` live-banner script only assembles DOM text nodes from
 * the structured object this module returns — all parsing, number-guarding,
 * and wording lives here so it is unit testable in plain TS.
 *
 * Inputs come from the subprocess SSE terminal event and are `RunSummary` /
 * `TierModelSnapshot` shaped, but arrive as `unknown` and are never trusted.
 */

import { ROUTING_ACCURACY_GATE, isPlainObject } from '../../../types/regression.js';

/** Structured banner the live-banner client renders as DOM text nodes. */
export interface TerminalBanner {
	/** Short human label for the `.run-state` span (NOT the CSS class). */
	stateLabel: string;
	/** Bold first line. */
	headline: string;
	/** Zero or more detail lines, rendered one node each. */
	lines: string[];
	/** Optional closing call-to-action. */
	hint?: string;
}

// Banner inputs cross the subprocess JSON boundary and must be treated as
// untrusted: any field can be wrong-typed, NaN, negative, fractional, or out
// of range. Bounded helpers below match the manifest validator's contract so
// a malformed event cannot render nonsense like `150.0%`, `-1 inputs`, or
// `1.2/3.4 cases`.
function accuracy(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function nonNegInt(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0
		? v
		: null;
}

function fastModel(modelIdsRaw: unknown): string | null {
	if (!isPlainObject(modelIdsRaw)) return null;
	const f = modelIdsRaw.fast;
	return typeof f === 'string' && f.length > 0 ? f : null;
}

function pct(acc: number): string {
	return `${(acc * 100).toFixed(1)}%`;
}

/**
 * Banner for a `gate-failed` terminal event: the suite ran to completion but
 * per-input routing accuracy was below the REQ-REG-011 bar. Framed explicitly
 * as a model result, not a crash.
 */
export function buildGateFailedBanner(
	summaryRaw: unknown,
	modelIdsRaw: unknown,
): TerminalBanner {
	const lines: string[] = [];
	const summary = isPlainObject(summaryRaw) ? summaryRaw : null;

	if (summary) {
		const acc = accuracy(summary.routingAccuracy);
		const inputs = nonNegInt(summary.routingInputsEvaluated);
		if (acc !== null && inputs !== null) {
			const model = fastModel(modelIdsRaw);
			const prefix = model ? `Fast-tier model ${model}: ` : '';
			lines.push(
				`${prefix}${pct(acc)} per-input routing accuracy over ${inputs} inputs — REQ-REG-011 needs ≥${ROUTING_ACCURACY_GATE * 100}%.`,
			);
		}
		const pass = nonNegInt(summary.pass);
		const total = nonNegInt(summary.totalCases);
		if (pass !== null && total !== null) {
			lines.push(
				`${pass}/${total} cases passed this run. The gate is measured per input, not per case.`,
			);
		}
	}

	return {
		stateLabel: 'accuracy gate not met',
		headline:
			'Suite completed — the model scored below the accuracy bar. This is a result, not a crash.',
		lines,
		hint: 'Pick a stronger fast-tier model on the Run tab and re-run.',
	};
}

/**
 * Banner for a `complete` terminal event: the suite finished and (when a
 * routing bucket ran) cleared the gate. Carries a one-line metric summary.
 */
export function buildCompleteBanner(summaryRaw: unknown): TerminalBanner {
	const lines: string[] = [];
	const summary = isPlainObject(summaryRaw) ? summaryRaw : null;

	if (summary) {
		const pass = nonNegInt(summary.pass);
		const total = nonNegInt(summary.totalCases);
		if (pass !== null && total !== null) {
			let line = `${pass}/${total} cases passed`;
			const acc = accuracy(summary.routingAccuracy);
			const inputs = nonNegInt(summary.routingInputsEvaluated);
			if (acc !== null && inputs !== null) {
				line += ` · routing accuracy ${pct(acc)} over ${inputs} inputs`;
			}
			lines.push(line);
		}
	}

	return {
		stateLabel: 'complete',
		headline: 'Run complete.',
		lines,
	};
}
