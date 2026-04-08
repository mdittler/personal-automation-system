/**
 * Bootstrap — the composition root.
 *
 * Creates all services in dependency order, loads apps, wires the
 * bot middleware, starts the server, and registers graceful shutdown.
 * This is the main entry point for the PAS system.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { registerApiRoutes } from './api/index.js';
import { registerGuiRoutes } from './gui/index.js';
import { registerGlobalErrorHandlers } from './middleware/error-handler.js';
import {
	createApiRateLimiter,
	createLoginRateLimiter,
	createTelegramRateLimiter,
} from './middleware/rate-limiter.js';
import { ShutdownManager } from './middleware/shutdown.js';
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
import { CostTracker } from './services/llm/cost-tracker.js';
import { LLMServiceImpl } from './services/llm/index.js';
import { llmContext } from './services/llm/llm-context.js';
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
import { Router } from './services/router/index.js';
import { PendingVerificationStore } from './services/router/pending-verification-store.js';
import { RouteVerifier } from './services/router/route-verifier.js';
import { VerificationLogger } from './services/router/verification-logger.js';
import { SchedulerServiceImpl } from './services/scheduler/index.js';
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
import { VaultService } from './services/vault/index.js';
import { WebhookService } from './services/webhooks/index.js';
import type { CoreServices } from './types/app-module.js';

export async function main(): Promise<void> {
	// 1. Config + Logger
	const config = await loadSystemConfig();
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
		defaultStandard: llmConfig?.tiers.standard ?? {
			provider: 'anthropic',
			model: config.claude.model,
		},
		defaultFast: llmConfig?.tiers.fast ?? {
			provider: 'anthropic',
			model: config.claude.fastModel ?? 'claude-haiku-4-5-20251001',
		},
		defaultReasoning: llmConfig?.tiers.reasoning,
		logger: createChildLogger(logger, { service: 'model-selector' }),
	});
	await modelSelector.load();

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

	const userGuard = new UserGuard({
		userManager,
		telegram: telegramService,
		logger: createChildLogger(logger, { service: 'user-guard' }),
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
			conditionEvaluator: declaredServices.has('condition-evaluator')
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
			secrets,
			config: appConfig,
			timezone: config.timezone,
			logger: appLogger,
		} as CoreServices;
	};

	await registry.loadAll(serviceFactory);

	// 9b. Register app cron schedules from manifests
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
					() => async () => {
						await appModule.handleScheduledJob!(schedule.id);
					},
				);
			}
			logger.info({ appId, count: schedules.length }, 'Registered %d app cron schedule(s)', schedules.length);
		}
	}

	// 9c. Index app documentation after all apps are loaded
	await appKnowledge.init();

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

		logger.info('Route verification enabled');
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

			if (!(await userGuard.checkUser(messageCtx.userId))) return;

			if (!telegramRateLimiter.isAllowed(messageCtx.userId)) {
				await telegramService.send(messageCtx.userId, 'Please slow down. Try again in a moment.');
				return;
			}

			// Wrap in LLM context so cost tracking can attribute LLM calls to this user
			await llmContext.run({ userId: messageCtx.userId }, () => router.routeMessage(messageCtx));
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
				await llmContext.run({ userId: photoCtx.userId }, () => router.routePhoto(photoCtx));
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

					const resolved = await routeVerifier.resolveCallback(pendingId, chosenAppId);
					if (!resolved) return;

					const { entry } = resolved;
					const appEntry = registry.getApp(chosenAppId);

					// Dispatch to chosen app (wrap in LLM context for cost tracking)
					await llmContext.run({ userId }, async () => {
						if (chosenAppId === 'chatbot' && chatbotApp) {
							await chatbotApp.module.handleMessage(
								entry.ctx as import('./types/telegram.js').MessageContext,
							);
						} else if (appEntry) {
							if (entry.isPhoto && appEntry.module.handlePhoto) {
								await appEntry.module.handlePhoto(
									entry.ctx as import('./types/telegram.js').PhotoContext,
								);
							} else {
								await appEntry.module.handleMessage(
									entry.ctx as import('./types/telegram.js').MessageContext,
								);
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
						await llmContext.run({ userId }, () => handler(customData, callbackCtx));
					}
					return;
				}

				// Default: sendOptions callback handling
				telegramService.handleCallbackQuery(userId, data);
			});
		} finally {
			await ctx.answerCallbackQuery().catch(() => {});
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
	registerHealthRoute(server);
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
			llm: systemLlm,
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

	// 14b. Load and register report cron jobs
	await reportService.init();

	// 14c. Load and register alert cron jobs
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
