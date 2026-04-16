/**
 * D5b-8: Account management UI — credential + API key routes.
 *
 * Tests the self-service account page, password change, admin password reset,
 * and API key management (create, list, revoke, ownership gate).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../../services/api-keys/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerCredentialRoutes } from '../routes/credentials.js';
import { registerApiKeyRoutes } from '../routes/api-keys.js';

const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_USER = { id: 'admin-1', name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] };
const MEMBER_USER = { id: 'member-1', name: 'Member', isAdmin: false, enabledApps: ['*'], sharedScopes: [] };
const ALL_USERS = [ADMIN_USER, MEMBER_USER];

const ADMIN_PASS = 'admin-secret-123';
const MEMBER_PASS = 'member-secret-456';

function makeUserManager(): UserManager {
	return {
		getUser: vi.fn().mockImplementation((id: string) => ALL_USERS.find((u) => u.id === id) ?? null),
		getAllUsers: vi.fn().mockReturnValue(ALL_USERS),
		isRegistered: vi.fn().mockImplementation((id: string) => ALL_USERS.some((u) => u.id === id)),
	} as unknown as UserManager;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: vi.fn().mockReturnValue('hh-1'),
		getHousehold: vi.fn().mockReturnValue({ id: 'hh-1', name: 'Home', adminUserIds: [] }),
	} as unknown as Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'>;
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies as Array<{ name: string; value: string }>) {
			result[c.name] = c.value;
		}
	}
	return result;
}

let tempDir: string;
let credService: CredentialService;
let apiKeyService: ApiKeyService;
let app: Awaited<ReturnType<typeof Fastify>>;

async function buildApp() {
	const userManager = makeUserManager();
	const householdService = makeHouseholdService();

	const fastify = Fastify({ logger: false });
	await fastify.register(fastifyCookie, { secret: 'test-cookie-secret' });

	const eta = new Eta();
	await fastify.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await fastify.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: '',
				credentialService: credService,
				userManager,
				householdService,
			});
			await registerCsrfProtection(gui);
			registerCredentialRoutes(gui, {
				credentialService: credService,
				userManager,
				logger,
			});
			registerApiKeyRoutes(gui, {
				apiKeyService,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastify;
}

/** Login with username + password, return the auth cookie. */
async function loginWithPassword(userId: string, password: string): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	return collectCookies(res);
}

/** GET a page and extract the CSRF token from the meta tag. */
async function getCsrfToken(cookies: Record<string, string>): Promise<{ csrfToken: string; cookies: Record<string, string> }> {
	const res = await app.inject({
		method: 'GET',
		url: '/gui/account',
		cookies,
	});
	const allCookies = { ...cookies, ...collectCookies(res) };
	const metaMatch = res.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return { csrfToken, cookies: allCookies };
}

/** Authenticated POST with CSRF token. */
async function authPost(
	userId: string,
	password: string,
	url: string,
	payload: Record<string, unknown>,
) {
	const loginCookies = await loginWithPassword(userId, password);
	const { csrfToken, cookies } = await getCsrfToken(loginCookies);
	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies,
	});
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b8-test-'));
	credService = new CredentialService({ dataDir: tempDir });
	apiKeyService = new ApiKeyService({ dataDir: tempDir, logger });

	// Pre-set passwords for test users
	await credService.setPassword(ADMIN_USER.id, ADMIN_PASS);
	await credService.setPassword(MEMBER_USER.id, MEMBER_PASS);

	app = await buildApp();
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('D5b-8: Account management', () => {
	// ---- Test 1: password change — success path ----
	it('POST /account/password with correct old password bumps sessionVersion and reissues cookie', async () => {
		const versionBefore = await credService.getSessionVersion(ADMIN_USER.id);

		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, '/gui/account/password', {
			currentPassword: ADMIN_PASS,
			newPassword: 'new-password-xyz',
			confirmPassword: 'new-password-xyz',
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Password updated successfully');

		const versionAfter = await credService.getSessionVersion(ADMIN_USER.id);
		expect(versionAfter).toBeGreaterThan(versionBefore);

		// Response should contain a Set-Cookie header (reissued cookie)
		const cookieNames = (res.cookies as Array<{ name: string }>).map((c) => c.name);
		expect(cookieNames).toContain('pas_auth');
	});

	// ---- Test 2: wrong current password → 400 ----
	it('POST /account/password with wrong current password returns 400 with error', async () => {
		const versionBefore = await credService.getSessionVersion(ADMIN_USER.id);

		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, '/gui/account/password', {
			currentPassword: 'wrong-password',
			newPassword: 'new-password-xyz',
			confirmPassword: 'new-password-xyz',
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('Current password is incorrect');

		// sessionVersion unchanged
		const versionAfter = await credService.getSessionVersion(ADMIN_USER.id);
		expect(versionAfter).toBe(versionBefore);
	});

	// ---- Test 3: non-admin cannot reset another user's password ----
	it('non-admin POST /users/:userId/reset-password → 403', async () => {
		const res = await authPost(MEMBER_USER.id, MEMBER_PASS, `/gui/users/${ADMIN_USER.id}/reset-password`, {
			newPassword: 'hacked-password',
			confirmPassword: 'hacked-password',
		});

		// requirePlatformAdmin returns 403
		expect(res.statusCode).toBe(403);
	});

	// ---- Test 4: admin can reset another user's password ----
	it('admin POST /users/:userId/reset-password succeeds and bumps target sessionVersion', async () => {
		const versionBefore = await credService.getSessionVersion(MEMBER_USER.id);

		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, `/gui/users/${MEMBER_USER.id}/reset-password`, {
			newPassword: 'admin-reset-pass',
			confirmPassword: 'admin-reset-pass',
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Password for');
		expect(res.body).toContain('has been reset');

		const versionAfter = await credService.getSessionVersion(MEMBER_USER.id);
		expect(versionAfter).toBeGreaterThan(versionBefore);
	});

	// ---- Test 5: non-admin can change their own password (self-service) ----
	it('non-admin can change their own password via self-service route', async () => {
		const res = await authPost(MEMBER_USER.id, MEMBER_PASS, '/gui/account/password', {
			currentPassword: MEMBER_PASS,
			newPassword: 'member-new-pass',
			confirmPassword: 'member-new-pass',
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Password updated successfully');

		// New password should now verify
		expect(await credService.verifyPassword(MEMBER_USER.id, 'member-new-pass')).toBe(true);
	});

	// ---- Test 6: create API key → one-time reveal ----
	it('POST /account/api-keys creates key and shows full token once', async () => {
		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, '/gui/account/api-keys', {
			label: 'test key',
			scopes: ['data:read'],
		});

		expect(res.statusCode).toBe(200);
		// Full token shown in the response (starts with pas_)
		expect(res.body).toMatch(/pas_[a-f0-9]+_[a-f0-9]+/);
		// Listed in keys table
		const keys = await apiKeyService.listKeysForUser(ADMIN_USER.id);
		expect(keys).toHaveLength(1);
		// hashedSecret NOT in response
		expect(res.body).not.toContain('hashedSecret');
	});

	// ---- Test 7: revoke own API key ----
	it('POST /account/api-keys/:keyId/revoke marks key as revoked', async () => {
		// Create a key first
		const { keyId } = await apiKeyService.createKey(ADMIN_USER.id, {
			scopes: ['data:read'],
			label: 'to-revoke',
		});

		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, `/gui/account/api-keys/${keyId}/revoke`, {});

		// Should redirect after revoke
		expect(res.statusCode).toBe(302);

		const keys = await apiKeyService.listKeysForUser(ADMIN_USER.id);
		const revokedKey = keys.find((k) => k.keyId === keyId);
		expect(revokedKey?.revokedAt).toBeTruthy();
	});

	// ---- Test 8: cannot revoke another user's key ----
	it('cannot revoke another user API key (URL tampering) → 403', async () => {
		// Create key for the member user
		const { keyId } = await apiKeyService.createKey(MEMBER_USER.id, {
			scopes: ['data:read'],
		});

		// Admin tries to revoke member's key via the self-service route
		const res = await authPost(ADMIN_USER.id, ADMIN_PASS, `/gui/account/api-keys/${keyId}/revoke`, {});

		// Route checks listKeysForUser(admin) — doesn't contain member's key → 403
		expect(res.statusCode).toBe(403);

		// Key should still be active
		const keys = await apiKeyService.listKeysForUser(MEMBER_USER.id);
		const key = keys.find((k) => k.keyId === keyId);
		expect(key?.revokedAt).toBeFalsy();
	});

	// ---- Test 9: CSRF required on all mutating routes ----
	it('POST /account/password without CSRF token → 403', async () => {
		const loginCookies = await loginWithPassword(ADMIN_USER.id, ADMIN_PASS);

		// POST without CSRF token
		const res = await app.inject({
			method: 'POST',
			url: '/gui/account/password',
			payload: {
				currentPassword: ADMIN_PASS,
				newPassword: 'new-pass-abc',
				confirmPassword: 'new-pass-abc',
			},
			cookies: loginCookies,
		});

		expect(res.statusCode).toBe(403);
	});

	// ---- Test 10: API keys page lists only own keys ----
	it('GET /account/api-keys lists only own keys (not cross-user)', async () => {
		// Create keys for both users
		await apiKeyService.createKey(ADMIN_USER.id, { scopes: ['data:read'], label: 'admin-key' });
		await apiKeyService.createKey(MEMBER_USER.id, { scopes: ['data:read'], label: 'member-key' });

		const loginCookies = await loginWithPassword(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({
			method: 'GET',
			url: '/gui/account/api-keys',
			cookies: loginCookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('admin-key');
		expect(res.body).not.toContain('member-key');
	});
});
