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

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

export interface SchedulerOptions {
	scheduler: SchedulerServiceImpl;
	timezone: string;
	logger: Logger;
}

export function registerSchedulerRoutes(server: FastifyInstance, options: SchedulerOptions): void {
	const { scheduler, timezone, logger } = options;

	const platformAdminOnly = { preHandler: [requirePlatformAdmin] };

	server.get(
		'/scheduler',
		platformAdminOnly,
		async (_request: FastifyRequest, reply: FastifyReply) => {
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
						disabled: j.disabled,
						failureCount: j.failureCount,
					};
				}),
				pendingTasks: pendingTasks.map((t) => ({
					id: t.id,
					appId: t.appId,
					jobId: t.jobId,
					runAt: formatDateTime(t.runAt, timezone),
					runAtRelative: formatRelativeTime(t.runAt, now),
					createdAt: formatDateTime(t.createdAt, timezone),
					disabled: scheduler.oneOff.isDisabled(t.appId, t.jobId),
					failureCount: scheduler.oneOff.getFailureCount(t.appId, t.jobId),
				})),
			});
		},
	);

	server.post(
		'/scheduler/:appId/:jobId/re-enable',
		platformAdminOnly,
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { appId, jobId } = request.params as { appId: string; jobId: string };
			if (!appId || !jobId || !SAFE_SEGMENT.test(appId) || !SAFE_SEGMENT.test(jobId)) {
				logger.warn({ appId, jobId }, 'Rejected invalid scheduler re-enable request');
				return reply.status(400).type('text/plain').send('Invalid schedule identifier.');
			}
			if (!scheduler.cron.hasJob(`${appId}:${jobId}`)) {
				logger.warn({ appId, jobId }, 'Scheduler job not found for GUI re-enable request');
				return reply.status(404).type('text/plain').send('Schedule not found.');
			}
			const reEnabled = scheduler.cron.reEnable(appId, jobId);
			logger.info({ appId, jobId, reEnabled }, 'Scheduler job re-enabled via GUI');
			return reply.redirect('/gui/scheduler');
		},
	);
}
