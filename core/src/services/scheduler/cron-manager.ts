/**
 * Cron job manager.
 *
 * Uses node-cron for standard 5-field cron scheduling (URS-SCH-002).
 * Each job is wrapped in the task runner for isolation.
 * Logs start time, end time, and success/failure (URS-SCH-004).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { ScheduledJob } from '../../types/scheduler.js';
import { type TaskHandler, runTask } from './task-runner.js';

interface RegisteredCronJob {
	job: ScheduledJob;
	task: ScheduledTask;
}

export class CronManager {
	private readonly jobs = new Map<string, RegisteredCronJob>();
	private readonly lastRunAt = new Map<string, Date>();
	private readonly logger: Logger;
	private readonly timezone: string;

	constructor(logger: Logger, timezone: string) {
		this.logger = logger;
		this.timezone = timezone;
	}

	/**
	 * Register a cron job. The handler resolver is called at execution time
	 * to get the actual handler function (allows lazy loading of app modules).
	 */
	register(job: ScheduledJob, handlerResolver: () => TaskHandler): void {
		const jobKey = `${job.appId}:${job.id}`;

		if (this.jobs.has(jobKey)) {
			this.logger.warn({ jobKey }, 'Cron job already registered, skipping duplicate');
			return;
		}

		if (!cron.validate(job.cron)) {
			this.logger.error({ jobKey, cron: job.cron }, 'Invalid cron expression, skipping');
			return;
		}

		const task = cron.createTask(
			job.cron,
			async () => {
				const handler = handlerResolver();
				await runTask(job.appId, job.id, handler, this.logger);
				this.lastRunAt.set(jobKey, new Date());
			},
			{ timezone: this.timezone },
		);

		this.jobs.set(jobKey, { job, task });
		this.logger.info(
			{ jobKey, cron: job.cron, description: job.description },
			'Cron job registered',
		);
	}

	/**
	 * Start all registered cron jobs.
	 */
	start(): void {
		for (const [key, { task }] of this.jobs) {
			task.start();
			this.logger.debug({ jobKey: key }, 'Cron job started');
		}
	}

	/**
	 * Stop all registered cron jobs.
	 */
	stop(): void {
		for (const [key, { task }] of this.jobs) {
			task.stop();
			this.logger.debug({ jobKey: key }, 'Cron job stopped');
		}
	}

	/**
	 * Unregister and stop a cron job by its key.
	 * Returns true if the job was found and removed.
	 */
	unregister(jobKey: string): boolean {
		const entry = this.jobs.get(jobKey);
		if (!entry) return false;

		entry.task.stop();
		this.jobs.delete(jobKey);
		this.lastRunAt.delete(jobKey);
		this.logger.info({ jobKey }, 'Cron job unregistered');
		return true;
	}

	/**
	 * Get all registered job keys.
	 */
	getRegisteredJobs(): string[] {
		return Array.from(this.jobs.keys());
	}

	/**
	 * Get all registered jobs with their full details.
	 */
	getJobDetails(): Array<{ job: ScheduledJob; key: string; lastRunAt: Date | null }> {
		return Array.from(this.jobs.entries()).map(([key, { job }]) => ({
			job,
			key,
			lastRunAt: this.lastRunAt.get(key) ?? null,
		}));
	}
}
