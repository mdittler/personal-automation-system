/**
 * Approximate per-bucket cost constants for the `/gui/regression` page
 * banner. NOT the production cost calculator — that lives behind
 * `CostTracker.estimateCost` which requires loaded model pricing. The
 * binding limit for safety is `regression.maxRunBudgetUsd` (the
 * `ceilingUsd` field threaded through here).
 *
 * Constants are calibrated against the food-shadow / session-control /
 * PAS classifier observed costs (~$0.001–0.005 per case for fast-tier
 * routing). As of 2026-05-22, `RunResult.tokenCounts` carries real
 * observed token data (REQ-REG-018), so the constants can be recalibrated
 * from a fresh full-suite run. Numeric recalibration is deliberately
 * deferred and tracked in `docs/open-items.md` ("Numeric recalibration of
 * regression estimator constants"); the constants remain documented
 * approximations. The binding safety limit is still the per-run budget cap.
 *
 * The constants are REMOTE prices. Local models (Ollama, llama.cpp) run on
 * the operator's own hardware and are never billed per token, so a bucket
 * whose tier slot is served by a local provider estimates exactly $0 — see
 * `EstimatorOptions.localTiers`. Callers that cannot determine provider
 * locality omit `localTiers` and get the conservative remote constants.
 */

import type { ModelTier } from '../../../types/llm.js';

const PER_CASE_USD_BY_BUCKET = {
	routing: 0.005,
	receipt: 0.06,
	chatbot: 0.04,
	recall: 0.01,
} as const;

export type Bucket = keyof typeof PER_CASE_USD_BY_BUCKET;

/**
 * Which tier slot each bucket's dispatch actually runs on. Mirrors the
 * case-runners' `evaluatedTier`: routing + recall classify on the `fast`
 * tier; receipt extraction and the chatbot rubric judge both run on
 * `standard`. Keep in lockstep with `regression/src/runner/index.ts`'s
 * `BUCKET_ESTIMATE`.
 */
export const BUCKET_TIER: Readonly<Record<Bucket, ModelTier>> = {
	routing: 'fast',
	recall: 'fast',
	receipt: 'standard',
	chatbot: 'standard',
};

export interface EstimatedCase {
	caseId: string;
	bucket: Bucket;
}

export interface EstimatorOptions {
	/** `regression.maxRunBudgetUsd` — pass-through for the banner. */
	ceilingUsd: number;
	/**
	 * Tier slots served by a local provider (Ollama / llama.cpp). Any bucket
	 * mapped by `BUCKET_TIER` to a tier marked `true` here estimates $0.
	 * Missing entries mean "not known to be local" and keep the conservative
	 * remote constant.
	 */
	localTiers?: Partial<Record<ModelTier, boolean>>;
}

export interface EstimatorResult {
	estimateUsd: number;
	ceilingUsd: number;
	perBucketUsd: Record<Bucket, number>;
	/**
	 * True when at least one case was selected AND every selected case's tier
	 * is served by a local provider — i.e. the run costs exactly nothing. The
	 * GUI banner says so explicitly rather than showing a bare "$0.00".
	 */
	allLocal: boolean;
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
	let counted = 0;
	let localCount = 0;
	for (const c of cases) {
		const rate = PER_CASE_USD_BY_BUCKET[c.bucket];
		if (rate === undefined) continue;
		counted++;
		const local = options.localTiers?.[BUCKET_TIER[c.bucket]] === true;
		if (local) {
			localCount++;
			continue; // local inference is free by construction — charge nothing
		}
		perBucketUsd[c.bucket] += rate;
	}
	const estimateUsd =
		perBucketUsd.routing + perBucketUsd.receipt + perBucketUsd.chatbot + perBucketUsd.recall;
	return {
		estimateUsd,
		ceilingUsd: options.ceilingUsd,
		perBucketUsd,
		allLocal: counted > 0 && localCount === counted,
	};
}

/** Exposed for the constants-snapshot doc test (M5). */
export { PER_CASE_USD_BY_BUCKET };
