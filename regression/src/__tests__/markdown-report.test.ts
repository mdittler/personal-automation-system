import { describe, expect, it } from 'vitest';
import type { RoutingTarget, RunResult } from '../shared/types.js';
import {
	ACCURACY_GATE_THRESHOLD,
	FOOD_SHADOW_INPUT_FLOOR,
	buildSummary,
	computeRoutingAccuracy,
	formatSummaryMarkdown,
} from '../runner/markdown-report.js';

function mk(
	caseId: string,
	verdicts: Array<'pass' | 'fail' | 'error'>,
	caseVerdict?: RunResult['verdict'],
): RunResult {
	return {
		caseId,
		cacheKey: 'a'.repeat(64),
		source: 'fresh',
		verdict:
			caseVerdict ??
			(verdicts.includes('error')
				? 'error'
				: verdicts.includes('fail')
					? 'fail'
					: 'pass'),
		inputs: verdicts.map(() => ({ payload: 'x', expected: {} })),
		actuals: verdicts.map(() => ''),
		oracleVerdicts: verdicts.map((v) => ({ verdict: v, details: '' })),
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds: { fast: 'f', standard: 's', reasoning: null },
		timestamp: new Date().toISOString(),
		durationMs: 0,
	};
}

describe('computeRoutingAccuracy (REQ-REG-011, Codex C-2)', () => {
	it('threshold constant equals 0.95', () => {
		expect(ACCURACY_GATE_THRESHOLD).toBe(0.95);
	});

	it('returns 1.0 when all food-shadow inputs pass', () => {
		const results = Array.from({ length: 25 }, (_, i) => mk(`c${i}`, ['pass']));
		const targets = new Map(
			results.map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		expect(computeRoutingAccuracy(results, targets)).toBe(1.0);
	});

	it('counts fail against the gate', () => {
		const passes = Array.from({ length: 23 }, (_, i) => mk(`p${i}`, ['pass']));
		const fail = mk('f1', ['fail']);
		const targets = new Map(
			[...passes, fail].map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		const acc = computeRoutingAccuracy([...passes, fail], targets);
		expect(acc).toBeCloseTo(23 / 24, 3);
	});

	it('counts error against the gate', () => {
		const passes = Array.from({ length: 23 }, (_, i) => mk(`p${i}`, ['pass']));
		const err = mk('e1', ['error']);
		const targets = new Map(
			[...passes, err].map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		const acc = computeRoutingAccuracy([...passes, err], targets);
		expect(acc).toBeCloseTo(23 / 24, 3);
	});

	it('counts budget-exceeded cases (whose synthesized verdicts are error) against the gate', () => {
		const passes = Array.from({ length: 19 }, (_, i) => mk(`p${i}`, ['pass']));
		const be = mk('b1', ['error'], 'budget-exceeded');
		const targets = new Map(
			[...passes, be].map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		const acc = computeRoutingAccuracy([...passes, be], targets);
		expect(acc).toBeCloseTo(19 / 20, 3);
	});

	it(`returns null below floor (${FOOD_SHADOW_INPUT_FLOOR})`, () => {
		expect(FOOD_SHADOW_INPUT_FLOOR).toBe(20);
		const results = Array.from({ length: 10 }, (_, i) => mk(`c${i}`, ['pass']));
		const targets = new Map(
			results.map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		expect(computeRoutingAccuracy(results, targets)).toBeNull();
	});

	it('returns null when there are exactly FLOOR-1 evaluable inputs', () => {
		const results = Array.from({ length: FOOD_SHADOW_INPUT_FLOOR - 1 }, (_, i) =>
			mk(`c${i}`, ['pass']),
		);
		const targets = new Map(
			results.map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		expect(computeRoutingAccuracy(results, targets)).toBeNull();
	});

	it('aggregates across multi-input cases at the input level', () => {
		const verdicts: Array<'pass' | 'fail' | 'error'> = [];
		for (let i = 0; i < 21; i++) verdicts.push('pass');
		verdicts.push('fail');
		const results = [mk('c1', verdicts, 'fail')];
		const targets = new Map([['c1', 'food-shadow' as RoutingTarget]]);
		expect(computeRoutingAccuracy(results, targets)).toBeCloseTo(21 / 22, 3);
	});

	it('ignores non-food-shadow targets', () => {
		const results = [mk('sc', ['fail'])];
		const targets = new Map([['sc', 'session-control' as RoutingTarget]]);
		expect(computeRoutingAccuracy(results, targets)).toBeNull();
	});

	it('mixes food-shadow + pas: counts only food-shadow inputs', () => {
		const food = Array.from({ length: 22 }, (_, i) => mk(`f${i}`, ['pass']));
		const pasFail = mk('pas-1', ['fail']);
		const targets = new Map<string, RoutingTarget>();
		for (const r of food) targets.set(r.caseId, 'food-shadow');
		targets.set(pasFail.caseId, 'pas');
		const acc = computeRoutingAccuracy([...food, pasFail], targets);
		expect(acc).toBe(1.0);
	});
});

describe('buildSummary', () => {
	it('aggregates verdicts at the case level', () => {
		const results = [mk('p', ['pass']), mk('f', ['fail']), mk('e', ['error'])];
		const targets = new Map(
			results.map((r) => [r.caseId, 'food-shadow' as RoutingTarget]),
		);
		const s = buildSummary(results, targets);
		expect(s.pass).toBe(1);
		expect(s.fail).toBe(1);
		expect(s.error).toBe(1);
		expect(s.totalCases).toBe(3);
	});

	it('sums totalCostUsd and totalDurationMs', () => {
		const r1: RunResult = { ...mk('a', ['pass']), costUsd: 0.001, durationMs: 100 };
		const r2: RunResult = { ...mk('b', ['pass']), costUsd: 0.002, durationMs: 200 };
		const targets = new Map([
			['a', 'food-shadow' as RoutingTarget],
			['b', 'food-shadow' as RoutingTarget],
		]);
		const s = buildSummary([r1, r2], targets);
		expect(s.totalCostUsd).toBeCloseTo(0.003, 6);
		expect(s.totalDurationMs).toBe(300);
	});

	it('counts routingInputsEvaluated correctly for food-shadow-only cases', () => {
		const r = mk('c1', ['pass', 'pass', 'fail']);
		const targets = new Map([['c1', 'food-shadow' as RoutingTarget]]);
		const s = buildSummary([r], targets);
		expect(s.routingInputsEvaluated).toBe(3);
	});
});

describe('formatSummaryMarkdown', () => {
	it('renders a markdown table', () => {
		const results = [mk('p', ['pass']), mk('f', ['fail'])];
		const targets = new Map([
			['p', 'food-shadow' as RoutingTarget],
			['f', 'food-shadow' as RoutingTarget],
		]);
		const md = formatSummaryMarkdown(results, targets);
		expect(md).toMatch(/\| metric \| value \|/);
		expect(md).toMatch(/\| pass \| 1 \|/);
		expect(md).toMatch(/\| fail \| 1 \|/);
		expect(md).toMatch(/REQ-REG-011/);
	});

	it('renders "below floor" when accuracy is null', () => {
		const md = formatSummaryMarkdown([], new Map());
		expect(md).toMatch(/below floor/i);
	});
});
