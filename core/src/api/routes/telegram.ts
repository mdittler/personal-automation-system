/**
 * Telegram send API endpoint.
 *
 * Sends messages via PAS's Telegram bot to registered users.
 * - POST /telegram/send — send a message to a user
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { assertCallerIsTargetUser } from '../guards/authorize-target.js';
import { requireScope } from '../guards/require-scope.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { TelegramService } from '../../types/telegram.js';

const MAX_MESSAGE_LENGTH = 4096;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface TelegramRouteOptions {
	telegram: TelegramService;
	userManager: UserManager;
	logger: Logger;
}

interface TelegramSendBody {
	userId?: string;
	message?: string;
}

export function registerTelegramRoute(
	server: FastifyInstance,
	options: TelegramRouteOptions,
): void {
	const { telegram, userManager, logger } = options;

	server.post('/telegram/send', { preHandler: [requireScope('telegram:send')] }, async (request, reply) => {
		const body = request.body as TelegramSendBody | undefined;

		if (!body?.userId) {
			return reply.status(400).send({ ok: false, error: 'Missing required field: userId' });
		}

		if (!body.message || typeof body.message !== 'string') {
			return reply.status(400).send({ ok: false, error: 'Missing required field: message' });
		}

		const { userId, message } = body;

		// Validate userId format
		if (!USER_ID_PATTERN.test(userId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid userId format.' });
		}

		// Validate message
		if (message.trim().length === 0) {
			return reply.status(400).send({ ok: false, error: 'Message must not be empty.' });
		}

		if (message.length > MAX_MESSAGE_LENGTH) {
			return reply.status(400).send({
				ok: false,
				error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.`,
			});
		}

		// Validate user is registered
		if (!userManager.isRegistered(userId)) {
			return reply.status(403).send({ ok: false, error: 'Unregistered user.' });
		}

		// D5b-7: per-user key may only send Telegram messages on behalf of its own userId
		if (request.actor && !assertCallerIsTargetUser(request.actor, userId)) {
			return reply.status(403).send({ ok: false, error: 'Access denied.' });
		}

		try {
			await telegram.send(userId, message);

			logger.info({ userId, messageLength: message.length }, 'API telegram message sent');

			return reply.send({ ok: true, sent: true });
		} catch (err) {
			logger.error({ err, userId }, 'API telegram send failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
