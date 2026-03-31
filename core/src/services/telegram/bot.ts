/**
 * grammY Bot setup for webhook mode.
 *
 * Creates and configures the grammY Bot instance.
 * No bot.start() — we use webhook mode, feeding updates
 * via the Fastify webhook route.
 */

import { Bot } from 'grammy';
import type { Logger } from 'pino';

export interface BotOptions {
	token: string;
	logger: Logger;
}

/**
 * Create a grammY Bot instance configured for webhook mode.
 * Does NOT call bot.start() — updates are fed via handleUpdate().
 */
export function createBot(options: BotOptions): Bot {
	const bot = new Bot(options.token);

	// Global error handler — log and continue
	bot.catch((err) => {
		options.logger.error({ error: err.message ?? err.error ?? err }, 'Bot middleware error');
	});

	return bot;
}

/**
 * Create a webhook callback that processes a raw Telegram Update object.
 * Used by the Fastify webhook route.
 */
export function createWebhookCallback(bot: Bot): (update: unknown) => Promise<void> {
	return async (update: unknown) => {
		// grammY's handleUpdate expects the Update type from Telegram
		await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
	};
}
