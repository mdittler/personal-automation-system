/**
 * API key self-service management routes (D5b-8).
 *
 * All routes operate on the authenticated actor's own keys only.
 *
 * - GET  /account/api-keys             — list own API keys
 * - POST /account/api-keys             — create a new API key (one-time reveal)
 * - POST /account/api-keys/:keyId/revoke — revoke own key
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ApiKeyService } from '../../services/api-keys/index.js';

/** Available scope names for API keys. */
const AVAILABLE_SCOPES = [
	'data:read',
	'data:write',
	'messages:send',
	'telegram:send',
	'reports:read',
	'reports:run',
	'alerts:read',
	'alerts:run',
	'schedules:read',
	'llm:complete',
] as const;

const KEY_ID_PATTERN = /^[a-zA-Z0-9]+$/;

export interface ApiKeyRoutesOptions {
	apiKeyService: ApiKeyService;
	logger: Logger;
}

export function registerApiKeyRoutes(
	server: FastifyInstance,
	options: ApiKeyRoutesOptions,
): void {
	const { apiKeyService, logger } = options;

	// -------------------------------------------------------------------------
	// GET /account/api-keys — list own keys (redacted, no secret)
	// -------------------------------------------------------------------------
	server.get('/account/api-keys', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const keys = await apiKeyService.listKeysForUser(user.userId);

		return reply.viewAsync('account/api-keys', {
			title: 'API Keys — PAS',
			activePage: 'account',
			keys,
			availableScopes: AVAILABLE_SCOPES,
			newKey: null,
			error: null,
		});
	});

	// -------------------------------------------------------------------------
	// POST /account/api-keys — create a new key (one-time reveal)
	// -------------------------------------------------------------------------
	server.post('/account/api-keys', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const body = request.body as {
			label?: string;
			scopes?: string | string[];
			expiresAt?: string;
		};

		// Normalise scopes: may come as a single string or array from form checkboxes
		const rawScopes = body.scopes;
		const scopeArray: string[] = rawScopes
			? Array.isArray(rawScopes)
				? rawScopes
				: [rawScopes]
			: [];

		// Only allow known scopes
		const validScopes = scopeArray.filter((s): s is (typeof AVAILABLE_SCOPES)[number] =>
			(AVAILABLE_SCOPES as readonly string[]).includes(s),
		);

		if (validScopes.length === 0) {
			const keys = await apiKeyService.listKeysForUser(user.userId);
			return reply.status(400).viewAsync('account/api-keys', {
				title: 'API Keys — PAS',
				activePage: 'account',
				keys,
				availableScopes: AVAILABLE_SCOPES,
				newKey: null,
				error: 'Select at least one scope.',
			});
		}

		const label = body.label?.trim() || undefined;
		const expiresAt = body.expiresAt?.trim() || undefined;

		const { keyId, fullToken } = await apiKeyService.createKey(user.userId, {
			scopes: validScopes,
			label,
			expiresAt,
		});

		logger.info({ userId: user.userId, keyId, scopes: validScopes }, 'API key created');

		const keys = await apiKeyService.listKeysForUser(user.userId);

		// Show the full token only this once — it is never recoverable after this response.
		return reply.viewAsync('account/api-keys', {
			title: 'API Keys — PAS',
			activePage: 'account',
			keys,
			availableScopes: AVAILABLE_SCOPES,
			newKey: { keyId, fullToken },
			error: null,
		});
	});

	// -------------------------------------------------------------------------
	// POST /account/api-keys/:keyId/revoke — revoke own key
	// -------------------------------------------------------------------------
	server.post(
		'/account/api-keys/:keyId/revoke',
		async (request: FastifyRequest, reply: FastifyReply) => {
			const user = request.user;
			if (!user) return reply.redirect('/gui/login');

			const { keyId } = request.params as { keyId: string };

			if (!KEY_ID_PATTERN.test(keyId)) {
				return reply.status(400).type('text/html').send('Invalid key ID format.');
			}

			// Verify the key belongs to the authenticated user before revoking
			const userKeys = await apiKeyService.listKeysForUser(user.userId);
			const ownKey = userKeys.find((k) => k.keyId === keyId);
			if (!ownKey) {
				// Either not found or belongs to another user — both return 403
				return reply.status(403).type('text/html').send('Access denied.');
			}

			await apiKeyService.revokeKey(keyId);
			logger.info({ userId: user.userId, keyId }, 'API key revoked');

			return reply.redirect('/gui/account/api-keys');
		},
	);
}
