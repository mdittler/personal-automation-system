/**
 * Bootstrap — the composition root.
 *
 * Creates all services in dependency order, loads apps, wires the
 * bot middleware, starts the server, and registers graceful shutdown.
 * This is the main entry point for the PAS system.
 */

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { registerApiRoutes } from './api/index.js';
import { registerGuiRoutes } from './gui/index.js';
import { registerGlobalErrorHandlers } from './middleware/error-handler.js';
import { HouseholdService } from './services/household/index.js';
import { runHouseholdMigration } from './services/household/migration.js';
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
import { loadSystemConfig } from './services/config/index.js';
import { ContextStoreServiceImpl } from './services/context-store/index.js';
import { DailyDiffService } from './services/daily-diff/index.js';
import { ChangeLog } from './services/data-store/change-log.js';
import { DataStoreServiceImpl } from './services/data-store/index.js';
import { EventBusServiceImpl } from './services/event-bus/index.js';
import { InviteService } from './services/invite/index.js';
import { CostTracker } from './services/llm/cost-tracker.js';
import { LLMServiceImpl } from './services/llm/index.js';
import { requestContext } from './services/context/request-context.js';
import { LLMGuard } from './services/llm/llm-guard.js';
import { ModelCatalog } from './services/llm/model-catalog.js';
import { ModelSelector } from './services/llm/model-selector.js';
import { createProvider } from './services/llm/providers/provider-factory.js';
import { ProviderRegistry } from './services/llm/providers/provider-registry.js';
import { SystemLLMGuard } from './services/llm/system-llm-guard.js';
import { createChildLogger, createLogger } from './services/logger/index.js';
import { ModelJournalServiceImpl } from './services/model-journal/index.js';
import { N8nDispatcherImpl } from './services/n8n/index.js';
import { ReportService } from './services/reports/index.js';
import { FallbackHandler } from './services/router/fallback.js';
import { buildUserOverrideRouteInfo, Router } from './services/router/index.js';
import { PendingVerificationStore } from './services/router/pending-verification-store.js';
import { RouteVerifier } from './services/router/route-verifier.js';
import { VerificationLogger } from './services/router/verification-logger.js';
import { JobFailureNotifier } from './services/scheduler/job-failure-notifier.js';
import { SchedulerServiceImpl } from './services/scheduler/index.js';
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
import { FileIndexService } from './services/file-index/index.js';
import { DataQueryServiceImpl } from './services/data-query/index.js';
import type { DataQueryOptions } from './types/data-query.js';
import { InteractionContextServiceImpl } from './services/interaction-context/index.js';
import { EditServiceImpl, EditLog } from './services/edit/index.js';
import { VaultService } from './services/vault/index.js';
import { WebhookService } from './services/webhooks/index.js';
import type { CoreServices } from './types/app-module.js';
import type { DataChangedPayload } from './types/data-events.js';
import type { ManifestDataScope } from './types/manifest.js';

export async function main(): Promise<void> {
	// 1. Config + Logger — three-phase boot for household migration
	//
	// Phase 1: Transitional load — accepts users without householdId.
	//   Sets config.migrationNeeded = true if any user is missing householdId.
	// Phase 2: Migration — if needed, moves data/ → data/households/default/ and
	//   rewrites pas.yaml. On failure, startup is aborted (error propagates).
	// Phase 3: Strict load — every user MUST have a householdId. This is the
	//   config that feeds all subsequent services.

	const transitionalConfig = await loadSystemConfig({ mode: 'transitional' });
	const configPath = resolve('config', 'pas.yaml');
	const migrationRan = !!transitionalConfig.migrationNeeded;

	if (migrationRan) {
		// Phase 2: Run migration (fail-fast on error).
		// Logger not yet constructed — use console so migration progress is visible.
		// biome-ignore lint/suspicious/noConsole: logger not available during migration
		await runHouseholdMigration({
			dataDir: resolve(transitionalConfig.dataDir),
			configPath,
			// biome-ignore lint/suspicious/noConsole: logger not available during migration
			logger: console,
		});
	}

	// Phase 3: Strict config — all users must have householdId after migration
	const config = await loadSystemConfig({ mode: 'strict' });
	const logger = await createLogger({
		level: config.logLevel,
		dataDir: config.dataDir,
		pretty: process.env.NODE_ENV !== 'production',
	});

	logger.info('PAS starting...');

	// 1b. Shutdown manager + global error handlers
	const shutdownManager = new ShutdownManager({ logger });
	registerGlobalErrorHandlers(logger, (signal) => shutdownManager.shutdown(signal));

	// 2. Shared infrastructure
	const changeLog = new ChangeLog(config.dataDir);
	const eventBus = new EventBusServiceImpl(createChildLogger(logger, { service: 'event-bus' }));

	// 3. Provider registry, model selector, catalog, LLM service
	const llmConfig = config.llm;
	const costTracker = new CostTracker(
		config.dataDir,
		createChildLogger(logger, { service: 'cost-tracker' }),
	);

	// Create provider registry and instantiate providers from config
	const providerRegistry = new ProviderRegistry(
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
	// Note: providerRegistry.getProviderIds() contains only providers where createProvider()
	// succeeded — this is the correct availability set. F11's getAvailableProviderIds() is a
	// pre-flight credential check; some configured providers may still fail to instantiate
	// (e.g. wrong type string), so the registry set is authoritative here.
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

	// Load monthly cost cache for LLMGuard enforcement
	await costTracker.loadMonthlyCache();

	// System-level LLM guard for infrastructure calls (D3 fix)
	const systemLlm = new SystemLLMGuard({
		inner: llm,
		costTracker,
		globalMonthlyCostCap: config.llm?.safeguards?.globalMonthlyCostCap ?? 50.0,
		logger: createChildLogger(logger, { service: 'system-llm-guard' }),
	});

	// API-level LLM guard — same global cap but attributes costs to 'api' (F14 fix)
	const apiLlm = new SystemLLMGuard({
		inner: llm,
		costTracker,
		globalMonthlyCostCap: config.llm?.safeguards?.globalMonthlyCostCap ?? 50.0,
		logger: createChildLogger(logger, { service: 'api-llm-guard' }),
		attributionId: 'api',
	});

	// 4. Scheduler
	const scheduler = new SchedulerServiceImpl({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'scheduler' }),
		timezone: config.timezone,
	});

	// 5. Context Store, Audio, Daily Diff
	const contextStore = new ContextStoreServiceImpl({
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'context-store' }),
	});

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
	const bot = createBot({
		token: config.telegram.botToken,
		logger: createChildLogger(logger, { service: 'telegram-bot' }),
	});

	const telegramService = new TelegramServiceImpl({
		bot,
		logger: createChildLogger(logger, { service: 'telegram' }),
	});

	// 7. Fallback handler
	const fallback = new FallbackHandler({
		dataDir: config.dataDir,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'fallback' }),
	});

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

	// 8b-hh. Household Service — tenant boundary enforcement
	// Initialized from the strict config (all users have householdId after migration).
	const householdService = new HouseholdService({
		dataDir: config.dataDir,
		users: config.users,
		logger: createChildLogger(logger, { service: 'household' }),
	});
	await householdService.init();

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
	});

	// 8b2. Space service (shared data spaces with membership)
	const spaceService = new SpaceService({
		dataDir: config.dataDir,
		userManager,
		logger: createChildLogger(logger, { service: 'spaces' }),
	});
	await spaceService.init();

	// 8b3. n8n dispatch (optional — dispatches execution to n8n when configured)
	const n8nDispatcher = new N8nDispatcherImpl({
		dispatchUrl: config.n8n.dispatchUrl,
		logger: createChildLogger(logger, { service: 'n8n-dispatch' }),
	});
	if (n8nDispatcher.enabled) {
		logger.info({ url: config.n8n.dispatchUrl }, 'n8n dispatch mode enabled');
	}

	// 8c. Report service (needs telegram + userManager + scheduler)
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
	});

	// 8d. Alert service (needs telegram + userManager + scheduler + reportService + eventBus + audio)
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
	});

	// 8e. Rate limiters
	const telegramRateLimiter = createTelegramRateLimiter();
	telegramRateLimiter.startCleanup();

	const loginRateLimiter = createLoginRateLimiter();
	loginRateLimiter.startCleanup();

	// 9. App Registry — discovers, loads, and initializes all apps
	const appsDir = resolve('apps');
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
		infraDocsDir: resolve('core/docs/help'),
		logger: createChildLogger(logger, { service: 'app-knowledge' }),
	});

	// 9b. Model journal — persistent file the AI model can write to
	const modelJournal = new ModelJournalServiceImpl({
		dataDir: config.dataDir,
		timezone: config.timezone,
		logger: createChildLogger(logger, { service: 'model-journal' }),
	});

	// 9c. System info service — read-only introspection for chatbot /ask
	const systemInfoService = new SystemInfoServiceImpl({
		modelSelector,
		providerRegistry,
		modelCatalog,
		costTracker,
		cronManager: scheduler.cron,
		userManager,
		appRegistry: registry,
		safeguards: config.llm?.safeguards ?? {
			defaultRateLimit: { maxRequests: 60, windowSeconds: 3600 },
			defaultMonthlyCostCap: 10.0,
			globalMonthlyCostCap: 50.0,
		},
		timezone: config.timezone,
		fallbackMode: config.fallback ?? 'chatbot',
		logger: createChildLogger(logger, { service: 'system-info' }),
	});

	// Per-app LLM guards — collected for shutdown cleanup
	const llmGuards: LLMGuard[] = [];

	// Safeguard defaults from config (or hardcoded fallbacks)
	const safeguards = config.llm?.safeguards;
	const defaultMaxRequests = safeguards?.defaultRateLimit.maxRequests ?? 60;
	const defaultWindowSeconds = safeguards?.defaultRateLimit.windowSeconds ?? 3600;
	const defaultMonthlyCostCap = safeguards?.defaultMonthlyCostCap ?? 10.0;
	const globalMonthlyCostCap = safeguards?.globalMonthlyCostCap ?? 50.0;

	// D2b: Lazy facade for DataQueryService.
	// serviceFactory runs during registry.loadAll() — before FileIndexService is instantiated.
	// Apps that declare 'data-query' get a facade that delegates to the real service once
	// it is initialized (after loadAll completes). Safe because apps only call services
	// during message handling, not during init().
	let dataQueryServiceImpl: DataQueryServiceImpl | undefined;

	// D2c: Lazy facade for EditService.
	// Same pattern as DataQueryService — EditService depends on DataQueryServiceImpl and
	// FileIndexService, both of which are initialized after registry.loadAll() completes.
	let editServiceImpl: EditServiceImpl | undefined;

	// D2c: InteractionContextService — per-user interaction tracking with disk persistence.
	// Created once and shared across all apps that declare 'interaction-context'.
	const interactionContextService = new InteractionContextServiceImpl({
		dataDir: config.dataDir,
		logger: logger.child({ service: 'interaction-context' }),
	});
	await interactionContextService.loadFromDisk();

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
			});
			llmGuards.push(guard);
			appLlm = guard;
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

		// Build CoreServices with only declared services.
		// Undeclared services are set to undefined — apps should only access
		// services they declared in manifest.requirements.services.
		return {
			telegram: declaredServices.has('telegram') ? telegramService : undefined,
			llm: appLlm,
			data: declaredServices.has('data-store') ? dataStore : undefined,
			scheduler: declaredServices.has('scheduler') ? scheduler : undefined,
			// Note: condition evaluator's data store is user-scoped ('system') with the
			// app's declared userScopes enforced. Apps that need to evaluate shared data
			// paths must use separate store access outside the condition evaluator.
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
								logger.warn('DataQueryService called before initialization — returning empty result');
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
								return Promise.resolve({ kind: 'error' as const, action: 'no_match' as const, message: 'Edit service not yet initialized.' });
							}
							return editServiceImpl.proposeEdit(desc, uid);
						},
						confirmEdit: (proposal: Parameters<EditServiceImpl['confirmEdit']>[0]) => {
							if (!editServiceImpl) {
								return Promise.resolve({ ok: false as const, reason: 'Edit service not yet initialized.' });
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

	// 9b. Register app cron schedules from manifests.
	//
	// For `user_scope: all` schedules, buildScheduledJobHandler iterates
	// the registered users and wraps each invocation in a requestContext
	// scope so that services.config.get (and any other per-request
	// infrastructure) resolves per-user within the handler body.
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
	//
	// Without this, due one-off tasks have no handler to invoke. The resolver
	// looks up the app in the registry and returns a buildScheduledJobHandler
	// for it. If the app is gone, it throws — OneOffManager will keep the task
	// pending for retry rather than silently deleting it.
	scheduler.oneOff.setHandlerResolver((appId, _handler, jobId) => {
		// _handler is the job's handler path (stored in YAML for readability),
		// but dispatch always uses appModule.handleScheduledJob(jobId) — the
		// handler path is not dynamically loaded at runtime.
		const entry = registry.getApp(appId);
		if (!entry?.module.handleScheduledJob) {
			throw new Error(`App "${appId}" not found or has no handleScheduledJob`);
		}
		return buildScheduledJobHandler({
			appId,
			jobId,
			// One-off tasks have no user_scope field in their schema; 'system' runs
			// the job once without per-user context. If per-user one-off tasks are
			// needed in future, add user_scope to the OneOffTask schema.
			userScope: 'system',
			appModule: entry.module,
			userProvider: userManager,
			householdService,
			logger: createChildLogger(logger, { service: 'scheduled-job', appId }),
		});
	});

	// 9b-iii. Wire job failure notifications (F33)
	//
	// JobFailureNotifier was fully implemented but never instantiated.
	// Without this, job failures generate no Telegram notifications and
	// auto-disable never triggers. Requires an admin user to know where
	// to send notifications.
	const adminUser = userManager.getAllUsers().find((u) => u.isAdmin);
	if (adminUser) {
		const jobFailureNotifier = new JobFailureNotifier({
			logger: createChildLogger(logger, { service: 'job-failure-notifier' }),
			sender: telegramService,
			adminChatId: adminUser.id,
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

	// If migration ran, paths changed (data/users/ → data/households/default/users/).
	// Rebuild to pick up new locations — the initial rebuild above read pre-migration paths.
	if (migrationRan) {
		await fileIndex.rebuild();
		logger.info({ count: fileIndex.size }, 'FileIndexService: post-migration index rebuilt');
	} else {
		logger.info({ count: fileIndex.size }, 'FileIndexService: initial index built');
	}

	const onDataChanged = (payload: unknown) => {
		fileIndex.handleDataChanged(payload as DataChangedPayload).catch((err) => {
			logger.warn({ err }, 'FileIndexService: failed to handle data:changed');
		});
	};
	eventBus.on('data:changed', onDataChanged);

	// D2b: Initialize DataQueryService now that FileIndexService is ready.
	// Apps declared 'data-query' already have the lazy facade; assigning the impl here
	// makes the facade functional before any message handling begins.
	dataQueryServiceImpl = new DataQueryServiceImpl({
		fileIndex,
		spaceService,
		llm: systemLlm,
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'data-query' }),
	});
	logger.info('DataQueryService: initialized');

	// D2c: EditService — LLM-assisted file editing with propose/confirm flow.
	// Depends on DataQueryServiceImpl (for file discovery), AppRegistry (for access checks),
	// and the system-level LLM guard. Must be initialized after DataQueryServiceImpl.
	editServiceImpl = new EditServiceImpl({
		dataQueryService: dataQueryServiceImpl,
		appRegistry: registry,
		llm: systemLlm,
		changeLog,
		eventBus,
		dataDir: config.dataDir,
		logger: createChildLogger(logger, { service: 'edit-service' }),
		editLog: new EditLog(join(config.dataDir, 'system', 'edit-log.jsonl')),
	});
	logger.info('EditService: initialized');

	// 9d. Vault service — per-user Obsidian vault directories with symlinks
	const vaultService = new VaultService({
		dataDir: config.dataDir,
		spaceService,
		userManager,
		logger: createChildLogger(logger, { service: 'vault' }),
	});
	spaceService.setVaultService(vaultService);
	await vaultService.rebuildAll();

	// 9b. Look up chatbot app for fallback dispatch
	const chatbotApp = registry.getApp('chatbot');
	const fallbackMode = config.fallback ?? 'chatbot';
	if (fallbackMode === 'chatbot' && !chatbotApp) {
		logger.warn(
			'Fallback mode is "chatbot" but chatbot app was not loaded — falling back to notes mode',
		);
	}

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
	const router = new Router({
		registry,
		llm: systemLlm,
		telegram: telegramService,
		fallback,
		chatbotApp: chatbotApp ?? undefined,
		fallbackMode,
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
		logger: createChildLogger(logger, { service: 'router' }),
	});
	router.buildRoutingTables();

	// Wire router into alert service (circular dep: AlertService created before Router)
	alertService.setRouter(router);

	// 11. Wire bot middleware (with user guard + rate limiting + request tracking)
	bot.on('message:text', async (ctx) => {
		await shutdownManager.trackRequest(async () => {
			const messageCtx = adaptTextMessage(ctx);
			if (!messageCtx) return;

			if (!(await userGuard.checkUser(messageCtx.userId, messageCtx.text))) return;

			if (!telegramRateLimiter.isAllowed(messageCtx.userId)) {
				await telegramService.send(messageCtx.userId, 'Please slow down. Try again in a moment.');
				return;
			}

			// Wrap in LLM context so cost tracking can attribute LLM calls to this user
			await requestContext.run({ userId: messageCtx.userId }, () => router.routeMessage(messageCtx));
		});
	});

	const photoLogger = createChildLogger(logger, { service: 'photo-adapter' });
	bot.on('message:photo', async (ctx) => {
		await shutdownManager.trackRequest(async () => {
			const userId = extractUserId(ctx);

			// Guard check before photo download (avoid unnecessary download for unregistered users)
			if (userId && !(await userGuard.checkUser(userId))) return;

			if (userId && !telegramRateLimiter.isAllowed(userId)) {
				await telegramService.send(userId, 'Please slow down. Try again in a moment.');
				return;
			}

			const photoCtx = await adaptPhotoMessage(ctx, photoLogger);
			if (photoCtx) {
				await requestContext.run({ userId: photoCtx.userId }, () => router.routePhoto(photoCtx));
			} else if (ctx.message?.photo) {
				// Photo was present but adapter returned null (download failed)
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

				// Route verification callback (user chose an app from inline buttons)
				if (data.startsWith('rv:') && routeVerifier) {
					const parts = data.split(':');
					const pendingId = parts[1];
					const chosenAppId = parts[2];
					if (!pendingId || !chosenAppId) return;

					// Access check BEFORE resolveCallback — pending entry is NOT consumed on denial
					const enabledApps = userManager.getUserApps(userId);
					if (!(await appToggle.isEnabled(userId, chosenAppId, enabledApps))) {
						callbackLogger.debug(
							{ chosenAppId, userId },
							'Verification callback for disabled app',
						);
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

					// Build user-override route metadata (pure helper — testable independently).
					const overrideRoute = buildUserOverrideRouteInfo(
						entry.classifierResult,
						chosenAppId,
						entry.verifierSuggestedIntent,
					);

					// Dispatch to chosen app (wrap in LLM context for cost tracking)
					await requestContext.run({ userId }, async () => {
						if (chosenAppId === 'chatbot' && chatbotApp) {
							await chatbotApp.module.handleMessage({
								...(entry.ctx as import('./types/telegram.js').MessageContext),
								route: overrideRoute,
							});
						} else if (appEntry) {
							if (entry.isPhoto && appEntry.module.handlePhoto) {
								await appEntry.module.handlePhoto({
									...(entry.ctx as import('./types/telegram.js').PhotoContext),
									route: overrideRoute,
								});
							} else {
								await appEntry.module.handleMessage({
									...(entry.ctx as import('./types/telegram.js').MessageContext),
									route: overrideRoute,
								});
							}
						}
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
						await requestContext.run({ userId }, () => handler(customData, callbackCtx));
					}
					return;
				}

				// Default: sendOptions callback handling
				telegramService.handleCallbackQuery(userId, data);
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

	// Derive webhook secret from bot token (deterministic, no extra config needed).
	// Users can override via TELEGRAM_WEBHOOK_SECRET env var.
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
	});

	// 13b. External Data API (optional — disabled when API_TOKEN is empty)
	let apiRateLimiter: ReturnType<typeof createApiRateLimiter> | undefined;
	if (config.api.token) {
		apiRateLimiter = createApiRateLimiter();
		apiRateLimiter.startCleanup();
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

	// 13c. Outbound webhooks (optional — only if webhooks configured)
	let webhookService: WebhookService | undefined;
	if (config.webhooks.length > 0) {
		webhookService = new WebhookService({
			webhooks: config.webhooks,
			eventBus,
			logger: createChildLogger(logger, { service: 'webhooks' }),
		});
		webhookService.init();
		logger.info({ count: config.webhooks.length }, 'Outbound webhooks configured');
	}

	await server.listen({ port: config.port, host: '0.0.0.0' });

	// Webhook mode (production) vs polling mode (local dev)
	const webhookUrl = process.env.WEBHOOK_URL;
	if (webhookUrl) {
		await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
		logger.info({ url: webhookUrl }, 'Webhook registered with Telegram');
	} else {
		// Local dev: use long polling so no tunnel is needed
		await bot.api.deleteWebhook();
		bot.start({
			onStart: () => logger.info('Bot started in long-polling mode (no WEBHOOK_URL set)'),
		});
	}

	// 14. Register daily diff cron (runs at 2am daily)
	scheduler.cron.register(
		{
			id: 'daily-diff',
			appId: 'system',
			cron: '0 2 * * *',
			handler: 'daily-diff',
			description: 'Generate daily diff report from change log',
			userScope: 'system',
		},
		() => async () => {
			if (n8nDispatcher.enabled) {
				const dispatched = await n8nDispatcher.dispatch({
					type: 'daily_diff',
					id: 'daily-diff',
					action: 'run',
				});
				if (dispatched) return;
				logger.info('n8n dispatch failed for daily-diff, running internally');
			}
			await dailyDiff.run();
		},
	);

	// 14b. Register system backup cron job (if enabled)
	if (config.backup.enabled) {
		const { BackupService } = await import('./services/backup/index.js');
		const backupService = new BackupService({
			dataDir: config.dataDir,
			configDir: resolve('config'),
			backupPath: config.backup.path,
			retentionCount: config.backup.retentionCount,
			logger: createChildLogger(logger, { service: 'backup' }),
		});
		scheduler.cron.register(
			{
				id: 'system-backup',
				appId: 'system',
				cron: config.backup.schedule,
				handler: 'system-backup',
				description: 'Backup data and config directories',
				userScope: 'system',
			},
			() => async () => {
				const path = await backupService.createBackup();
				if (path) logger.info({ path }, 'System backup saved');
			},
		);
	}

	// 14d. Load and register report cron jobs
	await reportService.init();

	// 14e. Load and register alert cron jobs
	await alertService.init();

	// 15. Start scheduler
	scheduler.start();

	logger.info({ port: config.port, apps: registry.getLoadedAppIds() }, 'PAS started successfully');

	// 16b. Validate user config against loaded apps
	const configWarnings = userManager.validateConfig(registry.getLoadedAppIds());
	for (const warning of configWarnings) {
		logger.warn({ warning }, 'Config validation warning');
	}

	// 17. Graceful shutdown
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
	shutdownManager.register();
}

// Entry point when run directly
main().catch((err) => {
	// biome-ignore lint/suspicious/noConsole: Logger not available before bootstrap
	console.error('Fatal startup error:', err);
	process.exit(1);
});
