/**
 * Telegram webhook route.
 *
 * POST /webhook/telegram — receives Telegram Update objects
 * from the Telegram Bot API and passes them to the grammY bot.
 *
 * When a webhookSecret is provided, validates the
 * X-Telegram-Bot-Api-Secret-Token header to ensure the request
 * actually came from the Telegram API.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

export interface WebhookRouteOptions {
	webhookCallback: (update: unknown) => Promise<void>;
	logger: Logger;
	/** Secret token for webhook authentication. If set, validates the header. */
	webhookSecret?: string;
}

export function registerWebhookRoute(app: FastifyInstance, options: WebhookRouteOptions): void {
	app.post('/webhook/telegram', async (request: FastifyRequest, reply: FastifyReply) => {
		// Validate webhook secret if configured
		if (options.webhookSecret) {
			const headerSecret = request.headers['x-telegram-bot-api-secret-token'];
			if (typeof headerSecret !== 'string') {
				options.logger.warn('Webhook request with missing secret token');
				return reply.status(401).send({ ok: false });
			}

			const headerBuf = Buffer.from(headerSecret);
			const secretBuf = Buffer.from(options.webhookSecret);
			if (headerBuf.length !== secretBuf.length || !timingSafeEqual(headerBuf, secretBuf)) {
				options.logger.warn('Webhook request with invalid secret token');
				return reply.status(401).send({ ok: false });
			}
		}

		try {
			await options.webhookCallback(request.body);
		} catch (error) {
			// Log but don't fail — Telegram retries on non-200 responses
			options.logger.error({ error }, 'Webhook handler error');
		}

		// Always return 200 to acknowledge receipt
		return { ok: true };
	});
}
