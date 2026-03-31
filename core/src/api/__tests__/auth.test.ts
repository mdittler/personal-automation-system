import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { createApiAuthHook } from '../auth.js';

const API_TOKEN = 'test-api-secret';

function buildApp(rateLimiter?: RateLimiter) {
	const app = Fastify({ logger: false });
	const limiter = rateLimiter ?? new RateLimiter({ maxAttempts: 100, windowMs: 60_000 });

	app.register(
		async (api) => {
			api.addHook('onRequest', createApiAuthHook({ apiToken: API_TOKEN, rateLimiter: limiter }));
			api.get('/test', async () => ({ ok: true }));
		},
		{ prefix: '/api' },
	);

	return app;
}

describe('API Auth', () => {
	let app: ReturnType<typeof buildApp>;

	beforeEach(() => {
		app = buildApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('valid token returns 200', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});

	it('missing Authorization header returns 401', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/test' });
		expect(res.statusCode).toBe(401);
		expect(res.json().ok).toBe(false);
	});

	it('wrong prefix (no "Bearer ") returns 401', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: `Basic ${API_TOKEN}` },
		});
		expect(res.statusCode).toBe(401);
	});

	it('empty token after Bearer returns 401', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: 'Bearer ' },
		});
		expect(res.statusCode).toBe(401);
	});

	it('wrong token returns 401', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: 'Bearer wrong-token' },
		});
		expect(res.statusCode).toBe(401);
		expect(res.json().error).toBe('Invalid API token.');
	});

	it('rate limit exceeded returns 429', async () => {
		const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });
		const rateLimitedApp = buildApp(limiter);

		// First request succeeds
		const res1 = await rateLimitedApp.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
		expect(res1.statusCode).toBe(200);

		// Second request rate limited
		const res2 = await rateLimitedApp.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
		expect(res2.statusCode).toBe(429);

		await rateLimitedApp.close();
	});

	it('rate limit check runs before auth', async () => {
		const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 60_000 });
		const rateLimitedApp = buildApp(limiter);

		// First request with wrong token uses up a rate limit slot
		await rateLimitedApp.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: 'Bearer wrong' },
		});

		// Second request with correct token is still rate limited
		const res = await rateLimitedApp.inject({
			method: 'GET',
			url: '/api/test',
			headers: { authorization: `Bearer ${API_TOKEN}` },
		});
		expect(res.statusCode).toBe(429);

		await rateLimitedApp.close();
	});
});
