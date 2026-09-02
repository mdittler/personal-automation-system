/**
 * Per-(tier, model) leaderboard aggregation (REQ-REG-GUI-V2-008).
 *
 * Input: a list of `RunManifest`s + a `tier` filter. Output: one row per
 * model that participated in `tier` across the supplied runs, with the row
 * showing metrics from EXACTLY ONE run (latest by default, or pinned via
 * `pinOverrides`).
 *
 * "Participated" = the manifest's modelIds[tier] equals the row's model AND
 * the manifest contains at least one caseResult with `evaluatedTier === tier`.
 *
 * Mixed-tier and unknown-tier caseResults are excluded from per-tier metrics.
 */

import {
	type ManifestCaseResult,
	type RunManifest,
	type TierModelSnapshot,
	VERDICT,
} from '../../../types/regression.js';

export type LeaderboardTier = 'fast' | 'standard' | 'reasoning';

export interface LeaderboardBucketCounts {
	bucket: string;
	pass: number;
	fail: number;
	error: number;
	cached: number;
	total: number;
}

export interface LeaderboardRow {
	tier: LeaderboardTier;
	modelId: string;
	runId: string;
	completedAt: string;
	pass: number;
	fail: number;
	error: number;
	budgetExceeded: number;
	cached: number;
	total: number;
	passRate: number; // pass / total, 0..1
	totalCostUsd: number;
	buckets: LeaderboardBucketCounts[];
	/**
	 * Signals a separate `--judge-model` was used to grade rubric cases at run
	 * time. Only meaningful on the `standard` tier.
	 */
	judgeOverrideApplied: boolean;
	/** Separate rubric judge, when a run recorded one. */
	judgeModelId?: string;
	/**
	 * Per-input REQ-REG-011 routing accuracy from the run summary. Routing
	 * cases evaluate on the fast tier, so this is populated only on `fast`
	 * rows — copying the run-wide figure onto a standard/reasoning row would
	 * misattribute the fast tier's result. `null` on non-fast rows and when
	 * the run was below the food-shadow input floor.
	 */
	routingAccuracy: number | null;
	/** Food-shadow inputs evaluated for `routingAccuracy`; 0 on non-fast rows. */
	routingInputsEvaluated: number;
}

export interface PinOverrideKey {
	tier: LeaderboardTier;
	modelId: string;
	runId: string;
}

export interface AggregateOptions {
	manifests: readonly RunManifest[];
	tier: LeaderboardTier;
	/**
	 * Pins a specific (tier, modelId) row to a specific historical runId.
	 * Used by REQ-REG-GUI-V2-010 `?pin=<tier>:<modelId>:<runId>`.
	 */
	pinOverrides?: readonly PinOverrideKey[];
}

/**
 * Compute one row per model that participated in `tier`. Default selection
 * is the manifest with the latest `completedAt`; pin overrides win.
 */
export function aggregateLeaderboard(opts: AggregateOptions): LeaderboardRow[] {
	const { manifests, tier, pinOverrides = [] } = opts;
	const pinByModel = new Map<string, string>(); // modelId → runId
	for (const p of pinOverrides) {
		if (p.tier === tier) pinByModel.set(p.modelId, p.runId);
	}

	// Group manifests by (tier-slot model id). `participates(m, tier)` checks
	// that at least one caseResult in `m` ran under `tier`.
	const grouped = new Map<string, RunManifest[]>();
	for (const m of manifests) {
		const modelForTier = modelIdForTier(m.modelIds, tier);
		if (!modelForTier) continue;
		if (!participates(m, tier)) continue;
		const list = grouped.get(modelForTier) ?? [];
		list.push(m);
		grouped.set(modelForTier, list);
	}

	const rows: LeaderboardRow[] = [];
	for (const [modelId, runs] of grouped) {
		const pinnedRunId = pinByModel.get(modelId);
		// `runs` is unordered; pick the pinned manifest if specified, else the
		// latest by completedAt.
		let chosen: RunManifest | undefined;
		if (pinnedRunId) chosen = runs.find((r) => r.runId === pinnedRunId);
		if (!chosen) {
			chosen = runs.reduce((a, b) => (a.completedAt >= b.completedAt ? a : b));
		}
		rows.push(buildRow(chosen, tier, modelId));
	}
	// Sort rows by passRate desc, then totalCostUsd asc (cheaper wins ties).
	rows.sort((a, b) => {
		if (b.passRate !== a.passRate) return b.passRate - a.passRate;
		return a.totalCostUsd - b.totalCostUsd;
	});
	return rows;
}

function buildRow(m: RunManifest, tier: LeaderboardTier, modelId: string): LeaderboardRow {
	const tierResults = m.caseResults.filter((cr) => cr.evaluatedTier === tier);
	const counts = countVerdicts(tierResults);
	const buckets = groupByBucket(tierResults);
	const total = counts.pass + counts.fail + counts.error + counts.budgetExceeded;
	const passRate = total === 0 ? 0 : counts.pass / total;
	const cached = tierResults.filter((cr) => cr.source === 'cached').length;
	const totalCostUsd = tierResults.reduce((sum, cr) => sum + cr.costUsd, 0);
	const isFast = tier === 'fast';
	return {
		tier,
		modelId,
		runId: m.runId,
		completedAt: m.completedAt,
		pass: counts.pass,
		fail: counts.fail,
		error: counts.error,
		budgetExceeded: counts.budgetExceeded,
		cached,
		total,
		passRate,
		totalCostUsd,
		buckets,
		judgeOverrideApplied: tier === 'standard' ? m.judgeOverrideApplied : false,
		...(tier === 'standard' && m.judgeModelId ? { judgeModelId: m.judgeModelId } : {}),
		routingAccuracy: isFast ? m.summary.routingAccuracy : null,
		routingInputsEvaluated: isFast ? m.summary.routingInputsEvaluated : 0,
	};
}

function countVerdicts(results: readonly ManifestCaseResult[]): {
	pass: number;
	fail: number;
	error: number;
	budgetExceeded: number;
} {
	let pass = 0;
	let fail = 0;
	let error = 0;
	let budgetExceeded = 0;
	for (const r of results) {
		if (r.verdict === VERDICT.pass) pass++;
		else if (r.verdict === VERDICT.fail) fail++;
		else if (r.verdict === VERDICT.error) error++;
		else if (r.verdict === VERDICT.budgetExceeded) budgetExceeded++;
	}
	return { pass, fail, error, budgetExceeded };
}

function groupByBucket(results: readonly ManifestCaseResult[]): LeaderboardBucketCounts[] {
	const map = new Map<string, LeaderboardBucketCounts>();
	for (const r of results) {
		let row = map.get(r.bucket);
		if (!row) {
			row = { bucket: r.bucket, pass: 0, fail: 0, error: 0, cached: 0, total: 0 };
			map.set(r.bucket, row);
		}
		row.total++;
		if (r.verdict === VERDICT.pass) row.pass++;
		else if (r.verdict === VERDICT.fail) row.fail++;
		else if (r.verdict === VERDICT.error) row.error++;
		if (r.source === 'cached') row.cached++;
	}
	return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function modelIdForTier(modelIds: TierModelSnapshot, tier: LeaderboardTier): string | null {
	if (tier === 'fast') return modelIds.fast;
	if (tier === 'standard') return modelIds.standard;
	return modelIds.reasoning;
}

function participates(m: RunManifest, tier: LeaderboardTier): boolean {
	for (const cr of m.caseResults) {
		if (cr.evaluatedTier === tier) return true;
	}
	return false;
}
