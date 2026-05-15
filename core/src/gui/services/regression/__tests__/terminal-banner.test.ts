/**
 * Server-side terminal-banner builder tests.
 *
 * The regression GUI's live banner is formatted here (not in the `.eta`
 * inline script) so all parsing, number-guarding, and wording is unit
 * testable. Inputs arrive from the subprocess SSE event as `unknown` —
 * `RunSummary` and `TierModelSnapshot` shaped, but never trusted.
 */

import { describe, expect, it } from 'vitest';
import { buildCompleteBanner, buildGateFailedBanner } from '../terminal-banner.js';

const validSummary = {
	totalCases: 71,
	pass: 30,
	fail: 38,
	error: 3,
	budgetExceeded: 0,
	routingAccuracy: 0.906,
	routingInputsEvaluated: 53,
	totalCostUsd: 0.31,
	totalDurationMs: 174000,
};

const validModelIds = {
	fast: 'gemma4:26b',
	standard: 'claude-sonnet-4-6',
	reasoning: 'claude-sonnet-4-6',
};

describe('buildGateFailedBanner', () => {
	it('builds a model-result banner from a valid summary + modelIds', () => {
		const b = buildGateFailedBanner(validSummary, validModelIds);
		expect(b.stateLabel).toBe('accuracy gate not met');
		expect(b.headline).toContain('not a crash');
		// per-input accuracy line, with the tested fast-tier model named
		expect(b.lines[0]).toContain('gemma4:26b');
		expect(b.lines[0]).toContain('90.6%');
		expect(b.lines[0]).toContain('53 inputs');
		expect(b.lines[0]).toContain('≥95%');
		// per-case line, clearly disambiguated from the gate metric
		expect(b.lines[1]).toContain('30/71 cases');
		expect(b.lines[1]).toContain('per input, not per case');
		expect(b.hint).toContain('Run tab');
	});

	it('omits the accuracy line when routingAccuracy is null', () => {
		const b = buildGateFailedBanner(
			{ ...validSummary, routingAccuracy: null },
			validModelIds,
		);
		expect(b.lines.some((l) => l.includes('per-input routing accuracy'))).toBe(false);
		// the case line and the action hint still render
		expect(b.lines.some((l) => l.includes('30/71 cases'))).toBe(true);
		expect(b.hint).toContain('Run tab');
	});

	it('omits the model name when modelIds is missing', () => {
		const b = buildGateFailedBanner(validSummary, undefined);
		const accLine = b.lines.find((l) => l.includes('routing accuracy'));
		expect(accLine).toBeDefined();
		expect(accLine).not.toContain('Fast-tier model');
		expect(accLine).toContain('90.6%');
	});

	it('treats a non-string modelIds.fast as absent', () => {
		const b = buildGateFailedBanner(validSummary, { fast: 123, standard: 'x', reasoning: null });
		const accLine = b.lines.find((l) => l.includes('routing accuracy'));
		expect(accLine).not.toContain('Fast-tier model');
	});

	it('falls back to headline + hint only when the summary is not an object', () => {
		for (const bad of [null, undefined, 'oops', 42]) {
			const b = buildGateFailedBanner(bad, validModelIds);
			expect(b.headline).toContain('not a crash');
			expect(b.hint).toContain('Run tab');
			expect(b.lines).toEqual([]);
		}
	});

	it('omits the accuracy line for non-finite routingAccuracy', () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.9']) {
			const b = buildGateFailedBanner({ ...validSummary, routingAccuracy: bad }, validModelIds);
			expect(b.lines.some((l) => l.includes('routing accuracy'))).toBe(false);
		}
	});

	it('omits the case line when pass/totalCases are not finite numbers', () => {
		const b = buildGateFailedBanner(
			{ ...validSummary, pass: Number.NaN, totalCases: 'lots' },
			validModelIds,
		);
		expect(b.lines.some((l) => l.includes('cases passed'))).toBe(false);
	});

	it('rejects routingAccuracy outside [0, 1]', () => {
		// Banner inputs are untrusted — out-of-range values must not render
		// nonsense like `150.0%` accuracy.
		for (const bad of [-0.01, 1.01, -1, 2]) {
			const b = buildGateFailedBanner({ ...validSummary, routingAccuracy: bad }, validModelIds);
			expect(b.lines.some((l) => l.includes('routing accuracy'))).toBe(false);
		}
	});

	it('rejects non-integer or negative pass / totalCases', () => {
		for (const bad of [-1, 1.5]) {
			const b = buildGateFailedBanner(
				{ ...validSummary, pass: bad, totalCases: bad },
				validModelIds,
			);
			expect(b.lines.some((l) => l.includes('cases passed'))).toBe(false);
		}
	});

	it('rejects non-integer or negative routingInputsEvaluated', () => {
		for (const bad of [-1, 53.5]) {
			const b = buildGateFailedBanner(
				{ ...validSummary, routingInputsEvaluated: bad },
				validModelIds,
			);
			expect(b.lines.some((l) => l.includes('per-input routing accuracy'))).toBe(false);
		}
	});
});

describe('buildCompleteBanner', () => {
	it('builds a success banner with the metric summary line', () => {
		const b = buildCompleteBanner(validSummary);
		expect(b.stateLabel).toBe('complete');
		expect(b.headline).toBe('Run complete.');
		expect(b.lines[0]).toContain('30/71 cases passed');
		expect(b.lines[0]).toContain('routing accuracy 90.6%');
		expect(b.lines[0]).toContain('53 inputs');
		expect(b.hint).toBeUndefined();
	});

	it('drops the routing-accuracy clause when routingAccuracy is null', () => {
		const b = buildCompleteBanner({ ...validSummary, routingAccuracy: null });
		expect(b.lines[0]).toContain('30/71 cases passed');
		expect(b.lines[0]).not.toContain('routing accuracy');
	});

	it('falls back to the headline only when the summary is not an object', () => {
		const b = buildCompleteBanner(null);
		expect(b.headline).toBe('Run complete.');
		expect(b.lines).toEqual([]);
		expect(b.hint).toBeUndefined();
	});

	it('omits the metric line when pass/totalCases are not finite', () => {
		const b = buildCompleteBanner({ ...validSummary, totalCases: null });
		expect(b.lines).toEqual([]);
	});

	it('drops the routing-accuracy clause for out-of-range or fractional values', () => {
		// accuracy 1.5 → routing clause omitted but the case line still renders
		const bad = buildCompleteBanner({ ...validSummary, routingAccuracy: 1.5 });
		expect(bad.lines[0]).toContain('30/71 cases passed');
		expect(bad.lines[0]).not.toContain('routing accuracy');
		// fractional input count → same treatment
		const frac = buildCompleteBanner({ ...validSummary, routingInputsEvaluated: 53.5 });
		expect(frac.lines[0]).not.toContain('routing accuracy');
	});
});
