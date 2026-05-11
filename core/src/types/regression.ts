/**
 * Persona Regression Suite — shared types (lives in core to avoid a
 * `core → regression` import cycle from the GUI). The regression workspace
 * re-exports these via `regression/src/shared/types.ts`.
 *
 * REQ-REG-002, REQ-REG-008, REQ-REG-011, REQ-REG-013, REQ-REG-014.
 */

export type OracleKind = 'structural' | 'rubric' | 'judge';

export type Verdict = 'pass' | 'fail' | 'error' | 'budget-exceeded';

/**
 * Verdict literal constants. Use these in place of bare strings so a typo
 * fails at the type level instead of silently mis-categorising a result.
 */
export const VERDICT = {
	pass: 'pass',
	fail: 'fail',
	error: 'error',
	budgetExceeded: 'budget-exceeded',
} as const satisfies Record<string, Verdict>;

export type RoutingTarget = 'food-shadow' | 'session-control' | 'pas';

export interface PersonaInput {
	payload: unknown;
	expected: unknown;
	label?: string;
}

export interface PersonaCase {
	id: string;
	description: string;
	bucket: 'receipt' | 'chatbot' | 'recall' | 'routing';
	/** Required when `bucket === 'routing'`; forbidden otherwise. */
	routingTarget?: RoutingTarget;
	coverage: string[]; // repo-relative POSIX paths only
	inputs: PersonaInput[];
	oracle: OracleKind;
	rubric?: string;
	budgetUsd: number;
}

export interface OracleVerdict {
	verdict: Exclude<Verdict, 'budget-exceeded'>;
	details: string;
}

/**
 * Tier model snapshot at run time.
 *
 * `reasoning` is nullable (not optional): the snapshot must always record the
 * slot, but `ModelSelector.getReasoningRef()` returns `ModelRef | undefined`,
 * which is normalized to `null` here for stable JSON round-tripping.
 */
export interface TierModelSnapshot {
	fast: string;
	standard: string;
	reasoning: string | null;
}

/**
 * Per-call metering captured by an adapter around a production LLM-using
 * classifier. `costUsd` is authoritative (computed from `CostTracker` delta).
 * Token counts are best-effort; 0 when the provider does not report usage.
 */
export interface CallMeter {
	model: string;
	tokenIn: number;
	tokenOut: number;
	costUsd: number;
}

export interface RunResult {
	caseId: string;
	cacheKey: string;
	source: 'cached' | 'fresh';
	verdict: Verdict;
	inputs: PersonaInput[];
	actuals: unknown[];
	oracleVerdicts: OracleVerdict[];
	tokenCounts: { input: number; output: number };
	costUsd: number;
	modelIds: TierModelSnapshot;
	timestamp: string; // ISO-8601
	durationMs: number;
}

export interface CacheEntry {
	result: RunResult;
}

/**
 * Aggregate summary surfaced by the runner CLI and the GUI. REQ-REG-011's
 * `routingAccuracy` is computed at the input level over food-shadow cases —
 * `fail` and `error` both count against the gate.
 */
export interface RunSummary {
	totalCases: number;
	pass: number;
	fail: number;
	error: number;
	budgetExceeded: number;
	/** pass / (pass + fail + error) over food-shadow INPUTS. null when floor not met. */
	routingAccuracy: number | null;
	routingInputsEvaluated: number;
	totalCostUsd: number;
	totalDurationMs: number;
}

export interface LoadedCase {
	case: PersonaCase;
	/** Absolute path to the file that defines the case (used by `computeCacheKey`). */
	filePath: string;
}

// ─────────────────────────────────────────────────────────────────
// Shared runtime helpers — single source of truth for the
// `regression/` workspace (write path: `CacheStore`) AND the GUI
// (read path: `cache-reader`). Were duplicated byte-for-byte
// before the B.2 simplify pass.
// ─────────────────────────────────────────────────────────────────

export const VALID_BUCKETS: readonly PersonaCase['bucket'][] = [
	'routing',
	'receipt',
	'chatbot',
	'recall',
] as const;

export function isValidBucket(s: string): s is PersonaCase['bucket'] {
	return (VALID_BUCKETS as readonly string[]).includes(s);
}

/**
 * Case-id format on disk (cache directory names + arg validation).
 * Permissive (allows leading digit, allows underscore, case-insensitive)
 * — the strict `PersonaCase.id` format is enforced by `validatePersonaCase`
 * in the regression workspace; this defends downstream consumers against
 * tampered cache files or hostile path components.
 */
export const SAFE_CASE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

/** SHA-256 hex (cache key on disk). */
export const SAFE_CACHE_KEY_RE = /^[a-f0-9]{64}$/i;

const VERDICT_VALUES: readonly Verdict[] = ['pass', 'fail', 'error', 'budget-exceeded'];

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strict `RunResult` shape check. Used by:
 *   - `regression/src/runner/cache.ts` (write path) with `expectedCacheKey`
 *     to verify the file content matches its filename.
 *   - `core/src/gui/services/regression/cache-reader.ts` (read path)
 *     without `expectedCacheKey` — the GUI scans a directory and trusts
 *     the filename → the shape check still enforces a valid 64-hex key.
 *
 * Invalid files are rejected; callers skip + warn (REQ-REG-002 / 010).
 */
export function looksLikeRunResult(
	v: unknown,
	expectedCaseId: string,
	expectedCacheKey?: string,
): v is RunResult {
	if (!isPlainObject(v)) return false;
	if (v.caseId !== expectedCaseId) return false;
	if (typeof v.cacheKey !== 'string' || !SAFE_CACHE_KEY_RE.test(v.cacheKey)) return false;
	if (expectedCacheKey !== undefined && v.cacheKey !== expectedCacheKey) return false;
	if (typeof v.verdict !== 'string') return false;
	if (!VERDICT_VALUES.includes(v.verdict as Verdict)) return false;
	if (typeof v.timestamp !== 'string' || Number.isNaN(Date.parse(v.timestamp))) return false;
	if (!isPlainObject(v.modelIds)) return false;
	const m = v.modelIds as Record<string, unknown>;
	if (typeof m.fast !== 'string' || typeof m.standard !== 'string') return false;
	if (m.reasoning !== null && typeof m.reasoning !== 'string') return false;
	if (typeof v.costUsd !== 'number' || !Number.isFinite(v.costUsd) || v.costUsd < 0) return false;
	if (!Array.isArray(v.actuals)) return false;
	if (!Array.isArray(v.oracleVerdicts)) return false;
	if (!Array.isArray(v.inputs)) return false;
	if (!isPlainObject(v.tokenCounts)) return false;
	const t = v.tokenCounts as Record<string, unknown>;
	if (typeof t.input !== 'number' || !Number.isFinite(t.input) || t.input < 0) return false;
	if (typeof t.output !== 'number' || !Number.isFinite(t.output) || t.output < 0) return false;
	if (v.source !== 'cached' && v.source !== 'fresh') return false;
	if (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs < 0) {
		return false;
	}
	return true;
}
