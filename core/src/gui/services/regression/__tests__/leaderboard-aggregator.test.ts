/**
 * Tests for `aggregateLeaderboard` (REQ-REG-GUI-V2-008/009/010).
 * - One row per (tier, model) that participated.
 * - Selection defaults to latest completedAt; pin overrides win.
 * - Mixed/unknown-tier caseResults excluded.
 * - Per-bucket breakdown + cached count + judge override flag.
 */

import { describe, expect, it } from 'vitest';
import type { ManifestCaseResult, RunManifest } from '../../../../types/regression.js';
import { aggregateLeaderboard } from '../leaderboard-aggregator.js';

function cr(overrides: Partial<ManifestCaseResult> & { caseId: string }): ManifestCaseResult {
	return {
		bucket: 'routing',
		cacheKey: 'a'.repeat(64),
		evaluatedTier: 'fast',
		verdict: 'pass',
		source: 'fresh',
		costUsd: 0.001,
		timestamp: '2026-05-13T11:00:00.000Z',
		...overrides,
	};
}

function manifest(opts: {
	runId: string;
	completedAt: string;
	fast?: string;
	standard?: string;
	reasoning?: string | null;
	judgeOverride?: boolean;
	caseResults: ManifestCaseResult[];
	routingAccuracy?: number | null;
	routingInputsEvaluated?: number;
}): RunManifest {
	return {
		runId: opts.runId,
		startedAt: '2026-05-13T10:00:00.000Z',
		completedAt: opts.completedAt,
		modelIds: {
			fast: opts.fast ?? 'ollama/gemma3:31b',
			standard: opts.standard ?? 'anthropic/claude-sonnet-4-6',
			reasoning: opts.reasoning === undefined ? null : opts.reasoning,
		},
		judgeOverrideApplied: opts.judgeOverride ?? false,
		bucketsRequested: ['__all__'],
		caseResults: opts.caseResults,
		summary: {
			totalCases: opts.caseResults.length,
			pass: 0,
			fail: 0,
			error: 0,
			budgetExceeded: 0,
			routingAccuracy: opts.routingAccuracy ?? null,
			routingInputsEvaluated: opts.routingInputsEvaluated ?? 0,
			totalCostUsd: opts.caseResults.reduce((s, c) => s + c.costUsd, 0),
			totalDurationMs: 0,
		},
	};
}

describe('aggregateLeaderboard — single tier', () => {
	it('returns one row per fast-tier model that has fast-tier results', () => {
		const m1 = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const m2 = manifest({
			runId: 'r2',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'B',
			caseResults: [cr({ caseId: 'c2', verdict: 'fail' })],
		});
		const rows = aggregateLeaderboard({ manifests: [m1, m2], tier: 'fast' });
		expect(rows.map((r) => r.modelId).sort()).toEqual(['A', 'B']);
		expect(rows.find((r) => r.modelId === 'A')!.passRate).toBe(1);
		expect(rows.find((r) => r.modelId === 'B')!.passRate).toBe(0);
	});

	it('excludes manifests that have no fast-tier results', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', evaluatedTier: 'standard' })],
		});
		expect(aggregateLeaderboard({ manifests: [m], tier: 'fast' })).toEqual([]);
	});

	it('mixed and unknown evaluatedTier do NOT count toward any per-tier row', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			caseResults: [
				cr({ caseId: 'c1', evaluatedTier: 'fast' }),
				cr({ caseId: 'c2', evaluatedTier: 'mixed', verdict: 'fail' }),
				cr({ caseId: 'c3', evaluatedTier: 'unknown', verdict: 'error' }),
			],
		});
		const rows = aggregateLeaderboard({ manifests: [m], tier: 'fast' });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.total).toBe(1);
		expect(rows[0]!.passRate).toBe(1);
	});

	it('latest-by-completedAt wins when a model has multiple runs', () => {
		const older = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T08:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', verdict: 'fail' })],
		});
		const newer = manifest({
			runId: 'r2',
			completedAt: '2026-05-13T12:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', verdict: 'pass' })],
		});
		const rows = aggregateLeaderboard({ manifests: [older, newer], tier: 'fast' });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.runId).toBe('r2');
		expect(rows[0]!.passRate).toBe(1);
		expect(rows[0]!.completedAt).toBe('2026-05-13T12:00:00.000Z');
	});

	it('pinOverrides selects a specific historical run (REQ-REG-GUI-V2-010)', () => {
		const older = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T08:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', verdict: 'fail' })],
		});
		const newer = manifest({
			runId: 'r2',
			completedAt: '2026-05-13T12:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', verdict: 'pass' })],
		});
		const rows = aggregateLeaderboard({
			manifests: [older, newer],
			tier: 'fast',
			pinOverrides: [{ tier: 'fast', modelId: 'A', runId: 'r1' }],
		});
		expect(rows[0]!.runId).toBe('r1');
		expect(rows[0]!.passRate).toBe(0);
	});

	it('pin override for a different tier is ignored on this tier', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const rows = aggregateLeaderboard({
			manifests: [m],
			tier: 'fast',
			pinOverrides: [{ tier: 'standard', modelId: 'wrong', runId: 'does-not-exist' }],
		});
		expect(rows[0]!.runId).toBe('r1');
	});

	it('judgeOverrideApplied surfaces on standard tier rows only', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			standard: 'S',
			judgeOverride: true,
			caseResults: [
				cr({ caseId: 'c1', evaluatedTier: 'fast' }),
				cr({ caseId: 'c2', evaluatedTier: 'standard' }),
			],
		});
		const fastRow = aggregateLeaderboard({ manifests: [m], tier: 'fast' })[0]!;
		const standardRow = aggregateLeaderboard({ manifests: [m], tier: 'standard' })[0]!;
		expect(fastRow.judgeOverrideApplied).toBe(false);
		expect(standardRow.judgeOverrideApplied).toBe(true);
	});
});

describe('aggregateLeaderboard — counts and grouping', () => {
	const fixture = manifest({
		runId: 'r1',
		completedAt: '2026-05-13T11:00:00.000Z',
		fast: 'A',
		caseResults: [
			cr({ caseId: 'c1', bucket: 'routing', verdict: 'pass' }),
			cr({ caseId: 'c2', bucket: 'routing', verdict: 'fail' }),
			cr({ caseId: 'c3', bucket: 'recall', verdict: 'pass', source: 'cached' }),
			cr({
				caseId: 'c4',
				bucket: 'routing',
				verdict: 'error',
				costUsd: 0.005,
			}),
		],
	});

	it('total = pass+fail+error+budgetExceeded; passRate is pass/total', () => {
		const row = aggregateLeaderboard({ manifests: [fixture], tier: 'fast' })[0]!;
		expect(row.total).toBe(4);
		expect(row.pass).toBe(2);
		expect(row.fail).toBe(1);
		expect(row.error).toBe(1);
		expect(row.passRate).toBeCloseTo(0.5, 5);
	});

	it('cached count reflects ManifestCaseResult.source', () => {
		const row = aggregateLeaderboard({ manifests: [fixture], tier: 'fast' })[0]!;
		expect(row.cached).toBe(1);
	});

	it('totalCostUsd sums per-case costs', () => {
		const row = aggregateLeaderboard({ manifests: [fixture], tier: 'fast' })[0]!;
		expect(row.totalCostUsd).toBeCloseTo(0.001 + 0.001 + 0.001 + 0.005, 6);
	});

	it('per-bucket breakdown groups results and sorts alphabetically', () => {
		const row = aggregateLeaderboard({ manifests: [fixture], tier: 'fast' })[0]!;
		expect(row.buckets.map((b) => b.bucket)).toEqual(['recall', 'routing']);
		expect(row.buckets.find((b) => b.bucket === 'routing')!.fail).toBe(1);
	});

	it('passRate 0 / total 0 when no per-tier results', () => {
		const m = manifest({
			runId: 'r0',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', evaluatedTier: 'standard' })],
		});
		const rows = aggregateLeaderboard({ manifests: [m], tier: 'fast' });
		expect(rows).toEqual([]);
	});
});

describe('aggregateLeaderboard — routing accuracy attribution', () => {
	it('fast-tier rows carry routingAccuracy + routingInputsEvaluated from the summary', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			routingAccuracy: 0.906,
			routingInputsEvaluated: 53,
			caseResults: [cr({ caseId: 'c1', evaluatedTier: 'fast' })],
		});
		const row = aggregateLeaderboard({ manifests: [m], tier: 'fast' })[0]!;
		expect(row.routingAccuracy).toBe(0.906);
		expect(row.routingInputsEvaluated).toBe(53);
	});

	it('does NOT leak run-wide routing accuracy onto standard/reasoning rows', () => {
		// Same manifest, non-null summary.routingAccuracy — but routing cases
		// only ran on the fast tier, so standard/reasoning rows must read null/0.
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			standard: 'S',
			reasoning: 'R',
			routingAccuracy: 0.906,
			routingInputsEvaluated: 53,
			caseResults: [
				cr({ caseId: 'c1', evaluatedTier: 'fast', bucket: 'routing' }),
				cr({ caseId: 'c2', evaluatedTier: 'standard', bucket: 'chatbot' }),
				cr({ caseId: 'c3', evaluatedTier: 'reasoning', bucket: 'chatbot' }),
			],
		});
		const standardRow = aggregateLeaderboard({ manifests: [m], tier: 'standard' })[0]!;
		const reasoningRow = aggregateLeaderboard({ manifests: [m], tier: 'reasoning' })[0]!;
		expect(standardRow.routingAccuracy).toBeNull();
		expect(standardRow.routingInputsEvaluated).toBe(0);
		expect(reasoningRow.routingAccuracy).toBeNull();
		expect(reasoningRow.routingInputsEvaluated).toBe(0);
	});

	it('fast-tier row reads null when the summary routingAccuracy is null (below floor)', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'A',
			routingAccuracy: null,
			routingInputsEvaluated: 0,
			caseResults: [cr({ caseId: 'c1', evaluatedTier: 'fast' })],
		});
		const row = aggregateLeaderboard({ manifests: [m], tier: 'fast' })[0]!;
		expect(row.routingAccuracy).toBeNull();
		expect(row.routingInputsEvaluated).toBe(0);
	});
});

describe('aggregateLeaderboard — row sort', () => {
	it('sorts by passRate desc, then totalCostUsd asc as tiebreaker', () => {
		const a = manifest({
			runId: 'r1',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'expensive-perfect',
			caseResults: [cr({ caseId: 'c1', verdict: 'pass', costUsd: 1 })],
		});
		const b = manifest({
			runId: 'r2',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'cheap-perfect',
			caseResults: [cr({ caseId: 'c1', verdict: 'pass', costUsd: 0.001 })],
		});
		const c = manifest({
			runId: 'r3',
			completedAt: '2026-05-13T11:00:00.000Z',
			fast: 'lower-accuracy',
			caseResults: [cr({ caseId: 'c1', verdict: 'fail', costUsd: 0 })],
		});
		const rows = aggregateLeaderboard({ manifests: [a, b, c], tier: 'fast' });
		expect(rows.map((r) => r.modelId)).toEqual([
			'cheap-perfect',
			'expensive-perfect',
			'lower-accuracy',
		]);
	});
});
