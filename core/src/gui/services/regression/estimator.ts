/**
 * Approximate per-bucket cost constants for the `/gui/regression` page
 * banner. NOT the production cost calculator — that lives behind
 * `CostTracker.estimateCost` which requires loaded model pricing. The
 * binding limit for safety is `regression.maxRunBudgetUsd` (the
 * `ceilingUsd` field threaded through here).
 *
 * Constants are calibrated against the food-shadow / session-control /
 * PAS classifier observed costs (~$0.001–0.005 per case for fast-tier
 * routing). Recalibrate when LLMService usage plumbing lands — see
 * `docs/open-items.md` "LLMService.complete usage plumbing".
 */

const PER_CASE_USD_BY_BUCKET = {
	routing: 0.005,
	receipt: 0.06,
	chatbot: 0.04,
	recall: 0.01,
} as const;

export type Bucket = keyof typeof PER_CASE_USD_BY_BUCKET;

export interface EstimatedCase {
	caseId: string;
	bucket: Bucket;
}

export interface EstimatorOptions {
	/** `regression.maxRunBudgetUsd` — pass-through for the banner. */
	ceilingUsd: number;
}

export interface EstimatorResult {
	estimateUsd: number;
	ceilingUsd: number;
	perBucketUsd: Record<Bucket, number>;
}

export function estimateRunCostUsd(
	cases: readonly EstimatedCase[],
	options: EstimatorOptions,
): EstimatorResult {
	if (!Number.isFinite(options.ceilingUsd) || options.ceilingUsd < 0) {
		throw new Error(
			`estimator: ceilingUsd must be a finite non-negative number (got ${options.ceilingUsd})`,
		);
	}
	const perBucketUsd: Record<Bucket, number> = {
		routing: 0,
		receipt: 0,
		chatbot: 0,
		recall: 0,
	};
	for (const c of cases) {
		const rate = PER_CASE_USD_BY_BUCKET[c.bucket];
		if (rate === undefined) continue;
		perBucketUsd[c.bucket] += rate;
	}
	const estimateUsd =
		perBucketUsd.routing + perBucketUsd.receipt + perBucketUsd.chatbot + perBucketUsd.recall;
	return { estimateUsd, ceilingUsd: options.ceilingUsd, perBucketUsd };
}

/** Exposed for the constants-snapshot doc test (M5). */
export { PER_CASE_USD_BY_BUCKET };
