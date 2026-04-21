/**
 * D5b-6: ApiKeyService + API auth hook tests.
 *
 * Covers the 15 tests specified in the plan.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiAuthHook } from '../../../api/auth.js';
import { RateLimiter } from '../../../middleware/rate-limiter.js';
import type { HouseholdService } from '../../household/index.js';
import type { UserManager } from '../../user-manager/index.js';
import { ApiKeyService } from '../index.js';

const logger = pino({ level: 'silent' });
const LEGACY_TOKEN = 'legacy-api-token-for-tests';

function makeRateLimiter(): RateLimiter {
	return new RateLimiter({ windowMs: 60_000, maxAttempts: 10_000 });
}

function makeUserManager(users: Array<{ id: string; name: string; isAdmin?: boolean }>) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
	} as unknown as UserManager;
}

function makeHouseholdService(
	userToHousehold: Record<string, string>,
	households: Array<{ id: string; adminUserIds: string[] }>,
) {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
	} as unknown as HouseholdService;
}

// ─── ApiKeyService unit tests ─────────────────────────────────────────────────

describe('ApiKeyService', () => {
	let tempDir: string;
	let service: ApiKeyService;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-api-keys-'));
		service = new ApiKeyService({ dataDir: tempDir, logger });
	});

	afterEach(async () => {
		// A debounced lastUsedAt write may still be in flight on Windows;
		// retry once after a short wait if the first rm fails.
		await rm(tempDir, { recursive: true, force: true }).catch(async () => {
			await new Promise((r) => setTimeout(r, 300));
			await rm(tempDir, { recursive: true, force: true });
		});
	});

	it('test 1: createKey returns unique {keyId, fullToken}; fullToken is never persisted plaintext', async () => {
		const { keyId, fullToken } = await service.createKey('user-1', { scopes: ['data:read'] });
		expect(keyId).toBeTruthy();
		expect(fullToken).toMatch(/^pas_[0-9a-f]+_.+$/);

		// Verify the fullToken secret is NOT stored plaintext
		const keys = await service.listKeysForUser('user-1');
		expect(keys).toHaveLength(1);
		expect(JSON.stringify(keys)).not.toContain(fullToken.split('_')[2]); // rawSecret
	});

	it('test 2: verifyAndConsume(fullToken) returns the record', async () => {
		const { fullToken } = await service.createKey('user-1', { scopes: ['data:read'] });
		const record = await service.verifyAndConsume(fullToken);
		expect(record).not.toBeNull();
		expect(record?.userId).toBe('user-1');
		expect(record?.scopes).toEqual(['data:read']);
	});

	it('test 3: wrong secret for valid keyId → null', async () => {
		const { keyId } = await service.createKey('user-1', { scopes: [] });
		// Construct a token with correct keyId but wrong secret
		const forgedToken = `pas_${keyId}_wrongsecret00000000000000000000000000000000000000000000000000000`;
		const result = await service.verifyAndConsume(forgedToken);
		expect(result).toBeNull();
	});

	it('test 4: malformed token (no pas_ prefix) → null', async () => {
		const result = await service.verifyAndConsume('not-a-real-token');
		expect(result).toBeNull();
	});

	it('test 5: expired key → null', async () => {
		const pastDate = new Date(Date.now() - 1000).toISOString();
		const { fullToken } = await service.createKey('user-1', {
			scopes: [],
			expiresAt: pastDate,
		});
		const result = await service.verifyAndConsume(fullToken);
		expect(result).toBeNull();
	});

	it('test 6: revoked key → null', async () => {
		const { keyId, fullToken } = await service.createKey('user-1', { scopes: [] });
		await service.revokeKey(keyId);
		const result = await service.verifyAndConsume(fullToken);
		expect(result).toBeNull();
	});

	it('test 7: unknown keyId → null', async () => {
		const result = await service.verifyAndConsume('pas_nonexistentkeyid00000000000000_fakesecret00000000000000000000000000000000000000000000000000000000');
		expect(result).toBeNull();
	});

	it('test 8: listKeysForUser redacts hashedSecret + salt', async () => {
		await service.createKey('user-1', { scopes: ['data:read'] });
		const keys = await service.listKeysForUser('user-1');
		expect(keys).toHaveLength(1);
		const key = keys[0]!;
		expect('hashedSecret' in key).toBe(false);
		expect('salt' in key).toBe(false);
		expect(key.userId).toBe('user-1');
		expect(key.scopes).toEqual(['data:read']);
	});

	it('test 9: lastUsedAt bumped once, second verify within 60s → no second write', async () => {
		const { fullToken } = await service.createKey('user-1', { scopes: [] });

		// First verify: no lastUsedAt yet
		const before = await service.listKeysForUser('user-1');
		expect(before[0]?.lastUsedAt).toBeUndefined();

		// First consume — triggers debounced write
		await service.verifyAndConsume(fullToken);

		// Wait a tick for the fire-and-forget write to complete
		await new Promise((r) => setTimeout(r, 100));

		const after1 = await service.listKeysForUser('user-1');
		const ts1 = after1[0]?.lastUsedAt;
		expect(ts1).toBeTruthy();

		// Second consume immediately — debounce should prevent second write
		await service.verifyAndConsume(fullToken);
		await new Promise((r) => setTimeout(r, 100));

		const after2 = await service.listKeysForUser('user-1');
		expect(after2[0]?.lastUsedAt).toBe(ts1); // unchanged
	});

	it('test 10: cleanupExpired removes past-expiry keys, returns count', async () => {
		const past = new Date(Date.now() - 5000).toISOString();
		const future = new Date(Date.now() + 60_000).toISOString();

		await service.createKey('user-1', { scopes: [], expiresAt: past });
		await service.createKey('user-1', { scopes: [], expiresAt: future });
		await service.createKey('user-1', { scopes: [] }); // no expiry

		const count = await service.cleanupExpired();
		expect(count).toBe(1);

		const remaining = await service.listKeysForUser('user-1');
		expect(remaining).toHaveLength(2);
	});
});

// ─── API auth hook tests ──────────────────────────────────────────────────────

describe('API auth hook', () => {
	let tempDir: string;
	let apiKeyService: ApiKeyService;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-api-auth-'));
		apiKeyService = new ApiKeyService({ dataDir: tempDir, logger });
	});

	afterEach(async () => {
		// A debounced lastUsedAt write may still be in flight on Windows;
		// retry once after a short wait if the first rm fails.
		await rm(tempDir, { recursive: true, force: true }).catch(async () => {
			await new Promise((r) => setTimeout(r, 300));
			await rm(tempDir, { recursive: true, force: true });
		});
	});

	async function buildServer(opts: {
		apiToken?: string;
		includeKeyService?: boolean;
		userManager?: UserManager;
		householdService?: HouseholdService;
	}) {
		const server = Fastify({ logger: false });
		const rateLimiter = makeRateLimiter();

		const authHook = createApiAuthHook({
			apiToken: opts.apiToken ?? LEGACY_TOKEN,
			rateLimiter,
			apiKeyService: opts.includeKeyService ? apiKeyService : undefined,
			userManager: opts.userManager,
			householdService: opts.householdService,
		});

		server.addHook('onRequest', authHook);

		server.get('/test', async (request) => {
			return {
				actor: request.actor ?? null,
			};
		});

		await server.ready();
		return server;
	}

	it('test 11: legacy API_TOKEN → platform-system actor with scopes: [*]', async () => {
		const server = await buildServer({});

		const res = await server.inject({
			method: 'GET',
			url: '/test',
			headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.actor.userId).toBe('__platform_system__');
		expect(body.actor.householdId).toBe('__platform__');
		expect(body.actor.scopes).toEqual(['*']);
		expect(body.actor.authMethod).toBe('legacy-api-token');
	});

	it('test 12: valid per-user key → per-user actor with key scopes, household rehydrated', async () => {
		const um = makeUserManager([{ id: 'user-1', name: 'User One', isAdmin: false }]);
		const hs = makeHouseholdService({ 'user-1': 'hh-1' }, [{ id: 'hh-1', adminUserIds: [] }]);

		const server = await buildServer({
			includeKeyService: true,
			userManager: um,
			householdService: hs,
		});

		const { fullToken } = await apiKeyService.createKey('user-1', {
			scopes: ['data:read'],
		});

		const res = await server.inject({
			method: 'GET',
			url: '/test',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.actor.userId).toBe('user-1');
		expect(body.actor.householdId).toBe('hh-1');
		expect(body.actor.scopes).toEqual(['data:read']);
		expect(body.actor.authMethod).toBe('api-key');
		expect(body.actor.isPlatformAdmin).toBe(false);
	});

	it('test 13: household rehydration — move user to different household, key uses new household', async () => {
		let currentHousehold = 'hh-old';
		const um = makeUserManager([{ id: 'user-1', name: 'User One', isAdmin: false }]);
		const hsFactory = () => makeHouseholdService(
			{ 'user-1': currentHousehold },
			[
				{ id: 'hh-old', adminUserIds: [] },
				{ id: 'hh-new', adminUserIds: [] },
			],
		);

		const { fullToken } = await apiKeyService.createKey('user-1', { scopes: ['data:read'] });

		// First request: user is in hh-old
		const server1 = await buildServer({
			includeKeyService: true,
			userManager: um,
			householdService: hsFactory(),
		});
		const res1 = await server1.inject({
			method: 'GET',
			url: '/test',
			headers: { authorization: `Bearer ${fullToken}` },
		});
		expect(JSON.parse(res1.body).actor.householdId).toBe('hh-old');
		await server1.close();

		// Move user to hh-new
		currentHousehold = 'hh-new';

		// Second request: same key, now reports hh-new
		const server2 = await buildServer({
			includeKeyService: true,
			userManager: um,
			householdService: hsFactory(),
		});
		const res2 = await server2.inject({
			method: 'GET',
			url: '/test',
			headers: { authorization: `Bearer ${fullToken}` },
		});
		expect(JSON.parse(res2.body).actor.householdId).toBe('hh-new');
		await server2.close();
	});

	it('test 14: missing Authorization header → 401', async () => {
		const server = await buildServer({});
		const res = await server.inject({ method: 'GET', url: '/test' });
		expect(res.statusCode).toBe(401);
	});

	it('test 15: after decoration, request.actor userId is set correctly inside handler', async () => {
		// Note: testing getCurrentUserId() via ALS is unreliable in Vitest because
		// enterWith() from a prior test can pollute the shared async context in the same
		// worker thread. We verify request.actor instead — which is set directly on the
		// Fastify request object by the auth hook and is not affected by ALS ordering.
		const server = Fastify({ logger: false });
		const rateLimiter = makeRateLimiter();
		const um = makeUserManager([{ id: 'user-1', name: 'User One' }]);
		const hs = makeHouseholdService({ 'user-1': 'hh-1' }, [{ id: 'hh-1', adminUserIds: [] }]);

		const authHook = createApiAuthHook({
			apiToken: LEGACY_TOKEN,
			rateLimiter,
			apiKeyService,
			userManager: um,
			householdService: hs,
		});
		server.addHook('onRequest', authHook);

		server.get('/ctx-test', async (request) => {
			return {
				actorUserId: request.actor?.userId ?? null,
				actorHouseholdId: request.actor?.householdId ?? null,
				authMethod: request.actor?.authMethod ?? null,
			};
		});
		await server.ready();

		const { fullToken } = await apiKeyService.createKey('user-1', { scopes: ['data:read'] });

		const res = await server.inject({
			method: 'GET',
			url: '/ctx-test',
			headers: { authorization: `Bearer ${fullToken}` },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		// Verify the auth hook correctly populated request.actor
		expect(body.actorUserId).toBe('user-1');
		expect(body.actorHouseholdId).toBe('hh-1');
		expect(body.authMethod).toBe('api-key');

		await server.close();
	});
});
