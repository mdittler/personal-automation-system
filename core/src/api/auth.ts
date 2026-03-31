/**
 * API Bearer token authentication.
 *
 * Validates `Authorization: Bearer <token>` header using timing-safe
 * comparison. Rate limits by client IP before auth check.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimiter } from '../middleware/rate-limiter.js';

export interface ApiAuthOptions {
	apiToken: string;
	rateLimiter: RateLimiter;
}

/**
 * Create a Fastify onRequest hook that validates Bearer token auth.
 */
export function createApiAuthHook(options: ApiAuthOptions) {
	const { apiToken, rateLimiter } = options;
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

		const submittedBuf = Buffer.from(token);
		const isValid =
			submittedBuf.length === expectedBuf.length && timingSafeEqual(submittedBuf, expectedBuf);

		if (!isValid) {
			return reply.status(401).send({ ok: false, error: 'Invalid API token.' });
		}
	};
}
