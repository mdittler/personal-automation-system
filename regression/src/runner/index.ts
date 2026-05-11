/**
 * Persona Regression Suite orchestrator (REQ-REG-002, REQ-REG-008,
 * REQ-REG-009, REQ-REG-011).
 *
 * `runSuite()` loads PersonaCases, dispatches them sequentially, and
 * returns aggregated `{summary, results, targets}`. Designed to be called
 * both from the CLI (Task 8) and the GUI (Chunk B.2 via subprocess).
 *
 * Behaviours:
 *
 * - Cache hit short-circuits the dispatch (REQ-REG-002 / REQ-REG-010).
 * - `bucketFilter` skips non-matching cases; useful for routing-only runs
 *   in CI before receipt fixtures arrive.
 * - `rerunIds` forces a fresh dispatch for the listed case IDs even when
 *   a valid cache entry exists.
 * - `dryRun` produces zero-cost "fresh" results without dispatching, so
 *   operators can preview a run's estimate (REQ-REG-009 prep).
 * - **Hard-abort RunBudget** (Codex C-9): once `runBudget.canAfford(next)`
 *   returns false, all remaining selected cases are emitted as
 *   `verdict: 'budget-exceeded'` without any LLM dispatch. The per-case
 *   `oracleVerdicts` are filled with `verdict: 'error'` entries so the
 *   REQ-REG-011 gate counts the skipped inputs against accuracy.
 * - `onResult(r)` fires once per case completion, in dispatch order.
 *   Used by the SSE handler in Chunk B.2 to stream progress.
 *
 * Dispatch is sequential by design. Two parallel cases would race the
 * `CostTracker` snapshot used by classifier adapters; the gate would
 * still be correct in aggregate but per-case `costUsd` would drift.
 */

import { relative } from 'node:path';
import type {
	PersonaCase,
	RoutingTarget,
	RunResult,
	RunSummary,
	TierModelSnapshot,
} from '@core/types/regression.js';
import { computeCacheKey } from '../shared/cache-key.js';
import { RunBudget } from './budget.js';
import { CacheStore } from './cache.js';
import { loadCases } from './case-loader.js';
import {
	type MinimalLogger,
	type RoutingClassifierAdapter,
	runRoutingCase,
} from './case-runners/routing-runner.js';
import { buildSummary } from './markdown-report.js';

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

const ESTIMATE_TOKENS = { tokenIn: 400, tokenOut: 80 };

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

	for (const lc of filtered) {
		const cacheKey = await computeCacheKey({
			casePath: relative(opts.repoRoot, lc.filePath),
			coveragePaths: lc.case.coverage,
			modelIds: opts.modelIds,
			repoRoot: opts.repoRoot,
		});

		// Cache short-circuit (unless rerun requested or dry-run).
		if (!opts.dryRun && !opts.rerunIds?.has(lc.case.id)) {
			const cached = await cache.read(lc.case.id, cacheKey);
			if (cached) {
				const out: RunResult = { ...cached, source: 'cached' };
				results.push(out);
				opts.onResult?.(out);
				continue;
			}
		}

		if (opts.dryRun) {
			const dr = makeDryRunResult(lc.case, cacheKey, opts.modelIds);
			results.push(dr);
			opts.onResult?.(dr);
			continue;
		}

		// Hard-abort RunBudget (Codex C-9): skip dispatch entirely when the
		// case's worst-case estimate would push us over the run ceiling.
		const caseEstimate =
			opts.estimateUsd(ESTIMATE_TOKENS) * Math.max(1, lc.case.inputs.length);
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
			// receipt / chatbot / recall buckets aren't wired in B.1; receipt arrives
			// with Chunk A.2's photo delivery, chatbot+recall in Chunk C.
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

function makeDryRunResult(
	c: PersonaCase,
	cacheKey: string,
	modelIds: TierModelSnapshot,
): RunResult {
	return {
		caseId: c.id,
		cacheKey,
		source: 'fresh',
		verdict: 'pass',
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
		verdict: 'budget-exceeded',
		inputs: c.inputs,
		actuals: [],
		// One synthetic 'error' oracle verdict per input so the REQ-REG-011
		// accuracy gate counts skipped food-shadow inputs against accuracy
		// (Codex C-2).
		oracleVerdicts: c.inputs.map(() => ({
			verdict: 'error' as const,
			details: 'run budget exhausted; case skipped without dispatch',
		})),
		tokenCounts: { input: 0, output: 0 },
		costUsd: 0,
		modelIds,
		timestamp: new Date().toISOString(),
		durationMs: 0,
	};
}
