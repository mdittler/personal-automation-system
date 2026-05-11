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
	OracleVerdict,
	PersonaCase,
	PersonaInput,
	RoutingTarget,
	RunResult,
	RunSummary,
	TierModelSnapshot,
	Verdict,
} from '@core/types/regression.js';
