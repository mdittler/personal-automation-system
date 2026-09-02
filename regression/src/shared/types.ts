/**
 * Persona Regression Suite — shared types (re-export).
 *
 * Canonical definitions live in `@core/types/regression` to avoid a
 * `core → regression` import cycle from the GUI in Chunk B.2.
 *
 * REQ-REG-002, REQ-REG-008, REQ-REG-011, REQ-REG-013, REQ-REG-014.
 */

export type {
	CacheEntry,
	CallMeter,
	LoadedCase,
	OracleKind,
	OracleLabel,
	OracleVerdict,
	PersonaCase,
	PersonaInput,
	RoutingTarget,
	RunResult,
	RunSummary,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';

import type { ModelTier } from '@core/types/llm.js';

export type { ModelTier };

/**
 * Argument to the pre-flight cost estimator threaded through `RunSuiteOptions`
 * and every case-runner.
 *
 * `tier` names the tier slot the call will actually run on, which is what
 * makes the estimate honest: the estimator prices the tier's CURRENT model
 * AND its provider type. Without a tier it defaults to `fast`, and without a
 * provider a local model (which has no `MODEL_PRICING` entry) would silently
 * fall through to `DEFAULT_REMOTE_PRICING` — quoting frontier rates for
 * inference that runs free on the operator's own hardware.
 */
export interface EstimateCall {
	tokenIn: number;
	tokenOut: number;
	tier?: ModelTier;
}

export type EstimateUsdFn = (call: EstimateCall) => number;

// Runtime helpers (shared with the GUI; see core/src/types/regression.ts).
export {
	isPlainObject,
	isValidBucket,
	looksLikeRunResult,
	ORACLE_LABEL,
	SAFE_CACHE_KEY_RE,
	SAFE_CASE_ID_RE,
	VALID_BUCKETS,
	VERDICT,
	VERDICT_VALUES,
} from '@core/types/regression.js';
