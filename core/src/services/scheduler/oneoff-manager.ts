/**
 * One-off task manager.
 *
 * Stores pending one-off tasks in data/system/scheduled-jobs.yaml.
 * Checks on a 1-minute interval, fires matching tasks, and removes
 * them from YAML after execution. Survives restarts by reading YAML
 * on startup.
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { OneOffTask } from '../../types/scheduler.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';
import { type TaskHandler, runTask } from './task-runner.js';

/** Serializable form of a one-off task for YAML storage. */
interface SerializedTask {
	id: string;
	appId: string;
	jobId: string;
	runAt: string;
	handler: string;
	createdAt: string;
}

export class OneOffManager {
	private readonly yamlPath: string;
	private readonly logger: Logger;
	private checkInterval: ReturnType<typeof setInterval> | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	/**
	 * Handler resolver: given an appId and handler path,
	 * returns the function to execute. Set by the bootstrap.
	 */
	private handlerResolver: ((appId: string, handler: string) => TaskHandler) | null = null;

	constructor(dataDir: string, logger: Logger) {
		this.yamlPath = join(dataDir, 'system', 'scheduled-jobs.yaml');
		this.logger = logger;
	}

	/**
	 * Set the handler resolver. Called by bootstrap after app loading.
	 */
	setHandlerResolver(resolver: (appId: string, handler: string) => TaskHandler): void {
		this.handlerResolver = resolver;
	}

	/**
	 * Enqueue a write operation, ensuring serial execution even after failures.
	 */
	private enqueue(fn: () => Promise<void>): Promise<void> {
		const p = this.writeQueue.then(fn, fn);
		this.writeQueue = p.then(() => {}, () => {});
		return p;
	}

	/**
	 * Schedule a one-off task.
	 */
	async schedule(appId: string, jobId: string, runAt: Date, handler: string): Promise<void> {
		return this.enqueue(() => this.doSchedule(appId, jobId, runAt, handler));
	}

	/**
	 * Cancel a pending one-off task.
	 */
	async cancel(appId: string, jobId: string): Promise<void> {
		return this.enqueue(() => this.doCancel(appId, jobId));
	}

	/**
	 * Start the 1-minute interval check for due tasks.
	 */
	start(): void {
		if (this.checkInterval) return;

		// Run immediately on start, then every 60 seconds
		void this.checkAndExecute();
		this.checkInterval = setInterval(() => {
			void this.checkAndExecute();
		}, 60_000);

		this.logger.info('One-off task checker started (60s interval)');
	}

	/**
	 * Stop the interval check.
	 */
	stop(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
			this.logger.info('One-off task checker stopped');
		}
	}

	/**
	 * Check for due tasks and execute them.
	 */
	async checkAndExecute(): Promise<void> {
		return this.enqueue(() => this.doCheckAndExecute());
	}

	private async doSchedule(
		appId: string,
		jobId: string,
		runAt: Date,
		handler: string,
	): Promise<void> {
		const tasks = await this.loadTasks();
		const id = `${appId}:${jobId}`;

		// Remove existing task with same ID if present
		const filtered = tasks.filter((t) => t.id !== id);

		filtered.push({
			id,
			appId,
			jobId,
			runAt,
			handler,
			createdAt: new Date(),
		});

		await this.saveTasks(filtered);
		this.logger.info({ appId, jobId, runAt: runAt.toISOString() }, 'One-off task scheduled');
	}

	private async doCancel(appId: string, jobId: string): Promise<void> {
		const tasks = await this.loadTasks();
		const id = `${appId}:${jobId}`;
		const filtered = tasks.filter((t) => t.id !== id);

		if (filtered.length < tasks.length) {
			await this.saveTasks(filtered);
			this.logger.info({ appId, jobId }, 'One-off task cancelled');
		}
	}

	private async doCheckAndExecute(): Promise<void> {
		const tasks = await this.loadTasks();
		const now = new Date();
		const due: OneOffTask[] = [];
		const remaining: OneOffTask[] = [];

		for (const task of tasks) {
			if (task.runAt <= now) {
				due.push(task);
			} else {
				remaining.push(task);
			}
		}

		if (due.length === 0) return;

		this.logger.debug({ count: due.length }, 'Executing due one-off tasks');

		for (const task of due) {
			if (this.handlerResolver) {
				const handler = this.handlerResolver(task.appId, task.handler);
				await runTask(task.appId, task.jobId, handler, this.logger);
			} else {
				this.logger.warn(
					{ appId: task.appId, jobId: task.jobId },
					'No handler resolver set, skipping one-off task',
				);
			}
		}

		// Remove executed tasks from YAML
		await this.saveTasks(remaining);
	}

	/**
	 * Get all pending tasks (for inspection/testing).
	 */
	async getPendingTasks(): Promise<OneOffTask[]> {
		return this.loadTasks();
	}

	private async loadTasks(): Promise<OneOffTask[]> {
		const data = await readYamlFile<SerializedTask[]>(this.yamlPath);
		if (!data || !Array.isArray(data)) return [];

		return data.map((t) => ({
			id: t.id,
			appId: t.appId,
			jobId: t.jobId,
			runAt: new Date(t.runAt),
			handler: t.handler,
			createdAt: new Date(t.createdAt),
		}));
	}

	private async saveTasks(tasks: OneOffTask[]): Promise<void> {
		const serialized: SerializedTask[] = tasks.map((t) => ({
			id: t.id,
			appId: t.appId,
			jobId: t.jobId,
			runAt: t.runAt.toISOString(),
			handler: t.handler,
			createdAt: t.createdAt.toISOString(),
		}));

		await writeYamlFile(this.yamlPath, serialized);
	}
}
