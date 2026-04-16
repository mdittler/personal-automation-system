/**
 * API Bearer token authentication.
 *
 * Validates `Authorization: Bearer <token>` header. Accepts:
 *   1. Legacy `API_TOKEN` env var → platform-system actor with scopes: ['*']
 *   2. Per-user key (format: `pas_<keyId>_<rawSecret>`) → per-user actor
 *
 * Sets `request.actor` and calls `enterRequestContext({userId, householdId})`
 * so ALS-based consumers work correctly within the handler.
 *
 * Rate limits by client IP before auth check.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiKeyService } from '../services/api-keys/index.js';
import { enterRequestContext } from '../services/context/request-context.js';
import type { HouseholdService } from '../services/household/index.js';
import type { UserManager } from '../services/user-manager/index.js';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import type { AuthenticatedActor } from '../types/auth-actor.js';

export interface ApiAuthOptions {
	apiToken: string;
	rateLimiter: RateLimiter;
	/** When provided, per-user API keys are accepted in addition to the legacy API_TOKEN. */
	apiKeyService?: ApiKeyService;
	/** Required when apiKeyService is provided — used to resolve household + admin status. */
	userManager?: UserManager;
	/** Required when apiKeyService is provided — used to rehydrate household at verify time. */
	householdService?: HouseholdService;
}

/**
 * Create a Fastify onRequest hook that validates Bearer token auth.
 *
 * On success: sets `request.actor` and enters the ALS request context.
 * On failure: returns 401.
 */
export function createApiAuthHook(options: ApiAuthOptions) {
	const { apiToken, rateLimiter, apiKeyService, userManager, householdService } = options;
	const expectedBuf = Buffer.from(apiToken);

	return async (request: FastifyRequest, reply: FastifyReply) => {
		// Rate limit by IP before checking auth
		const clientIp = request.ip;
		if (!rateLimiter.isAllowed(clientIp)) {
			return reply
				.status(429)
				.send({ ok: false, error: 'Too many requests. Please try again later.' });
		}

		const authHeader = request.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return reply
				.status(401)
				.send({ ok: false, error: 'Missing or invalid Authorization header.' });
		}

		const token = authHeader.slice(7);
		if (!token) {
			return reply
				.status(401)
				.send({ ok: false, error: 'Missing or invalid Authorization header.' });
		}

		// --- Path 1: legacy API_TOKEN (timing-safe) ---
		const submittedBuf = Buffer.from(token);
		const isLegacy =
			apiToken.length > 0 &&
			submittedBuf.length === expectedBuf.length &&
			timingSafeEqual(submittedBuf, expectedBuf);

		if (isLegacy) {
			const actor: AuthenticatedActor = {
				userId: '__platform_system__',
				householdId: '__platform__',
				isPlatformAdmin: true,
				isHouseholdAdmin: false,
				authMethod: 'legacy-api-token',
				scopes: ['*'],
			};
			request.actor = actor;
			enterRequestContext({ userId: '__platform_system__', householdId: '__platform__' });
			return;
		}

		// --- Path 2: per-user API key (pas_<keyId>_<rawSecret>) ---
		if (apiKeyService && token.startsWith('pas_')) {
			const record = await apiKeyService.verifyAndConsume(token);
			if (!record) {
				return reply.status(401).send({ ok: false, error: 'Invalid or expired API key.' });
			}

			// Rehydrate user + household from current service state (never from the stored record)
			const user = userManager?.getUser(record.userId) ?? null;
			if (!user) {
				return reply
					.status(401)
					.send({ ok: false, error: 'API key owner no longer exists.' });
			}

			const resolvedHouseholdId =
				householdService?.getHouseholdForUser(record.userId) ?? '__platform__';
			const household = householdService?.getHousehold(resolvedHouseholdId) ?? null;
			const isHouseholdAdmin = household?.adminUserIds?.includes(record.userId) ?? false;

			const actor: AuthenticatedActor = {
				userId: record.userId,
				householdId: resolvedHouseholdId,
				isPlatformAdmin: (user as { isAdmin?: boolean }).isAdmin === true,
				isHouseholdAdmin,
				authMethod: 'api-key',
				scopes: record.scopes,
			};
			request.actor = actor;
			enterRequestContext({ userId: record.userId, householdId: resolvedHouseholdId });
			return;
		}

		// --- Nothing matched ---
		return reply.status(401).send({ ok: false, error: 'Invalid API token.' });
	};
}
