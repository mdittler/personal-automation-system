/**
 * Persona Regression Suite orchestrator (REQ-REG-002, REQ-REG-008,
 * REQ-REG-009, REQ-REG-011).
 *
 * `runSuite()` loads PersonaCases, dispatches them sequentially, and
 * returns aggregated `{summary, results, targets}`. Designed to be called
 * both from the CLI and the GUI (Chunk B.2 via subprocess).
 *
 * Key behaviours:
 *  - Cache hit short-circuits dispatch (REQ-REG-002 / REQ-REG-010).
 *  - `bucketFilter` / `rerunIds` / `dryRun` shape the run.
 *  - Hard-abort RunBudget: once `runBudget.canAfford(next)` is false, every
 *    remaining selected case is emitted as `verdict: 'budget-exceeded'`
 *    without an LLM call; synthesized 'error' oracle verdicts per input
 *    let the REQ-REG-011 gate count the skipped inputs against accuracy.
 *  - `onResult(r)` fires once per case in dispatch order — used by the
 *    GUI subprocess (B.2) for SSE progress.
 *
 * Dispatch is sequential by design: two parallel cases would race the
 * `CostTracker` delta used by classifier adapters.
 */

import { relative } from 'node:path';
import { requestContext } from '@core/services/context/request-context.js';
import type { LLMService } from '@core/types/llm.js';
import {
	type PersonaCase,
	type RoutingTarget,
	type RunResult,
	type RunSummary,
	type TierModelSnapshot,
	VERDICT,
} from '@core/types/regression.js';
import { computeCacheKey } from '../shared/cache-key.js';
import { type CliOptions, HELP_TEXT, parseCliArgs } from './args.js';
import { RunBudget } from './budget.js';
import { CacheStore } from './cache.js';
import { loadCases } from './case-loader.js';
import { runChatbotCase } from './case-runners/chatbot-runner.js';
import { runRecallCase } from './case-runners/recall-runner.js';
import {
	ESTIMATE_TOKENS,
	type MinimalLogger,
	type RoutingClassifierAdapter,
	runRoutingCase,
} from './case-runners/routing-runner.js';
import type { RecallAdapter } from './dispatch.js';
import { buildManifest, writeManifest } from './manifest-writer.js';
import {
	ACCURACY_GATE_THRESHOLD,
	buildSummary,
	formatDryRunMarkdown,
	formatSummaryMarkdown,
} from './markdown-report.js';
import type { ManifestDefaults } from './runner-options.js';

export interface RunSuiteOptions {
	casesDir: string;
	cacheDir: string;
	repoRoot: string;
	modelIds: TierModelSnapshot;
	maxRunBudgetUsd: number;
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number;
	classifiers: RoutingClassifierAdapter;
	/** Recall adapter (Chunk C). Required when any case has bucket === 'recall'. */
	recallAdapter?: RecallAdapter;
	/** Lazily builds the chatbot environment when the first chatbot case dispatches. */
	chatbotEnvFactory?: () => Promise<{
		userId: string;
		householdId: string;
		telegram: { sent: ReadonlyArray<{ userId: string; text: string }> };
		runtime: { services: { router: { routeMessage: (ctx: unknown) => Promise<void> } } };
		captureHandler: () => () => string | null;
		endActiveSession: () => Promise<void>;
		dispose: () => Promise<void>;
	}>;
	/** Judge LLM used by the rubric oracle. Required if any chatbot case is present. */
	judgeLlm?: Pick<LLMService, 'complete'>;
	/** CostTracker proxy used by the rubric oracle to meter judge cost (and chatbot turn cost). */
	costTracker?: { getMonthlyTotalCost: () => number };
	logger: MinimalLogger;
	bucketFilter?: 'routing' | 'receipt' | 'chatbot' | 'recall';
	rerunIds?: Set<string>;
	/** Force fresh dispatch for every case (skip all cache reads). Plumbs the
	 * `--no-cache` CLI flag through. */
	noCache?: boolean;
	dryRun?: boolean;
	onResult?: (result: RunResult) => void;
	/**
	 * When set together with `manifestDir`, the runner writes a `RunManifest`
	 * at completion (REQ-REG-GUI-V2-003). The GUI's subprocess always passes
	 * its registry UUID; pure CLI invocations leave this blank and no
	 * manifest is written.
	 */
	runId?: string;
	/** Root directory for manifest files. Required iff `runId` is set. */
	manifestDir?: string;
	/** Signals that `--judge-model` was applied at run time (recorded in manifest). */
	judgeOverrideApplied?: boolean;
}

export interface RunSuiteOutcome {
	summary: RunSummary;
	results: RunResult[];
	/** caseId → routingTarget. Needed by the REQ-REG-011 accuracy gate. */
	targets: Map<string, RoutingTarget>;
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteOutcome> {
	const startedAt = new Date().toISOString();
	const loaded = await loadCases(opts.casesDir);
	const filtered = opts.bucketFilter
		? loaded.filter((lc) => lc.case.bucket === opts.bucketFilter)
		: loaded;

	const cache = new CacheStore(opts.cacheDir);
	const runBudget = new RunBudget(opts.maxRunBudgetUsd);
	const results: RunResult[] = [];
	const targets = new Map<string, RoutingTarget>();
	for (const lc of filtered) {
		if (lc.case.routingTarget) targets.set(lc.case.id, lc.case.routingTarget);
	}

	// Compute every cache key up-front in parallel. Cases share coverage paths
	// (all 27 FOOD_PERSONAS use the same 3) — the shared `hashCache` map
	// coalesces repeated `git hash-object` spawns across calls.
	const hashCache = new Map<string, Promise<string>>();
	const cacheKeys = await Promise.all(
		filtered.map((lc) =>
			computeCacheKey({
				casePath: relative(opts.repoRoot, lc.filePath),
				coveragePaths: lc.case.coverage,
				modelIds: opts.modelIds,
				repoRoot: opts.repoRoot,
				hashCache,
			}),
		),
	);

	// Pre-read every cache entry in parallel for the cache-hit happy path.
	// Misses become dispatches in the sequential loop below; hits short-circuit.
	const cacheReads = await Promise.all(
		filtered.map((lc, i) => {
			if (opts.dryRun) return Promise.resolve(null);
			if (opts.noCache) return Promise.resolve(null);
			if (opts.rerunIds?.has(lc.case.id)) return Promise.resolve(null);
			return cache.read(lc.case.id, cacheKeys[i]!);
		}),
	);

	// Chatbot env is built lazily on the first chatbot case; reused across the
	// run; disposed once in the `finally` below (REQ-REG-006). Codex I3: if the
	// factory fails once, every subsequent chatbot case yields a synthesized
	// error result without retrying — the failure message is cached here.
	let chatbotEnv: Awaited<ReturnType<NonNullable<typeof opts.chatbotEnvFactory>>> | null = null;
	let chatbotEnvFailure: string | null = null;

	try {
		for (let i = 0; i < filtered.length; i++) {
			const lc = filtered[i]!;
			const cacheKey = cacheKeys[i]!;
			const cached = cacheReads[i];

			if (cached) {
				const out: RunResult = { ...cached, source: 'cached' };
				results.push(out);
				opts.onResult?.(out);
				continue;
			}

			if (opts.dryRun) {
				const dr = makeDryRunResult(lc.case, cacheKey, opts.modelIds);
				results.push(dr);
				opts.onResult?.(dr);
				continue;
			}

			const caseEstimate = opts.estimateUsd(ESTIMATE_TOKENS) * Math.max(1, lc.case.inputs.length);
			if (!runBudget.canAfford(caseEstimate)) {
				opts.logger.warn(
					{
						caseId: lc.case.id,
						remaining: runBudget.remainingUsd,
						estimate: caseEstimate,
					},
					'orchestrator: run budget exhausted — case skipped without dispatch',
				);
				const be = makeBudgetExceededResult(lc.case, cacheKey, opts.modelIds);
				results.push(be);
				opts.onResult?.(be);
				continue;
			}

			let result: RunResult;
			if (lc.case.bucket === 'routing') {
				result = await runRoutingCase(lc.case, {
					modelIds: opts.modelIds,
					cacheKey,
					caseBudgetUsd: lc.case.budgetUsd,
					estimateUsd: opts.estimateUsd,
					logger: opts.logger,
					classifiers: opts.classifiers,
				});
			} else if (lc.case.bucket === 'recall') {
				if (!opts.recallAdapter) {
					throw new Error(
						`orchestrator: case "${lc.case.id}" has bucket="recall" but no recallAdapter was provided`,
					);
				}
				result = await runRecallCase(lc.case, {
					adapter: opts.recallAdapter,
					modelIds: opts.modelIds,
					cacheKey,
					caseBudgetUsd: lc.case.budgetUsd,
					estimateUsd: opts.estimateUsd,
					logger: opts.logger,
				});
			} else if (lc.case.bucket === 'chatbot') {
				if (!opts.chatbotEnvFactory || !opts.judgeLlm) {
					throw new Error(
						`orchestrator: chatbotEnvFactory + judgeLlm are required to dispatch chatbot case "${lc.case.id}"`,
					);
				}
				// Codex I3: once the factory has failed once, every subsequent
				// chatbot case in the same run yields an error result without
				// dispatch — the factory is NOT retried.
				if (chatbotEnvFailure !== null) {
					const errResult = makeEnvFailureResult(
						lc.case,
						cacheKey,
						opts.modelIds,
						chatbotEnvFailure,
					);
					results.push(errResult);
					opts.onResult?.(errResult);
					continue;
				}
				if (chatbotEnv === null) {
					try {
						chatbotEnv = await opts.chatbotEnvFactory();
					} catch (err) {
						chatbotEnvFailure = (err as Error).message || 'chatbot env factory failed';
						opts.logger.warn(
							{ err: chatbotEnvFailure },
							'orchestrator: chatbot env factory failed — marking remaining chatbot cases as error',
						);
						const errResult = makeEnvFailureResult(
							lc.case,
							cacheKey,
							opts.modelIds,
							chatbotEnvFailure,
						);
						results.push(errResult);
						opts.onResult?.(errResult);
						continue;
					}
				}
				const env = chatbotEnv;
				result = await runChatbotCase(lc.case, {
					env: {
						userId: env.userId,
						householdId: env.householdId,
						telegram: env.telegram,
						captureHandler: env.captureHandler,
						endActiveSession: env.endActiveSession,
						routeMessage: (ctx) =>
							requestContext.run({ userId: env.userId, householdId: env.householdId }, () =>
								env.runtime.services.router.routeMessage(ctx),
							),
					},
					judgeLlm: opts.judgeLlm,
					judgeModelId: opts.modelIds.standard,
					costTracker: opts.costTracker ?? { getMonthlyTotalCost: () => 0 },
					modelIds: opts.modelIds,
					cacheKey,
					caseBudgetUsd: lc.case.budgetUsd,
					estimateUsd: opts.estimateUsd,
					logger: opts.logger,
				});
			} else {
				// Receipt bucket lands with Chunk A.2 carry-forward — orchestrator
				// dispatch is intentionally not wired (the standalone receipt
				// runner is invoked from a dedicated entry point).
				opts.logger.info(
					{ caseId: lc.case.id, bucket: lc.case.bucket },
					'orchestrator: bucket runner not wired yet — skipping case',
				);
				continue;
			}

			runBudget.add(result.costUsd);
			await cache.write(result);
			results.push(result);
			opts.onResult?.(result);
		}
	} finally {
		if (chatbotEnv) {
			await chatbotEnv.dispose();
		}
	}

	const summary = buildSummary(results, targets);

	// REQ-REG-GUI-V2-003: persist a RunManifest when the GUI passes --run-id
	// (or a test sets these directly). Dry-runs and `--list` mode bypass
	// runSuite entirely, so no extra guard is needed here. Manifest write
	// failures are logged but do NOT fail the run — the subprocess's exit
	// code is REQ-REG-011's gate, not the manifest's persistence.
	if (opts.runId && opts.manifestDir && !opts.dryRun) {
		try {
			const cases = new Map<string, PersonaCase>();
			for (const lc of filtered) cases.set(lc.case.id, lc.case);
			const manifest = buildManifest({
				runId: opts.runId,
				startedAt,
				completedAt: new Date().toISOString(),
				modelIds: opts.modelIds,
				judgeOverrideApplied: opts.judgeOverrideApplied === true,
				bucketsRequested: opts.bucketFilter ? [opts.bucketFilter] : ['__all__'],
				results,
				cases,
				summary,
			});
			await writeManifest(opts.manifestDir, manifest);
		} catch (err) {
			opts.logger.warn(
				{ err: (err as Error).message, runId: opts.runId, manifestDir: opts.manifestDir },
				'orchestrator: RunManifest write failed (run results still valid; GUI leaderboard will miss this run)',
			);
		}
	}

	return {
		summary,
		results,
		targets,
	};
}

/**
 * CLI entry — parses argv, dispatches `runSuite`, emits stdout, returns the
 * exit code that REQ-REG-011 demands.
 *
 * `deps` is what the CLI's `cli-main.ts` provides from production config
 * (LLMService, CostTracker, adapters, cases/cache dirs, modelIds). Tests
 * can pass their own deps with mocked adapters.
 *
 * In `--json` mode the runner emits one line per case result during the
 * run via `opts.onResult`, then a final `{type:'summary', summary}` line.
 * The GUI subprocess (Chunk B.2) consumes this stream verbatim.
 */
export type RunCliDeps = Omit<
	RunSuiteOptions,
	| 'bucketFilter'
	| 'rerunIds'
	| 'noCache'
	| 'dryRun'
	| 'onResult'
	| 'runId'
	| 'manifestDir'
	| 'judgeOverrideApplied'
>;

export interface RunCliResult {
	exitCode: 0 | 1;
	outcome: RunSuiteOutcome | null;
	options: CliOptions;
}

export async function runCli(
	argv: readonly string[],
	deps: RunCliDeps,
	streams: { stdout?: (s: string) => void } = {},
	manifestDefaults?: ManifestDefaults,
): Promise<RunCliResult> {
	const write = streams.stdout ?? ((s: string) => process.stdout.write(s));
	let cli: CliOptions;
	try {
		cli = parseCliArgs(argv);
	} catch (err) {
		write(`error: ${(err as Error).message}\n${HELP_TEXT}`);
		return {
			exitCode: 1,
			outcome: null,
			options: {
				dryRun: false,
				json: false,
				help: false,
				listOnly: false,
				noCache: false,
				noManifest: false,
			},
		};
	}
	if (cli.help) {
		write(HELP_TEXT);
		return { exitCode: 0, outcome: null, options: cli };
	}
	if (cli.listOnly) {
		await emitCaseList(deps, write);
		return { exitCode: 0, outcome: null, options: cli };
	}

	// When `manifestDefaults` is provided the resolver has already factored
	// in --no-manifest, --manifest-dir, and DATA_DIR. Test callers that
	// pass nothing get the legacy behavior: no manifest unless the test
	// explicitly supplied `--run-id`.
	const effectiveRunId =
		manifestDefaults !== undefined ? (manifestDefaults.runId ?? undefined) : cli.runId;
	const effectiveManifestDir =
		manifestDefaults !== undefined ? (manifestDefaults.manifestDir ?? undefined) : undefined;

	const outcome = await runSuite({
		...deps,
		bucketFilter: cli.bucketFilter,
		rerunIds: cli.rerunIds,
		noCache: cli.noCache,
		dryRun: cli.dryRun,
		runId: effectiveRunId,
		manifestDir: effectiveManifestDir,
		judgeOverrideApplied: cli.judgeModel !== undefined,
		onResult: cli.json
			? (r) => write(`${JSON.stringify({ type: 'case-result', result: r })}\n`)
			: undefined,
	});

	if (cli.json) {
		// `modelIds` rides as a sibling of `summary` (it is not part of
		// `RunSummary`) so the GUI can name the model that was actually tested.
		write(
			`${JSON.stringify({ type: 'summary', summary: outcome.summary, modelIds: deps.modelIds })}\n`,
		);
	} else if (cli.dryRun) {
		// Dry-run cases have empty oracleVerdicts and synthetic pass verdicts.
		// Reporting them as pass/fail would mislead the operator — render the
		// estimate-focused dry-run summary instead.
		write(`${formatDryRunMarkdown(outcome.results, deps.estimateUsd)}\n`);
	} else {
		write(`${formatSummaryMarkdown(outcome.results, outcome.targets)}\n`);
	}

	// REQ-REG-011 gate: skip on dry-run (no oracle ran). Below floor → null →
	// exit 0 with a warning.
	if (
		!cli.dryRun &&
		outcome.summary.routingAccuracy !== null &&
		outcome.summary.routingAccuracy < ACCURACY_GATE_THRESHOLD
	) {
		write(
			`\nREQ-REG-011 FAILED: routing accuracy ${(outcome.summary.routingAccuracy * 100).toFixed(2)}% < ${(ACCURACY_GATE_THRESHOLD * 100).toFixed(0)}%\n`,
		);
		return { exitCode: 1, outcome, options: cli };
	}
	return { exitCode: 0, outcome, options: cli };
}

/**
 * `--list` mode (Chunk B.2 Codex C5). Loads cases and emits one
 * `{type:'case-list-entry'}` line per case (with enough metadata for the
 * GUI to render a never-run drilldown), then a `{type:'case-list-end'}`
 * terminator (Codex I4 fail-closed signal for the case-discovery
 * consumer). No dispatch occurs; the orchestrator's classifier adapters
 * are never invoked.
 */
async function emitCaseList(deps: RunCliDeps, write: (s: string) => void): Promise<void> {
	const loaded = await loadCases(deps.casesDir);
	const hashCache = new Map<string, Promise<string>>();
	const cacheKeys = await Promise.all(
		loaded.map((lc) =>
			computeCacheKey({
				casePath: relative(deps.repoRoot, lc.filePath),
				coveragePaths: lc.case.coverage,
				modelIds: deps.modelIds,
				repoRoot: deps.repoRoot,
				hashCache,
			}),
		),
	);
	let totalInputs = 0;
	for (let i = 0; i < loaded.length; i++) {
		const c = loaded[i]!.case;
		totalInputs += c.inputs.length;
		const entry: Record<string, unknown> = {
			type: 'case-list-entry',
			caseId: c.id,
			bucket: c.bucket,
			description: c.description,
			oracle: c.oracle,
			coverage: c.coverage,
			inputs: c.inputs,
			inputCount: c.inputs.length,
			budgetUsd: c.budgetUsd,
			currentCacheKey: cacheKeys[i]!,
		};
		if (c.routingTarget) entry.routingTarget = c.routingTarget;
		write(`${JSON.stringify(entry)}\n`);
	}
	write(
		`${JSON.stringify({
			type: 'case-list-end',
			totalCases: loaded.length,
			totalInputs,
			modelIds: deps.modelIds,
		})}\n`,
	);
}

function makeDryRunResult(
	c: PersonaCase,
	cacheKey: string,
	modelIds: TierModelSnapshot,
): RunResult {
	return {
		caseId: c.id,
		cacheKey,
		source: 'fresh',
		verdict: VERDICT.pass,
		inputs: c.inputs,
		actuals: [],
		oracleVerdicts: [],
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds,
		timestamp: new Date().toISOString(),
		durationMs: 0,
	};
}

function makeBudgetExceededResult(
	c: PersonaCase,
	cacheKey: string,
	modelIds: TierModelSnapshot,
): RunResult {
	return {
		caseId: c.id,
		cacheKey,
		source: 'fresh',
		verdict: VERDICT.budgetExceeded,
		inputs: c.inputs,
		actuals: [],
		// One synthetic 'error' oracle verdict per input so the REQ-REG-011
		// accuracy gate counts skipped food-shadow inputs against accuracy.
		oracleVerdicts: c.inputs.map(() => ({
			verdict: VERDICT.error,
			details: 'run budget exhausted; case skipped without dispatch',
		})),
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds,
		timestamp: new Date().toISOString(),
		durationMs: 0,
	};
}

/**
 * Synthesized chatbot-bucket result for cases that cannot dispatch because the
 * `chatbotEnvFactory` itself failed (Codex I3). One `error` oracle verdict per
 * input so any downstream gate counts these against accuracy the same way
 * `makeBudgetExceededResult` does for the run-budget hard-abort.
 */
function makeEnvFailureResult(
	c: PersonaCase,
	cacheKey: string,
	modelIds: TierModelSnapshot,
	reason: string,
): RunResult {
	return {
		caseId: c.id,
		cacheKey,
		source: 'fresh',
		verdict: VERDICT.error,
		inputs: c.inputs,
		actuals: [],
		oracleVerdicts: c.inputs.map(() => ({
			verdict: VERDICT.error,
			details: `chatbot env-factory failed: ${reason}`,
		})),
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds,
		timestamp: new Date().toISOString(),
		durationMs: 0,
	};
}
