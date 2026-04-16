/**
 * API scope enforcement preHandler.
 *
 * Rejects with 403 when the authenticated actor does not carry the required scope.
 * Bypasses for platform-admin and legacy-api-token actors (scope: ['*']).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

type PreHandlerFn = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Returns a Fastify preHandler that enforces the given scope.
 *
 * Must run after the auth hook (onRequest) which sets request.actor.
 */
export function requireScope(scope: string): PreHandlerFn {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.actor;
		if (!actor) {
			return reply.status(401).send({ ok: false, error: 'Unauthenticated.' });
		}
		const scopes = actor.scopes ?? [];
		if (!scopes.includes('*') && !scopes.includes(scope)) {
			return reply
				.status(403)
				.send({ ok: false, error: `Missing required scope: ${scope}` });
		}
	};
}
