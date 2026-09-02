/**
 * Estimator behavioural tests (Codex M5).
 *
 * Snapshot tests would be brittle (constants change as we calibrate);
 * the contracts we care about are: totals correctly aggregate by bucket,
 * empty input → 0, unknown bucket → safe default, ceiling field reflects
 * the configured max-run budget.
 */

import { describe, expect, it } from 'vitest';
import { BUCKET_TIER, type EstimatedCase, estimateRunCostUsd } from '../estimator.js';

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

	it('omitting localTiers keeps the legacy remote constants', () => {
		const cases: EstimatedCase[] = [{ caseId: 'r1', bucket: 'routing' }];
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5 });
		expect(out.estimateUsd).toBeGreaterThan(0);
		expect(out.allLocal).toBe(false);
	});
});

/**
 * The operator's invariant: local models (Ollama, llama.cpp) run on the
 * operator's own hardware and are never billed per token, so an all-local
 * matrix costs exactly $0. The GUI confirm dialog used to show the same
 * dollar figure for an all-Ollama matrix as for an all-Opus one — ~$0.19 for
 * a 37-case routing run that costs nothing.
 *
 * Mirrors `regression/src/__tests__/local-model-estimate.test.ts`, which pins
 * the same invariant at the runner's own estimator.
 */
describe('estimateRunCostUsd — local tiers are free', () => {
	const ALL_LOCAL = { fast: true, standard: true, reasoning: true } as const;

	it('an all-local model matrix estimates $0.00', () => {
		const cases: EstimatedCase[] = [
			{ caseId: 'r1', bucket: 'routing' },
			{ caseId: 'p1', bucket: 'receipt' },
			{ caseId: 'c1', bucket: 'chatbot' },
			{ caseId: 'n1', bucket: 'recall' },
		];
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5, localTiers: ALL_LOCAL });
		expect(out.estimateUsd).toBe(0);
		expect(out.perBucketUsd).toEqual({ routing: 0, receipt: 0, chatbot: 0, recall: 0 });
		expect(out.allLocal).toBe(true);
	});

	it('a 37-case all-local routing sweep estimates $0.00', () => {
		const cases: EstimatedCase[] = Array.from({ length: 37 }, (_, i) => ({
			caseId: `r${i}`,
			bucket: 'routing' as const,
		}));
		// Same selection priced remotely is decidedly non-zero — that number is
		// exactly what the operator used to be shown for a free run.
		expect(estimateRunCostUsd(cases, { ceilingUsd: 5 }).estimateUsd).toBeGreaterThan(0.1);
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5, localTiers: ALL_LOCAL });
		expect(out.estimateUsd).toBe(0);
		expect(out.allLocal).toBe(true);
	});

	it('a mixed matrix prices only the buckets served by a remote tier', () => {
		// fast local (routing + recall free), standard remote (receipt + chatbot billed).
		const localFastOnly = { fast: true, standard: false, reasoning: false };
		const cases: EstimatedCase[] = [
			{ caseId: 'r1', bucket: 'routing' },
			{ caseId: 'n1', bucket: 'recall' },
			{ caseId: 'p1', bucket: 'receipt' },
			{ caseId: 'c1', bucket: 'chatbot' },
		];
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5, localTiers: localFastOnly });
		expect(out.perBucketUsd.routing).toBe(0);
		expect(out.perBucketUsd.recall).toBe(0);
		expect(out.perBucketUsd.receipt).toBeGreaterThan(0);
		expect(out.perBucketUsd.chatbot).toBeGreaterThan(0);
		expect(out.estimateUsd).toBeCloseTo(out.perBucketUsd.receipt + out.perBucketUsd.chatbot, 8);
		// Not every selected case is local → not an all-local run.
		expect(out.allLocal).toBe(false);
	});

	it('a local standard tier zeroes receipt + chatbot but not routing', () => {
		const localStandardOnly = { fast: false, standard: true, reasoning: false };
		const cases: EstimatedCase[] = [
			{ caseId: 'r1', bucket: 'routing' },
			{ caseId: 'p1', bucket: 'receipt' },
		];
		const out = estimateRunCostUsd(cases, { ceilingUsd: 5, localTiers: localStandardOnly });
		expect(out.perBucketUsd.receipt).toBe(0);
		expect(out.perBucketUsd.routing).toBeGreaterThan(0);
		expect(out.allLocal).toBe(false);
	});

	it('allLocal is false for an empty selection (nothing to run is not a free run)', () => {
		expect(estimateRunCostUsd([], { ceilingUsd: 5, localTiers: ALL_LOCAL }).allLocal).toBe(false);
	});

	it('bucket → tier map matches what the case-runners actually dispatch on', () => {
		// routing/recall classify on `fast`; the receipt extractor and the
		// chatbot rubric judge both run on `standard`.
		expect(BUCKET_TIER).toEqual({
			routing: 'fast',
			recall: 'fast',
			receipt: 'standard',
			chatbot: 'standard',
		});
	});
});
