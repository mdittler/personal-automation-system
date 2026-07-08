/**
 * SR-4 — regression-harness seam: interface PROPOSAL (declarations only).
 *
 * STATUS: This file is a design artifact accompanying
 * `2026-07-08-sr-4-regression-harness-seam.md`. It is NOT compiled into core
 * or the regression workspace (nothing imports this file). It typechecks
 * standalone with no dependencies under the EXACT command:
 *   npx tsc --strict --noEmit --lib es2020 \
 *     docs/superpowers/specs/regression-harness.interface.ts
 * The `--lib es2020` is load-bearing: `ReadonlyMap` (SuiteGate.evaluate) is
 * unavailable under the default lib when no `--target` is set. Biome checks
 * this file on push (docs/ is not in the biome ignore list); keep it lint-
 * and format-clean.
 *
 * Layering (design doc §3): the harness core owns the suite orchestrator,
 * cache, budgets, loader, and the generic oracles; consumers register a
 * HarnessProfile (runners + cache-key contributors + gates + case sources).
 * PAS's four buckets, the AG-7 agent bucket, and per-app discovered cases
 * are all consumers of the SAME seam — no consumer imports harness
 * internals, and the harness imports nothing from `@core/*`.
 *
 * Implementation bodies, the PAS profile, and the package split belong to
 * the SR-4 implementing phase. Do not import this file from any workspace.
 */

// ---------------------------------------------------------------------------
// Frozen wire vocabulary (today's `@core/types/regression.ts` shapes; these
// move INTO the harness package and core re-exports them — design doc §9).
// ---------------------------------------------------------------------------

export type Verdict = 'pass' | 'fail' | 'error' | 'budget-exceeded';

/**
 * `label` widens from today's closed `'structural' | 'transcription'` union
 * to an open string so consumer runners (AG-7: 'final-state',
 * 'budget-compliance') can label their oracle verdicts without editing the
 * harness. `looksLikeRunResult` never validated label values, so cache
 * files are unaffected (design doc §4).
 */
export interface OracleVerdict {
	readonly verdict: Exclude<Verdict, 'budget-exceeded'>;
	readonly details: string;
	readonly label?: string;
}

export interface CaseInput {
	readonly payload: unknown;
	readonly expected: unknown;
	readonly label?: string;
}

/** Per-call metering (CostTracker delta on the PAS side; consumer-defined). */
export interface CallMeter {
	readonly model: string;
	readonly tokenIn: number;
	readonly tokenOut: number;
	readonly costUsd: number;
}

/**
 * The neutral case schema. `bucket` is an OPEN string validated against the
 * registered runners (unknown bucket = load-time error, fail-loud), replacing
 * today's closed `'receipt' | 'chatbot' | 'recall' | 'routing'` union.
 * Runner-specific fields (e.g. routing's `routingTarget`, agent's
 * `seedFixture`/`maxSteps`) live on runner-declared subtypes and are
 * narrowed by `CaseRunner.validateCase` (parse-don't-validate).
 */
export interface HarnessCase {
	readonly id: string;
	readonly description: string;
	readonly bucket: string;
	/** Repo-relative POSIX paths hashed into the cache key. */
	readonly coverage: readonly string[];
	readonly inputs: readonly CaseInput[];
	/** Oracle discipline hint; the owning runner validates and interprets it. */
	readonly oracle: string;
	readonly rubric?: string;
	readonly budgetUsd: number;
}

export interface LoadedCase {
	readonly case: HarnessCase;
	/** Absolute path of the defining file (hashed into the cache key). */
	readonly filePath: string;
	/** Which CaseSource discovered it (per-app cost attribution — §8). */
	readonly sourceId: string;
}

/**
 * The frozen on-disk result shape (cache files + NDJSON + manifest rows).
 * `modelIds` generalizes from PAS's `{fast, standard, reasoning}` to an
 * open slot record; PAS's profile declares exactly those three slots, so
 * existing cache JSON round-trips byte-identically (design doc §5).
 */
export interface RunResult {
	readonly caseId: string;
	readonly cacheKey: string;
	readonly source: 'cached' | 'fresh';
	readonly verdict: Verdict;
	readonly inputs: readonly CaseInput[];
	readonly actuals: readonly unknown[];
	readonly oracleVerdicts: readonly OracleVerdict[];
	readonly tokenCounts: { readonly input: number; readonly output: number };
	readonly costUsd: number;
	readonly modelIds: Readonly<Record<string, string | null>>;
	readonly evaluatedTier?: string;
	readonly timestamp: string;
	readonly durationMs: number;
}

/**
 * One gate's result as carried in the summary. Additive over today's shape
 * (design doc §4/§8) — extends the SuiteGate outcome (below) with the gate id.
 */
export interface SummaryGateOutcome extends GateOutcome {
	readonly id: string;
}

/**
 * Aggregate run summary — a WIRE type (the GUI consumes the `{type:'summary'}`
 * NDJSON line). PAS-flavored fields (`routingAccuracy` /
 * `routingInputsEvaluated`, REQ-REG-011) are KEPT and populated by the PAS
 * gate; `gateOutcomes` is the additive generalization so a non-PAS profile's
 * gates surface without the routing fields being meaningful. Removing the
 * routing fields is deferred until the GUI reader migrates (design doc §4,
 * open question Q2).
 */
export interface RunSummary {
	readonly totalCases: number;
	readonly pass: number;
	readonly fail: number;
	readonly error: number;
	readonly budgetExceeded: number;
	readonly routingAccuracy: number | null;
	readonly routingInputsEvaluated: number;
	readonly totalCostUsd: number;
	readonly totalDurationMs: number;
	/** One entry per registered SuiteGate. Additive; readers tolerate absent. */
	readonly gateOutcomes?: readonly SummaryGateOutcome[];
}

/**
 * Per-case manifest row (was `ManifestCaseResult`, core/types/regression.ts:143).
 * `bucket` opens to string (profile-provided valid set — design doc §7.1);
 * `sourceId` is the additive per-app attribution field (§8), optional so
 * pre-v2 manifests decode unchanged.
 */
export interface ManifestCaseResult {
	readonly caseId: string;
	readonly bucket: string;
	readonly cacheKey: string;
	readonly evaluatedTier: string;
	readonly verdict: Verdict;
	readonly source: 'cached' | 'fresh';
	readonly costUsd: number;
	readonly timestamp: string;
	/** Which CaseSource the case came from (per-app roll-ups — §8). Additive. */
	readonly sourceId?: string;
}

/**
 * Persisted run manifest (was `RunManifest`, core/types/regression.ts:160).
 * `modelIds` generalizes with RunResult (§5); `judgeOverrideApplied` keeps the
 * "`modelIds.standard` IS the judge" convention (§6). `bucketsRequested`
 * opens to string per the profile-provided valid set.
 */
export interface RunManifest {
	readonly runId: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly modelIds: Readonly<Record<string, string | null>>;
	readonly judgeOverrideApplied: boolean;
	readonly bucketsRequested: readonly string[];
	readonly caseResults: readonly ManifestCaseResult[];
	readonly summary: RunSummary;
}

// ---------------------------------------------------------------------------
// Model handles (design doc §6) — what crosses the seam INSTEAD of
// ModelSelector / LLMService / tier literals.
// ---------------------------------------------------------------------------

/**
 * The consumer's model lineup for one run, snapshotted at composition time.
 * `slots` fixes the cache-key serialization order — PAS declares
 * `['fast', 'standard', 'reasoning']`, reproducing today's
 * `fast=…,standard=…,reasoning=…` modelStr byte-for-byte.
 */
export interface ModelInventory {
	readonly slots: readonly string[];
	readonly models: Readonly<Record<string, string | null>>;
}

export interface ModelCompletionRequest {
	readonly prompt: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly responseFormat?: 'json' | 'text';
}

/**
 * A bound, override-resolved completion function. SEAM INVARIANTS:
 * (1) the handle already reflects any operator override (PAS: `--judge-model`
 *     via ModelSelector transient overrides — consumer-side, never crosses);
 * (2) composition fails loudly if the override cannot be honored (PAS:
 *     `ModelSelector.reconcile` throwIfFrozen);
 * (3) the harness asserts `id === inventory.models[slot]` at composition so
 *     the cache key can never silently disagree with the dispatched model.
 */
export interface ModelHandle {
	/** Concrete model identifier (feeds CallMeter.model and the manifest). */
	readonly id: string;
	/** The ModelInventory slot this handle draws from ('standard' for PAS's judge). */
	readonly slot: string;
	complete(req: ModelCompletionRequest): Promise<string>;
}

/** Cost/token meter source (PAS: CostTracker). Deltas are only coherent
 * under the harness's sequential-dispatch invariant (design doc §3). */
export interface MeterSource {
	getMonthlyTotalCost(): number;
	getTokenUsageTotals(): { input: number; output: number };
}

export interface HarnessLogger {
	warn(...args: unknown[]): void;
	info(...args: unknown[]): void;
	debug(...args: unknown[]): void;
	error(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// CaseRunner — the seam all three consumers implement (design doc §3).
// ---------------------------------------------------------------------------

export interface CaseRunContext {
	readonly cacheKey: string;
	/** Authoritative per-case budget (from HarnessCase.budgetUsd). */
	readonly caseBudgetUsd: number;
	readonly inventory: ModelInventory;
	estimateUsd(call: { tokenIn: number; tokenOut: number }): number;
	readonly meter: MeterSource;
	readonly logger: HarnessLogger;
}

/**
 * One runner per bucket, registered in the HarnessProfile. Replaces the
 * orchestrator's hardcoded four-way bucket dispatch AND the per-bucket
 * fields on RunSuiteOptions (classifiers / recallAdapter /
 * chatbotEnvFactory / judgeLlm / receiptLlm) — those dependencies are bound
 * into the runner instance at composition time, consumer-side.
 *
 * HARNESS-OWNED (runners rely on, must not duplicate): cache read/write,
 * run-budget pre-charge, dry-run synthesis, budget-exceeded synthesis,
 * setup-failure latching, sequential dispatch, manifest/summary/gates.
 * RUNNER-OWNED: per-input loop, per-case budget enforcement, adapter
 * dispatch, oracle invocation, verdict aggregation, metering.
 */
export interface CaseRunner<TCase extends HarnessCase = HarnessCase> {
	readonly bucket: string;
	/**
	 * Parse-don't-validate: narrow a loaded case to this runner's subtype,
	 * throwing on malformed extension fields (load-time, before any dispatch).
	 */
	validateCase(c: HarnessCase): TCase;
	/**
	 * Projected USD for the run-budget pre-charge gate. Each bucket owns its
	 * own token shape (routing: 400/80 per input; agent: the full session
	 * budget). Replaces the orchestrator's one-size ESTIMATE_TOKENS.
	 */
	estimateCase(c: TCase, estimateUsd: CaseRunContext['estimateUsd']): number;
	/**
	 * Optional run-scoped environment, built lazily before this runner's
	 * first dispatched case. If it throws, the harness latches the failure:
	 * every remaining case for this bucket synthesizes `verdict: 'error'`
	 * with one error oracle-verdict per input, and setup is NOT retried
	 * within the run (generalizes today's chatbot env-factory latch).
	 */
	setup?(): Promise<void>;
	run(c: TCase, ctx: CaseRunContext): Promise<RunResult>;
	/** Called once in the harness's `finally` iff setup() completed. */
	dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// CacheKeyContributor — composable key salts (design doc §5).
// ---------------------------------------------------------------------------

export interface CacheKeyEnv {
	readonly repoRoot: string;
	readonly timezone: string;
	readonly inventory: ModelInventory;
}

/**
 * Consumers add cache-salt material without forking the key recipe. The
 * base recipe (case-file hash, sorted coverage hashes, inventory string,
 * `\0` separators) is FROZEN. Composition law:
 *   0 contributions → no salt block (today's routing/recall/chatbot keys);
 *   1 contribution  → legacy `salt:<value>` block, value byte-identical to
 *                      today's receipt salt (`today:<YYYY-MM-DD>:tz:<tz>`);
 *   ≥2 contributions → `salt:` + values sorted by contributor id, joined
 *                      with `\n`.
 * Validation applies to EVERY produced value regardless of how many
 * contributors are registered: the value MUST begin with `${namespace}:`
 * and MUST NOT contain `\n` (the multi-contributor join separator) — a
 * newline is rejected even in the single-contribution case, so a later
 * second contributor can never retroactively reinterpret a smuggled
 * newline. Namespaces are unique at registration. `contribute` is
 * SYNCHRONOUS and must be deterministic within a run — both `runSuite` and
 * list mode call it, and key parity between them is a hard invariant.
 */
export interface CacheKeyContributor {
	readonly id: string;
	readonly namespace: string;
	contribute(c: HarnessCase, env: CacheKeyEnv): string | undefined;
}

// ---------------------------------------------------------------------------
// Suite gates + case sources (design doc §8) — consumer 2's half of the seam.
// ---------------------------------------------------------------------------

export interface GateOutcome {
	readonly pass: boolean;
	readonly message?: string;
	/** Surfaced in the summary (e.g. routingAccuracy). null = floor not met. */
	readonly metrics?: Readonly<Record<string, number | null>>;
}

/**
 * Exit-code gates over the completed run. REQ-REG-011 (routing accuracy
 * ≥ 0.95 over food-shadow inputs) becomes the PAS profile's first gate;
 * the harness core ships none.
 */
export interface SuiteGate {
	readonly id: string;
	evaluate(results: readonly RunResult[], cases: ReadonlyMap<string, HarnessCase>): GateOutcome;
}

/** One discovery root. PAS: the in-repo cases dir; v2 adds one per app. */
export interface CaseSource {
	readonly id: string;
	readonly casesDir: string;
}

// ---------------------------------------------------------------------------
// HarnessProfile — the single registration object a consumer hands the
// harness (design doc §3, §9). Everything PAS-specific lives behind it.
// ---------------------------------------------------------------------------

export interface HarnessProfile {
	readonly inventory: ModelInventory;
	/**
	 * The consumer's bound model handles. HARNESS COMPOSITION ASSERTION
	 * (design doc §6): for every handle, `handle.id === inventory.models[handle.slot]`
	 * — the harness refuses to run on mismatch. This makes the
	 * `applyJudgeModelOverride` desync class (build-deps.ts:474 rewrites only
	 * `modelIds` while the live dispatch path resolves through a live service)
	 * a typed, load-time failure instead of a documented hazard. PAS binds one
	 * handle `{ id: modelIds.standard, slot: 'standard', complete: judge }`;
	 * the same handle instances the consumer wires into its runners are the
	 * ones registered here, so what the harness asserts is what dispatches.
	 * A profile with no LLM-judged buckets registers an empty array.
	 */
	readonly modelHandles: readonly ModelHandle[];
	/**
	 * The registered runners. Their `bucket` values form the PROFILE-PROVIDED
	 * VALID BUCKET SET — the single source of truth that the design doc §7.1
	 * requires be threaded through every consumer that currently rejects
	 * unknown buckets (CLI `--bucket`, GUI spawn allowlist, case discovery,
	 * manifest validation, POST validation, UI labels). Opening
	 * `HarnessCase.bucket` to string is necessary but not sufficient; this set
	 * is what those sites must validate against instead of a hardcoded union.
	 */
	readonly runners: readonly CaseRunner[];
	readonly contributors: readonly CacheKeyContributor[];
	readonly gates: readonly SuiteGate[];
	readonly sources: readonly CaseSource[];
	readonly meter: MeterSource;
	readonly logger: HarnessLogger;
	estimateUsd(call: { tokenIn: number; tokenOut: number }): number;
	readonly maxRunBudgetUsd: number;
	readonly repoRoot: string;
	readonly cacheDir: string;
	readonly timezone: string;
}
