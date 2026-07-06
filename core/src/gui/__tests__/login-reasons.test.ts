/**
 * Login page sign-out explanations (audit I4, I7).
 *
 * The auth guard already redirects to `/gui/login?reason=<code>` for every
 * kind of forced sign-out (expired session, invalidated session, removed
 * user, missing household, password-required). What was missing: the
 * GET /login handler never read `reason` from the querystring at all, so
 * login.eta's `it.reason === 'password-required'` check could never be
 * true from a real redirect — the operator just saw a bare login form
 * with no explanation for why they were signed out.
 *
 * This file verifies:
 *  (a) An expired session cookie redirects to `/gui/login?reason=expired`.
 *  (b) GET /gui/login?reason=expired renders a plain-language explanation.
 *  (c) A stale-sessionVersion cookie redirects to reason=session-invalidated,
 *      and that reason renders its own explanation.
 *  (d) Exceeding the login rate limit names the actual configured wait
 *      window and tells the user to try again.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormBody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLoginRateLimiter } from '../../middleware/rate-limiter.js';
import type { RateLimiter } from '../../middleware/rate-limiter.js';
import { CredentialService } from '../../services/credentials/index.js';
import { registerAuth } from '../auth.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-secret-token';
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

interface MockUser {
	id: string;
	name: string;
	isAdmin: boolean;
}

function makeUserManager(users: MockUser[]) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<MockUser>,
	};
}

interface MockHousehold {
	id: string;
	adminUserIds: string[];
}

function makeHouseholdService(
	userToHousehold: Record<string, string>,
	households: MockHousehold[],
) {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
	};
}

interface FixtureOptions {
	users?: MockUser[];
	userToHousehold?: Record<string, string>;
	households?: MockHousehold[];
	credService: CredentialService;
	loginRateLimiter?: RateLimiter;
}

async function buildApp(opts: FixtureOptions) {
	const users = opts.users ?? [{ id: '111', name: 'Alice', isAdmin: true }];
	const households = opts.households ?? [{ id: 'hh-1', adminUserIds: ['111'] }];
	const userToHousehold = opts.userToHousehold ?? { '111': 'hh-1' };

	const userManager = makeUserManager(users);
	const householdService = makeHouseholdService(userToHousehold, households);

	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });
	await app.register(fastifyFormBody);

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
	});

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: opts.credService,
				userManager: userManager as Parameters<typeof registerAuth>[1]['userManager'],
				householdService: householdService as Parameters<
					typeof registerAuth
				>[1]['householdService'],
				loginRateLimiter: opts.loginRateLimiter,
			});

			await registerViewLocals(gui, {
				userManager: userManager as Parameters<typeof registerViewLocals>[1]['userManager'],
			});

			gui.get('/dashboard', async (req, reply) => {
				return reply.send({ ok: true, user: req.user ?? null });
			});
		},
		{ prefix: '/gui' },
	);

	return app;
}

async function loginWithPassword(
	app: Awaited<ReturnType<typeof buildApp>>,
	userId: string,
	password: string,
) {
	return app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: `userId=${encodeURIComponent(userId)}&password=${encodeURIComponent(password)}`,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
	});
}

function extractAuthCookie(res: { cookies: Array<{ name: string; value: string }> }) {
	return res.cookies.find((c) => c.name === 'pas_auth');
}

describe('Login page sign-out explanations (I4, I7)', () => {
	let tmpDir: string;
	let credService: CredentialService;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-login-reasons-'));
		credService = new CredentialService({ dataDir: tmpDir });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('(a) an expired session cookie redirects to reason=expired', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const loginRes = await loginWithPassword(app, '111', 'pw');
		const authCookie = extractAuthCookie(loginRes);
		expect(authCookie).toBeDefined();

		const expiredPayload = JSON.stringify({
			userId: '111',
			sessionVersion: 1,
			issuedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago > 24h window
			authMethod: 'gui-password',
		});
		const { sign } = await import('@fastify/cookie');
		const signedExpired = sign(expiredPayload, AUTH_TOKEN);

		const res = await app.inject({
			method: 'GET',
			url: '/gui/dashboard',
			cookies: { pas_auth: signedExpired },
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toMatch(/reason=expired/);

		await app.close();
	});

	it('(b) GET /gui/login?reason=expired explains the session expired', async () => {
		const app = await buildApp({ credService });
		const res = await app.inject({ method: 'GET', url: '/gui/login?reason=expired' });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('You were signed out because your session expired');
		await app.close();
	});

	it('(c) a stale-sessionVersion cookie redirects to reason=session-invalidated, which explains itself', async () => {
		await credService.setPassword('111', 'pw1');
		const app = await buildApp({ credService });

		const loginRes = await loginWithPassword(app, '111', 'pw1');
		const authCookie = extractAuthCookie(loginRes);
		expect(authCookie).toBeDefined();

		// Bumps sessionVersion, invalidating the cookie just issued.
		await credService.setPassword('111', 'pw2');

		const res = await app.inject({
			method: 'GET',
			url: '/gui/dashboard',
			cookies: { pas_auth: authCookie?.value ?? '' },
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toMatch(/reason=session-invalidated/);

		const loginPage = await app.inject({
			method: 'GET',
			url: res.headers.location as string,
		});
		expect(loginPage.statusCode).toBe(200);
		expect(loginPage.body).toContain(
			'You were signed out because your password was changed or the server restarted',
		);

		await app.close();
	});

	it('(d) exceeding the login rate limit names the real wait window and says try again', async () => {
		const limiter = createLoginRateLimiter();
		const app = await buildApp({ credService, loginRateLimiter: limiter });

		// createLoginRateLimiter() = 5 attempts / 15 minutes per IP (rate-limiter.ts).
		for (let i = 0; i < 5; i++) {
			await loginWithPassword(app, '111', 'wrong-password');
		}
		const res = await loginWithPassword(app, '111', 'wrong-password');
		expect(res.statusCode).toBe(429);
		expect(res.body).toContain('15 minutes');
		expect(res.body).toMatch(/try again/i);

		limiter.dispose();
		await app.close();
	});
});
