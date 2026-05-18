/**
 * Batch 2C: integration test for `loginByNameAllowed: false`.
 *
 * When `scanForDuplicateNames` detects pre-existing duplicate display names in
 * pas.yaml, compose-runtime sets `loginByNameAllowed: false` and threads it
 * into `registerAuth` via AuthOptions. POST /login then refuses to resolve a
 * name to a numeric id, but numeric-id login still works — so the operator
 * can always reach the GUI to fix the duplicate.
 *
 * This test fixtures both branches end-to-end via Fastify's inject API,
 * paralleling the Batch 2A `auth-username-login.test.ts` setup.
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
import { CredentialService } from '../../services/credentials/index.js';
import { registerAuth } from '../auth.js';

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
		findByName: (name: string) => {
			if (!name) return undefined;
			const target = name.toLocaleLowerCase();
			return users.find((u) => u.name.toLocaleLowerCase() === target) ?? undefined;
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

interface FixtureOptions {
	users: MockUser[];
	credService: CredentialService;
	loginByNameAllowed?: boolean;
}

async function buildApp(opts: FixtureOptions) {
	const users = opts.users;
	const households: MockHousehold[] = users.map((u) => ({
		id: `hh-${u.id}`,
		adminUserIds: [u.id],
	}));
	const userToHousehold = Object.fromEntries(users.map((u) => [u.id, `hh-${u.id}`]));

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
				...(opts.loginByNameAllowed !== undefined
					? { loginByNameAllowed: opts.loginByNameAllowed }
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

function extractAuthCookie(res: { cookies: Array<{ name: string; value: string }> }) {
	return res.cookies.find((c) => c.name === 'pas_auth');
}

async function getCookieUserId(rawValue: string): Promise<string> {
	const { unsign } = await import('@fastify/cookie');
	const result = unsign(rawValue, AUTH_TOKEN);
	if (!result.valid || !result.value) throw new Error('Cookie failed to unsign');
	const payload = JSON.parse(result.value) as { userId: string };
	return payload.userId;
}

describe('POST /login with loginByNameAllowed: false', () => {
	let tmpDir: string;
	let credService: CredentialService;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-batch2c-disabled-'));
		credService = new CredentialService({ dataDir: tmpDir });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('username login returns the generic "Invalid user ID or password." (no info leak)', async () => {
		// Two users with case-insensitively-duplicate names — the exact scenario
		// scanForDuplicateNames would have flagged at boot.
		await credService.setPassword('111', 'pw1');
		await credService.setPassword('222', 'pw2');
		const app = await buildApp({
			credService,
			loginByNameAllowed: false,
			users: [
				{ id: '111', name: 'Matt', isAdmin: true },
				{ id: '222', name: 'matt', isAdmin: false },
			],
		});

		const res = await loginWithPassword(app, 'Matt', 'pw1');
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain('Invalid user ID or password');
		// No cookie was issued.
		expect(extractAuthCookie(res)).toBeUndefined();

		await app.close();
	});

	it('numeric-id login still succeeds when login-by-name is disabled', async () => {
		await credService.setPassword('111', 'pw1');
		await credService.setPassword('222', 'pw2');
		const app = await buildApp({
			credService,
			loginByNameAllowed: false,
			users: [
				{ id: '111', name: 'Matt', isAdmin: true },
				{ id: '222', name: 'matt', isAdmin: false },
			],
		});

		const res = await loginWithPassword(app, '111', 'pw1');
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toBe('/gui/');

		const cookie = extractAuthCookie(res);
		expect(cookie).toBeDefined();
		const cookieUserId = await getCookieUserId(cookie!.value);
		expect(cookieUserId).toBe('111');

		await app.close();
	});

	it('numeric-id login for the OTHER duplicate user also succeeds', async () => {
		// Sanity check: both ids reachable via numeric login, regardless of the
		// duplicate-name flag. The duplicate is a name-resolution problem, not an
		// id problem.
		await credService.setPassword('111', 'pw1');
		await credService.setPassword('222', 'pw2');
		const app = await buildApp({
			credService,
			loginByNameAllowed: false,
			users: [
				{ id: '111', name: 'Matt', isAdmin: true },
				{ id: '222', name: 'matt', isAdmin: false },
			],
		});

		const res = await loginWithPassword(app, '222', 'pw2');
		expect(res.statusCode).toBe(302);
		const cookie = extractAuthCookie(res);
		const cookieUserId = await getCookieUserId(cookie!.value);
		expect(cookieUserId).toBe('222');

		await app.close();
	});

	it('username login is also rejected for a name that is not duplicated (flag applies globally, not per-name)', async () => {
		// When the flag is false, ALL name lookups are skipped — not just the
		// duplicated ones. This is the safer policy: an operator hand-editing
		// pas.yaml might fix one duplicate and leave another, and we don't want
		// half-working login.
		await credService.setPassword('333', 'pw3');
		const app = await buildApp({
			credService,
			loginByNameAllowed: false,
			users: [
				{ id: '111', name: 'Matt', isAdmin: true },
				{ id: '222', name: 'matt', isAdmin: false },
				{ id: '333', name: 'Carol', isAdmin: false }, // unique
			],
		});

		const res = await loginWithPassword(app, 'Carol', 'pw3');
		expect(res.statusCode).toBe(401);
		expect(res.body).toContain('Invalid user ID or password');

		await app.close();
	});
});

describe('POST /login with loginByNameAllowed omitted (defaults to true)', () => {
	let tmpDir: string;
	let credService: CredentialService;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-batch2c-default-'));
		credService = new CredentialService({ dataDir: tmpDir });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('default behavior matches Batch 2A — username login still works', async () => {
		await credService.setPassword('111', 'pw');
		const app = await buildApp({
			credService,
			// loginByNameAllowed omitted — defaults to true inside registerAuth.
			users: [{ id: '111', name: 'Matt', isAdmin: true }],
		});

		const res = await loginWithPassword(app, 'Matt', 'pw');
		expect(res.statusCode).toBe(302);
		const cookie = extractAuthCookie(res);
		const cookieUserId = await getCookieUserId(cookie!.value);
		expect(cookieUserId).toBe('111');

		await app.close();
	});
});
