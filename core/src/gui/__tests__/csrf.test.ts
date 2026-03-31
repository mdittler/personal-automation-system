import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormBody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCsrfProtection } from '../csrf.js';

const COOKIE_SECRET = 'test-cookie-secret-at-least-32-chars';
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

/**
 * Build a minimal Fastify app with CSRF protection enabled.
 * Includes a GET route (sets CSRF cookie) and a POST route (validates CSRF).
 */
async function buildApp(): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });

	await app.register(fastifyCookie, { secret: COOKIE_SECRET });
	await app.register(fastifyFormBody);

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
	});

	await app.register(
		async (gui) => {
			await registerCsrfProtection(gui);

			// Test GET route — should set CSRF cookie
			gui.get('/page', async (request, reply) => {
				const token = (request as unknown as Record<string, unknown>).csrfToken as string;
				return reply.send({ csrfToken: token });
			});

			// Test POST route — should validate CSRF
			gui.post('/action', async (_request, reply) => {
				return reply.send({ ok: true });
			});

			// Public route — CSRF should be skipped
			gui.get('/public/asset', async (_request, reply) => {
				return reply.send({ public: true });
			});

			// Login route — CSRF should be skipped for POST
			gui.post('/login', async (_request, reply) => {
				return reply.send({ logged: true });
			});
		},
		{ prefix: '/gui' },
	);

	return app;
}

/** Extract the signed CSRF cookie from a GET response. */
function extractCsrfCookie(res: { cookies: Array<{ name: string; value: string }> }):
	| string
	| undefined {
	return res.cookies.find((c) => c.name === 'pas_csrf')?.value;
}

describe('CSRF Protection', () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await buildApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('GET request sets CSRF cookie', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/page' });
		expect(res.statusCode).toBe(200);
		const csrfCookie = extractCsrfCookie(res);
		expect(csrfCookie).toBeDefined();
	});

	it('GET request returns CSRF token on request object', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/page' });
		const body = JSON.parse(res.body);
		expect(body.csrfToken).toBeDefined();
		expect(typeof body.csrfToken).toBe('string');
		expect(body.csrfToken.length).toBe(64); // 32 bytes hex = 64 chars
	});

	it('POST with valid CSRF token via header succeeds', async () => {
		// First GET to obtain the CSRF cookie and token
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);
		const { csrfToken } = JSON.parse(getRes.body);

		// POST with the token in header and cookie
		const postRes = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'x-csrf-token': csrfToken,
				cookie: `pas_csrf=${csrfCookie}`,
			},
		});
		expect(postRes.statusCode).toBe(200);
		expect(JSON.parse(postRes.body)).toEqual({ ok: true });
	});

	it('POST with valid CSRF token via body field succeeds', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);
		const { csrfToken } = JSON.parse(getRes.body);

		const postRes = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				cookie: `pas_csrf=${csrfCookie}`,
			},
			payload: `_csrf=${csrfToken}`,
		});
		expect(postRes.statusCode).toBe(200);
	});

	it('reuses existing CSRF cookie on subsequent GET requests', async () => {
		const res1 = await app.inject({ method: 'GET', url: '/gui/page' });
		const cookie1 = extractCsrfCookie(res1);

		// Second request with existing cookie should reuse it
		const res2 = await app.inject({
			method: 'GET',
			url: '/gui/page',
			cookies: { pas_csrf: cookie1 ?? '' },
		});

		// Should still succeed
		expect(res2.statusCode).toBe(200);
	});

	it('rejects POST without CSRF cookie', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: { 'x-csrf-token': 'some-token' },
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('CSRF token missing');
	});

	it('rejects POST without CSRF token in header or body', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: { cookie: `pas_csrf=${csrfCookie}` },
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('CSRF token not provided');
	});

	it('rejects POST with mismatched CSRF token', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'x-csrf-token': 'wrong-token-value-that-does-not-match',
				cookie: `pas_csrf=${csrfCookie}`,
			},
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('CSRF token mismatch');
	});

	it('rejects POST with invalid (unsigned) CSRF cookie', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'x-csrf-token': 'some-token',
				cookie: 'pas_csrf=tampered-unsigned-value',
			},
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('Invalid CSRF cookie');
	});

	it('rejects POST with empty string CSRF token', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'x-csrf-token': '',
				cookie: `pas_csrf=${csrfCookie}`,
			},
		});
		expect(res.statusCode).toBe(403);
	});

	it('allows token reuse across multiple POSTs', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);
		const { csrfToken } = JSON.parse(getRes.body);

		const headers = {
			'x-csrf-token': csrfToken,
			cookie: `pas_csrf=${csrfCookie}`,
		};

		const res1 = await app.inject({ method: 'POST', url: '/gui/action', headers });
		expect(res1.statusCode).toBe(200);

		const res2 = await app.inject({ method: 'POST', url: '/gui/action', headers });
		expect(res2.statusCode).toBe(200);
	});

	it('skips CSRF for /gui/login POST', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: 'token=test',
		});
		// Should not get 403 — CSRF is skipped for login
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ logged: true });
	});

	it('skips CSRF for /gui/public/ paths', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/public/asset' });
		// Should not set CSRF cookie on public paths
		expect(res.statusCode).toBe(200);
		const csrfCookie = extractCsrfCookie(res);
		expect(csrfCookie).toBeUndefined();
	});

	it('header token takes priority over body field', async () => {
		const getRes = await app.inject({ method: 'GET', url: '/gui/page' });
		const csrfCookie = extractCsrfCookie(getRes);
		const { csrfToken } = JSON.parse(getRes.body);

		// Send correct token in header but wrong in body
		const postRes = await app.inject({
			method: 'POST',
			url: '/gui/action',
			headers: {
				'x-csrf-token': csrfToken,
				'content-type': 'application/x-www-form-urlencoded',
				cookie: `pas_csrf=${csrfCookie}`,
			},
			payload: '_csrf=wrong-body-token',
		});
		// Header token is correct, so should succeed
		expect(postRes.statusCode).toBe(200);
	});
});
