/**
 * Per-user scheduled-job dispatch.
 *
 * Bridges the manifest's `user_scope` declaration to the concrete invocation
 * of an app's `handleScheduledJob`. For `user_scope: all` schedules, the
 * handler is invoked once per registered user, each call wrapped in a
 * `requestContext.run({ userId }, ...)` scope so that `services.config.get`
 * transparently returns that user's overrides.
 *
 * For `user_scope: shared` and `user_scope: system`, the handler is invoked
 * once with no userId (legacy behavior preserved).
 *
 * Per-user iteration failures are isolated: one user throwing does not
 * abort the loop for other users, mirroring the existing task-runner
 * contract (one failed job must not block sibling jobs — URS-SCH-005).
 */

import type { Logger } from 'pino';
import { requestContext } from '../context/request-context.js';
import type { TaskHandler } from './task-runner.js';

/**
 * The subset of AppModule used here, narrowed for testability.
 */
export interface ScheduledJobAppModule {
	handleScheduledJob?: (jobId: string, userId?: string) => Promise<void>;
}

/**
 * The subset of UserManager used here, narrowed for testability.
 */
export interface ScheduledJobUserProvider {
	getAllUsers(): ReadonlyArray<{ id: string }>;
}

export interface BuildScheduledJobHandlerOptions {
	appId: string;
	jobId: string;
	userScope: 'all' | 'shared' | 'system';
	appModule: ScheduledJobAppModule;
	userProvider: ScheduledJobUserProvider;
	logger: Logger;
}

/**
 * Build the TaskHandler that the cron runner will invoke.
 *
 * - `user_scope: all` → iterates `userProvider.getAllUsers()` and calls the
 *   handler once per user inside `requestContext.run({ userId }, ...)`.
 *   Per-user errors are caught, logged, and do not abort the loop.
 * - `user_scope: shared` / `user_scope: system` → calls the handler once
 *   with no userId. Errors propagate to the task runner as before.
 */
export function buildScheduledJobHandler(opts: BuildScheduledJobHandlerOptions): TaskHandler {
	const { appId, jobId, userScope, appModule, userProvider, logger } = opts;

	return async () => {
		if (!appModule.handleScheduledJob) return;

		if (userScope !== 'all') {
			await appModule.handleScheduledJob(jobId);
			return;
		}

		const users = userProvider.getAllUsers();
		if (users.length === 0) {
			logger.info({ appId, jobId }, 'Per-user scheduled job has no users to dispatch to');
			return;
		}

		for (const user of users) {
			try {
				await requestContext.run({ userId: user.id }, () =>
					appModule.handleScheduledJob!(jobId, user.id),
				);
			} catch (err) {
				logger.error(
					{
						appId,
						jobId,
						userId: user.id,
						error: err instanceof Error ? err.message : String(err),
					},
					'Per-user scheduled job invocation failed for user',
				);
			}
		}
	};
}
