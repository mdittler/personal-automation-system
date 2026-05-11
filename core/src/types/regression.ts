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
