/**
 * Bootstrap — the main entry point for the PAS system.
 *
 * Calls composeRuntime() to wire all services (Phases A–D), then runs
 * Phase E: starts external resources (Fastify, Telegraf, scheduler,
 * signal handlers, cleanup timers, init services).
 */

import { resolve } from 'node:path';
import { registerDailyDiffCron } from './bootstrap/register-daily-diff-cron.js';
import { composeRuntime } from './compose-runtime.js';
import { createChildLogger } from './services/logger/index.js';

export async function main(): Promise<void> {
	const runtime = await composeRuntime();
	const { services, bot, server, shutdownManager, logger } = runtime;

	const {
		config,
		scheduler,
		registry,
		reportService,
		alertService,
		telegramRateLimiter,
		loginRateLimiter,
		apiRateLimiter,
		webhookService,
		dailyDiff,
		n8nDispatcher,
	} = services;

	// Phase E: start external resources

	// 13c. Outbound webhooks — init event-bus subscriptions
	if (webhookService) webhookService.init();

	// Start Fastify server
	await server.listen({ port: config.port, host: '0.0.0.0' });

	// Webhook mode (production) vs polling mode (local dev)
	const webhookUrl = process.env.WEBHOOK_URL;
	if (webhookUrl) {
		const webhookSecret =
			process.env.TELEGRAM_WEBHOOK_SECRET ||
			(await import('node:crypto'))
				.createHash('sha256')
				.update(`pas-webhook:${config.telegram.botToken}`)
				.digest('hex')
				.slice(0, 64);
		await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret });
		logger.info({ url: webhookUrl }, 'Webhook registered with Telegram');
	} else {
		// Local dev: use long polling so no tunnel is needed
		await bot.api.deleteWebhook();
		bot.start({
			onStart: () => logger.info('Bot started in long-polling mode (no WEBHOOK_URL set)'),
		});
	}

	// 14. Register daily diff cron (runs at 2am daily)
	registerDailyDiffCron({
		cronManager: scheduler.cron,
		dailyDiff,
		n8nDispatcher,
		logger,
	});

	// 14b. Register system backup cron job (if enabled)
	if (config.backup.enabled) {
		const { BackupService } = await import('./services/backup/index.js');
		const backupService = new BackupService({
			dataDir: config.dataDir,
			configDir: resolve('config'),
			backupPath: config.backup.path,
			retentionCount: config.backup.retentionCount,
			logger: createChildLogger(logger, { service: 'backup' }),
		});
		scheduler.cron.register(
			{
				id: 'system-backup',
				appId: 'system',
				cron: config.backup.schedule,
				handler: 'system-backup',
				description: 'Backup data and config directories',
				userScope: 'system',
			},
			() => async () => {
				const path = await backupService.createBackup();
				if (path) logger.info({ path }, 'System backup saved');
			},
		);
	}

	// 14d. Load and register report cron jobs
	await reportService.init();

	// 14e. Load and register alert cron jobs
	await alertService.init();

	// 15. Start scheduler
	scheduler.start();

	logger.info({ port: config.port, apps: registry.getLoadedAppIds() }, 'PAS started successfully');

	// Start rate limiter cleanup timers
	telegramRateLimiter.startCleanup();
	loginRateLimiter.startCleanup();
	if (apiRateLimiter) apiRateLimiter.startCleanup();

	// 17. Graceful shutdown — register signal handlers
	shutdownManager.register();
}

// Entry point when run directly
main().catch((err) => {
	// biome-ignore lint/suspicious/noConsole: Logger not available before bootstrap
	console.error('Fatal startup error:', err);
	process.exit(1);
});
