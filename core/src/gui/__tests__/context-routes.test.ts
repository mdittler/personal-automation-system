import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextStoreServiceImpl } from '../../services/context-store/index.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerContextRoutes } from '../routes/context.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{ id: '123', name: 'TestUser', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			{ id: '456', name: 'OtherUser', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
		],
	} as SystemConfig;
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

async function buildApp(tempDir: string) {
	const config = createMockConfig();
	config.dataDir = tempDir;
	const contextStore = new ContextStoreServiceImpl({ dataDir: tempDir, logger });

	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await app.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerContextRoutes(gui, { contextStore, config, logger });
		},
		{ prefix: '/gui' },
	);

	return { app, contextStore };
}

async function authenticatedGet(app: ReturnType<typeof Fastify>, url: string) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const cookies = collectCookies(loginRes);
	return app.inject({ method: 'GET', url, cookies });
}

async function authenticatedPost(
	app: ReturnType<typeof Fastify>,
	url: string,
	payload: Record<string, unknown>,
) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const loginCookies = collectCookies(loginRes);
	const getRes = await app.inject({ method: 'GET', url: '/gui/context', cookies: loginCookies });
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies: allCookies,
	});
}

describe('Context GUI Routes', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;
	let contextStore: ContextStoreServiceImpl;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-ctx-gui-'));
		const built = await buildApp(tempDir);
		app = built.app;
		contextStore = built.contextStore;
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	// -- Standard --

	describe('GET /gui/context', () => {
		it('returns 200 with user list', async () => {
			const res = await authenticatedGet(app, '/gui/context');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('TestUser');
			expect(res.body).toContain('OtherUser');
		});
	});

	describe('GET /gui/context/:userId (htmx partial)', () => {
		it('returns empty state when user has no entries', async () => {
			const res = await authenticatedGet(app, '/gui/context/123');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('No context entries yet');
		});

		it('returns entry list when entries exist', async () => {
			await contextStore.save('123', 'preferences', '- Likes metric\n');
			const res = await authenticatedGet(app, '/gui/context/123');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('preferences');
			expect(res.body).toContain('Likes metric');
		});

		it('lists multiple entries', async () => {
			await contextStore.save('123', 'food', 'Likes pasta');
			await contextStore.save('123', 'fitness', 'Runs daily');
			const res = await authenticatedGet(app, '/gui/context/123');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('food');
			expect(res.body).toContain('fitness');
		});
	});

	describe('GET /gui/context/:userId/edit', () => {
		it('returns create form when key is empty', async () => {
			const res = await authenticatedGet(app, '/gui/context/123/edit?key=');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Name');
			expect(res.body).toContain('Create');
		});

		it('returns edit form with existing content', async () => {
			await contextStore.save('123', 'prefs', 'Old content');
			const res = await authenticatedGet(app, '/gui/context/123/edit?key=prefs');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Old content');
			expect(res.body).toContain('Update');
		});
	});

	describe('POST /gui/context/:userId (save)', () => {
		it('creates entry and redirects', async () => {
			const res = await authenticatedPost(app, '/gui/context/123', {
				key: 'Food Preferences',
				content: '- Likes pasta',
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/context');

			// Verify file was created with slugified name
			const entries = await contextStore.listForUser('123');
			expect(entries.some((e) => e.key === 'food-preferences')).toBe(true);
		});

		it('redirects to context page after save', async () => {
			const res = await authenticatedPost(app, '/gui/context/123', {
				key: 'test',
				content: 'data',
			});
			expect(res.headers.location).toBe('/gui/context');
		});
	});

	describe('POST /gui/context/:userId/delete', () => {
		it('deletes entry and redirects', async () => {
			await contextStore.save('123', 'prefs', 'content');
			const res = await authenticatedPost(app, '/gui/context/123/delete', { key: 'prefs' });
			expect(res.statusCode).toBe(302);

			const entries = await contextStore.listForUser('123');
			expect(entries).toHaveLength(0);
		});
	});

	// -- Edge cases --

	describe('edge cases', () => {
		it('POST with empty key returns 400', async () => {
			const res = await authenticatedPost(app, '/gui/context/123', {
				key: '',
				content: 'data',
			});
			expect(res.statusCode).toBe(400);
		});

		it('POST with empty content returns 400', async () => {
			const res = await authenticatedPost(app, '/gui/context/123', {
				key: 'test',
				content: '',
			});
			expect(res.statusCode).toBe(400);
		});

		it('POST with symbols-only key returns 400 (slugifies to empty)', async () => {
			const res = await authenticatedPost(app, '/gui/context/123', {
				key: '!!!',
				content: 'data',
			});
			expect(res.statusCode).toBe(400);
		});

		it('GET edit for non-existent key returns empty form', async () => {
			const res = await authenticatedGet(app, '/gui/context/123/edit?key=missing');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Update'); // Edit mode but empty content
		});
	});

	// -- Error handling --

	describe('error handling', () => {
		it('invalid userId format returns 400', async () => {
			const res = await authenticatedGet(app, '/gui/context/bad%20user!');
			expect(res.statusCode).toBe(400);
		});

		it('unregistered userId on save returns 400', async () => {
			const res = await authenticatedPost(app, '/gui/context/999', {
				key: 'test',
				content: 'data',
			});
			expect(res.statusCode).toBe(400);
		});
	});

	// -- Security --

	describe('security', () => {
		it('escapes HTML in entry content display', async () => {
			await contextStore.save('123', 'xss-test', '<script>alert("xss")</script>');
			const res = await authenticatedGet(app, '/gui/context/123');
			expect(res.statusCode).toBe(200);
			expect(res.body).not.toContain('<script>');
			expect(res.body).toContain('&lt;script&gt;');
		});

		it('path traversal in userId rejected for list', async () => {
			const res = await authenticatedGet(app, '/gui/context/..%2F..%2Fetc');
			expect(res.statusCode).toBe(400);
		});

		it('CSRF token included in forms', async () => {
			const res = await authenticatedGet(app, '/gui/context/123/edit?key=');
			expect(res.body).toContain('name="_csrf"');
		});
	});
});
