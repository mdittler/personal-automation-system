/**
 * Build trend chart data from `RunManifest`s (REQ-REG-GUI-V2-013/014/015).
 *
 * Given a list of manifests, a tier, an optional bucket filter, and an
 * optional time window, returns:
 *   - `lineSeries`: per-model accuracy over time. One series per model.
 *   - `scatterPoints`: one point per (model, run); x=cost, y=accuracy.
 *
 * Pure function; no I/O. The route layer composes manifests from
 * `runHistoryStore`, calls this helper, and pipes the result into
 * `chart-svg.ts`.
 */

import type { ManifestCaseResult, RunManifest } from '../../../types/regression.js';
import type { LineSeries, ScatterPoint } from './chart-svg.js';
import type { LeaderboardTier } from './leaderboard-aggregator.js';

export type TimeWindow = '7d' | '30d' | 'all';

export interface BuildTrendDataOptions {
	manifests: readonly RunManifest[];
	tier: LeaderboardTier;
	/** Optional bucket filter; if omitted, all caseResults for the tier count. */
	bucket?: string;
	window: TimeWindow;
	now?: Date; // override for tests
}

export interface TrendData {
	lineSeries: LineSeries[];
	scatterPoints: ScatterPoint[];
	tableRows: Array<{
		modelId: string;
		runId: string;
		completedAt: string;
		total: number;
		pass: number;
		passRate: number;
		costUsd: number;
	}>;
}

export function buildTrendData(opts: BuildTrendDataOptions): TrendData {
	const since = computeSince(opts.window, opts.now ?? new Date());
	const grouped = new Map<string, Array<{ manifest: RunManifest; metrics: TierMetrics }>>();
	for (const m of opts.manifests) {
		if (since !== null && m.completedAt < since) continue;
		const modelId = modelIdForTier(m, opts.tier);
		if (!modelId) continue;
		const metrics = computeTierMetrics(m.caseResults, opts.tier, opts.bucket);
		if (metrics.total === 0) continue;
		const list = grouped.get(modelId) ?? [];
		list.push({ manifest: m, metrics });
		grouped.set(modelId, list);
	}

	const lineSeries: LineSeries[] = [];
	const scatterPoints: ScatterPoint[] = [];
	const tableRows: TrendData['tableRows'] = [];

	for (const [modelId, runs] of grouped) {
		runs.sort((a, b) => a.manifest.completedAt.localeCompare(b.manifest.completedAt));
		lineSeries.push({
			label: modelId,
			tier: opts.tier,
			modelId,
			points: runs.map((r) => ({
				xIso: r.manifest.completedAt,
				y: r.metrics.passRate,
			})),
		});
		for (const r of runs) {
			scatterPoints.push({
				label: modelId,
				tier: opts.tier,
				modelId,
				x: r.metrics.totalCostUsd,
				y: r.metrics.passRate,
				runId: r.manifest.runId,
			});
			tableRows.push({
				modelId,
				runId: r.manifest.runId,
				completedAt: r.manifest.completedAt,
				total: r.metrics.total,
				pass: r.metrics.pass,
				passRate: r.metrics.passRate,
				costUsd: r.metrics.totalCostUsd,
			});
		}
	}
	tableRows.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
	return { lineSeries, scatterPoints, tableRows };
}

interface TierMetrics {
	pass: number;
	total: number;
	passRate: number;
	totalCostUsd: number;
}

function computeTierMetrics(
	results: readonly ManifestCaseResult[],
	tier: LeaderboardTier,
	bucket: string | undefined,
): TierMetrics {
	let pass = 0;
	let total = 0;
	let totalCostUsd = 0;
	for (const r of results) {
		if (r.evaluatedTier !== tier) continue;
		if (bucket && r.bucket !== bucket) continue;
		total++;
		totalCostUsd += r.costUsd;
		if (r.verdict === 'pass') pass++;
	}
	return { pass, total, passRate: total === 0 ? 0 : pass / total, totalCostUsd };
}

function modelIdForTier(m: RunManifest, tier: LeaderboardTier): string | null {
	if (tier === 'fast') return m.modelIds.fast;
	if (tier === 'standard') return m.modelIds.standard;
	return m.modelIds.reasoning;
}

function computeSince(window: TimeWindow, now: Date): string | null {
	if (window === 'all') return null;
	const days = window === '7d' ? 7 : 30;
	const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
	return since.toISOString();
}
