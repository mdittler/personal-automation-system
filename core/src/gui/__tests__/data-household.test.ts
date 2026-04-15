/**
 * Household-aware GUI data browser tests.
 *
 * Verifies that:
 * - ?scope=user&userId=u1 (u1 in hhA) → reads from households/hhA/users/u1
 * - ?scope=shared without householdId → 400 when householdService is wired
 * - ?scope=shared&householdId=hhA → reads from households/hhA/shared
 * - ?scope=user&userId=u1&householdId=hhB (u1 actually in hhA) → 403
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerDataRoutes } from '../routes/data.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

let dataDir: string;
let server: ReturnType<typeof Fastify>;
let authCookie: string;

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: '', model: '' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{
				id: 'u1',
				name: 'User One',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		],
	};
}

function makeHouseholdService(map: Record<string, string | null>) {
	return {
		getHouseholdForUser(userId: string): string | null {
			return userId in map ? (map[userId] ?? null) : null;
		},
		listHouseholds() {
			const ids = new Set(Object.values(map).filter(Boolean) as string[]);
			return Array.from(ids).map((id) => ({ id, name: id }));
		},
	};
}

beforeEach(async () => {
	dataDir = join(tmpdir(), `pas-data-hh-test-${Date.now()}`);

	// Household layout: households/hh-a/users/u1/food/
	await mkdir(join(dataDir, 'households', 'hh-a', 'users', 'u1', 'food'), { recursive: true });
	await writeFile(
		join(dataDir, 'households', 'hh-a', 'users', 'u1', 'food', 'items.md'),
		'pasta\n',
	);

	// Household shared layout: households/hh-a/shared/recipes/
	await mkdir(join(dataDir, 'households', 'hh-a', 'shared', 'recipes'), { recursive: true });
	await writeFile(
		join(dataDir, 'households', 'hh-a', 'shared', 'recipes', 'lasagna.md'),
		'layers\n',
	);

	const config = createMockConfig();
	const householdService = makeHouseholdService({ u1: 'hh-a' });

	server = Fastify();
	await server.register(fastifyCookie, { secret: 'test-secret' });
	const eta = new Eta({ views: viewsDir, autoEscape: true });
	await server.register(fastifyView, { engine: { eta }, root: viewsDir });

	await server.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			registerDataRoutes(gui, { config, dataDir, logger, householdService });
		},
		{ prefix: '/gui' },
	);

	await server.ready();

	// Get auth cookie
	const loginRes = await server.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
	const authC = cookies.find((c) => c.name === 'pas_auth');
	authCookie = authC ? `pas_auth=${authC.value}` : '';
});

afterEach(async () => {
	await server.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe('GET /gui/data/browse — household routing', () => {
	it('scope=user returns files from household layout when householdService is wired', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=u1&appId=food',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('items.md');
	});

	it('scope=shared without householdId → 400 when householdService is wired', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=shared',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('householdId');
	});

	it('scope=shared&householdId=hh-a → files from households/hh-a/shared', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=shared&householdId=hh-a',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('recipes');
	});

	it('scope=user with mismatched householdId → 403', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=u1&householdId=hh-b',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(403);
	});
});

describe('GET /gui/data/view — household routing', () => {
	it('scope=shared without householdId → 400 when householdService is wired', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/view?scope=shared&subpath=recipes/lasagna.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('scope=user with mismatched householdId → 403', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/view?scope=user&userId=u1&householdId=hh-b&subpath=food/items.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(403);
	});

	it('scope=user with correct householdId reads from household path', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/view?scope=user&userId=u1&householdId=hh-a&appId=food&subpath=items.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pasta');
	});
});
