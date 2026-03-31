import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoute } from '../health.js';

describe('GET /health', () => {
	it('should return 200 with status ok', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.status).toBe('ok');
		expect(typeof body.uptime).toBe('number');

		await app.close();
	});

	it('should return application/json content type', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		expect(response.headers['content-type']).toContain('application/json');

		await app.close();
	});

	it('should return uptime as a non-negative number', async () => {
		const app = Fastify({ logger: false });
		registerHealthRoute(app);

		const response = await app.inject({
			method: 'GET',
			url: '/health',
		});

		const body = response.json();
		expect(body.uptime).toBeGreaterThanOrEqual(0);

		await app.close();
	});
});
