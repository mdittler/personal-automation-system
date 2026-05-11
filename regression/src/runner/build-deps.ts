/**
 * Build production deps for the regression CLI.
 *
 * `buildProductionDeps` reads `config/pas.yaml` via `loadSystemConfig`
 * and composes the same CostTracker + ProviderRegistry + ModelSelector
 * + LLMServiceImpl stack `compose-runtime.ts` uses for the live server.
 * Required env (same as `pnpm dev`): TELEGRAM_BOT_TOKEN, GUI_AUTH_TOKEN,
 * and at least one provider API key.
 *
 * `buildDryRunDeps` is a lighter alternative that does NOT require
 * production env vars or a working LLMService — dry-run only loads cases
 * and computes estimated costs. Used by `cli-main.ts` when the operator
 * passes `--dry-run`.
 */

import { resolve } from 'node:path';
import { type Logger, pino } from 'pino';
import { loadSystemConfig } from '@core/services/config/index.js';
import { CostTracker } from '@core/services/llm/cost-tracker.js';
import { LLMServiceImpl } from '@core/services/llm/index.js';
import { ModelCatalog } from '@core/services/llm/model-catalog.js';
import { ModelSelector } from '@core/services/llm/model-selector.js';
import { createProvider } from '@core/services/llm/providers/provider-factory.js';
import { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import type { TierModelSnapshot } from '@core/types/regression.js';
import { buildClassifierAdapters } from './dispatch.js';
import type { RunCliDeps } from './index.js';

const DEFAULT_MAX_RUN_BUDGET_USD = 5.0;

interface RepoPaths {
	repoRoot: string;
	casesDir: string;
	cacheDir: string;
	configPath: string;
}

function resolveRepoPaths(): RepoPaths {
	const repoRoot = resolve(process.cwd());
	return {
		repoRoot,
		casesDir: resolve(repoRoot, 'regression', 'src', 'cases'),
		cacheDir: resolve(repoRoot, 'data', 'system', 'regression-cache'),
		configPath: resolve(repoRoot, 'config', 'pas.yaml'),
	};
}

export async function buildProductionDeps(): Promise<RunCliDeps> {
	const paths = resolveRepoPaths();
	const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

	const config = await loadSystemConfig({ configPath: paths.configPath, mode: 'strict' });

	const costTracker = new CostTracker(config.dataDir, logger.child({ service: 'cost-tracker' }));
	await costTracker.loadMonthlyCache();

	const llm = await composeLLMService(config, costTracker, logger);
	const modelIds = await resolveTierModelIds(config, costTracker, logger);
	const maxRunBudgetUsd = config.regression?.maxRunBudgetUsd ?? DEFAULT_MAX_RUN_BUDGET_USD;

	const classifiers = buildClassifierAdapters({
		llm,
		logger: {
			warn: (...args) => logger.warn(...(args as Parameters<typeof logger.warn>)),
			info: (...args) => logger.info(...(args as Parameters<typeof logger.info>)),
			debug: (...args) => logger.debug(...(args as Parameters<typeof logger.debug>)),
			error: (...args) => logger.error(...(args as Parameters<typeof logger.error>)),
		},
		costTracker,
		modelIds,
	});

	return {
		casesDir: paths.casesDir,
		cacheDir: paths.cacheDir,
		repoRoot: paths.repoRoot,
		modelIds,
		maxRunBudgetUsd,
		estimateUsd: (call) => costTracker.estimateCost(modelIds.fast, call.tokenIn, call.tokenOut),
		classifiers,
		logger,
	};
}

/**
 * Compose a fully-functional production LLMService. Mirrors the LLM
 * composition slice in `compose-runtime.ts:310-372` — same classes, same
 * wiring — but skips downstream services the CLI doesn't need (routers,
 * GUI, alerts, schedulers).
 *
 * Exported for test composition via stubbed `ProviderRegistry` overrides.
 */
export async function composeLLMService(
	config: Awaited<ReturnType<typeof loadSystemConfig>>,
	costTracker: CostTracker,
	logger: Logger,
	registryOverride?: ProviderRegistry,
): Promise<LLMServiceImpl> {
	const llmConfig = config.llm;
	const registry =
		registryOverride ?? new ProviderRegistry(logger.child({ service: 'provider-registry' }));

	if (!registryOverride && llmConfig) {
		for (const [id, providerConfig] of Object.entries(llmConfig.providers)) {
			const provider = createProvider(
				id,
				providerConfig,
				logger.child({ service: `provider-${id}` }),
				costTracker,
			);
			if (provider) registry.register(provider);
		}
	}

	if (registry.size === 0) {
		logger.warn(
			'regression CLI: no LLM providers registered — set ANTHROPIC_API_KEY (or another provider) and configure config/pas.yaml',
		);
	}

	const modelSelector = new ModelSelector({
		dataDir: config.dataDir,
		defaultStandard: llmConfig?.tiers.standard ?? { provider: 'anthropic', model: config.claude.model },
		defaultFast: llmConfig?.tiers.fast ?? {
			provider: 'anthropic',
			model: config.claude.fastModel ?? 'claude-haiku-4-5-20251001',
		},
		defaultReasoning: llmConfig?.tiers.reasoning,
		logger: logger.child({ service: 'model-selector' }),
	});
	await modelSelector.load();
	modelSelector.reconcile(new Set(registry.getProviderIds()));

	// ModelCatalog is wired by composeRuntime; the regression CLI doesn't need
	// it for dispatch but constructing it here keeps composition symmetry and
	// lets future test:regression features (live model swaps) reuse the slot.
	new ModelCatalog({
		apiKey: config.claude.apiKey,
		logger: logger.child({ service: 'model-catalog' }),
		providerRegistry: registry,
	});

	return new LLMServiceImpl({
		registry,
		modelSelector,
		costTracker,
		logger: logger.child({ service: 'llm' }),
	});
}

/**
 * Resolve concrete model identifiers for each tier, after `ModelSelector`
 * has reconciled against the registered providers. The returned snapshot
 * feeds the cache key — a tier-model swap invalidates cached runs.
 */
/**
 * Build deps for a `--dry-run` invocation. Does not load `pas.yaml`, does
 * not require env vars, does not compose an LLMService. The classifier
 * adapters are a throwing stub — runSuite never invokes them in dry-run
 * (the orchestrator short-circuits to `makeDryRunResult`), and runCli
 * renders an estimate-focused summary instead of pass/fail counts.
 */
export function buildDryRunDeps(): RunCliDeps {
	const paths = resolveRepoPaths();
	const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'warn' });
	const throwOnDispatch = (): never => {
		throw new Error(
			'dry-run deps: classifier adapter invoked. Orchestrator should short-circuit on dryRun=true before dispatch.',
		);
	};
	return {
		casesDir: paths.casesDir,
		cacheDir: paths.cacheDir,
		repoRoot: paths.repoRoot,
		// Stable placeholder model IDs — irrelevant for dry-run because no LLM
		// call is made and the result's cache key is not persisted.
		modelIds: { fast: 'dry-run', standard: 'dry-run', reasoning: null },
		maxRunBudgetUsd: DEFAULT_MAX_RUN_BUDGET_USD,
		estimateUsd: () => 0.0001,
		classifiers: {
			foodShadow: async () => throwOnDispatch(),
			sessionControl: async () => throwOnDispatch(),
			pas: async () => throwOnDispatch(),
		},
		logger: {
			warn: (...args) => logger.warn(...(args as Parameters<typeof logger.warn>)),
			info: (...args) => logger.info(...(args as Parameters<typeof logger.info>)),
			debug: (...args) => logger.debug(...(args as Parameters<typeof logger.debug>)),
			error: (...args) => logger.error(...(args as Parameters<typeof logger.error>)),
		},
	};
}

async function resolveTierModelIds(
	config: Awaited<ReturnType<typeof loadSystemConfig>>,
	costTracker: CostTracker,
	logger: Logger,
): Promise<TierModelSnapshot> {
	const llmConfig = config.llm;
	const modelSelector = new ModelSelector({
		dataDir: config.dataDir,
		defaultStandard: llmConfig?.tiers.standard ?? { provider: 'anthropic', model: config.claude.model },
		defaultFast: llmConfig?.tiers.fast ?? {
			provider: 'anthropic',
			model: config.claude.fastModel ?? 'claude-haiku-4-5-20251001',
		},
		defaultReasoning: llmConfig?.tiers.reasoning,
		logger: logger.child({ service: 'model-selector-resolve' }),
	});
	await modelSelector.load();
	void costTracker; // currently unused here; reserved for cost-aware tier resolution
	const fast = modelSelector.getTierRef('fast')?.model ?? 'unknown';
	const standard = modelSelector.getTierRef('standard')?.model ?? 'unknown';
	const reasoning = modelSelector.getTierRef('reasoning')?.model ?? null;
	return { fast, standard, reasoning };
}
