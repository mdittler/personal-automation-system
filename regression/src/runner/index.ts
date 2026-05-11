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
import {
	ESTIMATE_TOKENS,
	type MinimalLogger,
	type RoutingClassifierAdapter,
	runRoutingCase,
} from './case-runners/routing-runner.js';
import {
	ACCURACY_GATE_THRESHOLD,
	buildSummary,
	formatDryRunMarkdown,
	formatSummaryMarkdown,
} from './markdown-report.js';

export interface RunSuiteOptions {
	casesDir: string;
	cacheDir: string;
	repoRoot: string;
	modelIds: TierModelSnapshot;
	maxRunBudgetUsd: number;
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number;
	classifiers: RoutingClassifierAdapter;
	logger: MinimalLogger;
	bucketFilter?: 'routing' | 'receipt' | 'chatbot' | 'recall';
	rerunIds?: Set<string>;
	dryRun?: boolean;
	onResult?: (result: RunResult) => void;
}

export interface RunSuiteOutcome {
	summary: RunSummary;
	results: RunResult[];
	/** caseId → routingTarget. Needed by the REQ-REG-011 accuracy gate. */
	targets: Map<string, RoutingTarget>;
}

export async function runSuite(opts: RunSuiteOptions): Promise<RunSuiteOutcome> {
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
			if (opts.rerunIds?.has(lc.case.id)) return Promise.resolve(null);
			return cache.read(lc.case.id, cacheKeys[i]!);
		}),
	);

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
		} else {
			// Receipt bucket lands with Chunk A.2; chatbot + recall with Chunk C.
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

	return {
		summary: buildSummary(results, targets),
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
export type RunCliDeps = Omit<RunSuiteOptions, 'bucketFilter' | 'rerunIds' | 'dryRun' | 'onResult'>;

export interface RunCliResult {
	exitCode: 0 | 1;
	outcome: RunSuiteOutcome | null;
	options: CliOptions;
}

export async function runCli(
	argv: readonly string[],
	deps: RunCliDeps,
	streams: { stdout?: (s: string) => void } = {},
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
			options: { dryRun: false, json: false, help: false, listOnly: false },
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

	const outcome = await runSuite({
		...deps,
		bucketFilter: cli.bucketFilter,
		rerunIds: cli.rerunIds,
		dryRun: cli.dryRun,
		onResult: cli.json
			? (r) => write(`${JSON.stringify({ type: 'case-result', result: r })}\n`)
			: undefined,
	});

	if (cli.json) {
		write(`${JSON.stringify({ type: 'summary', summary: outcome.summary })}\n`);
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
	for (let i = 0; i < loaded.length; i++) {
		const c = loaded[i]!.case;
		const entry: Record<string, unknown> = {
			type: 'case-list-entry',
			caseId: c.id,
			bucket: c.bucket,
			description: c.description,
			oracle: c.oracle,
			coverage: c.coverage,
			inputs: c.inputs,
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
