/**
 * External data API plugin registration.
 *
 * Registers all API routes under /api/ prefix with Bearer token auth.
 * Separate from the GUI — no cookies, no CSRF, no templates.
 * Disabled when API_TOKEN is empty.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import type { AlertService } from '../services/alerts/index.js';
import type { ChangeLog } from '../services/data-store/change-log.js';
import type { HouseholdService } from '../services/household/index.js';
import type { ReportService } from '../services/reports/index.js';
import type { Router } from '../services/router/index.js';
import type { CronManager } from '../services/scheduler/cron-manager.js';
import type { SpaceService } from '../services/spaces/index.js';
import type { UserManager } from '../services/user-manager/index.js';
import type { EventBusService } from '../types/events.js';
import type { LLMService } from '../types/llm.js';
import type { TelegramService } from '../types/telegram.js';
import { createApiAuthHook } from './auth.js';
import { registerAlertsApiRoute } from './routes/alerts-api.js';
import { registerChangesRoute } from './routes/changes.js';
import { registerDataReadRoute } from './routes/data-read.js';
import { registerDataRoute } from './routes/data.js';
import { registerLlmRoute } from './routes/llm.js';
import { registerMessagesRoute } from './routes/messages.js';
import { registerReportsApiRoute } from './routes/reports-api.js';
import { registerSchedulesRoute } from './routes/schedules.js';
import { registerTelegramRoute } from './routes/telegram.js';

export interface ApiOptions {
	apiToken: string;
	rateLimiter: RateLimiter;
	dataDir: string;
	changeLog: ChangeLog;
	spaceService: SpaceService;
	userManager: UserManager;
	router: Router;
	cronManager: CronManager;
	timezone: string;
	logger: Logger;
	eventBus: EventBusService;
	// Phase 26A additions
	reportService: ReportService;
	alertService: AlertService;
	telegram: TelegramService;
	llm: LLMService;
	/** Optional — when present, householdId is derived for message dispatch context. */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
}

export async function registerApiRoutes(
	server: FastifyInstance,
	options: ApiOptions,
): Promise<void> {
	const {
		apiToken,
		rateLimiter,
		dataDir,
		changeLog,
		spaceService,
		userManager,
		router,
		cronManager,
		timezone,
		logger,
		eventBus,
		reportService,
		alertService,
		telegram,
		llm,
		householdService,
	} = options;

	await server.register(
		async (api) => {
			// Auth hook for all /api/* routes
			const authHook = createApiAuthHook({ apiToken, rateLimiter });
			api.addHook('onRequest', authHook);

			// Phase 24-25 routes
			registerDataRoute(api, { dataDir, changeLog, spaceService, userManager, eventBus, logger });
			registerDataReadRoute(api, { dataDir, spaceService, userManager, logger });
			registerMessagesRoute(api, { router, userManager, logger, householdService });
			registerSchedulesRoute(api, { cronManager, timezone, logger });

			// Phase 26A routes
			registerReportsApiRoute(api, { reportService, telegram, userManager, logger });
			registerAlertsApiRoute(api, { alertService, logger });
			registerChangesRoute(api, { changeLog, logger });
			registerLlmRoute(api, { llm, logger });
			registerTelegramRoute(api, { telegram, userManager, logger });
		},
		{ prefix: '/api' },
	);

	logger.info('API routes registered at /api/');
}
