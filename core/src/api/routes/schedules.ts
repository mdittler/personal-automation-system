/**
 * Schedule listing API endpoint.
 *
 * Returns all registered cron jobs with human-readable descriptions,
 * next run times, and last run times. System-wide, no user scoping.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { CronManager } from '../../services/scheduler/cron-manager.js';
import { describeCron, getNextRun } from '../../utils/cron-describe.js';

export interface SchedulesRouteOptions {
	cronManager: CronManager;
	timezone: string;
	logger: Logger;
}

export function registerSchedulesRoute(
	server: FastifyInstance,
	options: SchedulesRouteOptions,
): void {
	const { cronManager, timezone, logger } = options;

	server.get('/schedules', async (_request, reply) => {
		const jobDetails = cronManager.getJobDetails();

		const jobs = jobDetails.map((detail) => {
			const nextRun = getNextRun(detail.job.cron, timezone);

			return {
				key: detail.key,
				appId: detail.job.appId,
				jobId: detail.job.id,
				description: detail.job.description ?? null,
				cron: detail.job.cron,
				humanSchedule: describeCron(detail.job.cron),
				nextRun: nextRun ? nextRun.toISOString() : null,
				lastRunAt: detail.lastRunAt ? detail.lastRunAt.toISOString() : null,
			};
		});

		logger.info({ count: jobs.length }, 'API schedules listed');

		return reply.send({ ok: true, jobs });
	});
}
