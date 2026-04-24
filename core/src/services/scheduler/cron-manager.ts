/**
 * Cron job manager.
 *
 * Uses node-cron for standard 5-field cron scheduling (URS-SCH-002).
 * Each job is wrapped in the task runner for isolation.
 * Logs start time, end time, and success/failure (URS-SCH-004).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import type { ScheduledJob } from '../../types/scheduler.js';
import type { SchedulerJobNotifier } from './notifier.js';
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
	private readonly persistPath: string;
	private notifier: SchedulerJobNotifier | null = null;
	private inFlightCount = 0;
	private readonly drainResolvers: Array<() => void> = [];
	private started = false;

	constructor(logger: Logger, timezone: string, dataDir: string) {
		this.logger = logger;
		this.timezone = timezone;
		this.persistPath = join(dataDir, 'system', 'cron-last-run.json');
		this.loadLastRunData();
	}

	setNotifier(notifier: SchedulerJobNotifier): void {
		this.notifier = notifier;
	}

	private loadLastRunData(): void {
		try {
			const raw = readFileSync(this.persistPath, 'utf-8');
			const data = JSON.parse(raw) as Record<string, string>;
			for (const [key, dateStr] of Object.entries(data)) {
				const parsed = new Date(dateStr);
				if (!isNaN(parsed.getTime())) {
					this.lastRunAt.set(key, parsed);
				}
			}
		} catch {
			// File doesn't exist yet or is malformed — start fresh
		}
	}

	private persistLastRunData(): void {
		try {
			const dir = dirname(this.persistPath);
			mkdirSync(dir, { recursive: true });
			const data: Record<string, string> = {};
			for (const [key, date] of this.lastRunAt) {
				data[key] = date.toISOString();
			}
			writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
		} catch (err) {
			this.logger.warn({ error: err }, 'Failed to persist cron last-run data');
		}
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
				if (this.notifier?.isDisabled(job.appId, job.id)) {
					this.logger.warn({ jobKey }, 'Cron job is disabled, skipping execution');
					return;
				}

				this.inFlightCount++;
				try {
					const handler = handlerResolver();
					const result = await runTask(job.appId, job.id, handler, this.logger);

					this.lastRunAt.set(jobKey, new Date());
					this.persistLastRunData();

					try {
						if (result.success) {
							this.notifier?.onSuccess(job.appId, job.id);
						} else {
							await this.notifier?.onFailure(job.appId, job.id, result.error ?? 'Unknown error');
						}
					} catch (err) {
						this.logger.error(
							{
								appId: job.appId,
								jobId: job.id,
								error: err instanceof Error ? err.message : String(err),
							},
							'Notifier threw during job lifecycle callback — ignoring',
						);
					}
				} finally {
					this.inFlightCount--;
					if (this.inFlightCount === 0) {
						for (const resolve of this.drainResolvers) resolve();
						this.drainResolvers.length = 0;
					}
				}
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
		this.started = true;
	}

	/**
	 * Returns true if the cron manager has been started.
	 */
	isRunning(): boolean {
		return this.started;
	}

	/**
	 * Stop all registered cron jobs and wait for any in-flight executions to complete.
	 * Waits up to 30 seconds for in-flight jobs before returning.
	 */
	async stop(): Promise<void> {
		this.started = false;
		for (const [key, { task }] of this.jobs) {
			task.stop();
			this.logger.debug({ jobKey: key }, 'Cron job stopped');
		}
		if (this.inFlightCount > 0) {
			this.logger.info({ inFlight: this.inFlightCount }, 'Waiting for in-flight cron jobs...');
			await Promise.race([
				new Promise<void>((resolve) => {
					this.drainResolvers.push(resolve);
				}),
				new Promise<void>((resolve) => {
					setTimeout(resolve, 30_000);
				}),
			]);
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
		this.persistLastRunData();
		this.logger.info({ jobKey }, 'Cron job unregistered');
		return true;
	}

	/**
	 * Get all registered job keys.
	 */
	getRegisteredJobs(): string[] {
		return Array.from(this.jobs.keys());
	}

	hasJob(jobKey: string): boolean {
		return this.jobs.has(jobKey);
	}

	reEnable(appId: string, jobId: string): boolean {
		if (!this.notifier?.reEnable) return false;
		const wasDisabled = this.notifier.isDisabled(appId, jobId);
		this.notifier.reEnable(appId, jobId);
		return wasDisabled;
	}

	/**
	 * Get all registered jobs with their full details.
	 */
	getJobDetails(): Array<{
		job: ScheduledJob;
		key: string;
		lastRunAt: Date | null;
		disabled: boolean;
		failureCount: number;
	}> {
		return Array.from(this.jobs.entries()).map(([key, { job }]) => ({
			job,
			key,
			lastRunAt: this.lastRunAt.get(key) ?? null,
			disabled: this.notifier?.isDisabled(job.appId, job.id) ?? false,
			failureCount: this.notifier?.getFailureCount?.(job.appId, job.id) ?? 0,
		}));
	}
}
