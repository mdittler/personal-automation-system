/**
 * Health check route.
 *
 * GET /health — returns system status for monitoring.
 */

import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance): void {
	app.get('/health', async () => {
		return {
			status: 'ok',
			uptime: process.uptime(),
		};
	});
}
