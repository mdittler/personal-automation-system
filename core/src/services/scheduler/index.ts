/**
 * Scheduler service.
 *
 * Manages both recurring cron jobs (from manifests) and dynamic
 * one-off tasks (scheduled programmatically by apps). Provides
 * the SchedulerService interface for apps and lifecycle management
 * for the infrastructure.
 */

import type { Logger } from 'pino';
import type { AppManifest } from '../../types/manifest.js';
import type { ScheduledJob, SchedulerService } from '../../types/scheduler.js';
import { CronManager } from './cron-manager.js';
import { OneOffManager } from './oneoff-manager.js';
import type { TaskHandler } from './task-runner.js';

export interface SchedulerServiceOptions {
	dataDir: string;
	logger: Logger;
	timezone: string;
}

export class SchedulerServiceImpl implements SchedulerService {
	readonly cron: CronManager;
	readonly oneOff: OneOffManager;

	constructor(options: SchedulerServiceOptions) {
		this.cron = new CronManager(options.logger, options.timezone, options.dataDir);
		this.oneOff = new OneOffManager(options.dataDir, options.logger);
	}

	/**
	 * Register cron jobs from an app's manifest.
	 * Called during app loading (Phase 5 bootstrap).
	 */
	registerFromManifest(
		manifest: AppManifest,
		handlerResolver: (handler: string) => TaskHandler,
	): void {
		const schedules = manifest.capabilities?.schedules ?? [];

		for (const schedule of schedules) {
			const job: ScheduledJob = {
				id: schedule.id,
				appId: manifest.app.id,
				cron: schedule.cron,
				handler: schedule.handler,
				description: schedule.description,
				userScope: schedule.user_scope,
			};

			this.cron.register(job, () => handlerResolver(schedule.handler));
		}
	}

	async scheduleOnce(appId: string, jobId: string, runAt: Date, handler: string): Promise<void> {
		await this.oneOff.schedule(appId, jobId, runAt, handler);
	}

	async cancelOnce(appId: string, jobId: string): Promise<void> {
		await this.oneOff.cancel(appId, jobId);
	}

	/**
	 * Start all cron jobs and the one-off task checker.
	 */
	start(): void {
		this.cron.start();
		this.oneOff.start();
	}

	/**
	 * Stop all cron jobs and the one-off task checker.
	 */
	stop(): void {
		this.cron.stop();
		this.oneOff.stop();
	}
}

export { CronManager } from './cron-manager.js';
export { OneOffManager } from './oneoff-manager.js';
export { runTask } from './task-runner.js';
export type { TaskHandler } from './task-runner.js';
