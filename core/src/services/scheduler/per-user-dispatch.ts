/**
 * Per-user and per-household scheduled-job dispatch.
 *
 * Bridges the manifest's `user_scope` declaration to the concrete invocation
 * of an app's `handleScheduledJob`. For `user_scope: all` schedules, the
 * handler is invoked once per registered user, each call wrapped in a
 * `requestContext.run({ userId, householdId }, ...)` scope so that
 * `services.config.get` transparently returns that user's overrides and
 * `forUser()` / `forShared()` route to the correct household directory.
 *
 * For `user_scope: shared`:
 * - When `householdService` is wired (post-migration): iterates
 *   `householdService.listHouseholds()` and invokes the handler once per
 *   household inside `requestContext.run({ householdId }, ...)`. This lets
 *   shared-job handlers call `services.data.forShared(...)` and route to
 *   the correct per-household directory. Per-household failures are isolated
 *   (one failing household does not abort siblings — URS-SCH-005).
 * - When `householdService` is absent (transitional / legacy): invokes the
 *   handler once globally with no context (legacy behavior preserved).
 *
 * For `user_scope: system`, the handler is always invoked once with no
 * context. These are infrastructure jobs (backups, catalog refresh) that
 * must use `forSystem()`, not `forShared()`.
 *
 * Per-user/per-household iteration failures are isolated: one failing entry
 * does not abort the loop for siblings, mirroring the existing task-runner
 * contract (one failed job must not block sibling jobs — URS-SCH-005).
 */

import type { Logger } from 'pino';
import { requestContext } from '../context/request-context.js';
import type { HouseholdService } from '../household/index.js';
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
	/**
	 * Optional — when present:
	 * - For `user_scope: all`: householdId is derived per-user and injected into context.
	 * - For `user_scope: shared`: households are listed and the job runs once per household.
	 */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser' | 'listHouseholds'>;
}

/**
 * Build the TaskHandler that the cron runner will invoke.
 *
 * See module-level JSDoc for full dispatch semantics.
 */
export function buildScheduledJobHandler(opts: BuildScheduledJobHandlerOptions): TaskHandler {
	const { appId, jobId, userScope, appModule, userProvider, logger, householdService } = opts;

	return async () => {
		if (!appModule.handleScheduledJob) return;

		if (userScope === 'all') {
			// Per-user dispatch: iterate all registered users.
			const users = userProvider.getAllUsers();
			if (users.length === 0) {
				logger.info({ appId, jobId }, 'Per-user scheduled job has no users to dispatch to');
				return;
			}

			for (const user of users) {
				try {
					const householdId = householdService?.getHouseholdForUser(user.id) ?? undefined;
					await requestContext.run({ userId: user.id, householdId }, () =>
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
			return;
		}

		if (userScope === 'shared' && householdService) {
			// R1: Per-household shared dispatch (post-migration).
			// Runs the handler once per household so forShared() routes to the
			// correct household directory via getCurrentHouseholdId().
			const households = householdService.listHouseholds();
			for (const hh of households) {
				try {
					await requestContext.run({ householdId: hh.id }, () =>
						appModule.handleScheduledJob!(jobId),
					);
				} catch (err) {
					logger.error(
						{
							appId,
							jobId,
							householdId: hh.id,
							error: err instanceof Error ? err.message : String(err),
						},
						'Shared scheduled job invocation failed for household',
					);
				}
			}
			return;
		}

		// user_scope: shared (legacy/transitional — no householdService) or user_scope: system:
		// single invocation with no context. Errors propagate to the task runner.
		await appModule.handleScheduledJob(jobId);
	};
}
