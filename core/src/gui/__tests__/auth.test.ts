import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuth } from '../auth.js';

const AUTH_TOKEN = 'test-secret-token';
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

async function buildApp() {
	const app = Fastify({ logger: false });

	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
	});

	await app.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });

			// Add a protected test route
			gui.get('/dashboard', async (_req, reply) => {
				return reply.send({ ok: true });
			});
		},
		{ prefix: '/gui' },
	);

	return app;
}

describe('GUI Auth', () => {
	let app: Awaited<ReturnType<typeof buildApp>>;

	beforeEach(async () => {
		app = await buildApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it('GET /gui/login renders login page', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/login' });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Authentication Token');
	});

	it('POST /gui/login with wrong token shows error', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { token: 'wrong-token' },
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Invalid token');
	});

	it('POST /gui/login with correct token sets cookie and redirects', async () => {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { token: AUTH_TOKEN },
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/gui/');
		expect(res.headers['set-cookie']).toBeDefined();
	});

	it('unauthenticated request to protected route redirects to login', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/dashboard' });
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/gui/login');
	});

	it('authenticated request with valid cookie succeeds', async () => {
		// Login first
		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { token: AUTH_TOKEN },
		});

		const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
		const authCookie = cookies.find((c) => c.name === 'pas_auth');
		expect(authCookie).toBeDefined();

		// Access protected route with cookie
		const res = await app.inject({
			method: 'GET',
			url: '/gui/dashboard',
			cookies: { pas_auth: authCookie?.value ?? '' },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ ok: true });
	});

	it('POST /gui/logout clears cookie and redirects', async () => {
		// Login first
		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { token: AUTH_TOKEN },
		});

		const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
		const authCookie = cookies.find((c) => c.name === 'pas_auth');

		// Logout
		const res = await app.inject({
			method: 'POST',
			url: '/gui/logout',
			cookies: { pas_auth: authCookie?.value ?? '' },
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/gui/login');
	});
});
