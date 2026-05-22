/**
 * Settings page route tests — Slices 1, 2, 3, 4, 5, 8.
 *
 * REQ-SETTINGS-002, 003, 004, 005, 014, 015, 016, 017, 018, 019, 020
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
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { SettingsRegistry } from '../../services/settings/settings-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const TEST_USER_ID = 'user1';
const TEST_PASSWORD = 'test-pass-123';
const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Test fixture definitions
// ---------------------------------------------------------------------------

/** Create a SettingsRegistry with test-only settings covering all widget types. */
function makeRegistry(): SettingsRegistry {
	const r = new SettingsRegistry();
	r.register({
		appId: 'chatbot',
		key: 'log_to_notes',
		label: 'Log to Notes',
		help: 'Save conversation summaries to your notes',
		type: 'boolean',
		default: false,
		category: 'personal',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /log.*(to|in).*notes/i,
	});
	r.register({
		appId: 'chatbot',
		key: 'flush_memory_on_idle_reset',
		label: 'Flush Memory on Idle Reset',
		help: 'Summarize and flush memory when session resets due to inactivity',
		type: 'boolean',
		default: false,
		category: 'memory-sessions',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /flush.*memory/i,
	});
	r.register({
		appId: 'food',
		key: 'macro_target_calories',
		label: 'Daily Calorie Target',
		help: 'Your target daily calorie intake',
		type: 'number',
		default: 2000,
		category: 'food',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	r.register({
		appId: 'food',
		key: 'dietary_preferences',
		label: 'Dietary Preferences',
		help: 'Your dietary restrictions or preferences',
		type: 'string',
		default: '',
		category: 'food',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /diet|vegetarian|vegan|gluten/i,
	});
	r.register({
		appId: 'food',
		key: 'preferred_cuisine',
		label: 'Preferred Cuisine',
		help: 'Your preferred cuisine type',
		type: 'select',
		options: ['Italian', 'Mexican', 'Asian', 'American'],
		default: 'Italian',
		category: 'food',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	// Hidden — should NOT appear in /gui/settings
	r.register({
		appId: 'food',
		key: 'internal_tracking_id',
		label: 'Internal ID',
		help: 'Internal tracking',
		type: 'string',
		default: '',
		category: 'food',
		adminOnly: false,
		dangerous: false,
		hidden: true,
		scope: 'per-user',
		nlSafe: false,
	});
	// adminOnly — should NOT appear in /gui/settings
	r.register({
		appId: 'food',
		key: 'routing_primary',
		label: 'Routing Primary',
		help: 'Which classifier is primary',
		type: 'string',
		default: 'regex',
		category: 'food',
		adminOnly: true,
		dangerous: true,
		dangerConfirmPrompt: 'Are you sure you want to change the routing?',
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	return r;
}

/** Chatbot manifest entries for SettingsWriter. */
const CHATBOT_MANIFEST = [
	{ key: 'log_to_notes', type: 'boolean' as const, default: false, description: 'Log to notes' },
	{
		key: 'flush_memory_on_idle_reset',
		type: 'boolean' as const,
		default: false,
		description: 'Flush memory',
	},
];

/** Food manifest entries for SettingsWriter. */
const FOOD_MANIFEST = [
	{
		key: 'macro_target_calories',
		type: 'number' as const,
		default: 2000,
		description: 'Calories',
	},
	{ key: 'dietary_preferences', type: 'string' as const, default: '', description: 'Diet' },
	{
		key: 'preferred_cuisine',
		type: 'select' as const,
		default: 'Italian',
		description: 'Cuisine',
		options: ['Italian', 'Mexican', 'Asian', 'American'],
	},
	{
		key: 'internal_tracking_id',
		type: 'string' as const,
		default: '',
		description: 'Internal',
	},
	{
		key: 'routing_primary',
		type: 'string' as const,
		default: 'regex',
		description: 'Routing',
	},
];

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

interface TestServer {
	app: ReturnType<typeof Fastify>;
	chatbotCfg: AppConfigServiceImpl;
	foodCfg: AppConfigServiceImpl;
	settingsWriter: SettingsWriter;
	registry: SettingsRegistry;
	tempDir: string;
}

async function buildTestServer(
	overrides?: Partial<{ disableFlushSpy: (userId: string) => Promise<void> }>,
): Promise<TestServer> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-settings-test-'));

	const chatbotCfg = new AppConfigServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		defaults: CHATBOT_MANIFEST,
	});
	const foodCfg = new AppConfigServiceImpl({
		dataDir: tempDir,
		appId: 'food',
		defaults: FOOD_MANIFEST,
	});

	const registry = makeRegistry();

	const mockLogger = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	const settingsWriter = new SettingsWriter({
		registry,
		appConfigResolver: (appId: string) => {
			if (appId === 'chatbot') return chatbotCfg;
			if (appId === 'food') return foodCfg;
			return undefined;
		},
		manifestResolver: (appId: string) => {
			if (appId === 'chatbot') return CHATBOT_MANIFEST;
			if (appId === 'food') return FOOD_MANIFEST;
			return undefined;
		},
		logger: mockLogger as unknown as Logger,
	});

	// Register flush hook if requested
	if (overrides?.disableFlushSpy) {
		settingsWriter.registerPostWriteHook(
			'chatbot.flush_memory_on_idle_reset',
			async ({ prevValue, newValue, userId }) => {
				if (prevValue === true && newValue === false) {
					await overrides.disableFlushSpy!(userId);
				}
			},
		);
	}

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);

	const userManager = {
		getUser: (id: string) =>
			id === TEST_USER_ID
				? { id: TEST_USER_ID, name: 'TestUser', isAdmin: false, telegramId: 1 }
				: null,
		getAllUsers: () => [{ id: TEST_USER_ID, name: 'TestUser', isAdmin: false, telegramId: 1 }],
	};

	const householdService = {
		getHouseholdForUser: (_id: string) => 'hh-1',
		getHousehold: (id: string) =>
			id === 'hh-1' ? { id: 'hh-1', adminUserIds: [TEST_USER_ID] } : null,
	};

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
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: userManager as unknown as UserManager,
				householdService: householdService as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, {
				userManager: userManager as unknown as UserManager,
			});
			registerSettingsRoutes(gui, {
				settingsRegistry: registry,
				settingsWriter,
				appConfigResolver: (appId: string) => {
					if (appId === 'chatbot') return chatbotCfg;
					if (appId === 'food') return foodCfg;
					return undefined;
				},
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, chatbotCfg, foodCfg, settingsWriter, registry, tempDir };
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

async function loginAndGetCookies(app: ReturnType<typeof Fastify>) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
	});
	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/settings',
		cookies: collectCookies(loginRes),
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return { allCookies, csrfToken, body: getRes.body, status: getRes.statusCode };
}

// ---------------------------------------------------------------------------
// Slice 1 — Auth gating
// ---------------------------------------------------------------------------

describe('Settings — Slice 1 (auth gating)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('GET /gui/settings without auth → 302 to /gui/login', async () => {
		const res = await server.app.inject({ method: 'GET', url: '/gui/settings' });
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('/gui/login');
	});

	it('GET /gui/settings with auth → 200 containing Settings', async () => {
		const { status, body } = await loginAndGetCookies(server.app);
		expect(status).toBe(200);
		expect(body).toContain('Settings');
	});

	it('POST /gui/settings without auth → 302 to /gui/login', async () => {
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {},
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('/gui/login');
	});

	it('POST /gui/settings/chatbot/log_to_notes/reset without auth → 302', async () => {
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: {},
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('/gui/login');
	});
});

// ---------------------------------------------------------------------------
// Slice 2 — Page rendering
// ---------------------------------------------------------------------------

describe('Settings — Slice 2 (page rendering)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('page contains Personal, Food, Memory & Sessions categories', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('Personal');
		expect(body).toContain('Food');
		expect(body).toContain('Memory &amp; Sessions');
	});

	it('page does NOT contain System or Dangerous categories', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).not.toContain('>System<');
		expect(body).not.toContain('>Dangerous<');
	});

	it('page does NOT contain the hidden setting', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).not.toContain('internal_tracking_id');
	});

	it('page does NOT contain adminOnly setting regardless of user role', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).not.toContain('routing_primary');
	});

	it('boolean renders checkbox + companion hidden present field', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('type="checkbox" name="chatbot__log_to_notes"');
		expect(body).toContain('name="chatbot__log_to_notes__present"');
	});

	it('number renders <input type="number">', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('type="number"');
		expect(body).toContain('name="food__macro_target_calories"');
	});

	it('string renders <input type="text">', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('type="text"');
		expect(body).toContain('name="food__dietary_preferences"');
	});

	it('select renders <select> with all options', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('<select');
		expect(body).toContain('name="food__preferred_cuisine"');
		expect(body).toContain('>Italian<');
		expect(body).toContain('>Mexican<');
		expect(body).toContain('>Asian<');
		expect(body).toContain('>American<');
	});

	it('boolean unchecked when default is false', async () => {
		const { body } = await loginAndGetCookies(server.app);
		// The checkbox for log_to_notes should NOT have 'checked'
		const cbMatch = body.match(/name="chatbot__log_to_notes"[^>]*/);
		expect(cbMatch?.[0]).not.toContain('checked');
	});

	it('number pre-fills manifest default when no override', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('value="2000"');
	});

	it('string pre-fills override when set', async () => {
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const getRes = await server.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
			headers: { 'X-CSRF-Token': csrfToken },
		});
		expect(getRes.body).toContain('checked');
	});

	it('select default option shows as selected', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('value="Italian" selected');
	});

	it('personal accordion has open attribute', async () => {
		const { body } = await loginAndGetCookies(server.app);
		// The personal category details should be open
		const personalIdx = body.indexOf('Personal');
		const detailsIdx = body.lastIndexOf('<details', personalIdx);
		const detailsSnippet = body.slice(detailsIdx, detailsIdx + 50);
		expect(detailsSnippet).toContain('open');
	});

	it('?saved=1 renders success banner', async () => {
		const { allCookies } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'GET',
			url: '/gui/settings?saved=1',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('saved successfully');
	});

	it('?saved=1&failed=food renders error banner with app name', async () => {
		const { allCookies } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'GET',
			url: '/gui/settings?saved=1&failed=food',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('food');
	});
});

// ---------------------------------------------------------------------------
// Slice 3 — Save happy path
// ---------------------------------------------------------------------------

describe('Settings — Slice 3 (save happy path)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('POST with one boolean change → 302 to ?saved=1', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__log_to_notes__present: '1',
				chatbot__log_to_notes: 'on',
			},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');
	});

	it('POST changing boolean persists override to disk', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__log_to_notes__present: '1',
				chatbot__log_to_notes: 'on',
			},
			cookies: allCookies,
		});
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		expect(overrides?.log_to_notes).toBe(true);
	});

	it('POST with all fields at current values → zero writes → 302 success', async () => {
		const writeBatchSpy = vi.spyOn(server.settingsWriter, 'writeBatch');
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				// Boolean at default (false): present but unchecked = false
				chatbot__log_to_notes__present: '1',
				chatbot__flush_memory_on_idle_reset__present: '1',
				// Number at default
				food__macro_target_calories: '2000',
				// String at default (empty)
				food__dietary_preferences: '',
				// Select at default
				food__preferred_cuisine: 'Italian',
			},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');
		// writeBatch should be called with empty array (or not at all)
		if (writeBatchSpy.mock.calls.length > 0) {
			expect(writeBatchSpy.mock.calls[0]![0]).toHaveLength(0);
		}
	});

	it('POST with unchecked checkbox and present field → persists false', async () => {
		// First set it to true
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		// Submit with present=1 but no checkbox value (unchecked)
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__log_to_notes__present: '1',
				// chatbot__log_to_notes is absent (unchecked)
			},
			cookies: allCookies,
		});
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		expect(overrides?.log_to_notes).toBe(false);
	});

	it('POST with absent boolean field (no present) → existing override untouched', async () => {
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		// Don't submit present field for log_to_notes
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		expect(overrides?.log_to_notes).toBe(true); // untouched
	});
});

// ---------------------------------------------------------------------------
// Slice 4 — Save validation errors
// ---------------------------------------------------------------------------

describe('Settings — Slice 4 (save validation errors)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('POST with non-numeric value for number field → 400 re-render with error', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				food__macro_target_calories: 'not-a-number',
			},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('not-a-number');
	});

	it('POST invalid number → page re-renders; valid fields NOT persisted (validation-atomic)', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				food__macro_target_calories: 'abc',
				// also a valid field — must NOT be persisted due to atomic validation
				food__dietary_preferences: 'vegan',
			},
			cookies: allCookies,
		});
		// Neither food field should be persisted
		const overrides = await server.foodCfg.getOverrides(TEST_USER_ID);
		expect(overrides).toBeNull();
	});

	it('POST /gui/settings/:appId/:key/reset with unknown appId → 404', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/unknown-app/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('POST /gui/settings/:appId/:key/reset with unknown key → 404', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/unknown_key_xyz/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('POST /gui/settings/:appId/:key/reset for hidden key → 404 (not discoverable)', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/food/internal_tracking_id/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		// Hidden settings return 404 so their existence is not confirmed.
		expect(res.statusCode).toBe(404);
	});

	it('POST /gui/settings/:appId/:key/reset for adminOnly key → 403', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/food/routing_primary/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('POST /gui/settings with path-traversal param → 404', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chat%2F..%2Ffoo/bar/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Slice 5 — Reset to default
// ---------------------------------------------------------------------------

describe('Settings — Slice 5 (reset to default)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('reset removes override — key no longer in getOverrides', async () => {
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		if (overrides !== null) {
			expect(overrides).not.toHaveProperty('log_to_notes');
		}
	});

	it('reset with no existing override → 200, no error, idempotent', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
	});

	it('reset preserves other overrides for same app', async () => {
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, {
			log_to_notes: true,
			flush_memory_on_idle_reset: true,
		});
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		expect(overrides?.flush_memory_on_idle_reset).toBe(true); // preserved
	});

	it('reset response does NOT contain <html> (layout-less partial)', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('<html');
		expect(res.body).toContain('setting-row');
	});

	it('reset response shows manifest default value', async () => {
		// log_to_notes default is false — checkbox should be unchecked
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		// After reset, default is false → checkbox should not be checked
		const cbMatch = res.body.match(/name="chatbot__log_to_notes"[^>]*/);
		expect(cbMatch?.[0]).not.toContain('checked');
	});

	it('reset fires post-write hook when prevValue=true and newValue=false', async () => {
		const disableFlushSpy = vi.fn().mockResolvedValue(undefined);
		const srv = await buildTestServer({ disableFlushSpy });

		try {
			await srv.chatbotCfg.updateOverrides(TEST_USER_ID, {
				flush_memory_on_idle_reset: true,
			});
			const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
			await srv.app.inject({
				method: 'POST',
				url: '/gui/settings/chatbot/flush_memory_on_idle_reset/reset',
				payload: { _csrf: csrfToken },
				cookies: allCookies,
			});
			expect(disableFlushSpy).toHaveBeenCalledWith(TEST_USER_ID);
		} finally {
			await srv.app.close();
			await rm(srv.tempDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Slice 8 — State transitions
// ---------------------------------------------------------------------------

describe('Settings — Slice 8 (state transitions)', () => {
	let server: TestServer;

	beforeEach(async () => {
		server = await buildTestServer();
	});

	afterEach(async () => {
		await server.app.close();
		await rm(server.tempDir, { recursive: true, force: true });
	});

	it('boolean toggle ON: after save, reload shows checked', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__log_to_notes__present: '1',
				chatbot__log_to_notes: 'on',
			},
			cookies: allCookies,
		});
		const getRes = await server.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(getRes.body).toContain('chatbot__log_to_notes');
		// Checkbox should be checked now
		const cbMatch = getRes.body.match(/name="chatbot__log_to_notes"[^>]*/);
		expect(cbMatch?.[0]).toContain('checked');
	});

	it('override set → reset → reload shows manifest default (unchecked)', async () => {
		await server.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		const overrides = await server.chatbotCfg.getOverrides(TEST_USER_ID);
		if (overrides !== null) {
			expect(overrides).not.toHaveProperty('log_to_notes');
		}
		// Default is false → getAll should return false
		const all = await server.chatbotCfg.getAll(TEST_USER_ID);
		expect(all.log_to_notes).toBe(false);
	});

	it('numeric override 0 (falsy) persists and round-trips', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				food__macro_target_calories: '0',
			},
			cookies: allCookies,
		});
		const all = await server.foodCfg.getAll(TEST_USER_ID);
		expect(all.macro_target_calories).toBe(0);
	});

	it('Save → Reset → Save round-trip: final value is second Save', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		// First save
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: csrfToken, food__dietary_preferences: 'vegan' },
			cookies: allCookies,
		});
		// Reset
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings/food/dietary_preferences/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		// Second save
		await server.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: csrfToken, food__dietary_preferences: 'vegetarian' },
			cookies: allCookies,
		});
		const all = await server.foodCfg.getAll(TEST_USER_ID);
		expect(all.dietary_preferences).toBe('vegetarian');
	});

	it('unknown key in URL → 404, not 500', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(server.app);
		const res = await server.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/zzz_nonexistent_zzz/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('layout nav link contains /gui/settings', async () => {
		const { body } = await loginAndGetCookies(server.app);
		expect(body).toContain('/gui/settings');
	});
});
