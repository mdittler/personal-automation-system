/**
 * composeRuntime() — wires all PAS services (Phases A–D) and returns a
 * fully-constructed RuntimeHandle without starting Telegraf, Fastify, or
 * the scheduler.
 *
 * `main()` in bootstrap.ts calls this and then runs Phase E (starts external
 * resources, registers signal handlers, etc.).
 *
 * The optional `RuntimeOverrides` argument allows tests to inject stubs for
 * config, LLM providers, Telegram, loggers, and the data directory.
 */

import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the repo root from this file's location (core/src/compose-runtime.ts → ../../)
// so path defaults are not sensitive to the caller's CWD.
const _repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
import './types/fastify-augmentation.js'; // D5b-2: module augmentation — adds user/actor to FastifyRequest
import type { FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import { registerApiRoutes } from './api/index.js';
import { registerGuiRoutes } from './gui/index.js';
import { registerGlobalErrorHandlers } from './middleware/error-handler.js';
import {
	createApiRateLimiter,
	createLoginRateLimiter,
	createTelegramRateLimiter,
} from './middleware/rate-limiter.js';
import { ShutdownManager } from './middleware/shutdown.js';
import { HealthChecker } from './server/health-checks.js';
import { createServer, registerHealthRoute, registerWebhookRoute } from './server/index.js';
import { AlertService } from './services/alerts/index.js';
import { AppKnowledgeBase } from './services/app-knowledge/index.js';
import { AppMetadataServiceImpl } from './services/app-metadata/index.js';
import { AppRegistry, type ServiceFactory } from './services/app-registry/index.js';
import { AppToggleStore } from './services/app-toggle/index.js';
import { AudioServiceImpl } from './services/audio/index.js';
import { ConditionEvaluatorServiceImpl } from './services/condition-evaluator/index.js';
import { AppConfigServiceImpl } from './services/config/app-config-service.js';
import { DEFAULT_LLM_SAFEGUARDS } from './services/config/defaults.js';
import { loadSystemConfig } from './services/config/index.js';
import { ContextStoreServiceImpl } from './services/context-store/index.js';
import { requestContext } from './services/context/request-context.js';
import { ConversationRetrievalServiceImpl } from './services/conversation-retrieval/index.js';
import { composeChatSessionStore } from './services/conversation-session/compose.js';
import {
	CONVERSATION_DATA_SCOPES,
	CONVERSATION_LLM_SAFEGUARDS,
	CONVERSATION_USER_CONFIG,
	ConversationService,
} from './services/conversation/index.js';
import { CredentialService } from './services/credentials/index.js';
import { DailyDiffService } from './services/daily-diff/index.js';
import { DataQueryServiceImpl } from './services/data-query/index.js';
import { ChangeLog } from './services/data-store/change-log.js';
import { DataStoreServiceImpl } from './services/data-store/index.js';
import { EditLog, EditServiceImpl } from './services/edit/index.js';
import { EventBusServiceImpl } from './services/event-bus/index.js';
import { FileIndexService } from './services/file-index/index.js';
import { HouseholdService } from './services/household/index.js';
import { InteractionContextServiceImpl } from './services/interaction-context/index.js';
import { InviteService } from './services/invite/index.js';
import { CostTracker } from './services/llm/cost-tracker.js';
import type { PriceLookup } from './services/llm/estimate-guard-cost.js';
import { HouseholdLLMLimiter } from './services/llm/household-llm-limiter.js';
import { LLMServiceImpl } from './services/llm/index.js';
import { LLMGuard } from './services/llm/llm-guard.js';
import { ModelCatalog } from './services/llm/model-catalog.js';
import { DEFAULT_REMOTE_PRICING, getModelPricing } from './services/llm/model-pricing.js';
import { ModelSelector } from './services/llm/model-selector.js';
import { createProvider } from './services/llm/providers/provider-factory.js';
import { ProviderRegistry } from './services/llm/providers/provider-registry.js';
import { SystemLLMGuard } from './services/llm/system-llm-guard.js';
import { createChildLogger, createLogger } from './services/logger/index.js';
import { MessageRateTracker } from './services/metrics/message-rate-tracker.js';
import { ModelJournalServiceImpl } from './services/model-journal/index.js';
import { N8nDispatcherImpl } from './services/n8n/index.js';
import { handleFirstRunWizardCallback } from './services/onboarding/first-run-wizard.js';
import { ReportService } from './services/reports/index.js';
import { FallbackHandler } from './services/router/fallback.js';
import { Router, buildUserOverrideRouteInfo } from './services/router/index.js';
import { PendingVerificationStore } from './services/router/pending-verification-store.js';
import { RouteVerifier } from './services/router/route-verifier.js';
import { VerificationLogger } from './services/router/verification-logger.js';
import { SchedulerServiceImpl } from './services/scheduler/index.js';
import { JobFailureNotifier } from './services/scheduler/job-failure-notifier.js';
import { buildScheduledJobHandler } from './services/scheduler/per-user-dispatch.js';
import { SecretsServiceImpl } from './services/secrets/index.js';
import { SpaceService } from './services/spaces/index.js';
import { SystemInfoServiceImpl } from './services/system-info/index.js';
import { createBot, createWebhookCallback } from './services/telegram/bot.js';
import { TelegramServiceImpl } from './services/telegram/index.js';
import {
	adaptPhotoMessage,
	adaptTextMessage,
	extractUserId,
} from './services/telegram/message-adapter.js';
import { UserManager } from './services/user-manager/index.js';
import { UserGuard } from './services/user-manager/user-guard.js';
import { UserMutationService } from './services/user-manager/user-mutation-service.js';
import { VaultService } from './services/vault/index.js';
import { WebhookService } from './services/webhooks/index.js';
import type { CoreServices } from './types/app-module.js';
import type { LLMSafeguardsConfig, SystemConfig } from './types/config.js';
import type { DataChangedPayload } from './types/data-events.js';
import type { DataQueryOptions } from './types/data-query.js';
import type { ManifestDataScope } from './types/manifest.js';
import type { TelegramService } from './types/telegram.js';

export interface RuntimeOverrides {
	dataDir?: string;
	configPath?: string;
	config?: SystemConfig;
	providerRegistry?: ProviderRegistry;
	telegramService?: TelegramService & { cleanup(): void | Promise<void> };
	logger?: Logger;
	/** Override the apps directory path. Useful in tests running from a sub-package CWD. */
	appsDir?: string;
}

/**
 * Named bundle of all runtime services returned by composeRuntime().
 */
export interface RuntimeServices {
	config: SystemConfig;
	router: Router;
	householdService: HouseholdService;
	costTracker: CostTracker;
	householdLimiter: HouseholdLLMLimiter;
	systemLlm: SystemLLMGuard;
	apiLlm: SystemLLMGuard;
	scheduler: SchedulerServiceImpl;
	telegram: TelegramService & { cleanup(): void | Promise<void> };
	registry: AppRegistry;
	reportService: ReportService;
	alertService: AlertService;
	fileIndex: FileIndexService;
	vault: VaultService;
	userManager: UserManager;
	spaceService: SpaceService;
	interactionContext: InteractionContextServiceImpl;
	contextStore: ContextStoreServiceImpl;
	fallback: FallbackHandler;
	webhookService: WebhookService | undefined;
	telegramRateLimiter: ReturnType<typeof createTelegramRateLimiter>;
	loginRateLimiter: ReturnType<typeof createLoginRateLimiter>;
	apiRateLimiter: ReturnType<typeof createApiRateLimiter> | undefined;
	dailyDiff: DailyDiffService;
	backupService: undefined; // instantiated lazily inside main() if backup is enabled
	n8nDispatcher: N8nDispatcherImpl;
	changeLog: ChangeLog;
	eventBus: EventBusServiceImpl;
	modelSelector: ModelSelector;
	modelCatalog: ModelCatalog;
	llm: LLMServiceImpl;
	providerRegistry: ProviderRegistry;
	safeguardsConfig: LLMSafeguardsConfig & {
		defaultReservationUsd?: number;
		reservationExpiryMs?: number;
	};
	[key: string]: unknown;
}

export interface RuntimeHandle {
	services: RuntimeServices;
	bot: Bot;
	server: FastifyInstance;
	shutdownManager: ShutdownManager;
	/** Root logger instance used by all services. Exposed so bootstrap.ts doesn't need a second createLogger() call. */
	logger: Logger;
	dispose: () => Promise<void>;
}

/**
 * Compose all PAS runtime services (Phases A–D) without starting any external
 * resources (Fastify listener, Telegraf polling/webhook, scheduler, signal handlers).
 *
 * Returns a fully-wired RuntimeHandle. Call `main()` or Phase E code to start
 * the external resources.
 *
 * The optional `overrides` argument allows tests to inject stubs for config,
 * LLM providers, Telegram, loggers, and the data directory.
 */
export async function composeRuntime(overrides: RuntimeOverrides = {}): Promise<RuntimeHandle> {
	const hasOverrides = Object.keys(overrides).length > 0;

	// -------------------------------------------------------------------------
	// Phase A: Config + Logger
	// -------------------------------------------------------------------------

	let config: SystemConfig;
	let configPath: string;

	if (overrides.config) {
		// Test override: use config directly without loading from disk.
		// FOOTGUN: if configPath is not also overridden, UserMutationService will
		// write-back to the real config/pas.yaml on invite redemption or user
		// mutation. Always pass configPath alongside config in test callers.
		// See docs/open-items.md — "composeRuntime configPath footgun".
		config = overrides.config;
		configPath = overrides.configPath ?? resolve('config', 'pas.yaml');
		// Apply dataDir override to config if provided
		if (overrides.dataDir) {
			config = { ...config, dataDir: overrides.dataDir };
		}
	} else {
		// Production: three-phase boot for household migration
		// Phase 1: Transitional load
		const { runHouseholdMigration } = await import('./services/household/migration.js');
		const transitionalConfig = await loadSystemConfig({
			mode: 'transitional',
			configPath: overrides.configPath,
		});
		configPath = overrides.configPath ?? resolve('config', 'pas.yaml');
		const needsMigration = !!transitionalConfig.migrationNeeded;

		if (needsMigration) {
			await runHouseholdMigration({
				dataDir: resolve(transitionalConfig.dataDir),
				configPath,
				logger: console,
			});
		}

		// Phase 3: Strict config
		config = await loadSystemConfig({ mode: 'strict', configPath: overrides.configPath });
		// Apply dataDir override
		if (overrides.dataDir) {
			config = { ...config, dataDir: overrides.dataDir };
		}
	}

	const logger =
		overrides.logger ??
		(await createLogger({
			level: config.logLevel,
			dataDir: config.dataDir,
			pretty: process.env.NODE_ENV !== 'production',
		}));

	logger.info('PAS starting...');

	// Phase A continued: Shutdown manager + global error handlers.
	// Global error handlers are only installed in production (no overrides). In
	// test mode each composeRuntime() call would otherwise stack additive
	// uncaughtException / unhandledRejection listeners on process — the same
	// class of global-side-effect problem that the signal-handler split fixed.
	// bootstrap.ts:main() calls registerGlobalErrorHandlers() after composeRuntime().
	const shutdownManager = new ShutdownManager({ logger });
	if (!hasOverrides) {
		registerGlobalErrorHandlers(logger, (signal) => shutdownManager.shutdown(signal));
	}

	// Shared infrastructure
	const changeLog = new ChangeLog(config.dataDir);
	const eventBus = new EventBusServiceImpl(createChildLogger(logger, { service: 'event-bus' }));

	// -------------------------------------------------------------------------
	// Phase B: ALL service construction
	// -------------------------------------------------------------------------

	// 3. Provider registry, model selector, catalog, LLM service
	const llmConfig = config.llm;
	const costTracker = new CostTracker(
		config.dataDir,
		createChildLogger(logger, { service: 'cost-tracker' }),
	);

	// Create provider registry — use override if provided, otherwise instantiate from config
	let providerRegistry: ProviderRegistry;
	if (overrides.providerRegistry) {
		providerRegistry = overrides.providerRegistry;
	} else {
		providerRegistry = new ProviderRegistry(
			createChildLogger(logger, { service: 'provider-registry' }),
		);
		if (llmConfig) {
			for (const [id, providerConfig] of Object.entries(llmConfig.providers)) {
				const provider = createProvider(
					id,
					providerConfig,
					createChildLogger(logger, { service: `provider-${id}` }),
					costTracker,
				);
				if (provider) {
					providerRegistry.register(provider);
				}
			}
		}
	}

	if (providerRegistry.size === 0) {
		logger.warn('No LLM providers registered — LLM calls will fail');
	}

	const modelSelector = new ModelSelector({
		dataDir: config.dataDir,
		defaultStandard: llmConfig?.tiers?.standard ?? {
			provider: 'anthropic',
			model: config.claude.model,
		},
		defaultFast: llmConfig?.tiers?.fast ?? {
			provider: 'anthropic',
			model: config.claude.fastModel ?? 'claude-haiku-4-5-20251001',
		},
		defaultReasoning: llmConfig?.tiers?.reasoning,
		logger: createChildLogger(logger, { service: 'model-selector' }),
	});
	await modelSelector.load();
	// Reconcile saved tier selections against registered providers (F12 fix).
	modelSelector.reconcile(new Set(providerRegistry.getProviderIds()));

	const modelCatalog = new ModelCatalog({
		apiKey: config.claude.apiKey,
		logger: createChildLogger(logger, { service: 'model-catalog' }),
		providerRegistry,
	});

	const llm = new LLMServiceImpl({
		registry: providerRegistry,
		modelSelector,
		costTracker,
		logger: createChildLogger(logger, { service: 'llm' }),
	});

	const guardPriceLookup: PriceLookup = {
		priceFor: (tier) => {
			const ref = modelSelector.getTierRef(tier);
			if (!ref) {
				return undefined;
			}

			const providerType = providerRegistry.get(ref.provider)?.providerType;
			if (providerType === 'ollama') {
				return { inputUsdPer1k: 0, outputUsdPer1k: 0 };
			}

			const pricing = getModelPricing(ref.model) ?? (providerType ? DEFAULT_REMOTE_PRICING : null);
			if (!pricing) {
				return undefined;
			}

			return {
				inputUsdPer1k: pricing.input / 1000,
				outputUsdPer1k: pricing.output / 1000,
			};
		},
	};

	// Load monthly cost cache for LLMGuard enforcement
	await costTracker.loadMonthlyCache();

	// Shared household-wide LLM limiter — one instance, injected into every guard
	const safeguardsConfig = config.llm?.safeguards ?? DEFAULT_LLM_SAFEGUARDS;
	const householdLimiter = new HouseholdLLMLimiter({
		costTracker,
		config: safeguardsConfig,
		logger: createChildLogger(logger, { service: 'household-llm-limiter' }),
	});

	// System-level LLM guard for infrastructure calls (D3 fix)
	const systemLlm = new SystemLLMGuard({
		inner: llm,
		costTracker,
		globalMonthlyCostCap:
			safeguardsConfig.globalMonthlyCostCap ?? DEFAULT_LLM_SAFEGUARDS.globalMonthlyCostCap,
		logger: createChildLogger(logger, { service: 'system-llm-guard' }),
		householdLimiter,
		priceLookup: guardPriceLookup,
		tier: 'fast',
	});

	// API-level LLM guard — same global cap but attributes costs to 'api' (F14 fix)
	const apiLlm = new SystemLLMGuard({
		inner: llm,
		costTracker,
		globalMonthlyCostCap:
			safeguardsConfig.globalMonthlyCostCap ?? DEFAULT_LLM_SAFEGUARDS.globalMonthlyCostCap,
		logger: createChildLogger(logger, { service: 'api-llm-guard' }),
		attributionId: 'api',
		householdLimiter,
		priceLookup: guardPriceLookup,
		tier: 'fast',
	});

	// 4. Scheduler
	const scheduler = new SchedulerServiceImpl({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'scheduler' }),
		timezone: config.timezone,
	});

	// 5. Audio, Daily Diff
	const audio = new AudioServiceImpl({
		logger: createChildLogger(logger, { service: 'audio' }),
		defaultDevice: process.env.CHROMECAST_DEVICE,
	});

	const dailyDiff = new DailyDiffService({
		dataDir: config.dataDir,
		changeLog,
		llm: systemLlm,
		logger: createChildLogger(logger, { service: 'daily-diff' }),
		enableSummarization: process.env.DAILY_DIFF_SUMMARIZE === 'true',
	});

	// 6. Telegram Bot + Service
	let telegramService: TelegramService & { cleanup(): void | Promise<void> };
	let bot: Bot;

	if (overrides.telegramService) {
		telegramService = overrides.telegramService;
		// Create a minimal bot stub so server/route registration has a reference
		bot = createBot({
			token: config.telegram.botToken,
			logger: createChildLogger(logger, { service: 'telegram-bot' }),
		});
	} else {
		bot = createBot({
			token: config.telegram.botToken,
			logger: createChildLogger(logger, { service: 'telegram-bot' }),
		});
		telegramService = new TelegramServiceImpl({
			bot,
			logger: createChildLogger(logger, { service: 'telegram' }),
		});
	}

	// 8. App Toggle Store (per-user app enable/disable overrides)
	const appToggle = new AppToggleStore({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'app-toggle' }),
	});

	// 8b. User Manager + Guard
	const userManager = new UserManager({
		config,
		appToggle,
		logger: createChildLogger(logger, { service: 'user-manager' }),
	});

	// 8b-cred. Credential Service
	const credentialService = new CredentialService({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'credentials' }),
	});

	// 8b-hh. Household Service — tenant boundary enforcement
	const householdService = new HouseholdService({
		dataDir: config.dataDir,
		users: config.users,
		logger: createChildLogger(logger, { service: 'household' }),
	});
	await householdService.init();

	// 5b. Context Store — household-aware
	const contextStore = new ContextStoreServiceImpl({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'context-store' }),
		householdService,
	});

	// 7b. Fallback handler — household-aware
	const fallback = new FallbackHandler({
		dataDir: config.dataDir,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'fallback' }),
		householdService,
	});

	const inviteService = new InviteService({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'invite' }),
	});
	await inviteService.cleanup();

	const userMutationService = new UserMutationService({
		userManager,
		configPath,
		householdService,
		logger: createChildLogger(logger, { service: 'user-mutation' }),
	});

	const userGuard = new UserGuard({
		userManager,
		telegram: telegramService,
		logger: createChildLogger(logger, { service: 'user-guard' }),
		inviteService,
		userMutationService,
		dataDir: config.dataDir,
	});

	// 8b2. Space service (shared data spaces with membership)
	const spaceService = new SpaceService({
		dataDir: config.dataDir,
		userManager,
		logger: createChildLogger(logger, { service: 'spaces' }),
		householdService,
	});
	await spaceService.init();

	// 8b3. n8n dispatch (optional)
	const n8nDispatcher = new N8nDispatcherImpl({
		dispatchUrl: config.n8n.dispatchUrl,
		logger: createChildLogger(logger, { service: 'n8n-dispatch' }),
	});
	if (n8nDispatcher.enabled) {
		logger.info({ url: config.n8n.dispatchUrl }, 'n8n dispatch mode enabled');
	}

	// 8c. Report service
	const reportService = new ReportService({
		dataDir: config.dataDir,
		changeLog,
		contextStore,
		llm: systemLlm,
		telegram: telegramService,
		userManager,
		cronManager: scheduler.cron,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'reports' }),
		eventBus,
		n8nDispatcher,
		householdService,
		spaceService,
	});

	// 8d. Alert service
	const alertService = new AlertService({
		dataDir: config.dataDir,
		llm: systemLlm,
		telegram: telegramService,
		userManager,
		cronManager: scheduler.cron,
		reportService,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'alerts' }),
		eventBus,
		n8nDispatcher,
		audioService: audio,
		householdService,
		spaceService,
	});

	// 8e. Rate limiters
	const telegramRateLimiter = createTelegramRateLimiter();
	const loginRateLimiter = createLoginRateLimiter();

	// 9. App Registry — discovers, loads, and initializes all apps
	const appsDir = overrides.appsDir ?? join(_repoRoot, 'apps');
	const registry = new AppRegistry({
		appsDir,
		config,
		logger: createChildLogger(logger, { service: 'app-registry' }),
	});

	// 9a. App metadata + knowledge base (created before loadAll, read lazily)
	const appMetadata = new AppMetadataServiceImpl({
		registry,
		appToggle,
		config,
	});

	const appKnowledge = new AppKnowledgeBase({
		registry,
		appToggle,
		config,
		infraDocsDir: join(_repoRoot, 'core/docs/help'),
		logger: createChildLogger(logger, { service: 'app-knowledge' }),
	});

	// 9b. Model journal — persistent file the AI model can write to
	const modelJournal = new ModelJournalServiceImpl({
		dataDir: config.dataDir,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'model-journal' }),
	});

	// 9c. System info service
	const systemInfoService = new SystemInfoServiceImpl({
		modelSelector,
		providerRegistry,
		modelCatalog,
		costTracker,
		cronManager: scheduler.cron,
		userManager,
		appRegistry: registry,
		safeguards: safeguardsConfig,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'system-info' }),
	});

	// Per-app LLM guards — collected for shutdown cleanup
	const llmGuards: LLMGuard[] = [];

	// Safeguard defaults from config (or DEFAULT_LLM_SAFEGUARDS)
	const defaultMaxRequests =
		safeguardsConfig.defaultRateLimit?.maxRequests ??
		DEFAULT_LLM_SAFEGUARDS.defaultRateLimit.maxRequests;
	const defaultWindowSeconds =
		safeguardsConfig.defaultRateLimit?.windowSeconds ??
		DEFAULT_LLM_SAFEGUARDS.defaultRateLimit.windowSeconds;
	const defaultMonthlyCostCap =
		safeguardsConfig.defaultMonthlyCostCap ?? DEFAULT_LLM_SAFEGUARDS.defaultMonthlyCostCap;
	const globalMonthlyCostCap =
		safeguardsConfig.globalMonthlyCostCap ?? DEFAULT_LLM_SAFEGUARDS.globalMonthlyCostCap;

	// D2b: Lazy facade for DataQueryService.
	// biome-ignore lint/style/useConst: reassigned after registry.loadAll() at line ~780
	let dataQueryServiceImpl: DataQueryServiceImpl | undefined;

	// D2c: Lazy facade for EditService.
	// biome-ignore lint/style/useConst: reassigned after registry.loadAll() at line ~790
	let editServiceImpl: EditServiceImpl | undefined;

	// D2c: InteractionContextService
	const interactionContextService = new InteractionContextServiceImpl({
		dataDir: config.dataDir,
		logger: logger.child({ service: 'interaction-context' }),
	});
	await interactionContextService.loadFromDisk();

	// Shared LLM guard for all chatbot/conversation paths — one guard = one shared
	// rate-limiter so /ask, /edit, and free-text all share the 60-req/hr cap.
	const conversationLLMGuard = new LLMGuard({
		inner: llm,
		appId: 'chatbot',
		costTracker,
		config: {
			maxRequests: CONVERSATION_LLM_SAFEGUARDS.rate_limit.max_requests,
			windowSeconds: CONVERSATION_LLM_SAFEGUARDS.rate_limit.window_seconds,
			monthlyCostCap: CONVERSATION_LLM_SAFEGUARDS.monthly_cost_cap,
			globalMonthlyCostCap,
		},
		logger: createChildLogger(logger, { service: 'llm-guard:chatbot' }),
		householdLimiter,
		priceLookup: guardPriceLookup,
		tier: CONVERSATION_LLM_SAFEGUARDS.tier,
	});
	llmGuards.push(conversationLLMGuard);

	// Service factory: creates scoped CoreServices per app
	const serviceFactory: ServiceFactory = (manifest, _appDir) => {
		const declaredServices = new Set(manifest.requirements?.services ?? []);
		const appId = manifest.app.id;
		const appLogger = createChildLogger(logger, { appId });

		const dataStore = new DataStoreServiceImpl({
			dataDir: config.dataDir,
			appId,
			userScopes: manifest.requirements?.data?.user_scopes ?? [],
			sharedScopes: manifest.requirements?.data?.shared_scopes ?? [],
			changeLog,
			spaceService,
			eventBus,
			householdService,
		});

		const appConfig = new AppConfigServiceImpl({
			dataDir: config.dataDir,
			appId,
			defaults: manifest.user_config ?? [],
		});

		// Create guarded LLM service for apps that declare it
		const needsLlm =
			declaredServices.has('llm') ||
			declaredServices.has('llm:ollama') ||
			declaredServices.has('llm:claude');

		let appLlm: LLMGuard | undefined;
		if (needsLlm) {
			if (appId === 'chatbot') {
				// Reuse the shared guard so /ask, /edit, and free-text share one rate-limiter
				appLlm = conversationLLMGuard;
			} else {
				const manifestLlm = manifest.requirements?.llm;
				const guard = new LLMGuard({
					inner: llm,
					appId,
					costTracker,
					config: {
						maxRequests: manifestLlm?.rate_limit?.max_requests ?? defaultMaxRequests,
						windowSeconds: manifestLlm?.rate_limit?.window_seconds ?? defaultWindowSeconds,
						monthlyCostCap: manifestLlm?.monthly_cost_cap ?? defaultMonthlyCostCap,
						globalMonthlyCostCap,
					},
					logger: appLogger,
					householdLimiter,
					priceLookup: guardPriceLookup,
					tier: manifestLlm?.tier ?? 'fast',
				});
				llmGuards.push(guard);
				appLlm = guard;
			}
		}

		// Build secrets from manifest external_apis declarations
		const externalApis = manifest.requirements?.external_apis ?? [];
		const secretValues = new Map<string, string>();
		for (const api of externalApis) {
			const value = process.env[api.env_var];
			if (value) {
				secretValues.set(api.id, value);
			} else if (api.required) {
				appLogger.warn('Required external API "%s" is missing env var %s', api.id, api.env_var);
			}
		}
		const secrets = new SecretsServiceImpl({ values: secretValues });

		return {
			telegram: declaredServices.has('telegram') ? telegramService : undefined,
			llm: appLlm,
			data: declaredServices.has('data-store') ? dataStore : undefined,
			scheduler: declaredServices.has('scheduler') ? scheduler : undefined,
			conditionEvaluator: declaredServices.has('condition-eval')
				? new ConditionEvaluatorServiceImpl({
						dataStore: dataStore.forUser('system'),
						llm: appLlm ?? systemLlm,
						logger: appLogger,
					})
				: undefined,
			audio: declaredServices.has('audio') ? audio : undefined,
			eventBus: declaredServices.has('event-bus') ? eventBus : undefined,
			contextStore: declaredServices.has('context-store') ? contextStore : undefined,
			appMetadata: declaredServices.has('app-metadata') ? appMetadata : undefined,
			appKnowledge: declaredServices.has('app-knowledge') ? appKnowledge : undefined,
			modelJournal: declaredServices.has('model-journal') ? modelJournal : undefined,
			systemInfo: declaredServices.has('system-info') ? systemInfoService : undefined,
			dataQuery: declaredServices.has('data-query')
				? {
						query: (q: string, uid: string, opts?: DataQueryOptions) => {
							if (!dataQueryServiceImpl) {
								logger.warn(
									'DataQueryService called before initialization — returning empty result',
								);
								return Promise.resolve({ files: [], empty: true });
							}
							return dataQueryServiceImpl.query(q, uid, opts);
						},
					}
				: undefined,
			interactionContext: declaredServices.has('interaction-context')
				? interactionContextService
				: undefined,
			editService: declaredServices.has('edit-service')
				? {
						proposeEdit: (desc: string, uid: string) => {
							if (!editServiceImpl) {
								logger.warn('EditService called before initialization — returning error');
								return Promise.resolve({
									kind: 'error' as const,
									action: 'no_match' as const,
									message: 'Edit service not yet initialized.',
								});
							}
							return editServiceImpl.proposeEdit(desc, uid);
						},
						confirmEdit: (proposal: Parameters<EditServiceImpl['confirmEdit']>[0]) => {
							if (!editServiceImpl) {
								return Promise.resolve({
									ok: false as const,
									reason: 'Edit service not yet initialized.',
								});
							}
							return editServiceImpl.confirmEdit(proposal);
						},
					}
				: undefined,
			secrets,
			config: appConfig,
			timezone: config.timezone,
			logger: appLogger,
		} as CoreServices;
	};

	await registry.loadAll(serviceFactory);

	// Virtual chatbot entry (REQ-CONV-013) — apps/chatbot/ no longer exists after D.3,
	// so the registry never has a real 'chatbot' app. Always register the virtual entry.
	const { buildVirtualChatbotApp, VIRTUAL_CHATBOT_PATH } = await import(
		'./services/conversation/virtual-app.js'
	);
	const { manifest: virtualManifest, module: virtualModule } = buildVirtualChatbotApp();
	registry.registerVirtual(virtualManifest, virtualModule, VIRTUAL_CHATBOT_PATH);

	// -------------------------------------------------------------------------
	// Phase C: App loading, late wiring, FileIndex, Router build
	// -------------------------------------------------------------------------

	// 9b. Register app cron schedules from manifests.
	for (const entry of registry.getAll()) {
		const schedules = entry.manifest.capabilities?.schedules ?? [];
		if (schedules.length > 0 && entry.module.handleScheduledJob) {
			const appModule = entry.module;
			const appId = entry.manifest.app.id;
			for (const schedule of schedules) {
				scheduler.cron.register(
					{
						id: schedule.id,
						appId,
						cron: schedule.cron,
						handler: schedule.handler,
						description: schedule.description,
						userScope: schedule.user_scope,
					},
					() =>
						buildScheduledJobHandler({
							appId,
							jobId: schedule.id,
							userScope: schedule.user_scope,
							appModule,
							userProvider: userManager,
							householdService,
							logger: createChildLogger(logger, {
								service: 'scheduled-job',
								appId,
							}),
						}),
				);
			}
			logger.info(
				{ appId, count: schedules.length },
				'Registered %d app cron schedule(s)',
				schedules.length,
			);
		}
	}

	// 9b-ii. Wire one-off task handler resolver (F31)
	scheduler.oneOff.setHandlerResolver((appId, _handler, jobId) => {
		const entry = registry.getApp(appId);
		if (!entry?.module.handleScheduledJob) {
			throw new Error(`App "${appId}" not found or has no handleScheduledJob`);
		}
		return buildScheduledJobHandler({
			appId,
			jobId,
			userScope: 'system',
			appModule: entry.module,
			userProvider: userManager,
			householdService,
			logger: createChildLogger(logger, { service: 'scheduled-job', appId }),
		});
	});

	// 9b-iii. Wire job failure notifications (F33)
	const adminUser = userManager.getAllUsers().find((u) => u.isAdmin);
	if (adminUser) {
		const jobFailureNotifier = new JobFailureNotifier({
			logger: createChildLogger(logger, { service: 'job-failure-notifier' }),
			sender: telegramService,
			adminChatId: adminUser.id,
			persistPath: join(config.dataDir, 'system', 'disabled-jobs.yaml'),
		});
		scheduler.setNotifier(jobFailureNotifier);
	} else {
		logger.warn('No admin user found — job failure notifications disabled');
	}

	// 9c. Index app documentation after all apps are loaded
	await appKnowledge.init();

	// 9c-ii. File index — metadata-based graph over all data files
	const appScopes = new Map<string, { user: ManifestDataScope[]; shared: ManifestDataScope[] }>();
	for (const app of registry.getAll()) {
		const data = app.manifest.requirements?.data;
		appScopes.set(app.manifest.app.id, {
			user: data?.user_scopes ?? [],
			shared: data?.shared_scopes ?? [],
		});
	}
	const fileIndex = new FileIndexService(config.dataDir, appScopes, (path, err) => {
		logger.warn({ path, err }, 'FileIndexService: skipped file during indexing');
	});
	await fileIndex.rebuild();

	logger.info({ count: fileIndex.size }, 'FileIndexService: initial index built');

	const onDataChanged = (payload: unknown) => {
		fileIndex.handleDataChanged(payload as DataChangedPayload).catch((err) => {
			logger.warn({ err }, 'FileIndexService: failed to handle data:changed');
		});
	};
	eventBus.on('data:changed', onDataChanged);

	// D2b: Initialize DataQueryService now that FileIndexService is ready.
	dataQueryServiceImpl = new DataQueryServiceImpl({
		fileIndex,
		spaceService,
		llm: systemLlm,
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'data-query' }),
	});
	logger.info('DataQueryService: initialized');

	// Shared adapter — avoids duplicating the null-guard wrapper at each call site.
	const dataQueryAdapter = dataQueryServiceImpl
		? {
				query: (q: string, uid: string, opts?: DataQueryOptions) =>
					dataQueryServiceImpl.query(q, uid, opts),
			}
		: undefined;

	// D2c: EditService
	editServiceImpl = new EditServiceImpl({
		dataQueryService: dataQueryServiceImpl,
		appRegistry: registry,
		llm: systemLlm,
		changeLog,
		eventBus,
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'edit-service' }),
		editLog: new EditLog(join(config.dataDir, 'system', 'edit-log.jsonl')),
		interactionContext: interactionContextService,
	});
	logger.info('EditService: initialized');

	// 9d. Vault service — per-user Obsidian vault directories with symlinks
	const vaultService = new VaultService({
		dataDir: config.dataDir,
		spaceService,
		userManager,
		householdService,
		logger: createChildLogger(logger, { service: 'vault' }),
	});
	spaceService.setVaultService(vaultService);
	await vaultService.rebuildAll();

	// 9c-pre. ConversationRetrievalService — wired here (Chunk A), handlers use it in Chunk D.
	const conversationRetrievalService = new ConversationRetrievalServiceImpl({
		dataQuery: dataQueryAdapter,
		contextStore,
		interactionContext: interactionContextService,
		appMetadata,
		appKnowledge,
		systemInfo: systemInfoService,
		reportService,
		alertService,
		logger: createChildLogger(logger, { service: 'conversation-retrieval' }),
	});
	logger.info('ConversationRetrievalService: initialized');

	// 9c. ConversationService — always present; provides free-text fallback dispatch.
	const conversationDataStore = new DataStoreServiceImpl({
		dataDir: config.dataDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog,
		spaceService,
		eventBus,
		householdService,
	});

	const conversationAppConfig = new AppConfigServiceImpl({
		dataDir: config.dataDir,
		appId: 'chatbot',
		defaults: CONVERSATION_USER_CONFIG,
	});

	const chatSessions = composeChatSessionStore({
		data: conversationDataStore,
		logger: createChildLogger(logger, { service: 'conversation-session' }),
	});

	const conversationService = new ConversationService({
		llm: conversationLLMGuard,
		telegram: telegramService,
		data: conversationDataStore,
		logger: createChildLogger(logger, { service: 'conversation' }),
		timezone: config.timezone,
		chatSessions,
		systemInfo: systemInfoService,
		appMetadata: appMetadata,
		appKnowledge: appKnowledge,
		modelJournal: modelJournal,
		contextStore: contextStore,
		config: conversationAppConfig,
		dataQuery: dataQueryAdapter,
		interactionContext: interactionContextService,
		editService: editServiceImpl ?? undefined,
		chatLogToNotesDefault: config.chat?.logToNotes ?? false,
		conversationRetrieval: conversationRetrievalService,
	});
	logger.info('ConversationService: initialized');

	// 9b. Route verification (optional)
	let routeVerifier: RouteVerifier | undefined;
	const verificationConfig = config.routing?.verification;
	if (verificationConfig?.enabled) {
		const pendingStore = new PendingVerificationStore();
		const verificationLogger = new VerificationLogger(resolve(config.dataDir, 'system'));

		routeVerifier = new RouteVerifier({
			llm: systemLlm,
			telegram: telegramService,
			registry,
			pendingStore,
			verificationLogger,
			logger: createChildLogger(logger, { service: 'route-verifier' }),
			photoDir: resolve(config.dataDir, 'system', 'route-verification', 'photos'),
		});

		logger.info({ upperBound: verificationConfig.upperBound }, 'Route verification enabled');
	} else {
		logger.info('Route verification disabled');
	}

	// 10. Router
	const messageRateTracker = new MessageRateTracker();

	const router = new Router({
		registry,
		llm: systemLlm,
		telegram: telegramService,
		fallback,
		conversationService,
		chatSessions,
		config,
		appToggle,
		spaceService,
		userManager,
		routeVerifier,
		verificationUpperBound: verificationConfig?.upperBound,
		inviteService,
		userMutationService,
		interactionContext: interactionContextService,
		householdService,
		messageRateTracker,
		logger: createChildLogger(logger, { service: 'router' }),
	});
	router.buildRoutingTables();

	// Wire router into alert service (circular dep: AlertService created before Router)
	alertService.setRouter(router);

	// -------------------------------------------------------------------------
	// Phase D: Bot handler registrations, GUI routes, API routes
	// -------------------------------------------------------------------------

	// 11. Wire bot middleware (with user guard + rate limiting + request tracking)
	bot.on('message:text', async (ctx) => {
		await shutdownManager.trackRequest(async () => {
			const messageCtx = adaptTextMessage(ctx);
			if (!messageCtx) return;

			const wasRegisteredBefore = userManager.isRegistered(messageCtx.userId);
			if (!(await userGuard.checkUser(messageCtx.userId, messageCtx.text))) return;
			if (!wasRegisteredBefore && userManager.isRegistered(messageCtx.userId)) return;

			if (!telegramRateLimiter.isAllowed(messageCtx.userId)) {
				await telegramService.send(messageCtx.userId, 'Please slow down. Try again in a moment.');
				return;
			}

			const msgHouseholdId = householdService.getHouseholdForUser(messageCtx.userId) ?? undefined;
			await requestContext.run({ userId: messageCtx.userId, householdId: msgHouseholdId }, () =>
				router.routeMessage(messageCtx),
			);
		});
	});

	const photoLogger = createChildLogger(logger, { service: 'photo-adapter' });
	bot.on('message:photo', async (ctx) => {
		await shutdownManager.trackRequest(async () => {
			const userId = extractUserId(ctx);

			if (userId && !(await userGuard.checkUser(userId))) return;

			if (userId && !telegramRateLimiter.isAllowed(userId)) {
				await telegramService.send(userId, 'Please slow down. Try again in a moment.');
				return;
			}

			const photoCtx = await adaptPhotoMessage(ctx, photoLogger);
			if (photoCtx) {
				const photoHouseholdId = householdService.getHouseholdForUser(photoCtx.userId) ?? undefined;
				await requestContext.run({ userId: photoCtx.userId, householdId: photoHouseholdId }, () =>
					router.routePhoto(photoCtx),
				);
			} else if (ctx.message?.photo) {
				if (userId) {
					try {
						await telegramService.send(userId, 'Failed to process your photo. Please try again.');
					} catch {
						// Already logged in adaptPhotoMessage
					}
				}
			}
		});
	});

	const callbackLogger = createChildLogger(logger, { service: 'callback-router' });
	bot.on('callback_query:data', async (ctx) => {
		let answeredCallback = false;
		try {
			await shutdownManager.trackRequest(async () => {
				const userId = extractUserId(ctx);
				if (!userId) return;

				if (!(await userGuard.checkUser(userId))) return;

				const data = ctx.callbackQuery.data;
				if (!data) return;

				// Route verification callback
				if (data.startsWith('rv:') && routeVerifier) {
					const parts = data.split(':');
					const pendingId = parts[1];
					const chosenAppId = parts[2];
					if (!pendingId || !chosenAppId) return;

					const enabledApps = userManager.getUserApps(userId);
					if (!(await appToggle.isEnabled(userId, chosenAppId, enabledApps))) {
						callbackLogger.debug({ chosenAppId, userId }, 'Verification callback for disabled app');
						answeredCallback = true;
						await ctx
							.answerCallbackQuery({ text: 'You no longer have access to this app.' })
							.catch(() => {});
						return;
					}

					const resolved = await routeVerifier.resolveCallback(pendingId, chosenAppId);
					if (!resolved) return;

					const { entry } = resolved;
					const appEntry = registry.getApp(chosenAppId);

					const overrideRoute = buildUserOverrideRouteInfo(
						entry.classifierResult,
						chosenAppId,
						entry.verifierSuggestedIntent,
					);

					if (chosenAppId === 'chatbot') {
						await router.dispatchConversation(
							entry.ctx as import('./types/telegram.js').MessageContext,
							overrideRoute,
						);
					} else if (appEntry) {
						if (entry.isPhoto && appEntry.module.handlePhoto) {
							await router.dispatchPhoto(
								appEntry,
								entry.ctx as import('./types/telegram.js').PhotoContext,
								overrideRoute,
							);
						} else {
							await router.dispatchMessage(
								appEntry,
								entry.ctx as import('./types/telegram.js').MessageContext,
								overrideRoute,
							);
						}
					}
					return;
				}

				// First-run wizard callbacks
				if (data.startsWith('onboard:')) {
					const onboardHouseholdId = householdService.getHouseholdForUser(userId) ?? undefined;
					await requestContext.run({ userId, householdId: onboardHouseholdId }, async () => {
						await handleFirstRunWizardCallback(
							{ telegram: telegramService, dataDir: config.dataDir, logger: callbackLogger },
							userId,
							data,
						);
					});
					return;
				}

				// Route app-specific callback queries
				if (data.startsWith('app:')) {
					const parts = data.split(':');
					const appId = parts[1];
					const customData = parts.slice(2).join(':');
					if (!appId || !customData) return;

					const appEntry = registry.getApp(appId);
					if (!appEntry) {
						callbackLogger.warn({ appId }, 'Callback for unknown app');
						return;
					}

					const enabledApps = userManager.getUserApps(userId);
					if (!(await appToggle.isEnabled(userId, appId, enabledApps))) {
						callbackLogger.debug({ appId, userId }, 'Callback for disabled app');
						return;
					}

					if (appEntry.module.handleCallbackQuery) {
						const callbackCtx = {
							userId,
							chatId: ctx.callbackQuery.message?.chat.id ?? 0,
							messageId: ctx.callbackQuery.message?.message_id ?? 0,
						};
						const handler = appEntry.module.handleCallbackQuery;
						const appCbHouseholdId = householdService.getHouseholdForUser(userId) ?? undefined;
						await requestContext.run({ userId, householdId: appCbHouseholdId }, () =>
							handler(customData, callbackCtx),
						);
					}
					return;
				}

				// Default: sendOptions callback handling
				// handleCallbackQuery is a concrete method on TelegramServiceImpl, not in the interface
				(telegramService as TelegramServiceImpl).handleCallbackQuery?.(userId, data);
			});
		} finally {
			if (!answeredCallback) {
				await ctx.answerCallbackQuery().catch(() => {});
			}
		}
	});

	// 12. Fastify Server
	const server = await createServer({
		logger: createChildLogger(logger, { service: 'http' }),
		cookieSecret: config.gui.authToken,
		trustProxy: process.env.TRUST_PROXY === 'true',
	});

	// Derive webhook secret from bot token
	const webhookSecret =
		process.env.TELEGRAM_WEBHOOK_SECRET ||
		createHash('sha256')
			.update(`pas-webhook:${config.telegram.botToken}`)
			.digest('hex')
			.slice(0, 64);

	const webhookCallback = createWebhookCallback(bot);
	const healthChecker = new HealthChecker({
		telegram: { getMe: () => bot.api.getMe() },
		scheduler: { isRunning: () => scheduler.isRunning() },
		providerRegistry,
		dataDir: config.dataDir,
		logger,
	});
	registerHealthRoute(server, healthChecker);
	registerWebhookRoute(server, {
		webhookCallback,
		webhookSecret,
		logger: createChildLogger(logger, { service: 'webhook' }),
	});

	// 13. Management GUI
	await registerGuiRoutes(server, {
		registry,
		scheduler,
		llm,
		config,
		appToggle,
		modelSelector,
		modelCatalog,
		providerRegistry,
		reportService,
		alertService,
		userManager,
		contextStore,
		spaceService,
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'gui' }),
		loginRateLimiter,
		userMutationService,
		householdService,
		credentialService,
		costTracker,
		messageRateTracker,
		llmSafeguards: safeguardsConfig,
	});

	// 13b. External Data API (optional)
	let apiRateLimiter: ReturnType<typeof createApiRateLimiter> | undefined;
	if (config.api.token) {
		apiRateLimiter = createApiRateLimiter();
		await registerApiRoutes(server, {
			apiToken: config.api.token,
			rateLimiter: apiRateLimiter,
			dataDir: config.dataDir,
			changeLog,
			spaceService,
			userManager,
			router,
			cronManager: scheduler.cron,
			timezone: config.timezone,
			logger: createChildLogger(logger, { service: 'api' }),
			eventBus,
			reportService,
			alertService,
			telegram: telegramService,
			llm: apiLlm,
			householdService,
		});
	} else {
		logger.info('API routes disabled (API_TOKEN not set)');
	}

	// 13c. Outbound webhooks (optional)
	let webhookService: WebhookService | undefined;
	if (config.webhooks.length > 0) {
		webhookService = new WebhookService({
			webhooks: config.webhooks,
			eventBus,
			logger: createChildLogger(logger, { service: 'webhooks' }),
		});
		logger.info({ count: config.webhooks.length }, 'Outbound webhooks configured');
	}

	// 16b. Validate user config against loaded apps
	const configWarnings = userManager.validateConfig(registry.getLoadedAppIds());
	for (const warning of configWarnings) {
		logger.warn({ warning }, 'Config validation warning');
	}

	// -------------------------------------------------------------------------
	// Wire ShutdownServices so dispose() has everything it needs
	// -------------------------------------------------------------------------

	const webhookUrl = process.env.WEBHOOK_URL;

	shutdownManager.registerServices({
		scheduler,
		telegram: telegramService,
		registry,
		eventBus,
		server,
		rateLimiters: [
			telegramRateLimiter,
			loginRateLimiter,
			...(apiRateLimiter ? [apiRateLimiter] : []),
		],
		// In polling mode, bot needs to be stopped on shutdown
		bot: webhookUrl ? undefined : bot,
		onShutdown: [
			// Dispose per-app LLM guard rate limiters
			...llmGuards.map((g) => () => g.dispose()),
			// Dispose shared household LLM limiter
			() => householdLimiter.dispose(),
			// Dispose message rate tracker cleanup timer
			() => messageRateTracker.dispose(),
			// Flush monthly cost cache to disk
			() => costTracker.flush(),
			// Dispose webhook service event subscriptions
			...(webhookService ? [() => webhookService.dispose()] : []),
			// Unsubscribe FileIndexService from data:changed events
			() => eventBus.off('data:changed', onDataChanged),
			// Flush interaction context to disk and drain write queue
			() => interactionContextService.stop(),
		],
	});

	// Build dispose() with idempotent guard
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await shutdownManager.performTeardown();
	};

	const services: RuntimeServices = {
		config,
		router,
		householdService,
		costTracker,
		householdLimiter,
		systemLlm,
		apiLlm,
		scheduler,
		telegram: telegramService,
		registry,
		reportService,
		alertService,
		fileIndex,
		vault: vaultService,
		userManager,
		spaceService,
		interactionContext: interactionContextService,
		contextStore,
		fallback,
		webhookService,
		telegramRateLimiter,
		loginRateLimiter,
		apiRateLimiter,
		dailyDiff,
		backupService: undefined,
		n8nDispatcher,
		changeLog,
		eventBus,
		modelSelector,
		modelCatalog,
		llm,
		providerRegistry,
		safeguardsConfig,
	};

	return {
		services,
		bot,
		server,
		shutdownManager,
		logger,
		dispose,
	};
}
