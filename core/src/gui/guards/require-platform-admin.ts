/**
 * requirePlatformAdmin — D5b-4.
 *
 * Fastify preHandler that rejects with a 403 template when the authenticated
 * actor is not a platform admin. Attach to any route or plugin that should be
 * restricted to platform administrators.
 *
 * Usage in a route file:
 *   import { requirePlatformAdmin } from '../../guards/require-platform-admin.js';
 *   server.get('/route', { preHandler: requirePlatformAdmin }, handler);
 *
 * Or apply globally to a prefix via addHook:
 *   server.addHook('preHandler', requirePlatformAdmin);
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export async function requirePlatformAdmin(
	request: FastifyRequest,
	reply: FastifyReply,
): Promise<void> {
	if (!request.user?.isPlatformAdmin) {
		await reply.status(403).viewAsync('403', {
			title: '403 Forbidden — PAS',
		});
	}
}
