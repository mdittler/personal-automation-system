/**
 * Health check routes.
 *
 * GET /health       — legacy, always 200. Returns {status:'ok', uptime}.
 * GET /health/live  — always 200. Returns {status:'ok', uptime}.
 * GET /health/ready — runs all health checks. Returns 200 if all essential
 *                     checks pass, 503 if an essential check (telegram or
 *                     filesystem) fails.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthChecker } from './health-checks.js';

/** Essential checks — failure here → HTTP 503. */
const ESSENTIAL_CHECKS = new Set(['telegram', 'filesystem']);

export function registerHealthRoute(app: FastifyInstance, checker?: HealthChecker): void {
	// Legacy endpoint — unchanged.
	app.get('/health', async () => {
		return {
			status: 'ok',
			uptime: process.uptime(),
		};
	});

	// Liveness probe — always 200.
	app.get('/health/live', async () => {
		return {
			status: 'ok',
			uptime: process.uptime(),
		};
	});

	// Readiness probe — runs dependency checks when a checker is provided.
	app.get('/health/ready', async (_req, reply) => {
		const uptime = process.uptime();

		if (!checker) {
			return reply.status(200).send({ status: 'ok', uptime });
		}

		const { checks } = await checker.checkAll();

		const essentialFailed = checks.some((c) => c.status === 'fail' && ESSENTIAL_CHECKS.has(c.name));

		const status = essentialFailed ? 'degraded' : 'ok';
		const httpStatus = essentialFailed ? 503 : 200;

		return reply.status(httpStatus).send({ status, uptime, checks });
	});
}
