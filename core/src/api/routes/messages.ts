/**
 * Message dispatch API endpoint.
 *
 * Accepts JSON payloads to dispatch text messages through PAS's router.
 * The router classifies and routes to apps; responses are sent to the
 * user's Telegram DM.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { assertCallerIsTargetUser } from '../guards/authorize-target.js';
import { requireScope } from '../guards/require-scope.js';
import { requestContext } from '../../services/context/request-context.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { Router } from '../../services/router/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { MessageContext } from '../../types/telegram.js';

const MAX_TEXT_LENGTH = 4096;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface MessagesRouteOptions {
	router: Router;
	userManager: UserManager;
	logger: Logger;
	/** Optional — when present, householdId is derived and injected into context. */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
}

interface MessagesRequestBody {
	userId?: string;
	text?: string;
}

export function registerMessagesRoute(
	server: FastifyInstance,
	options: MessagesRouteOptions,
): void {
	const { router, userManager, logger, householdService } = options;

	server.post('/messages', { preHandler: [requireScope('messages:send')] }, async (request, reply) => {
		const body = request.body as MessagesRequestBody | undefined;

		// Validate required fields
		if (!body?.userId) {
			return reply.status(400).send({ ok: false, error: 'Missing required field: userId' });
		}
		if (!body.text || typeof body.text !== 'string') {
			return reply.status(400).send({ ok: false, error: 'Missing required field: text' });
		}

		const { userId, text } = body;

		// Validate userId format (defense-in-depth)
		if (!USER_ID_PATTERN.test(userId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid userId format.' });
		}

		// Validate text length
		if (text.trim().length === 0) {
			return reply.status(400).send({ ok: false, error: 'Text must not be empty.' });
		}
		if (text.length > MAX_TEXT_LENGTH) {
			return reply.status(400).send({
				ok: false,
				error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters.`,
			});
		}

		// Validate user is registered
		if (!userManager.isRegistered(userId)) {
			return reply.status(403).send({ ok: false, error: 'Unregistered user.' });
		}

		// D5b-7: per-user key may only dispatch messages on behalf of its own userId
		if (request.actor && !assertCallerIsTargetUser(request.actor, userId)) {
			return reply.status(403).send({ ok: false, error: 'Access denied.' });
		}

		try {
			const ctx: MessageContext = {
				userId,
				text,
				timestamp: new Date(),
				chatId: 0,
				messageId: 0,
			};

			// Wrap in request context for per-user cost attribution + household boundary
			const householdId = householdService?.getHouseholdForUser(userId) ?? undefined;
			await requestContext.run({ userId, householdId }, () => router.routeMessage(ctx));

			logger.info({ userId, textLength: text.length }, 'API message dispatched');

			return reply.send({ ok: true, dispatched: true });
		} catch (err) {
			logger.error({ err, userId }, 'API message dispatch failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
