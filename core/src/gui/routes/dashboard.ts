/**
 * Dashboard route.
 *
 * GET /gui/ — system overview with uptime, app count,
 * user count, scheduler status, Ollama connectivity,
 * system config (read-only), and per-user app configuration.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppRegistry } from '../../services/app-registry/index.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import type { SystemConfig } from '../../types/config.js';

export interface DashboardOptions {
	registry: AppRegistry;
	scheduler: SchedulerServiceImpl;
	config: SystemConfig;
	dataDir: string;
	logger: Logger;
}

function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (mins > 0) parts.push(`${mins}m`);
	parts.push(`${secs}s`);
	return parts.join(' ');
}

export function registerDashboardRoutes(server: FastifyInstance, options: DashboardOptions): void {
	const { registry, scheduler, config, logger } = options;

	server.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
		const appIds = registry.getLoadedAppIds();
		const cronJobs = scheduler.cron.getJobDetails();
		let pendingTasks: unknown[] = [];

		try {
			pendingTasks = await scheduler.oneOff.getPendingTasks();
		} catch {
			logger.warn('Failed to load pending one-off tasks');
		}

		// Check Ollama connectivity (skip if Ollama is not configured)
		let ollamaStatus = config.ollama ? 'disconnected' : 'not configured';
		if (config.ollama) {
			try {
				const response = await fetch(config.ollama.url, { signal: AbortSignal.timeout(3000) });
				if (response.ok) ollamaStatus = 'connected';
			} catch {
				// Ollama not reachable
			}
		}

		// System config (read-only)
		const systemConfig = {
			port: config.port,
			logLevel: config.logLevel,
			timezone: config.timezone,
			ollamaUrl: config.ollama?.url ?? 'not configured',
			ollamaModel: config.ollama?.model ?? 'n/a',
			claudeModel: config.claude.model,
		};

		return reply.viewAsync('dashboard', {
			title: 'Dashboard — PAS',
			activePage: 'dashboard',
			uptime: formatUptime(process.uptime()),
			appCount: appIds.length,
			appIds,
			userCount: config.users.length,
			cronJobCount: cronJobs.length,
			pendingTaskCount: pendingTasks.length,
			ollamaStatus,
			systemConfig,
			users: config.users,
		});
	});
}
