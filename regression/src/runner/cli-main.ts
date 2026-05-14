#!/usr/bin/env tsx
/**
 * CLI entry — `pnpm test:regression`.
 *
 * Peeks at argv to pick the dep factory:
 *  - `--list`     → `buildMetadataDeps()`: resolves real tier IDs without
 *                   composing providers, so emitted `currentCacheKey`s match
 *                   what `runSuite()` would write to cache.
 *  - `--dry-run`  → `buildDryRunDeps()`: no env, no LLM, estimate only.
 *  - otherwise    → `buildProductionDeps()`: real LLMService stack.
 *
 * Also peeks at `--model-matrix` / `--judge-model` so the chatbot env factory
 * captures the tier override at factory-build time.
 *
 * Manifest defaults (runId + manifestDir) are resolved by `runner-options.ts`
 * — kept here as a thin wrapper so the precedence + DATA_DIR logic is
 * unit-testable without the top-level-await dance.
 */

import { buildTierOverrideFromCli, parseCliArgs } from './args.js';
import type { CliOptions } from './args.js';
import {
	applyJudgeModelOverride,
	applyModelMatrixOverride,
	buildDryRunDeps,
	buildMetadataDeps,
	buildProductionDeps,
} from './build-deps.js';
import { runCli } from './index.js';
import { resolveManifestDefaults } from './runner-options.js';

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
	peeked = {
		dryRun: false,
		json: false,
		help: false,
		listOnly: false,
		noCache: false,
		noManifest: false,
	};
}

// Combine --model-matrix and --judge-model into a single tier override.
// `--judge-model` wins over `--model-matrix=standard=` for the standard slot
// (the rubric oracle is the primary consumer of standard tier). The combiner
// lives in `args.ts` so the precedence is unit-testable (Codex correction #3).
const tierOverride = buildTierOverrideFromCli(peeked);

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

// Resolve manifest defaults BEFORE runCli so pure CLI sweeps (no --run-id)
// still write a RunManifest the GUI leaderboard can pick up. --list/--dry-run
// don't dispatch, so the manifest write inside runSuite is naturally a no-op.
const manifestDefaults = resolveManifestDefaults(peeked, process.env, deps.repoRoot);

const { exitCode } = await runCli(argv, deps, undefined, manifestDefaults);
// Drain stdout before exiting. On POSIX, `process.stdout` is async when piped
// (which is how the GUI subprocess + tests consume `--list` NDJSON), so calling
// `process.exit()` immediately after the final `write()` can truncate buffered
// output. Empty-write + callback is the canonical drain idiom: the callback
// fires only after all preceding writes have been flushed to the pipe.
process.stdout.write('', () => process.exit(exitCode));
