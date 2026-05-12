#!/usr/bin/env tsx
/**
 * CLI entry — invoked via `pnpm test:regression`.
 *
 * Peeks at argv to decide between three dep factories:
 *  - `--list`: `buildMetadataDeps()` — loads pas.yaml + resolves real
 *    tier model IDs via `ModelSelector` so the emitted `currentCacheKey`
 *    matches what `runSuite()` would later write to cache (Chunk B.2
 *    Codex C1). Does NOT compose providers or LLMService.
 *  - `--dry-run`: `buildDryRunDeps()` — no env, no real LLM, just enough
 *    to load cases and render an estimate.
 *  - otherwise: `buildProductionDeps()` — loads pas.yaml + composes the
 *    real LLMService stack (requires production env vars).
 *
 * Also peeks at argv for `--model-matrix=<list>` and `--judge-model=<ref>`
 * so the chatbot env factory can capture the tier override at factory-build
 * time (Task 12). Both `--flag=value` and `--flag value` forms are
 * supported.
 */

import { parseCliArgs } from './args.js';
import type { CliOptions } from './args.js';
import {
	applyJudgeModelOverride,
	applyModelMatrixOverride,
	buildDryRunDeps,
	buildMetadataDeps,
	buildProductionDeps,
} from './build-deps.js';
import { runCli } from './index.js';

// Silence dotenv's `[dotenv@x.y.z] injecting env (N) from .env` banner so
// stdout is strictly NDJSON whenever `--json` is set. Honour an explicit
// operator override. `loadDotenv` is only invoked at call time inside
// `loadSystemConfig` (not at module-load), so setting this before the
// build-deps call below is sufficient. (Codex P3.2.)
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET ?? 'true';

const argv = process.argv.slice(2);
const isList = argv.includes('--list');
const isDryRun = argv.includes('--dry-run');

// Peek at `--model-matrix` / `--judge-model` so the production deps factory
// can pass the tier override into `createChatbotEnvironment`. Reuses the
// canonical `parseCliArgs` rather than hand-rolling a partial peek so the
// equals-vs-space forms stay in lockstep with the test suite.
let peeked: CliOptions;
try {
	peeked = parseCliArgs(argv);
} catch {
	// Surface the parse error inside `runCli` (which prints HELP_TEXT). For
	// the peek-and-build phase, fall back to an empty CliOptions.
	peeked = { dryRun: false, json: false, help: false, listOnly: false };
}

// Combine --model-matrix and --judge-model into a single tier override so
// `buildProductionDeps` can push it into `config.llm.tiers` BEFORE composing the
// LLM service. `--judge-model` overrides the standard tier specifically; if the
// operator also passes `--model-matrix=...,standard=...`, judge-model wins for
// the standard slot (the rubric oracle is the primary consumer of standard tier
// in the regression run). Codex correction: previously the override only
// reached `modelIds` metadata and never affected the actual LLMService dispatch.
const tierOverride =
	peeked.modelMatrix || peeked.judgeModel
		? {
				...(peeked.modelMatrix?.fast ? { fast: peeked.modelMatrix.fast } : {}),
				...(peeked.judgeModel
					? { standard: peeked.judgeModel }
					: peeked.modelMatrix?.standard
						? { standard: peeked.modelMatrix.standard }
						: {}),
				...(peeked.modelMatrix?.reasoning
					? { reasoning: peeked.modelMatrix.reasoning }
					: {}),
			}
		: undefined;

let deps = isList
	? await buildMetadataDeps()
	: isDryRun
		? buildDryRunDeps()
		: await buildProductionDeps(tierOverride ? { tierOverride } : undefined);

// `applyModelMatrixOverride` / `applyJudgeModelOverride` are retained for the
// dry-run / metadata paths where the LLM service was never composed and the
// modelIds substitution is still needed to flow through cache keys.
if ((isDryRun || isList) && peeked.modelMatrix) {
	deps = applyModelMatrixOverride(deps, peeked.modelMatrix);
}
if ((isDryRun || isList) && peeked.judgeModel) {
	deps = applyJudgeModelOverride(deps, peeked.judgeModel);
}

const { exitCode } = await runCli(argv, deps);
process.exit(exitCode);
