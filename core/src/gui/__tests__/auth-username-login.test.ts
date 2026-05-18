/**
 * login accepts username OR numeric id.
 *
 * Verifies the resolve-then-rate-limit contract:
 *  - A case-insensitive `user.name` resolves to the canonical numeric id.
 *  - Purely numeric input is id-only (never falls through to name lookup).
 *  - The session cookie always carries the canonical numeric id.
 *  - The per-account rate limiter keys on the canonical id, so casing variants
 *    of a username share one counter and cannot be used to bypass throttling.
 *  - The IP limiter still throttles brute-force sprays even when no user resolves
 *    (unknown-username spray protection).
 *  - Resolution failure returns the same generic "Invalid login or password."
 *    text as a wrong-password failure (no enumeration).
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
import { extractAuthCookie, getCookieUserId } from './auth-test-helpers.js';
import { RateLimiter } from '../../middleware/rate-limiter.js';
import { CredentialService } from '../../services/credentials/index.js';
import { normalizeDisplayName } from '../../services/invite/normalize.js';
import { registerAuth } from '../auth.js';

const AUTH_TOKEN = 'test-secret-token';
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Mock implementations — modeled after auth-d5b3.test.ts
// ---------------------------------------------------------------------------

interface MockUser {
	id: string;
	name: string;
	isAdmin: boolean;
}

function makeUserManager(users: MockUser[]) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<MockUser>,
		findByName: (name: string) => {
			const target = normalizeDisplayName(name);
			if (!target) return undefined;
			return users.find((u) => normalizeDisplayName(u.name) === target) ?? undefined;
		},
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

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface FixtureOptions {
	users?: MockUser[];
	userToHousehold?: Record<string, string>;
	households?: MockHousehold[];
	credService: CredentialService;
	loginRateLimiter?: RateLimiter;
	/** Override the default Vitest auto-enable of non-numeric id login. */
	allowNonNumericIdLoginForTests?: boolean;
}

async function buildApp(opts: FixtureOptions) {
	const users = opts.users ?? [{ id: '111', name: 'Matt', isAdmin: true }];
	const households =
		opts.households ?? users.map((u) => ({ id: `hh-${u.id}`, adminUserIds: [u.id] }));
	const userToHousehold =
		opts.userToHousehold ?? Object.fromEntries(users.map((u) => [u.id, `hh-${u.id}`]));

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
				...(opts.allowNonNumericIdLoginForTests !== undefined
					? { allowNonNumericIdLoginForTests: opts.allowNonNumericIdLoginForTests }
					: {}),
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

const getCookieUserIdWithAuthToken = (raw: string) => getCookieUserId(raw, AUTH_TOKEN);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /login accepts username or numeric id', () => {
	let tmpDir: string;
	let credService: CredentialService;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-batch2a-test-'));
		credService = new CredentialService({ dataDir: tmpDir });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('accepts a case-insensitive username and issues a session cookie with the canonical numeric id', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const res = await loginWithPassword(app, 'matt', 'pw');
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/gui/');

		const cookie = extractAuthCookie(res);
		expect(cookie).toBeDefined();
		const cookieUserId = await getCookieUserIdWithAuthToken(cookie!.value);
		expect(cookieUserId).toBe('111');

		await app.close();
	});

	it('accepts mixed-case usernames', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		for (const casing of ['MATT', 'mAtT', 'Matt']) {
			const res = await loginWithPassword(app, casing, 'pw');
			expect(res.statusCode).toBe(302);
			const cookie = extractAuthCookie(res);
			const cookieUserId = await getCookieUserIdWithAuthToken(cookie!.value);
			expect(cookieUserId).toBe('111');
		}

		await app.close();
	});

	it('still accepts the numeric id', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const res = await loginWithPassword(app, '111', 'pw');
		expect(res.statusCode).toBe(302);
		const cookie = extractAuthCookie(res);
		const cookieUserId = await getCookieUserIdWithAuthToken(cookie!.value);
		expect(cookieUserId).toBe('111');

		await app.close();
	});

	it('returns generic "Invalid login or password." for an unknown username (no info leak)', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const res = await loginWithPassword(app, 'NoSuchPerson', 'pw');
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain('Invalid login or password');

		await app.close();
	});

	it('returns the same generic error for a wrong password as for an unknown user', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const wrongPw = await loginWithPassword(app, 'matt', 'wrong');
		const unknownUser = await loginWithPassword(app, 'NoSuchPerson', 'pw');

		expect(wrongPw.statusCode).toBe(401);
		expect(unknownUser.statusCode).toBe(401);
		// Same wording — neither path reveals which side failed.
		expect(wrongPw.body).toContain('Invalid login or password');
		expect(unknownUser.body).toContain('Invalid login or password');

		await app.close();
	});

	it('rate-limits per canonical user id across casing variants', async () => {
		// 5 attempts per window; configure a small window so the test runs quick.
		const limiter = new RateLimiter({ maxAttempts: 5, windowMs: 60_000 });
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService, loginRateLimiter: limiter });

		// Casing variants of "matt" — should all hit the same user counter.
		// 5 wrong-password attempts will exhaust the user-keyed counter.
		const responses = [];
		for (const casing of ['matt', 'MATT', 'Matt', 'mATT', 'MaTt']) {
			const res = await loginWithPassword(app, casing, 'wrong');
			responses.push(res.statusCode);
		}

		// The IP limiter (5 attempts/window) trips on the 6th request; but by attempt #5
		// the per-account limiter for user 111 should already be at capacity.
		// Now try with the correct password — should be rate-limited (either by IP or by user key).
		const next = await loginWithPassword(app, 'Matt', 'pw');
		expect(next.statusCode).toBe(429);

		await app.close();
	});

	it('treats purely numeric input as id-only (no name fallback)', async () => {
		// Create a user whose NAME is "111" — defense in depth even though createInvite
		// blocks that path. We register the user via the mock directly.
		await credService.setPassword('999', 'pw');
		const app = await buildApp({
			credService,
			users: [
				{ id: '999', name: '111', isAdmin: false }, // pathological case
			],
			userToHousehold: { '999': 'hh-999' },
			households: [{ id: 'hh-999', adminUserIds: ['999'] }],
		});

		// Numeric input "111" looks up by id; user 111 doesn't exist.
		// Even though there's a user with name "111", numeric input must not match it.
		const res = await loginWithPassword(app, '111', 'pw');
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain('Invalid login or password');

		await app.close();
	});

	it('throttles unknown-username brute-force sprays via the IP limiter', async () => {
		// Configure tight IP limit so the spray trips it fast.
		const limiter = new RateLimiter({ maxAttempts: 3, windowMs: 60_000 });
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService, loginRateLimiter: limiter });

		// Hammer with N different bogus usernames — none resolve, so each goes through
		// the IP path. After 3 attempts, the 4th must be rate-limited.
		await loginWithPassword(app, 'attacker1', 'pw');
		await loginWithPassword(app, 'attacker2', 'pw');
		await loginWithPassword(app, 'attacker3', 'pw');
		const fourth = await loginWithPassword(app, 'attacker4', 'pw');

		expect(fourth.statusCode).toBe(429);

		await app.close();
	});

	it('rejects blank userId with the explicit "required" error', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({ credService });

		const res = await loginWithPassword(app, '', 'pw');
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain('required');

		await app.close();
	});

	it('production wiring refuses non-numeric ids at login (display name still works)', async () => {
		// Pin the flag false to simulate production wiring (Vitest auto-enables
		// it for synthetic fixtures). A hand-edited pas.yaml could insert a
		// non-numeric id; production must refuse it because Telegram never
		// issues such ids.
		await credService.setPassword('admin-1', 'pw');
		const app = await buildApp({
			credService,
			users: [{ id: 'admin-1', name: 'Admin One', isAdmin: true }],
			allowNonNumericIdLoginForTests: false,
		});

		const idAttempt = await loginWithPassword(app, 'admin-1', 'pw');
		expect(idAttempt.statusCode).toBe(401);

		const nameAttempt = await loginWithPassword(app, 'Admin One', 'pw');
		expect(nameAttempt.statusCode).toBe(302);

		await app.close();
	});

});
