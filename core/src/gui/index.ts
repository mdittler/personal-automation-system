/**
 * Management GUI route registration.
 *
 * Registers all GUI routes under /gui/ prefix on the Fastify instance.
 * Includes auth middleware, dashboard, apps, scheduler, logs, config,
 * and LLM usage pages.
 */

import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import type { AlertService } from '../services/alerts/index.js';
import type { ApiKeyService } from '../services/api-keys/index.js';
import type { AppRegistry } from '../services/app-registry/index.js';
import type { AppToggleStore } from '../services/app-toggle/index.js';
import type { ChatTranscriptIndex } from '../services/chat-transcript-index/index.js';
import type { SystemConfigWriter } from '../services/config/system-config-writer.js';
import type { ContextStoreServiceImpl } from '../services/context-store/index.js';
import type { CredentialService } from '../services/credentials/index.js';
import type { HouseholdService } from '../services/household/index.js';
import type { CostTracker } from '../services/llm/cost-tracker.js';
import type { LLMServiceImpl } from '../services/llm/index.js';
import type { ModelCatalog } from '../services/llm/model-catalog.js';
import type { ModelSelector } from '../services/llm/model-selector.js';
import type { ProviderRegistry } from '../services/llm/providers/provider-registry.js';
import type { MessageRateTracker } from '../services/metrics/message-rate-tracker.js';
import type { ReportService } from '../services/reports/index.js';
import type { SchedulerServiceImpl } from '../services/scheduler/index.js';
import type { SettingsRegistry } from '../services/settings/settings-registry.js';
import type { SettingsWriter } from '../services/settings/settings-writer.js';
import type { SpaceService } from '../services/spaces/index.js';
import type { UserManager } from '../services/user-manager/index.js';
import type { UserMutationService } from '../services/user-manager/user-mutation-service.js';
import type { AppConfigService, LLMSafeguardsConfig, SystemConfig } from '../types/config.js';
import { describeCron } from '../utils/cron-describe.js';
import { registerAuth } from './auth.js';
import { registerCsrfProtection } from './csrf.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerAppsRoutes } from './routes/apps.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerContextRoutes } from './routes/context.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerDataRoutes } from './routes/data.js';
import { registerLlmUsageRoutes } from './routes/llm-usage.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerRegressionRoutes } from './routes/regression.js';
import { registerReportWizardRoutes } from './routes/report-wizard.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSpaceRoutes } from './routes/spaces.js';
import { registerUserRoutes } from './routes/users.js';
import { createCaseDiscovery } from './services/regression/case-discovery.js';
import { createRunHistoryStore } from './services/regression/run-history-store.js';
import { createRunRegistry } from './services/regression/run-registry.js';
import { createWeaknessSummarizer } from './services/regression/weakness-summarizer.js';
import { registerViewLocals } from './view-locals.js';

export interface GuiOptions {
	registry: AppRegistry;
	scheduler: SchedulerServiceImpl;
	llm: LLMServiceImpl;
	config: SystemConfig;
	appToggle: AppToggleStore;
	modelSelector: ModelSelector;
	modelCatalog: ModelCatalog;
	providerRegistry: ProviderRegistry;
	reportService?: ReportService;
	alertService?: AlertService;
	userManager?: UserManager;
	contextStore?: ContextStoreServiceImpl;
	spaceService?: SpaceService;
	userMutationService?: UserMutationService;
	dataDir: string;
	logger: Logger;
	loginRateLimiter?: RateLimiter;
	/**
	 * Optional — when present, householdId can be derived for simulated message dispatch
	 * and the data browser routes user/shared scopes through the household layout.
	 */
	householdService?: Pick<
		HouseholdService,
		'getHouseholdForUser' | 'listHouseholds' | 'getHousehold' | 'getMembers'
	>;
	/** D5b-3: Per-user credential store (password hashes + session versions). */
	credentialService?: CredentialService;
	/** D5b-8: Per-user API key store (for self-service key management UI). */
	apiKeyService?: ApiKeyService;
	/** D5c-D: Cost tracker for live per-household monthly costs in the ops dashboard. */
	costTracker?: CostTracker;
	/** D5c-D: Message rate tracker for live ops metrics. */
	messageRateTracker?: MessageRateTracker;
	/** D5c-D: LLM safeguards config for per-household cap display. */
	llmSafeguards?: LLMSafeguardsConfig;
	/** Settings-B: Shared SettingsRegistry for /gui/settings page and config routes. */
	settingsRegistry: SettingsRegistry;
	/** Settings-B: SettingsWriter for /gui/settings save + reset flows and config routes. */
	settingsWriter: SettingsWriter;
	/** Settings-B: Resolves AppConfigService by appId for /gui/settings reads + resets. */
	settingsAppConfigResolver?: (appId: string) => AppConfigService | undefined;
	/** Settings-C: SystemConfigWriter for system-scope reads, writes, and resets. */
	systemConfigWriter?: SystemConfigWriter;
	/** Settings-C: Live SystemConfig reference for system-scope reads. */
	systemConfig?: SystemConfig;
	/** `false` ⇒ login-by-name disabled (see scanForDuplicateNames). Default `true`. */
	loginByNameAllowed?: boolean;
	/**
	 * Batch 2 (GUI UX redesign): chat transcript FTS index, used by the
	 * permission-scoped activity-daily metrics endpoint (message counts) and,
	 * in a later batch, the Conversations browser. Optional — when absent,
	 * activity-daily's message counts are always 0 rather than erroring.
	 */
	chatTranscriptIndex?: Pick<ChatTranscriptIndex, 'countMessagesByDay'>;
}

/**
 * Register all GUI routes on the Fastify instance under /gui/ prefix.
 */
export async function registerGuiRoutes(
	server: FastifyInstance,
	options: GuiOptions,
): Promise<void> {
	const {
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
		userMutationService,
		contextStore,
		spaceService,
		dataDir,
		logger,
		loginRateLimiter,
		credentialService,
		apiKeyService,
		costTracker,
		messageRateTracker,
		llmSafeguards,
	} = options;

	await server.register(
		async (gui) => {
			// Auth middleware + login/logout routes (D5b-3: per-user password login).
			// credentialService/userManager/householdService are optional for backward compat
			// with legacy tests; when present, per-user auth is active.
			await registerAuth(gui, {
				authToken: config.gui.authToken,
				credentialService,
				userManager: userManager ?? undefined,
				householdService: options.householdService as
					| Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'>
					| undefined,
				loginRateLimiter,
				loginByNameAllowed: options.loginByNameAllowed,
			});

			// CSRF protection (after auth, before content routes)
			await registerCsrfProtection(gui);

			// View-locals: inject currentUser into every template render (D5b-3)
			if (userManager) {
				await registerViewLocals(gui, { userManager });
			}

			// Content routes
			registerDashboardRoutes(gui, {
				registry,
				scheduler,
				config,
				modelSelector,
				dataDir,
				logger,
				alertService,
				reportService,
				chatTranscriptIndex: options.chatTranscriptIndex,
				householdService: options.householdService,
				costTracker,
				llmSafeguards,
			});
			registerMetricsRoutes(gui, {
				dataDir,
				chatTranscriptIndex: options.chatTranscriptIndex,
				alertService,
				logger,
			});
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir, logger });
			registerSchedulerRoutes(gui, { scheduler, timezone: config.timezone, logger });
			registerLogsRoutes(gui, { dataDir, logger });
			registerDataRoutes(gui, {
				config,
				dataDir,
				logger,
				householdService: options.householdService,
				spaceService: spaceService ?? undefined,
			});
			registerConfigRoutes(gui, {
				registry,
				config,
				dataDir,
				logger,
				settingsWriter: options.settingsWriter,
				settingsRegistry: options.settingsRegistry,
			});
			if (contextStore) {
				if (!options.householdService) {
					throw new Error(
						'registerContextRoutes requires householdService — refusing to register ' +
							'/gui/context routes without per-household ALS attribution',
					);
				}
				registerContextRoutes(gui, {
					contextStore,
					config,
					logger,
					householdService: options.householdService,
				});
			}
			registerLlmUsageRoutes(gui, {
				llm,
				modelSelector,
				modelCatalog,
				providerRegistry,
				logger,
				costTracker,
				householdService: options.householdService,
				messageRateTracker,
				llmSafeguards,
				userManager,
			});
			// Persona Regression Suite admin page (Chunk B.2). The case-discovery
			// service shells out to the regression CLI on each page load (Codex
			// C4); the run-registry tracks in-flight subprocess runs. Resolve
			// repo-relative paths from cwd at registration time so the GUI works
			// against any worktree.
			const repoRoot = resolve(process.cwd());
			const cliPath = resolve(repoRoot, 'regression', 'src', 'runner', 'cli-main.ts');
			const tsconfigPath = resolve(repoRoot, 'regression', 'tsconfig.json');
			const cacheDir = resolve(repoRoot, 'data', 'system', 'regression-cache');
			const manifestDir = resolve(repoRoot, 'data', 'system', 'regression-runs');
			const regressionRunRegistry = createRunRegistry();
			const regressionCaseDiscovery = createCaseDiscovery({
				cliPath,
				cwd: repoRoot,
				tsconfigPath,
			});
			const regressionRunHistoryStore = createRunHistoryStore({
				rootDir: manifestDir,
				logger,
			});
			const summaryDir = resolve(repoRoot, 'data', 'system', 'regression-summaries');
			const regressionWeaknessSummarizer = createWeaknessSummarizer({
				manifestDir,
				cacheDir,
				summaryDir,
				llm,
				logger,
			});
			registerRegressionRoutes(gui, {
				caseDiscovery: regressionCaseDiscovery,
				runRegistry: regressionRunRegistry,
				runHistoryStore: regressionRunHistoryStore,
				weaknessSummarizer: regressionWeaknessSummarizer,
				modelCatalog,
				modelSelector,
				cacheDir,
				maxRunBudgetUsd: config.regression?.maxRunBudgetUsd ?? 5,
				logger,
				cliPath,
				cwd: repoRoot,
				tsconfigPath,
			});
			// Reap terminal RunStates hourly so the in-memory registry doesn't
			// grow without bound. SIGTERM any live children on Fastify close so
			// shutdown doesn't orphan the subprocess.
			const REGRESSION_GC_INTERVAL_MS = 60 * 60 * 1000;
			const regressionGcTimer = setInterval(
				() => regressionRunRegistry.gc({ maxAgeMs: REGRESSION_GC_INTERVAL_MS }),
				REGRESSION_GC_INTERVAL_MS,
			);
			regressionGcTimer.unref();
			gui.addHook('onClose', async () => {
				clearInterval(regressionGcTimer);
				await regressionRunRegistry.shutdown();
			});
			// Cron description API (used by cron-helper.js)
			gui.get(
				'/cron-describe',
				async (
					request: import('fastify').FastifyRequest<{ Querystring: { expr?: string } }>,
					reply: import('fastify').FastifyReply,
				) => {
					const expr = (request.query as { expr?: string }).expr || '';
					return reply.type('text/plain').send(describeCron(expr));
				},
			);

			if (reportService && userManager) {
				registerReportRoutes(gui, {
					reportService,
					userManager,
					registry,
					spaceService,
					dataDir,
					timezone: config.timezone,
					logger,
				});
				// Batch 3: guided report wizard — same reportService/registry, submits
				// the existing POST /gui/reports contract via reports.ts's own handler.
				registerReportWizardRoutes(gui, {
					reportService,
					userManager,
					registry,
					dataDir,
					timezone: config.timezone,
					logger,
				});
			}
			if (alertService && userManager) {
				registerAlertRoutes(gui, {
					alertService,
					userManager,
					registry,
					reportService,
					spaceService,
					n8nDispatchUrl: config.n8n?.dispatchUrl,
					dataDir,
					timezone: config.timezone,
					logger,
				});
			}
			if (spaceService && userManager) {
				registerSpaceRoutes(gui, {
					spaceService,
					userManager,
					logger,
				});
			}
			if (userManager && userMutationService && spaceService) {
				registerUserRoutes(gui, {
					userManager,
					userMutationService,
					registry,
					spaceService,
					logger,
				});
			}
			// D5b-8: self-service credential management (any authenticated user)
			if (credentialService && userManager) {
				registerCredentialRoutes(gui, {
					credentialService,
					userManager,
					logger,
				});
			}
			// D5b-8: self-service API key management (any authenticated user)
			if (apiKeyService) {
				registerApiKeyRoutes(gui, {
					apiKeyService,
					logger,
				});
			}
			// Settings-B: /gui/settings page
			if (options.settingsRegistry && options.settingsWriter && options.settingsAppConfigResolver) {
				registerSettingsRoutes(gui, {
					settingsRegistry: options.settingsRegistry,
					settingsWriter: options.settingsWriter,
					appConfigResolver: options.settingsAppConfigResolver,
					logger,
					systemConfigWriter: options.systemConfigWriter,
					systemConfig: options.systemConfig,
				});
			}
		},
		{ prefix: '/gui' },
	);

	logger.info('GUI routes registered at /gui/');
}
