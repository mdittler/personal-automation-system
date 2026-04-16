/**
 * Scheduler route.
 *
 * GET /gui/scheduler — list all cron jobs and pending one-off tasks
 * with human-readable schedules and next/last run times.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import {
	describeCron,
	formatDateTime,
	formatRelativeTime,
	getNextRun,
} from '../../utils/cron-describe.js';

export interface SchedulerOptions {
	scheduler: SchedulerServiceImpl;
	timezone: string;
	logger: Logger;
}

export function registerSchedulerRoutes(server: FastifyInstance, options: SchedulerOptions): void {
	const { scheduler, timezone, logger } = options;

	// D5b-4: platform-admin gate
	server.addHook('preHandler', requirePlatformAdmin);

	server.get('/scheduler', async (_request: FastifyRequest, reply: FastifyReply) => {
		const now = new Date();
		const cronJobs = scheduler.cron.getJobDetails();
		let pendingTasks: Array<{
			id: string;
			appId: string;
			jobId: string;
			runAt: Date;
			handler: string;
			createdAt: Date;
		}> = [];

		try {
			pendingTasks = await scheduler.oneOff.getPendingTasks();
		} catch (err) {
			logger.warn({ error: err }, 'Failed to load pending one-off tasks');
		}

		return reply.viewAsync('scheduler', {
			title: 'Scheduler — PAS',
			activePage: 'scheduler',
			cronJobs: cronJobs.map((j) => {
				const nextRun = getNextRun(j.job.cron, timezone);
				return {
					key: j.key,
					appId: j.job.appId,
					id: j.job.id,
					cron: j.job.cron,
					description: j.job.description,
					humanSchedule: describeCron(j.job.cron),
					nextRun: nextRun ? formatDateTime(nextRun, timezone) : null,
					nextRunRelative: nextRun ? formatRelativeTime(nextRun, now) : null,
					lastRunAt: j.lastRunAt ? formatDateTime(j.lastRunAt, timezone) : null,
					lastRunRelative: j.lastRunAt ? formatRelativeTime(j.lastRunAt, now) : null,
				};
			}),
			pendingTasks: pendingTasks.map((t) => ({
				id: t.id,
				appId: t.appId,
				jobId: t.jobId,
				runAt: formatDateTime(t.runAt, timezone),
				runAtRelative: formatRelativeTime(t.runAt, now),
				createdAt: formatDateTime(t.createdAt, timezone),
			})),
		});
	});
}
