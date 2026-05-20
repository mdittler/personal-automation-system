/**
 * Settings end-to-end integration test — Slice 9.
 *
 * Uses real SettingsRegistry, real SettingsWriter, real AppConfigServiceImpl,
 * real CSRF, real D5b-3 auth. Tests the full save/reset flow with hook verification.
 *
 * REQ-SETTINGS-002..020
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
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import { CredentialService } from '../../services/credentials/index.js';
import { SettingsRegistry } from '../../services/settings/settings-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const TEST_USER_ID = 'user1';
const TEST_PASSWORD = 'integration-pw-456';
const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const CHATBOT_MANIFEST = [
	{ key: 'log_to_notes', type: 'boolean' as const, default: false, description: 'Log to notes' },
	{
		key: 'flush_memory_on_idle_reset',
		type: 'boolean' as const,
		default: false,
		description: 'Flush memory',
	},
];
const FOOD_MANIFEST = [
	{ key: 'dietary_preferences', type: 'string' as const, default: '', description: 'Diet' },
];

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
		nlIntentRegex: /log.*notes/i,
	});
	r.register({
		appId: 'chatbot',
		key: 'flush_memory_on_idle_reset',
		label: 'Flush Memory on Idle Reset',
		help: 'Flush memory when idle resets',
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
		nlIntentRegex: /diet/i,
	});
	return r;
}

interface IntegrationServer {
	app: ReturnType<typeof Fastify>;
	chatbotCfg: AppConfigServiceImpl;
	foodCfg: AppConfigServiceImpl;
	settingsWriter: SettingsWriter;
	disableFlushSpy: ReturnType<typeof vi.fn>;
	tempDir: string;
}

async function buildIntegrationServer(): Promise<IntegrationServer> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-settings-int-'));

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
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {},
		child: () => mockLogger,
	};

	const disableFlushSpy = vi.fn().mockResolvedValue(undefined);

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
		// biome-ignore format: esbuild cannot parse import type assertions split across lines
		logger: mockLogger as unknown as import('pino').Logger,
	});

	// Wire flush hook (mirrors compose-runtime.ts)
	settingsWriter.registerPostWriteHook(
		'chatbot.flush_memory_on_idle_reset',
		async ({ prevValue, newValue, userId }) => {
			if (prevValue === true && newValue === false) {
				await disableFlushSpy(userId);
			}
		},
	);

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);
	const userManager = {
		getUser: (id: string) =>
			id === TEST_USER_ID ? { id: TEST_USER_ID, name: 'TestUser', isAdmin: false } : null,
		getAllUsers: () => [{ id: TEST_USER_ID, name: 'TestUser', isAdmin: false }],
	};
	const householdService = {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: (id: string) => (id === 'hh-1' ? { id: 'hh-1', adminUserIds: [] } : null),
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
				// biome-ignore format: esbuild cannot parse import type assertions split across lines
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
				// biome-ignore format: esbuild cannot parse import type assertions split across lines
				householdService: householdService as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, {
				// biome-ignore format: esbuild cannot parse import type assertions split across lines
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
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

	return { app, chatbotCfg, foodCfg, settingsWriter, disableFlushSpy, tempDir };
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const res of responses)
		for (const c of res.cookies as Array<{ name: string; value: string }>) out[c.name] = c.value;
	return out;
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
	return { allCookies, csrfToken, body: getRes.body };
}

describe('Settings Integration — Slice 9', () => {
	let srv: IntegrationServer;

	beforeEach(async () => {
		srv = await buildIntegrationServer();
	});

	afterEach(async () => {
		await srv.app.close();
		await rm(srv.tempDir, { recursive: true, force: true });
	});

	it('full login → GET settings → 200 with settings content', async () => {
		const { body } = await loginAndGetCookies(srv.app);
		expect(body).toContain('Settings');
		expect(body).toContain('Log to Notes');
		expect(body).toContain('Dietary Preferences');
	});

	it('full save flow: POST → 302 ?saved=1 → GET shows success banner', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);

		const postRes = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__log_to_notes__present: '1',
				chatbot__log_to_notes: 'on',
			},
			cookies: allCookies,
		});
		expect(postRes.statusCode).toBe(302);
		expect(postRes.headers.location).toContain('saved=1');

		// Follow redirect
		const redirectUrl = postRes.headers.location as string;
		const followRes = await srv.app.inject({
			method: 'GET',
			url: redirectUrl,
			cookies: allCookies,
		});
		expect(followRes.statusCode).toBe(200);
		expect(followRes.body).toContain('saved successfully');
	});

	it('save persists value to disk', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				food__dietary_preferences: 'gluten-free',
			},
			cookies: allCookies,
		});
		const all = await srv.foodCfg.getAll(TEST_USER_ID);
		expect(all.dietary_preferences).toBe('gluten-free');
	});

	it('reset flow: POST reset → 200 partial (no <html>), override removed', async () => {
		await srv.chatbotCfg.updateOverrides(TEST_USER_ID, { log_to_notes: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);

		const resetRes = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(resetRes.statusCode).toBe(200);
		expect(resetRes.body).not.toContain('<html');
		expect(resetRes.body).toContain('setting-row');

		const overrides = await srv.chatbotCfg.getOverrides(TEST_USER_ID);
		if (overrides !== null) {
			expect(overrides).not.toHaveProperty('log_to_notes');
		}
	});

	it('flush_memory_on_idle_reset hook fires when toggled OFF via save', async () => {
		// First set it to true
		await srv.chatbotCfg.updateOverrides(TEST_USER_ID, { flush_memory_on_idle_reset: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);

		// Save with it unchecked (false)
		await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__flush_memory_on_idle_reset__present: '1',
				// unchecked = false
			},
			cookies: allCookies,
		});

		expect(srv.disableFlushSpy).toHaveBeenCalledWith(TEST_USER_ID);
	});

	it('flush_memory_on_idle_reset hook fires when toggled OFF via reset', async () => {
		await srv.chatbotCfg.updateOverrides(TEST_USER_ID, { flush_memory_on_idle_reset: true });
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);

		await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/flush_memory_on_idle_reset/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});

		expect(srv.disableFlushSpy).toHaveBeenCalledWith(TEST_USER_ID);
	});

	it('flush hook does NOT fire when value stays false (no-op save)', async () => {
		// flush is false (default) — saving false again should not fire hook
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__flush_memory_on_idle_reset__present: '1',
				// unchecked = false (same as current default)
			},
			cookies: allCookies,
		});
		expect(srv.disableFlushSpy).not.toHaveBeenCalled();
	});

	it('layout nav link /gui/settings present on any GUI page', async () => {
		const { body } = await loginAndGetCookies(srv.app);
		expect(body).toContain('href="/gui/settings"');
	});

	it('XSS smoke: hostile string value renders safely in full page', async () => {
		const xssPayload = '<script>alert(1)</script>';
		await srv.foodCfg.updateOverrides(TEST_USER_ID, { dietary_preferences: xssPayload });
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.body).not.toContain(xssPayload);
		expect(res.body).toContain('&lt;script&gt;');
	});
});
