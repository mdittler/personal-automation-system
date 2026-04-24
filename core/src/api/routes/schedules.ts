/**
 * Schedule listing API endpoint.
 *
 * Returns all registered cron jobs with human-readable descriptions,
 * next run times, and last run times. System-wide, no user scoping.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { requireScope } from '../guards/require-scope.js';
import type { CronManager } from '../../services/scheduler/cron-manager.js';
import { describeCron, getNextRun } from '../../utils/cron-describe.js';

const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

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

	function isAdminActor(
		request: import('fastify').FastifyRequest,
		reply: import('fastify').FastifyReply,
	): import('fastify').FastifyReply | undefined {
		const actor = request.actor;
		if (actor && !actor.isPlatformAdmin && actor.authMethod !== 'legacy-api-token') {
			return reply.status(403).send({ ok: false, error: 'Insufficient privileges to manage schedules.' });
		}
		return undefined;
	}

	server.get('/schedules', { preHandler: [requireScope('schedules:read')] }, async (request, reply) => {
		// D5b-7: schedules list is platform-admin / platform-system only in D5b
		// (no ownership metadata on jobs, so non-admin has nothing to see)
		const denied = isAdminActor(request, reply);
		if (denied) {
			return denied;
		}

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
				disabled: detail.disabled,
				failureCount: detail.failureCount,
			};
		});

		logger.info({ count: jobs.length }, 'API schedules listed');

		return reply.send({ ok: true, jobs });
	});

	server.post(
		'/schedules/:appId/:jobId/re-enable',
		{ preHandler: [requireScope('schedules:write')] },
		async (request, reply) => {
			const denied = isAdminActor(request, reply);
			if (denied) {
				return denied;
			}

			const { appId, jobId } = request.params as { appId?: string; jobId?: string };
			if (!appId || !jobId || !SAFE_SEGMENT.test(appId) || !SAFE_SEGMENT.test(jobId)) {
				return reply.status(400).send({ ok: false, error: 'Invalid schedule identifier.' });
			}

			const jobKey = `${appId}:${jobId}`;
			if (!cronManager.hasJob(jobKey)) {
				return reply.status(404).send({ ok: false, error: 'Schedule not found.' });
			}

			const reEnabled = cronManager.reEnable(appId, jobId);
			logger.info({ appId, jobId, reEnabled }, 'API schedule re-enable requested');

			return reply.send({ ok: true, reEnabled });
		},
	);
}
