/**
 * Management GUI route registration.
 *
 * Registers all GUI routes under /gui/ prefix on the Fastify instance.
 * Includes auth middleware, dashboard, apps, scheduler, logs, config,
 * and LLM usage pages.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import type { AlertService } from '../services/alerts/index.js';
import type { AppRegistry } from '../services/app-registry/index.js';
import type { AppToggleStore } from '../services/app-toggle/index.js';
import type { ContextStoreServiceImpl } from '../services/context-store/index.js';
import type { LLMServiceImpl } from '../services/llm/index.js';
import type { ModelCatalog } from '../services/llm/model-catalog.js';
import type { ModelSelector } from '../services/llm/model-selector.js';
import type { ProviderRegistry } from '../services/llm/providers/provider-registry.js';
import type { ReportService } from '../services/reports/index.js';
import type { SchedulerServiceImpl } from '../services/scheduler/index.js';
import type { SpaceService } from '../services/spaces/index.js';
import type { UserManager } from '../services/user-manager/index.js';
import type { UserMutationService } from '../services/user-manager/user-mutation-service.js';
import type { SystemConfig } from '../types/config.js';
import { describeCron } from '../utils/cron-describe.js';
import { registerAuth } from './auth.js';
import { registerCsrfProtection } from './csrf.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerAppsRoutes } from './routes/apps.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerContextRoutes } from './routes/context.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerDataRoutes } from './routes/data.js';
import { registerLlmUsageRoutes } from './routes/llm-usage.js';
import { registerLogsRoutes } from './routes/logs.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerSpaceRoutes } from './routes/spaces.js';
import { registerUserRoutes } from './routes/users.js';

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
	} = options;

	await server.register(
		async (gui) => {
			// Auth middleware + login/logout routes
			await registerAuth(gui, { authToken: config.gui.authToken, loginRateLimiter });

			// CSRF protection (after auth, before content routes)
			await registerCsrfProtection(gui);

			// Content routes
			registerDashboardRoutes(gui, { registry, scheduler, config, modelSelector, dataDir, logger });
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir, logger });
			registerSchedulerRoutes(gui, { scheduler, timezone: config.timezone, logger });
			registerLogsRoutes(gui, { dataDir, logger });
			registerDataRoutes(gui, { config, dataDir, logger });
			registerConfigRoutes(gui, { registry, config, dataDir, logger });
			if (contextStore) {
				registerContextRoutes(gui, { contextStore, config, logger });
			}
			registerLlmUsageRoutes(gui, { llm, modelSelector, modelCatalog, providerRegistry, logger });
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
		},
		{ prefix: '/gui' },
	);

	logger.info('GUI routes registered at /gui/');
}
