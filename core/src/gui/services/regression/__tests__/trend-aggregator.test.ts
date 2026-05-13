/**
 * Tests for `buildTrendData` (REQ-REG-GUI-V2-013/014/015).
 */

import { describe, expect, it } from 'vitest';
import type {
	ManifestCaseResult,
	RunManifest,
} from '../../../../types/regression.js';
import { buildTrendData } from '../trend-aggregator.js';

function cr(o: Partial<ManifestCaseResult> & { caseId: string }): ManifestCaseResult {
	return {
		bucket: 'routing',
		cacheKey: 'a'.repeat(64),
		evaluatedTier: 'fast',
		verdict: 'pass',
		source: 'fresh',
		costUsd: 0.001,
		timestamp: '2026-05-13T11:00:00.000Z',
		...o,
	};
}

function manifest(o: {
	runId: string;
	completedAt: string;
	fast?: string;
	caseResults: ManifestCaseResult[];
}): RunManifest {
	return {
		runId: o.runId,
		startedAt: '2026-05-13T10:00:00.000Z',
		completedAt: o.completedAt,
		modelIds: {
			fast: o.fast ?? 'A',
			standard: 'standard-m',
			reasoning: null,
		},
		judgeOverrideApplied: false,
		bucketsRequested: ['__all__'],
		caseResults: o.caseResults,
		summary: {
			totalCases: o.caseResults.length,
			pass: 0,
			fail: 0,
			error: 0,
			budgetExceeded: 0,
			routingAccuracy: null,
			routingInputsEvaluated: 0,
			totalCostUsd: o.caseResults.reduce((s, c) => s + c.costUsd, 0),
			totalDurationMs: 0,
		},
	};
}

describe('buildTrendData', () => {
	it('returns empty series + points when no manifests', () => {
		const r = buildTrendData({ manifests: [], tier: 'fast', window: 'all' });
		expect(r.lineSeries).toEqual([]);
		expect(r.scatterPoints).toEqual([]);
	});

	it('builds one series per model, sorted by completedAt ascending', () => {
		const a1 = manifest({
			runId: 'r1',
			completedAt: '2026-05-11T00:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const a2 = manifest({
			runId: 'r2',
			completedAt: '2026-05-13T00:00:00.000Z',
			fast: 'A',
			caseResults: [cr({ caseId: 'c1', verdict: 'fail' })],
		});
		const b1 = manifest({
			runId: 'r3',
			completedAt: '2026-05-12T00:00:00.000Z',
			fast: 'B',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const r = buildTrendData({
			manifests: [a1, a2, b1],
			tier: 'fast',
			window: 'all',
		});
		expect(r.lineSeries.map((s) => s.modelId).sort()).toEqual(['A', 'B']);
		const seriesA = r.lineSeries.find((s) => s.modelId === 'A')!;
		expect(seriesA.points.map((p) => p.xIso)).toEqual([
			'2026-05-11T00:00:00.000Z',
			'2026-05-13T00:00:00.000Z',
		]);
		expect(seriesA.points[0]!.y).toBe(1); // pass / total = 1/1
		expect(seriesA.points[1]!.y).toBe(0); // 0/1
	});

	it('drops runs outside the time window (7d/30d/all)', () => {
		const now = new Date('2026-05-13T12:00:00.000Z');
		const old = manifest({
			runId: 'r1',
			completedAt: '2026-04-01T00:00:00.000Z',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const recent = manifest({
			runId: 'r2',
			completedAt: '2026-05-12T00:00:00.000Z',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const r7 = buildTrendData({
			manifests: [old, recent],
			tier: 'fast',
			window: '7d',
			now,
		});
		expect(r7.lineSeries[0]?.points).toHaveLength(1);
		const rAll = buildTrendData({
			manifests: [old, recent],
			tier: 'fast',
			window: 'all',
			now,
		});
		expect(rAll.lineSeries[0]?.points).toHaveLength(2);
	});

	it('honors bucket filter', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-12T00:00:00.000Z',
			caseResults: [
				cr({ caseId: 'c1', bucket: 'routing' }),
				cr({ caseId: 'c2', bucket: 'recall', verdict: 'fail' }),
			],
		});
		const routing = buildTrendData({
			manifests: [m],
			tier: 'fast',
			bucket: 'routing',
			window: 'all',
		});
		expect(routing.scatterPoints[0]?.y).toBe(1); // both routing pass → 100%
		const all = buildTrendData({ manifests: [m], tier: 'fast', window: 'all' });
		expect(all.scatterPoints[0]?.y).toBe(0.5); // 1/2 overall
	});

	it('produces one scatter point per (model, run) and one accessible table row each', () => {
		const m1 = manifest({
			runId: 'r1',
			completedAt: '2026-05-11T00:00:00.000Z',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const m2 = manifest({
			runId: 'r2',
			completedAt: '2026-05-12T00:00:00.000Z',
			caseResults: [cr({ caseId: 'c1' })],
		});
		const r = buildTrendData({ manifests: [m1, m2], tier: 'fast', window: 'all' });
		expect(r.scatterPoints).toHaveLength(2);
		expect(r.tableRows).toHaveLength(2);
		expect(r.tableRows[0]!.completedAt >= r.tableRows[1]!.completedAt).toBe(true); // desc
	});

	it('drops manifests with no per-tier results for the requested tier', () => {
		const m = manifest({
			runId: 'r1',
			completedAt: '2026-05-12T00:00:00.000Z',
			caseResults: [cr({ caseId: 'c1', evaluatedTier: 'standard' })],
		});
		const r = buildTrendData({ manifests: [m], tier: 'fast', window: 'all' });
		expect(r.lineSeries).toEqual([]);
	});
});
