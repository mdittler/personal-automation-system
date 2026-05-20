/**
 * app-detail.eta select widget XSS hardening tests.
 *
 * Verifies that hostile values in manifest options[] and in per-user override
 * files are properly escaped (or excluded) when rendered inside a <select>
 * widget on the /gui/apps/:appId detail page.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppRegistry, RegisteredApp } from '../../services/app-registry/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAppsRoutes } from '../routes/apps.js';

const TEST_USER_ID = '123';
const TEST_PASSWORD = 'test-password';
const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager(users: Array<{ id: string; name: string; isAdmin: boolean }>) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<{ id: string; name: string; isAdmin: boolean }>,
	};
}

function makeHouseholdService(
	userToHousehold: Record<string, string>,
	households: Array<{ id: string; adminUserIds: string[] }>,
) {
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
	};
}

async function buildHostileSelectApp(tempDir: string, options: string[], defaultOption: string) {
	const appDef: RegisteredApp = {
		manifest: {
			app: { id: 'hostile', name: 'Hostile', version: '1.0.0', description: 'XSS test' },
			capabilities: { messages: { intents: [] } },
			requirements: { services: [] },
			user_config: [
				{
					key: 'routing_primary',
					type: 'select',
					default: defaultOption,
					options,
					description: 'Routing',
				},
			],
		} as RegisteredApp['manifest'],
		module: { init: async () => {}, handleMessage: async () => {} },
		appDir: '/tmp/apps/hostile',
	};
	const registry = {
		getAll: () => [appDef],
		getApp: (id: string) => (id === 'hostile' ? appDef : undefined),
		getLoadedAppIds: () => ['hostile'],
		getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
	} as unknown as AppRegistry;

	const config = {
		port: 3000,
		dataDir: tempDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'llama3.2:3b' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		],
	};
	const toggle = new AppToggleStore({ dataDir: tempDir });
	const server = Fastify({ logger: false });
	await server.register(fastifyCookie, { secret: AUTH_TOKEN });
	const eta = new Eta();
	await server.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});
	const credSvc = new CredentialService({ dataDir: tempDir });
	await credSvc.setPassword(TEST_USER_ID, TEST_PASSWORD);
	const uMgr = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
	const hhSvc = makeHouseholdService({ [TEST_USER_ID]: 'hh-1' }, [
		{ id: 'hh-1', adminUserIds: [TEST_USER_ID] },
	]);

	await server.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credSvc,
				userManager: uMgr as unknown as UserManager,
				householdService: hhSvc as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerAppsRoutes(gui, {
				registry,
				config: config as unknown as import('../../types/config.js').SystemConfig,
				appToggle: toggle,
				dataDir: tempDir,
				logger,
			});
		},
		{ prefix: '/gui' },
	);
	return server;
}

describe('GET /gui/apps/:appId — type=select XSS hardening', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-sec-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('escapes HTML special chars in option values (script injection)', async () => {
		const HOSTILE = '<script>window.__pwn=1</script>';
		const server = await buildHostileSelectApp(tempDir, [HOSTILE, 'safe'], 'safe');
		try {
			const loginRes = await server.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const res = await server.inject({
				method: 'GET',
				url: '/gui/apps/hostile',
				cookies: { [loginRes.cookies[0]!.name]: loginRes.cookies[0]!.value },
			});

			expect(res.statusCode).toBe(200);
			// Literal hostile string must NOT appear unescaped
			expect(res.body).not.toContain(HOSTILE);
			// The escaped form must be present (Eta auto-escapes <%= %>)
			expect(res.body).toContain('&lt;script&gt;');
			// No injected <script> tag with our payload
			const injectedScripts = (res.body.match(/<script[^>]*>/g) ?? []).filter((s) =>
				s.includes('window.__pwn'),
			);
			expect(injectedScripts).toHaveLength(0);
			// The safe option must be present
			expect(res.body).toContain('<option value="safe"');
		} finally {
			await server.close();
		}
	});

	it('escapes attribute-breaking chars in option values', async () => {
		const HOSTILE = '" autofocus onfocus="alert(1)';
		const server = await buildHostileSelectApp(tempDir, [HOSTILE, 'safe'], 'safe');
		try {
			const loginRes = await server.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const res = await server.inject({
				method: 'GET',
				url: '/gui/apps/hostile',
				cookies: { [loginRes.cookies[0]!.name]: loginRes.cookies[0]!.value },
			});

			expect(res.statusCode).toBe(200);
			// The attribute boundary must not be broken
			expect(res.body).not.toContain('autofocus onfocus="alert(1)');
			// The quote must be HTML-entity-escaped
			expect(res.body).toContain('&quot;');
		} finally {
			await server.close();
		}
	});

	it('does NOT render hostile out-of-options override as selected (no escape leak)', async () => {
		const HOSTILE = '<img onerror=alert(1)>';
		// Manifest options are clean — hostile value only comes from the override file
		const server = await buildHostileSelectApp(tempDir, ['regex', 'shadow'], 'regex');
		try {
			// Pre-write hostile override directly to the canonical override path
			const overrideDir = join(tempDir, 'system', 'app-config', 'hostile');
			await mkdir(overrideDir, { recursive: true });
			await writeFile(join(overrideDir, `${TEST_USER_ID}.yaml`), `routing_primary: "${HOSTILE}"\n`);

			const loginRes = await server.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const res = await server.inject({
				method: 'GET',
				url: '/gui/apps/hostile',
				cookies: { [loginRes.cookies[0]!.name]: loginRes.cookies[0]!.value },
			});

			expect(res.statusCode).toBe(200);
			// The hostile string must not appear in the body (it's not in options[], so not rendered)
			expect(res.body).not.toContain(HOSTILE);
			// No option should be selected (hostile value is not in options[])
			expect(res.body).not.toMatch(/<option[^>]*selected/);
			// Manifest options are still present
			expect(res.body).toContain('<option value="regex"');
			expect(res.body).toContain('<option value="shadow"');
		} finally {
			await server.close();
		}
	});
});
