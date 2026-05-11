/**
 * Estimator behavioural tests (Codex M5).
 *
 * Snapshot tests would be brittle (constants change as we calibrate);
 * the contracts we care about are: totals correctly aggregate by bucket,
 * empty input → 0, unknown bucket → safe default, ceiling field reflects
 * the configured max-run budget.
 */

import { describe, expect, it } from 'vitest';
import { type EstimatedCase, estimateRunCostUsd } from '../estimator.js';

describe('estimateRunCostUsd', () => {
	it('returns 0 for an empty case list', () => {
		const { estimateUsd, ceilingUsd } = estimateRunCostUsd([], { ceilingUsd: 5 });
		expect(estimateUsd).toBe(0);
		expect(ceilingUsd).toBe(5);
	});

	it('sums per-bucket constants for a routing-only set', () => {
		const cases: EstimatedCase[] = [
			{ caseId: 'a', bucket: 'routing' },
			{ caseId: 'b', bucket: 'routing' },
			{ caseId: 'c', bucket: 'routing' },
		];
		const { estimateUsd } = estimateRunCostUsd(cases, { ceilingUsd: 5 });
		// 3 routing cases × routing constant
		expect(estimateUsd).toBeGreaterThan(0);
		expect(estimateUsd).toBeLessThan(0.1); // routing is the cheap bucket
	});

	it('charges receipt cases more than routing cases (vision dispatch)', () => {
		const routing: EstimatedCase[] = [{ caseId: 'r', bucket: 'routing' }];
		const receipt: EstimatedCase[] = [{ caseId: 'p', bucket: 'receipt' }];
		const r = estimateRunCostUsd(routing, { ceilingUsd: 5 }).estimateUsd;
		const p = estimateRunCostUsd(receipt, { ceilingUsd: 5 }).estimateUsd;
		expect(p).toBeGreaterThan(r);
	});

	it('breaks out per-bucket subtotals for the GUI banner', () => {
		const cases: EstimatedCase[] = [
			{ caseId: 'r1', bucket: 'routing' },
			{ caseId: 'r2', bucket: 'routing' },
			{ caseId: 'c1', bucket: 'chatbot' },
		];
		const { perBucketUsd } = estimateRunCostUsd(cases, { ceilingUsd: 5 });
		expect(perBucketUsd.routing).toBeGreaterThan(0);
		expect(perBucketUsd.chatbot).toBeGreaterThan(0);
		expect(perBucketUsd.receipt).toBe(0);
		expect(perBucketUsd.recall).toBe(0);
	});

	it('passes through the ceiling unchanged for the GUI banner', () => {
		expect(estimateRunCostUsd([], { ceilingUsd: 12.34 }).ceilingUsd).toBe(12.34);
		expect(estimateRunCostUsd([], { ceilingUsd: 0 }).ceilingUsd).toBe(0);
	});

	it('total === sum of perBucketUsd values (contract)', () => {
		const cases: EstimatedCase[] = [
			{ caseId: 'r1', bucket: 'routing' },
			{ caseId: 'p1', bucket: 'receipt' },
			{ caseId: 'c1', bucket: 'chatbot' },
			{ caseId: 'n1', bucket: 'recall' },
		];
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5 });
		const sum =
			out.perBucketUsd.routing +
			out.perBucketUsd.receipt +
			out.perBucketUsd.chatbot +
			out.perBucketUsd.recall;
		expect(out.estimateUsd).toBeCloseTo(sum, 8);
	});

	it('rejects NaN ceiling (defensive)', () => {
		expect(() => estimateRunCostUsd([], { ceilingUsd: Number.NaN })).toThrow();
	});

	it('rejects negative ceiling (defensive)', () => {
		expect(() => estimateRunCostUsd([], { ceilingUsd: -1 })).toThrow();
	});
});
