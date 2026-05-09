/**
 * Persona Regression Suite — shared types.
 * REQ-REG-002, REQ-REG-008, REQ-REG-013, REQ-REG-014.
 */

export type OracleKind = 'structural' | 'rubric' | 'judge';

export type Verdict = 'pass' | 'fail' | 'error' | 'budget-exceeded';

export interface PersonaInput {
	payload: unknown;
	expected: unknown;
	label?: string;
}

export interface PersonaCase {
	id: string;
	description: string;
	bucket: 'receipt' | 'chatbot' | 'recall' | 'routing';
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
 * Tier model snapshot at run time. `reasoning` is optional because
 * `ModelSelector.getReasoningRef()` returns `ModelRef | undefined`.
 */
export interface TierModelSnapshot {
	fast: string;
	standard: string;
	reasoning: string | null;
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
