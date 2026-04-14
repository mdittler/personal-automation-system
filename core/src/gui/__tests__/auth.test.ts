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

	describe('Secure cookie flag', () => {
		const originalNodeEnv = process.env['NODE_ENV'];
		const originalSecureCookies = process.env['GUI_SECURE_COOKIES'];

		afterEach(() => {
			if (originalNodeEnv === undefined) {
				delete process.env['NODE_ENV'];
			} else {
				process.env['NODE_ENV'] = originalNodeEnv;
			}
			if (originalSecureCookies === undefined) {
				delete process.env['GUI_SECURE_COOKIES'];
			} else {
				process.env['GUI_SECURE_COOKIES'] = originalSecureCookies;
			}
		});

		/** Find the Set-Cookie header string for a specific cookie name. */
		function findCookieHeader(
			res: { headers: Record<string, string | string[] | undefined> },
			cookieName: string,
		): string | undefined {
			const raw = res.headers['set-cookie'];
			const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
			return headers.find((h) => h.startsWith(`${cookieName}=`));
		}

		it('sets Secure flag on pas_auth cookie when NODE_ENV=production', async () => {
			process.env['NODE_ENV'] = 'production';
			const res = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			expect(res.statusCode).toBe(302);
			const authHeader = findCookieHeader(res, 'pas_auth');
			expect(authHeader).toBeDefined();
			expect(authHeader).toMatch(/(^|;\s*)Secure(;|$)/i);
		});

		it('sets Secure flag on pas_auth cookie when GUI_SECURE_COOKIES=true', async () => {
			process.env['GUI_SECURE_COOKIES'] = 'true';
			const res = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			expect(res.statusCode).toBe(302);
			const authHeader = findCookieHeader(res, 'pas_auth');
			expect(authHeader).toBeDefined();
			expect(authHeader).toMatch(/(^|;\s*)Secure(;|$)/i);
		});

		it('does NOT set Secure flag in development', async () => {
			delete process.env['NODE_ENV'];
			delete process.env['GUI_SECURE_COOKIES'];
			const res = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			expect(res.statusCode).toBe(302);
			const authHeader = findCookieHeader(res, 'pas_auth');
			expect(authHeader).toBeDefined();
			expect(authHeader).not.toMatch(/(^|;\s*)Secure(;|$)/i);
		});
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

	it('logout clearCookie includes Secure flag on pas_auth and pas_csrf in production', async () => {
		const originalNodeEnv = process.env['NODE_ENV'];
		try {
			process.env['NODE_ENV'] = 'production';
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
			const raw = res.headers['set-cookie'];
			const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
			const authClear = headers.find((h) => h.startsWith('pas_auth='));
			const csrfClear = headers.find((h) => h.startsWith('pas_csrf='));
			expect(authClear).toBeDefined();
			expect(authClear).toMatch(/(^|;\s*)Secure(;|$)/i);
			expect(csrfClear).toBeDefined();
			expect(csrfClear).toMatch(/(^|;\s*)Secure(;|$)/i);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env['NODE_ENV'];
			} else {
				process.env['NODE_ENV'] = originalNodeEnv;
			}
		}
	});

	it('auth guard reissues cookie with Secure flag in production (pre-hardening upgrade)', async () => {
		const originalNodeEnv = process.env['NODE_ENV'];
		try {
			// Login without production flag (simulates pre-hardening cookie)
			delete process.env['NODE_ENV'];
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
			const authCookie = cookies.find((c) => c.name === 'pas_auth');
			expect(authCookie).toBeDefined();

			// Now switch to production and access a protected route
			process.env['NODE_ENV'] = 'production';
			const res = await app.inject({
				method: 'GET',
				url: '/gui/dashboard',
				cookies: { pas_auth: authCookie?.value ?? '' },
			});
			expect(res.statusCode).toBe(200);
			// Auth guard should reissue the cookie with Secure flag
			const raw = res.headers['set-cookie'];
			const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
			const reissuedAuth = headers.find((h) => h.startsWith('pas_auth='));
			expect(reissuedAuth).toBeDefined();
			expect(reissuedAuth).toMatch(/(^|;\s*)Secure(;|$)/i);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env['NODE_ENV'];
			} else {
				process.env['NODE_ENV'] = originalNodeEnv;
			}
		}
	});

	it('invalid-cookie clearCookie includes Secure flag on pas_auth in production', async () => {
		const originalNodeEnv = process.env['NODE_ENV'];
		try {
			process.env['NODE_ENV'] = 'production';
			// Access protected route with a tampered/invalid cookie
			const res = await app.inject({
				method: 'GET',
				url: '/gui/dashboard',
				cookies: { pas_auth: 'tampered-invalid-cookie-value' },
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/login');
			const raw = res.headers['set-cookie'];
			const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
			const authClear = headers.find((h) => h.startsWith('pas_auth='));
			expect(authClear).toBeDefined();
			expect(authClear).toMatch(/(^|;\s*)Secure(;|$)/i);
		} finally {
			if (originalNodeEnv === undefined) {
				delete process.env['NODE_ENV'];
			} else {
				process.env['NODE_ENV'] = originalNodeEnv;
			}
		}
	});
});
