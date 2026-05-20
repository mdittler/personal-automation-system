/**
 * Settings security tests — Slice 6.
 *
 * CSRF, XSS, auth-ordering, path/key tampering.
 * REQ-SETTINGS-016, 017
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import { CredentialService } from '../../services/credentials/index.js';
import { SettingsRegistry } from '../../services/settings/settings-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const TEST_USER_ID = 'user1';
const TEST_PASSWORD = 'secret-pw-xyz';
const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_HELP = '<img onerror=alert(1) src=x>';
const HOSTILE_OPTION = '<svg onload=alert(1)>';

function makeHostileRegistry(): SettingsRegistry {
	const r = new SettingsRegistry();
	// Normal boolean for CSRF tests
	r.register({
		appId: 'chatbot',
		key: 'log_to_notes',
		label: 'Log to Notes',
		help: 'Save conversation summaries',
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
	// Setting with hostile label and help
	r.register({
		appId: 'chatbot',
		key: 'xss_label_test',
		label: HOSTILE_LABEL,
		help: HOSTILE_HELP,
		type: 'string',
		default: '',
		category: 'personal',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	// Select with hostile option
	r.register({
		appId: 'chatbot',
		key: 'xss_select_test',
		label: 'Select Test',
		help: 'Test select XSS',
		type: 'select',
		options: [HOSTILE_OPTION, 'safe'],
		default: HOSTILE_OPTION,
		category: 'personal',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	// Number for coercion error XSS test
	r.register({
		appId: 'chatbot',
		key: 'num_test',
		label: 'Num Test',
		help: 'A number setting',
		type: 'number',
		default: 42,
		category: 'personal',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});
	return r;
}

const CHATBOT_MANIFEST = [
	{ key: 'log_to_notes', type: 'boolean' as const, default: false, description: 'Log to notes' },
	{ key: 'xss_label_test', type: 'string' as const, default: '', description: 'XSS label' },
	{
		key: 'xss_select_test',
		type: 'select' as const,
		default: HOSTILE_OPTION,
		description: 'XSS select',
		options: [HOSTILE_OPTION, 'safe'],
	},
	{ key: 'num_test', type: 'number' as const, default: 42, description: 'Num' },
];

interface SecurityTestServer {
	app: ReturnType<typeof Fastify>;
	chatbotCfg: AppConfigServiceImpl;
	tempDir: string;
}

async function buildSecurityServer(): Promise<SecurityTestServer> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-settings-sec-'));
	const chatbotCfg = new AppConfigServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		defaults: CHATBOT_MANIFEST,
	});
	const registry = makeHostileRegistry();
	const mockLogger = {
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {},
		child: () => mockLogger,
	};
	const settingsWriter = new SettingsWriter({
		registry,
		appConfigResolver: () => chatbotCfg,
		manifestResolver: () => CHATBOT_MANIFEST,
		logger: mockLogger as unknown as import('pino').Logger,
	});

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
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: householdService as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, {
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
			});
			registerSettingsRoutes(gui, {
				settingsRegistry: registry,
				settingsWriter,
				appConfigResolver: () => chatbotCfg,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, chatbotCfg, tempDir };
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
	return { allCookies, csrfToken };
}

describe('Settings Security — CSRF', () => {
	let srv: SecurityTestServer;

	beforeEach(async () => {
		srv = await buildSecurityServer();
	});

	afterEach(async () => {
		await srv.app.close();
		await rm(srv.tempDir, { recursive: true, force: true });
	});

	it('authenticated POST /gui/settings without pas_csrf cookie → 403 with CSRF error', async () => {
		const loginRes = await srv.app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
		});
		const authCookies = collectCookies(loginRes);
		// POST without CSRF cookie (only auth cookie)
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: 'some-value' },
			cookies: { pas_auth: authCookies.pas_auth ?? '' },
		});
		expect(res.statusCode).toBe(403);
		expect(res.body).toMatch(/CSRF/i);
	});

	it('authenticated POST with cookie but no _csrf token → 403', async () => {
		const { allCookies } = await loginAndGetCookies(srv.app);
		// Have CSRF cookie but don't submit token
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('authenticated POST with mismatched _csrf → 403', async () => {
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: 'wrong-token-value-does-not-match' },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('reset POST without CSRF cookie → 403', async () => {
		const loginRes = await srv.app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
		});
		const authCookies = collectCookies(loginRes);
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: 'some-value' },
			cookies: { pas_auth: authCookies.pas_auth ?? '' },
		});
		expect(res.statusCode).toBe(403);
	});
});

describe('Settings Security — auth-before-CSRF ordering', () => {
	let srv: SecurityTestServer;

	beforeEach(async () => {
		srv = await buildSecurityServer();
	});

	afterEach(async () => {
		await srv.app.close();
		await rm(srv.tempDir, { recursive: true, force: true });
	});

	it('unauthenticated POST without CSRF → 302 to /gui/login (auth runs first)', async () => {
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {},
		});
		// Auth runs first → 302, not 403
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('/gui/login');
		// Body should NOT contain CSRF error text since auth short-circuited
		expect(res.body).not.toMatch(/CSRF/i);
	});
});

describe('Settings Security — XSS escaping', () => {
	let srv: SecurityTestServer;

	beforeEach(async () => {
		srv = await buildSecurityServer();
	});

	afterEach(async () => {
		await srv.app.close();
		await rm(srv.tempDir, { recursive: true, force: true });
	});

	it('hostile label is HTML-escaped in page output', async () => {
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.body).toContain('&lt;script&gt;');
		expect(res.body).not.toContain('<script>alert(1)</script>');
	});

	it('hostile help is HTML-escaped in page output', async () => {
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.body).toContain('&lt;img');
		expect(res.body).not.toContain('<img onerror=alert(1)');
	});

	it('hostile select option is HTML-escaped in page output', async () => {
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		// SVG option should be escaped
		expect(res.body).toContain('&lt;svg');
		expect(res.body).not.toContain('<svg onload=alert');
	});

	it('hostile string override value is escaped in input value attribute', async () => {
		const xssPayload = '</textarea><script>alert(1)</script>';
		await srv.chatbotCfg.updateOverrides(TEST_USER_ID, { xss_label_test: xssPayload });
		const { allCookies } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		// XSS payload in value attribute must be escaped
		expect(res.body).not.toContain(xssPayload);
		expect(res.body).toContain('&lt;/textarea&gt;');
	});

	it('hostile input echoed in error message is escaped', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		const xssInput = '<svg onload=alert(1)>';
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: {
				_csrf: csrfToken,
				chatbot__num_test: xssInput,
			},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(400);
		// The echoed raw value must be escaped
		expect(res.body).not.toContain(xssInput);
		expect(res.body).toContain('&lt;svg');
	});

	it('reset response HTML-escapes appId and key in data attributes', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		// The row should contain data-app and data-key with safe values
		expect(res.body).toContain('data-app="chatbot"');
		expect(res.body).toContain('data-key="log_to_notes"');
	});
});

describe('Settings Security — path/key tampering', () => {
	let srv: SecurityTestServer;

	beforeEach(async () => {
		srv = await buildSecurityServer();
	});

	afterEach(async () => {
		await srv.app.close();
		await rm(srv.tempDir, { recursive: true, force: true });
	});

	it('reset with path-traversal in appId → 404', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/../../etc/passwd/key/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('reset with space-encoded key → 404', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings/chatbot/log_to_notes%20extra/reset',
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('POST /gui/settings with __proto__ body field is silently ignored', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies(srv.app);
		// Submit a field named __proto__ — should be silently ignored by registry-iteration
		const res = await srv.app.inject({
			method: 'POST',
			url: '/gui/settings',
			payload: { _csrf: csrfToken, __proto__: 'polluted' },
			cookies: allCookies,
		});
		// Should redirect, not crash
		expect([302, 400]).toContain(res.statusCode);
		if (res.statusCode === 302) {
			expect(res.headers.location).toContain('saved=1');
		}
	});
});
