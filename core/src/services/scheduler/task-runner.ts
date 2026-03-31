/**
 * Task runner for scheduled job execution.
 *
 * Wraps handler execution in try/catch for isolation. On failure,
 * logs the error. Failed jobs don't prevent other jobs from running
 * (URS-SCH-005).
 */

import type { Logger } from 'pino';
import type { JobExecutionResult } from '../../types/scheduler.js';

/** A handler function that can be executed by the task runner. */
export type TaskHandler = () => Promise<void>;

/**
 * Execute a task handler with error isolation.
 */
export async function runTask(
	appId: string,
	jobId: string,
	handler: TaskHandler,
	logger: Logger,
): Promise<JobExecutionResult> {
	const startedAt = new Date();

	try {
		await handler();
		const completedAt = new Date();

		logger.info(
			{ appId, jobId, durationMs: completedAt.getTime() - startedAt.getTime() },
			'Scheduled job completed successfully',
		);

		return {
			jobId,
			appId,
			startedAt,
			completedAt,
			success: true,
		};
	} catch (err) {
		const completedAt = new Date();
		const errorMessage = err instanceof Error ? err.message : String(err);

		logger.error(
			{
				appId,
				jobId,
				error: errorMessage,
				durationMs: completedAt.getTime() - startedAt.getTime(),
			},
			'Scheduled job failed',
		);

		return {
			jobId,
			appId,
			startedAt,
			completedAt,
			success: false,
			error: errorMessage,
		};
	}
}
