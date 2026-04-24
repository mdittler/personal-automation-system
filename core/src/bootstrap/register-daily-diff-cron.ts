import type { Logger } from 'pino';
import type { DailyDiffService } from '../services/daily-diff/index.js';
import type { N8nDispatcher } from '../services/n8n/index.js';
import type { CronManager } from '../services/scheduler/cron-manager.js';

export interface RegisterDailyDiffCronOptions {
	cronManager: CronManager;
	dailyDiff: Pick<DailyDiffService, 'run'>;
	n8nDispatcher: N8nDispatcher;
	logger: Logger;
}

export function registerDailyDiffCron(options: RegisterDailyDiffCronOptions): void {
	const { cronManager, dailyDiff, n8nDispatcher, logger } = options;

	cronManager.register(
		{
			id: 'daily-diff',
			appId: 'system',
			cron: '0 2 * * *',
			handler: 'daily-diff',
			description: 'Generate daily diff report from change log',
			userScope: 'system',
		},
		() => async () => {
			if (n8nDispatcher.enabled) {
				const dispatched = await n8nDispatcher.dispatch({
					type: 'daily_diff',
					id: 'daily-diff',
					action: 'run',
				});
				if (dispatched) return;
				logger.info('n8n dispatch failed for daily-diff, running internally');
			}
			await dailyDiff.run();
		},
	);
}
