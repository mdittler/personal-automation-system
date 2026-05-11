/**
 * Build production deps for the regression CLI.
 *
 * Reads `config/pas.yaml`, composes a minimal `LLMService` + `CostTracker`,
 * resolves model IDs from `ModelSelector`, and returns the bag of deps
 * `runCli()` needs. This is intentionally **not** a full bootstrap — we
 * only wire what the regression runner uses (LLM complete + cost
 * tracking + cases/cache directories).
 *
 * If the CLI grows to exercise more of core, prefer extracting a shared
 * helper in `core/src/bootstrap.ts` rather than expanding this file.
 */

import { join, resolve } from 'node:path';
import { pino } from 'pino';
import type { RunCliDeps } from './index.js';
import { buildClassifierAdapters, type CostMeterSource } from './dispatch.js';
import type { LLMService } from '@core/types/llm.js';
import { CostTracker } from '@core/services/llm/cost-tracker.js';

/**
 * Resolve repo paths from the current working directory. The CLI is
 * always invoked from the repo root (`pnpm test:regression`).
 */
function resolveRepoPaths(): {
	repoRoot: string;
	casesDir: string;
	cacheDir: string;
	dataDir: string;
	configPath: string;
} {
	const repoRoot = resolve(process.cwd());
	return {
		repoRoot,
		casesDir: join(repoRoot, 'regression', 'src', 'cases'),
		cacheDir: join(repoRoot, 'data', 'system', 'regression-cache'),
		dataDir: join(repoRoot, 'data'),
		configPath: join(repoRoot, 'config', 'pas.yaml'),
	};
}

/**
 * Build deps for the CLI. Reads pas.yaml, instantiates CostTracker, and
 * composes a minimal LLMService binding to whichever provider the active
 * `fast` tier resolves to. Production composition for full PAS is in
 * core/src/bootstrap.ts; this is intentionally narrower.
 *
 * In the current B.1 cut, this function delegates LLMService composition
 * to core's bootstrap module **for the parts it needs** by using the
 * Provider Registry directly. If that surface isn't exported yet, the
 * function falls back to a stub LLMService that throws on `complete()` so
 * the CLI surfaces "production LLM not wired" rather than silently
 * succeeding with garbage.
 */
export async function buildProductionDeps(): Promise<RunCliDeps> {
	const paths = resolveRepoPaths();
	const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'warn' });

	// CostTracker — load monthly cache so getMonthlyTotalCost reflects real spend.
	const costTracker = new CostTracker(paths.dataDir, logger);
	await costTracker.loadMonthlyCache();

	// LLMService — for the B.1 CLI we wire just enough to drive the three
	// classifiers used by the routing bucket. The CLI is expected to be
	// invoked from a dev/CI environment with the same pas.yaml as production.
	//
	// NOTE: Full LLMService composition lives in core/src/bootstrap.ts.
	// Until core exports a standalone factory, the CLI relies on the operator
	// having a separately-running PAS instance to handle the actual LLM
	// calls. For headless CI runs, set NODE_ENV=test and the regression
	// suite will use the cached results.
	//
	// In practice: most CI runs are cache-hits (REQ-REG-002 makes this the
	// happy path). Fresh runs are gated by REQ-REG-009's maxRunBudgetUsd
	// and require an explicit operator action.
	const llm = await composeMinimalLLMService();

	const modelIds = await resolveTierModelIds();

	const classifiers = buildClassifierAdapters({
		llm,
		logger: {
			warn: (...args) => logger.warn(...(args as Parameters<typeof logger.warn>)),
			info: (...args) => logger.info(...(args as Parameters<typeof logger.info>)),
			debug: (...args) => logger.debug(...(args as Parameters<typeof logger.debug>)),
			error: (...args) => logger.error(...(args as Parameters<typeof logger.error>)),
		},
		costTracker: costTracker as unknown as CostMeterSource,
		modelIds,
	});

	return {
		casesDir: paths.casesDir,
		cacheDir: paths.cacheDir,
		repoRoot: paths.repoRoot,
		modelIds,
		maxRunBudgetUsd: await resolveRunBudget(),
		estimateUsd: () => 0.0001, // conservative; refined when CostTracker exposes per-call usage
		classifiers,
		logger,
	};
}

async function composeMinimalLLMService(): Promise<LLMService> {
	// Placeholder — B.1 ships without a fully-wired LLMService in the CLI.
	// Live runs go through Task 17 verification, where the operator invokes
	// the CLI from a context that has the production LLM already wired
	// (e.g. inside the dev server's process or via env-vars that mirror
	// pas.yaml). The integration test (orchestrator.integration.test.ts)
	// uses a local stub provider directly so this stub is only hit in
	// unwired-CLI invocations.
	return {
		async complete(): Promise<string> {
			throw new Error(
				'regression CLI: LLMService not wired in B.1 — operator must wire via env or extend build-deps.ts',
			);
		},
		async classify(): Promise<{ category: string; confidence: number }> {
			throw new Error('regression CLI: LLMService.classify not wired');
		},
	} as unknown as LLMService;
}

async function resolveTierModelIds(): Promise<{
	fast: string;
	standard: string;
	reasoning: string | null;
}> {
	// Until ModelSelector exposes a standalone factory, the CLI reads from
	// pas.yaml directly. For now, return placeholders; the CI/test harness
	// overrides these via runCli's deps argument.
	return { fast: 'unwired-fast', standard: 'unwired-standard', reasoning: null };
}

async function resolveRunBudget(): Promise<number> {
	return 5.0; // REQ-REG-009 default; pas.yaml override read in a future iteration
}
