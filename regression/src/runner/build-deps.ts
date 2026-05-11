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
import { loadSystemConfig } from '@core/services/config/index.js';
import { CostTracker } from '@core/services/llm/cost-tracker.js';
import { LLMServiceImpl } from '@core/services/llm/index.js';
import { ModelCatalog } from '@core/services/llm/model-catalog.js';
import { ModelSelector } from '@core/services/llm/model-selector.js';
import { createProvider } from '@core/services/llm/providers/provider-factory.js';
import { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import type { TierModelSnapshot } from '@core/types/regression.js';
import { type Logger, pino } from 'pino';
import type { CliOptions } from './args.js';
import { type TierOverride, createChatbotEnvironment } from './chatbot-environment.js';
import { buildClassifierAdapters, buildRecallAdapter } from './dispatch.js';
import type { RunCliDeps } from './index.js';

const DEFAULT_MAX_RUN_BUDGET_USD = 5.0;

interface RepoPaths {
	repoRoot: string;
	casesDir: string;
	cacheDir: string;
	configPath: string;
	chatbotSeedJsonPath: string;
	chatbotSeedShaPath: string;
}

function resolveRepoPaths(): RepoPaths {
	const repoRoot = resolve(process.cwd());
	return {
		repoRoot,
		casesDir: resolve(repoRoot, 'regression', 'src', 'cases'),
		cacheDir: resolve(repoRoot, 'data', 'system', 'regression-cache'),
		configPath: resolve(repoRoot, 'config', 'pas.yaml'),
		chatbotSeedJsonPath: resolve(repoRoot, 'regression', 'fixtures', 'chatbot', 'seed.json'),
		chatbotSeedShaPath: resolve(repoRoot, 'regression', 'fixtures', 'chatbot', 'seed.sha256'),
	};
}

export interface ProductionDepsOptions {
	tierOverride?: TierOverride;
}

/** YYYY-MM-DD in the supplied timezone — matches the format production
 * `todayInTimezone` produces (used by recall-classifier as `today`). */
function todayInTimezone(timezone: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date());
}

export async function buildProductionDeps(opts?: ProductionDepsOptions): Promise<RunCliDeps> {
	const paths = resolveRepoPaths();
	// Codex I3: route logs to stderr so stdout stays NDJSON-clean for `--json`.
	const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, process.stderr);

	const config = await loadSystemConfig({ configPath: paths.configPath, mode: 'strict' });

	const costTracker = new CostTracker(config.dataDir, logger.child({ service: 'cost-tracker' }));
	await costTracker.loadMonthlyCache();

	// Compose a shared ProviderRegistry once — the LLM service AND the chatbot
	// environment both reuse it so CostTracker delta metering stays coherent.
	const registry = new ProviderRegistry(logger.child({ service: 'provider-registry' }));
	const llmConfig = config.llm;
	if (llmConfig) {
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

	const llm = await composeLLMService(config, costTracker, logger, registry);
	const modelIds = await resolveTierModelIds(config, logger);
	const maxRunBudgetUsd = config.regression?.maxRunBudgetUsd ?? DEFAULT_MAX_RUN_BUDGET_USD;

	const minimalLogger = {
		warn: (...args: unknown[]) => logger.warn(...(args as Parameters<typeof logger.warn>)),
		info: (...args: unknown[]) => logger.info(...(args as Parameters<typeof logger.info>)),
		debug: (...args: unknown[]) => logger.debug(...(args as Parameters<typeof logger.debug>)),
		error: (...args: unknown[]) => logger.error(...(args as Parameters<typeof logger.error>)),
	};

	const classifiers = buildClassifierAdapters({
		llm,
		logger: minimalLogger,
		costTracker,
		modelIds,
	});

	const recallAdapter = buildRecallAdapter({
		llm,
		logger: minimalLogger,
		costTracker,
		modelIds,
		defaultToday: todayInTimezone(config.timezone || 'UTC'),
	});

	const chatbotEnvFactory = async () => {
		const env = await createChatbotEnvironment({
			seedJsonPath: paths.chatbotSeedJsonPath,
			seedShaPath: paths.chatbotSeedShaPath,
			productionConfigPath: paths.configPath,
			providerRegistry: registry,
			...(opts?.tierOverride ? { tierOverride: opts.tierOverride } : {}),
			logger,
		});
		// `captureHandler` + `endActiveSession` real-runtime plumbing lands with
		// Task 14 (chatSessions/eventBus are not currently surfaced on
		// RuntimeServices). For now, captureHandler returns a null handler id
		// (rubric oracle treats unknown handler as "no assertion") and
		// endActiveSession is a no-op so chatbot cases dispatch cleanly via
		// the existing routeMessage pipeline.
		return {
			userId: env.userId,
			householdId: env.householdId,
			telegram: env.telegram,
			runtime: env.runtime as unknown as {
				services: { router: { routeMessage: (ctx: unknown) => Promise<void> } };
			},
			captureHandler: () => () => null,
			endActiveSession: async () => undefined,
			dispose: env.dispose,
		};
	};

	return {
		casesDir: paths.casesDir,
		cacheDir: paths.cacheDir,
		repoRoot: paths.repoRoot,
		modelIds,
		maxRunBudgetUsd,
		estimateUsd: (call) => costTracker.estimateCost(modelIds.fast, call.tokenIn, call.tokenOut),
		classifiers,
		recallAdapter,
		chatbotEnvFactory,
		judgeLlm: llm,
		costTracker,
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
		defaultStandard: llmConfig?.tiers.standard ?? {
			provider: 'anthropic',
			model: config.claude.model,
		},
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
	// Codex I3: route logs to stderr so stdout stays NDJSON-clean for `--json`.
	const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);
	const throwOnDispatch = (): never => {
		throw new Error(
			'dry-run deps: classifier adapter invoked. Orchestrator should short-circuit on dryRun=true before dispatch.',
		);
	};
	const throwOnRecall = async (): Promise<never> => {
		throw new Error(
			'dry-run deps: recall adapter invoked. Orchestrator should short-circuit on dryRun=true before dispatch.',
		);
	};
	const throwOnChatbotEnv = async (): Promise<never> => {
		throw new Error(
			'dry-run deps: chatbot env factory invoked. Orchestrator should short-circuit on dryRun=true before dispatch.',
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
		recallAdapter: {
			recall: throwOnRecall,
		},
		chatbotEnvFactory: throwOnChatbotEnv,
		logger: {
			warn: (...args) => logger.warn(...(args as Parameters<typeof logger.warn>)),
			info: (...args) => logger.info(...(args as Parameters<typeof logger.info>)),
			debug: (...args) => logger.debug(...(args as Parameters<typeof logger.debug>)),
			error: (...args) => logger.error(...(args as Parameters<typeof logger.error>)),
		},
	};
}

/**
 * Build deps for `--list` mode (Chunk B.2 Codex C1 fix).
 *
 * Resolves real tier model IDs from `pas.yaml` + `ModelSelector` so the
 * `currentCacheKey` emitted by the orchestrator matches what `runSuite`
 * would later write to cache. Critically: does NOT compose providers or
 * instantiate `LLMServiceImpl`, so it works even when API keys are
 * unconfigured. Classifier adapters and `estimateUsd` are stubs that
 * throw / return 0 — list mode never dispatches.
 *
 * Requires the same env vars as `loadSystemConfig` (TELEGRAM_BOT_TOKEN,
 * GUI_AUTH_TOKEN). GUI process always has them; CLI-from-shell users get
 * the same env requirement as `pnpm dev`.
 */
export async function buildMetadataDeps(options?: { configPath?: string }): Promise<RunCliDeps> {
	const paths = resolveRepoPaths();
	// Codex I3: route logs to stderr so stdout stays NDJSON-clean for `--json`.
	const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' }, process.stderr);
	const config = await loadSystemConfig({
		configPath: options?.configPath ?? paths.configPath,
		mode: 'strict',
	});
	const modelIds = await resolveTierModelIds(config, logger);
	const maxRunBudgetUsd = config.regression?.maxRunBudgetUsd ?? DEFAULT_MAX_RUN_BUDGET_USD;
	const throwOnDispatch = (): never => {
		throw new Error(
			'metadata-only deps: classifier adapter invoked. List mode does not dispatch — the orchestrator should short-circuit on listOnly=true.',
		);
	};
	return {
		casesDir: paths.casesDir,
		cacheDir: paths.cacheDir,
		repoRoot: paths.repoRoot,
		modelIds,
		maxRunBudgetUsd,
		estimateUsd: () => 0,
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

/**
 * Resolve concrete model identifiers for each tier, after `ModelSelector`
 * has reconciled against the registered providers. The returned snapshot
 * feeds the cache key — a tier-model swap invalidates cached runs.
 */
async function resolveTierModelIds(
	config: Awaited<ReturnType<typeof loadSystemConfig>>,
	logger: Logger,
): Promise<TierModelSnapshot> {
	const llmConfig = config.llm;
	const modelSelector = new ModelSelector({
		dataDir: config.dataDir,
		defaultStandard: llmConfig?.tiers.standard ?? {
			provider: 'anthropic',
			model: config.claude.model,
		},
		defaultFast: llmConfig?.tiers.fast ?? {
			provider: 'anthropic',
			model: config.claude.fastModel ?? 'claude-haiku-4-5-20251001',
		},
		defaultReasoning: llmConfig?.tiers.reasoning,
		logger: logger.child({ service: 'model-selector-resolve' }),
	});
	await modelSelector.load();
	const fast = modelSelector.getTierRef('fast')?.model ?? 'unknown';
	const standard = modelSelector.getTierRef('standard')?.model ?? 'unknown';
	const reasoning = modelSelector.getTierRef('reasoning')?.model ?? null;
	return { fast, standard, reasoning };
}

/**
 * Substitute tier model IDs from a `--model-matrix=<list>` override into the
 * deps. Only `modelIds` are rewritten; the chatbot environment factory must
 * be re-built with `tierOverride` separately if the override needs to flow
 * into the live LLMService composed inside the chatbot runtime (see
 * `buildProductionDeps({ tierOverride })`). For routing / recall buckets the
 * `modelIds` substitution alone is sufficient because the cache key reflects
 * the override and the adapters dispatch through the shared LLMService.
 *
 * Returns a NEW deps object — does not mutate `deps.modelIds` in place.
 */
export function applyModelMatrixOverride(
	deps: RunCliDeps,
	matrix: NonNullable<CliOptions['modelMatrix']>,
): RunCliDeps {
	const newModelIds: TierModelSnapshot = {
		fast: matrix.fast?.model ?? deps.modelIds.fast,
		standard: matrix.standard?.model ?? deps.modelIds.standard,
		reasoning: matrix.reasoning?.model ?? deps.modelIds.reasoning,
	};
	return { ...deps, modelIds: newModelIds };
}

/**
 * Substitute the rubric oracle's judge model. The rubric oracle reads its
 * model id from `deps.modelIds.standard`, so swapping that field is enough
 * to force a specific judge — the existing `judgeLlm` continues to dispatch
 * through the shared LLMService, which routes by tier.
 *
 * Returns a NEW deps object — does not mutate.
 */
export function applyJudgeModelOverride(
	deps: RunCliDeps,
	judgeRef: { provider: string; model: string },
): RunCliDeps {
	return {
		...deps,
		modelIds: { ...deps.modelIds, standard: judgeRef.model },
	};
}
