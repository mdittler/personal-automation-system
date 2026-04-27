/**
 * Integration test: virtual chatbot registry entry works with GUI routes.
 *
 * Verifies REQ-CONV-013 — after apps/chatbot/ is deleted, the virtual entry
 * from buildVirtualChatbotApp() must allow:
 *   1. GET /gui/apps/chatbot to render both user_config fields
 *   2. POST /gui/config/chatbot/<userId> to persist an override to disk
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { parse as parseYaml } from 'yaml';
import type { AppRegistry } from '../../services/app-registry/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import { buildVirtualChatbotApp } from '../../services/conversation/virtual-app.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAppsRoutes } from '../routes/apps.js';
import { registerConfigRoutes } from '../routes/config.js';

const AUTH_TOKEN = 'test-token';
const TEST_USER_ID = '123';
const TEST_PASSWORD = 'test-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager() {
	return {
		getUser: (id: string) =>
			id === TEST_USER_ID ? { id: TEST_USER_ID, name: 'TestUser', isAdmin: true } : null,
		getAllUsers: () => [{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }],
	};
}

function makeHouseholdService() {
	return {
		getHouseholdForUser: (_userId: string) => 'hh-1',
		getHousehold: (id: string) => (id === 'hh-1' ? { id: 'hh-1', adminUserIds: [TEST_USER_ID] } : null),
	};
}

function makeMockConfig(dataDir: string): SystemConfig {
	return {
		port: 3000,
		dataDir,
		logLevel: 'info',
		timezone: 'UTC',
		users: [{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true, telegramId: 123 }],
	} as unknown as SystemConfig;
}

describe('GUI — virtual chatbot registry entry (REQ-CONV-013)', () => {
	let fastifyApp: ReturnType<typeof Fastify>;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-virtual-chatbot-'));

		const { manifest, module } = buildVirtualChatbotApp();
		const virtualRegisteredApp = { manifest, module, appDir: '<virtual:chatbot>' };

		const registry = {
			getAll: () => [virtualRegisteredApp],
			getApp: (id: string) => (id === 'chatbot' ? virtualRegisteredApp : undefined),
			getLoadedAppIds: () => ['chatbot'],
			getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
		} as unknown as AppRegistry;

		const config = makeMockConfig(tempDir);
		const appToggle = new AppToggleStore({ dataDir: tempDir });

		fastifyApp = Fastify({ logger: false });
		await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });
		const eta = new Eta();
		await fastifyApp.register(fastifyView, {
			engine: { eta },
			root: viewsDir,
			viewExt: 'eta',
			layout: 'layout',
		});

		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);

		await fastifyApp.register(
			async (gui) => {
				await registerAuth(gui, {
					authToken: AUTH_TOKEN,
					credentialService: credService,
					userManager: makeUserManager() as unknown as import('../../services/user-manager/index.js').UserManager,
					householdService: makeHouseholdService() as unknown as import('../../services/household/index.js').HouseholdService,
				});
				await registerCsrfProtection(gui);
				registerAppsRoutes(gui, {
					registry,
					config,
					appToggle,
					dataDir: tempDir,
					logger,
				});
				registerConfigRoutes(gui, { registry, config, dataDir: tempDir, logger });
			},
			{ prefix: '/gui' },
		);
	});

	afterEach(async () => {
		if (fastifyApp) await fastifyApp.close();
		await rm(tempDir, { recursive: true, force: true });
	});

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

	async function loginAndGetCookies() {
		const loginRes = await fastifyApp.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
		});
		// Also do a GET to pick up the CSRF double-submit cookie
		const getRes = await fastifyApp.inject({
			method: 'GET',
			url: '/gui/apps/chatbot',
			cookies: collectCookies(loginRes),
		});
		const allCookies = collectCookies(loginRes, getRes);
		const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
		const csrfToken = metaMatch?.[1] ?? '';
		return { allCookies, csrfToken, getBody: getRes.body, getStatus: getRes.statusCode };
	}

	it('GET /gui/apps/chatbot renders 200 with auto_detect_pas + log_to_notes', async () => {
		const { getStatus, getBody } = await loginAndGetCookies();

		expect(getStatus).toBe(200);
		expect(getBody).toContain('auto_detect_pas');
		expect(getBody).toContain('log_to_notes');
		expect(getBody).not.toMatch(/not found/i);
	});

	it('POST /gui/config/chatbot/<userId> persists override to disk (REQ-CONV-013)', async () => {
		const { allCookies, csrfToken } = await loginAndGetCookies();
		expect(csrfToken).toBeTruthy();

		const postRes = await fastifyApp.inject({
			method: 'POST',
			url: `/gui/config/chatbot/${TEST_USER_ID}`,
			payload: { _csrf: csrfToken, log_to_notes: 'true' },
			cookies: allCookies,
		});

		// POST should redirect (302) or return 200
		expect(postRes.statusCode).toBeLessThan(400);

		// AppConfigServiceImpl writes to dataDir/system/app-config/<appId>/<userId>.yaml.
		// registerConfigRoutes is called with dataDir: tempDir, so the path is:
		const overridePath = join(tempDir, 'system', 'app-config', 'chatbot', `${TEST_USER_ID}.yaml`);
		const onDisk = parseYaml(await readFile(overridePath, 'utf-8'));
		expect(onDisk.log_to_notes).toBe(true);
	});
});
