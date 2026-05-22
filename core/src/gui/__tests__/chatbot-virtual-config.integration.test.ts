/**
 * Integration test: virtual chatbot registry entry works with GUI routes.
 *
 * Verifies REQ-CONV-013 — after apps/chatbot/ is deleted, the virtual entry
 * from buildVirtualChatbotApp() must allow:
 *   1. GET /gui/apps/chatbot to render both user_config fields
 *   2. POST /gui/config/chatbot/<userId> to persist an override to disk
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AppRegistry } from '../../services/app-registry/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { AppConfigServiceImpl } from '../../services/config/app-config-service.js';
import {
	CONTEXT_INTERNAL_BYPASS,
	ContextStoreServiceImpl,
} from '../../services/context-store/index.js';
import { conversationManifestToSettingDefs } from '../../services/conversation/manifest-settings.js';
import {
	CONVERSATION_USER_CONFIG,
	CONVERSATION_USER_CONFIG_MANIFEST,
} from '../../services/conversation/manifest.js';
import {
	RECENT_SESSION_SUMMARY_KEY,
	disableFlushAndCleanup,
} from '../../services/conversation/memory-flush.js';
import {
	VIRTUAL_CHATBOT_PATH,
	buildVirtualChatbotApp,
} from '../../services/conversation/virtual-app.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { SettingsRegistry } from '../../services/settings/settings-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { UserManager } from '../../services/user-manager/index.js';
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
		getHousehold: (id: string) =>
			id === 'hh-1' ? { id: 'hh-1', adminUserIds: [TEST_USER_ID] } : null,
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
	let settingsWriter: SettingsWriter;
	let settingsRegistry: SettingsRegistry;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-virtual-chatbot-'));

		const { manifest, module } = buildVirtualChatbotApp();
		const virtualRegisteredApp = { manifest, module, appDir: VIRTUAL_CHATBOT_PATH };

		const registry = {
			getAll: () => [virtualRegisteredApp],
			getApp: (id: string) => (id === 'chatbot' ? virtualRegisteredApp : undefined),
			getLoadedAppIds: () => ['chatbot'],
			getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
		} as unknown as AppRegistry;

		const config = makeMockConfig(tempDir);
		const appToggle = new AppToggleStore({ dataDir: tempDir });

		// Build real SettingsRegistry with all chatbot settings registered.
		settingsRegistry = new SettingsRegistry();
		for (const def of conversationManifestToSettingDefs(CONVERSATION_USER_CONFIG)) {
			settingsRegistry.register(def);
		}

		// Build real AppConfigServiceImpl for chatbot (same pattern as compose-runtime).
		const chatbotConfigService = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			defaults: CONVERSATION_USER_CONFIG_MANIFEST,
		});

		// Build real SettingsWriter with registry + resolvers.
		settingsWriter = new SettingsWriter({
			registry: settingsRegistry,
			appConfigResolver: (appId: string) =>
				appId === 'chatbot' ? chatbotConfigService : undefined,
			manifestResolver: (appId: string) =>
				appId === 'chatbot' ? CONVERSATION_USER_CONFIG_MANIFEST : undefined,
			logger: pino({ level: 'silent' }),
		});

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
					userManager: makeUserManager() as unknown as UserManager,
					householdService: makeHouseholdService() as unknown as HouseholdService,
				});
				await registerCsrfProtection(gui);
				registerAppsRoutes(gui, {
					registry,
					config,
					appToggle,
					dataDir: tempDir,
					logger,
				});
				registerConfigRoutes(gui, {
					registry,
					config,
					dataDir: tempDir,
					logger,
					settingsWriter,
					settingsRegistry,
				});
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

		const overridePath = join(tempDir, 'system', 'app-config', 'chatbot', `${TEST_USER_ID}.yaml`);
		const onDisk = parseYaml(await readFile(overridePath, 'utf-8'));
		expect(onDisk.log_to_notes).toBe(true);
	});

	it('REQ-CONV-FLUSH-011 carry-forward: legacy /gui/config/chatbot/:userId toggle-off invokes the cleanup helper via the SettingsWriter post-write hook', async () => {
		// Register cleanup spy on the real settingsWriter (mirrors compose-runtime:1044-1051 wiring).
		const cleanupSpy = vi.fn(async (_userId: string) => {});
		settingsWriter.registerPostWriteHook(
			'chatbot.flush_memory_on_idle_reset',
			async ({ userId, prevValue, newValue }) => {
				if (prevValue === true && newValue === false) {
					await cleanupSpy(userId);
				}
			},
		);

		// Pre-populate override: flush_memory_on_idle_reset: true (so prevValue is true).
		const overrideDir = join(tempDir, 'system', 'app-config', 'chatbot');
		await mkdir(overrideDir, { recursive: true });
		await writeFile(
			join(overrideDir, `${TEST_USER_ID}.yaml`),
			'flush_memory_on_idle_reset: true\n',
		);

		const { allCookies, csrfToken } = await loginAndGetCookies();
		expect(csrfToken).toBeTruthy();

		const postRes = await fastifyApp.inject({
			method: 'POST',
			url: `/gui/config/chatbot/${TEST_USER_ID}`,
			payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
			cookies: allCookies,
		});

		expect(postRes.statusCode).toBe(302);

		// On-disk YAML must reflect the toggle-off.
		const overridePath = join(tempDir, 'system', 'app-config', 'chatbot', `${TEST_USER_ID}.yaml`);
		const onDisk = parseYaml(await readFile(overridePath, 'utf-8'));
		expect(onDisk.flush_memory_on_idle_reset).toBe(false);

		// Cleanup helper must have been invoked exactly once with the userId.
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(cleanupSpy).toHaveBeenCalledWith(TEST_USER_ID);
	});

	it('REQ-CONV-FLUSH-011 end-to-end: toggle-off via legacy route deletes recent-session-summary from ContextStore', async () => {
		// Build a real ContextStore in the temp dir.
		const contextStore = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger: pino({ level: 'silent' }),
		});

		// Register the real cleanup on the settingsWriter hook.
		const flushLogger = pino({ level: 'silent' });
		settingsWriter.registerPostWriteHook(
			'chatbot.flush_memory_on_idle_reset',
			async ({ userId, prevValue, newValue }) => {
				if (prevValue === true && newValue === false) {
					await disableFlushAndCleanup(userId, {
						flushRemove: (uid, key) => contextStore.remove(uid, key, CONTEXT_INTERNAL_BYPASS),
						logger: flushLogger,
					});
				}
			},
		);

		// Pre-populate the config override (flush=true) and the context entry.
		const overrideDir = join(tempDir, 'system', 'app-config', 'chatbot');
		await mkdir(overrideDir, { recursive: true });
		await writeFile(
			join(overrideDir, `${TEST_USER_ID}.yaml`),
			'flush_memory_on_idle_reset: true\n',
		);
		await contextStore.save(TEST_USER_ID, RECENT_SESSION_SUMMARY_KEY, 'test summary', {
			kind: 'environment-fact',
			bypass: CONTEXT_INTERNAL_BYPASS,
		});

		// Confirm the entry exists before the POST.
		const before = await contextStore.getForUser(
			RECENT_SESSION_SUMMARY_KEY,
			TEST_USER_ID,
			CONTEXT_INTERNAL_BYPASS,
		);
		expect(before).toBeTruthy();

		const { allCookies, csrfToken } = await loginAndGetCookies();
		const postRes = await fastifyApp.inject({
			method: 'POST',
			url: `/gui/config/chatbot/${TEST_USER_ID}`,
			payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
			cookies: allCookies,
		});
		expect(postRes.statusCode).toBe(302);

		// Entry must be gone from the ContextStore.
		const after = await contextStore.getForUser(
			RECENT_SESSION_SUMMARY_KEY,
			TEST_USER_ID,
			CONTEXT_INTERNAL_BYPASS,
		);
		expect(after).toBeNull();
	});
});
