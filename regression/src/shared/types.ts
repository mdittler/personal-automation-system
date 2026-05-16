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
} from '@core/types/regression.js';
