/**
 * Tests for the `evaluatedTier` field on `RunResult`: validator behavior
 * (legacy-tolerant + strict on values), case-runner attribution per bucket,
 * and the `getEvaluatedTier` read-side helper.
 *
 * REQ-REG-GUI-V2-001.
 */

import { describe, expect, it } from 'vitest';
import {
	EVALUATED_TIER_VALUES,
	type RunResult,
	getEvaluatedTier,
	looksLikeRunResult,
} from '@core/types/regression.js';
import { ROUTING_TARGET_TIER } from '../runner/case-runners/routing-runner.js';

const VALID_KEY = 'a'.repeat(64);

function baseResult(overrides: Partial<RunResult> = {}): RunResult {
	return {
		caseId: 'case-1',
		cacheKey: VALID_KEY,
		source: 'fresh',
		verdict: 'pass',
		inputs: [],
		actuals: [],
		oracleVerdicts: [],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds: { fast: 'f', standard: 's', reasoning: null },
		timestamp: '2026-05-08T00:00:00.000Z',
		durationMs: 0,
		...overrides,
	};
}

describe('EVALUATED_TIER_VALUES', () => {
	it('enumerates exactly fast/standard/reasoning/mixed/unknown', () => {
		expect([...EVALUATED_TIER_VALUES].sort()).toEqual([
			'fast',
			'mixed',
			'reasoning',
			'standard',
			'unknown',
		]);
	});
});

describe('looksLikeRunResult — evaluatedTier optional + enum-strict', () => {
	it('accepts a result with no evaluatedTier (legacy cache)', () => {
		const r = baseResult();
		// biome-ignore lint/performance/noDelete: targeted legacy-mode reproduction
		delete (r as Partial<RunResult>).evaluatedTier;
		expect(looksLikeRunResult(r, 'case-1', VALID_KEY)).toBe(true);
	});

	it.each(['fast', 'standard', 'reasoning', 'mixed', 'unknown'] as const)(
		'accepts evaluatedTier=%s',
		(tier) => {
			const r = baseResult({ evaluatedTier: tier });
			expect(looksLikeRunResult(r, 'case-1', VALID_KEY)).toBe(true);
		},
	);

	it('rejects unknown evaluatedTier string', () => {
		const r = baseResult();
		(r as unknown as { evaluatedTier: string }).evaluatedTier = 'tier-7';
		expect(looksLikeRunResult(r, 'case-1', VALID_KEY)).toBe(false);
	});

	it('rejects non-string evaluatedTier', () => {
		const r = baseResult();
		(r as unknown as { evaluatedTier: number }).evaluatedTier = 1;
		expect(looksLikeRunResult(r, 'case-1', VALID_KEY)).toBe(false);
	});
});

describe('getEvaluatedTier helper', () => {
	it('returns the tier when set', () => {
		expect(getEvaluatedTier({ evaluatedTier: 'standard' })).toBe('standard');
	});

	it('returns "unknown" when missing (legacy cache)', () => {
		expect(getEvaluatedTier({})).toBe('unknown');
	});
});

describe('ROUTING_TARGET_TIER lookup table', () => {
	it('maps every RoutingTarget to a tier slot', () => {
		expect(ROUTING_TARGET_TIER['food-shadow']).toBe('fast');
		expect(ROUTING_TARGET_TIER['session-control']).toBe('fast');
		expect(ROUTING_TARGET_TIER.pas).toBe('fast');
	});

	it('every value is one of the enumerated EvaluatedTier values', () => {
		const allowed = new Set(EVALUATED_TIER_VALUES as readonly string[]);
		for (const tier of Object.values(ROUTING_TARGET_TIER)) {
			expect(allowed.has(tier)).toBe(true);
		}
	});
});
