import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRegistry, RegisteredApp } from '../../services/app-registry/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import { CronManager } from '../../services/scheduler/cron-manager.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import { JobFailureNotifier } from '../../services/scheduler/job-failure-notifier.js';
import { OneOffManager } from '../../services/scheduler/oneoff-manager.js';
import type { SettingDef } from '../../services/settings/settings-registry.js';
import type { SettingsRegistry } from '../../services/settings/settings-registry.js';
import type {
	BatchAppResult,
	BatchResult,
	WriteRequest,
	WriteResult,
} from '../../services/settings/settings-writer.js';
import type { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAppsRoutes } from '../routes/apps.js';
import { registerConfigRoutes } from '../routes/config.js';
import { registerDashboardRoutes } from '../routes/dashboard.js';
import { registerLlmUsageRoutes } from '../routes/llm-usage.js';
import { registerLogsRoutes } from '../routes/logs.js';
import { registerSchedulerRoutes } from '../routes/scheduler.js';

const AUTH_TOKEN = 'test-token';
const TEST_USER_ID = '123';
const TEST_PASSWORD = 'test-password';
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

function makeNoopSettingsWriter(): SettingsWriter {
	return {
		write: vi.fn(async () => ({ ok: true, coerced: undefined }) as WriteResult),
		validate: vi.fn(() => ({ ok: true, coerced: undefined }) as WriteResult),
		writeBatch: vi.fn(async (items: WriteRequest[]) => {
			// Return success for each submitted appId so callers don't 500 on writeBatch.
			const perApp = new Map<string, BatchAppResult>();
			for (const item of items) {
				if (!perApp.has(item.appId)) {
					perApp.set(item.appId, { ok: true, written: [] });
				}
				(perApp.get(item.appId) as BatchAppResult).written.push(item.key);
			}
			return { perApp, perField: new Map() } as BatchResult;
		}),
		registerPostWriteHook: vi.fn(),
		runHooksForKey: vi.fn(async () => {}),
	} as unknown as SettingsWriter;
}

function makeStubRegistry(
	eligibleKeys: Array<{ appId: string; key: string }> = [],
): SettingsRegistry {
	const set = new Set(eligibleKeys.map((k) => `${k.appId}.${k.key}`));
	return {
		getByAppKey: (appId: string, key: string) =>
			set.has(`${appId}.${key}`) ? ({ appId, key } as SettingDef) : undefined,
		getAll: () => [],
		getByQualifiedKey: () => undefined,
		getForUser: () => [],
		getForCategory: () => [],
		getNlSafeQualifiedKeys: () => new Set<string>(),
	} as unknown as SettingsRegistry;
}

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'llama3.2:3b' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{
				id: '123',
				name: 'TestUser',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		],
	};
}

function createMockRegistry(): AppRegistry {
	const mockApp: RegisteredApp = {
		manifest: {
			app: {
				id: 'echo',
				name: 'Echo',
				version: '1.0.0',
				description: 'Test echo app',
			},
			capabilities: {
				messages: {
					intents: ['echo-message'],
					commands: [{ name: 'echo', description: 'Echo a message' }],
				},
			},
			requirements: {
				services: ['telegram'],
			},
		} as RegisteredApp['manifest'],
		module: {
			init: async () => {},
			handleMessage: async () => {},
		},
		appDir: '/tmp/apps/echo',
	};

	return {
		getAll: () => [mockApp],
		getApp: (id: string) => (id === 'echo' ? mockApp : undefined),
		getLoadedAppIds: () => ['echo'],
		getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
	} as unknown as AppRegistry;
}

async function buildApp(tempDir: string) {
	const config = createMockConfig();
	config.dataDir = tempDir;

	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	const registry = createMockRegistry();
	const cronManager = new CronManager(logger, 'UTC', tempDir);
	const oneOffManager = new OneOffManager(tempDir, logger);
	const notifier = new JobFailureNotifier({
		logger,
		sender: { send: vi.fn().mockResolvedValue(undefined) },
		adminChatId: TEST_USER_ID,
		autoDisableAfter: 1,
		notificationCooldownMs: 0,
		persistPath: join(tempDir, 'system', 'disabled-jobs.yaml'),
	});
	cronManager.setNotifier(notifier);
	oneOffManager.setNotifier(notifier);
	const scheduler = { cron: cronManager, oneOff: oneOffManager } as unknown as SchedulerServiceImpl;
	const appToggle = new AppToggleStore({ dataDir: tempDir, logger });
	const costTracker = { readUsage: async () => '' };
	const llm = { costTracker } as unknown as LLMServiceImpl;
	const modelSelector = {
		getStandardModel: () => 'claude-sonnet-4-20250514',
		getFastModel: () => 'claude-haiku-4-5-20251001',
		getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
		getFastRef: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
		getReasoningRef: () => undefined,
		setStandardModel: async () => {},
		setFastModel: async () => {},
		setStandardRef: async () => {},
		setFastRef: async () => {},
		setReasoningRef: async () => {},
	} as unknown as ModelSelector;
	const modelCatalog = {
		getModels: async () => [],
	} as unknown as ModelCatalog;
	const providerRegistry = {
		getAll: () => [],
		getProviderIds: () => [],
		has: () => false,
	} as unknown as ProviderRegistry;

	// D5b-4: wire per-user auth so requirePlatformAdmin can inspect request.user
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);
	const userManager = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
	const householdService = makeHouseholdService({ [TEST_USER_ID]: 'hh-1' }, [
		{ id: 'hh-1', adminUserIds: [TEST_USER_ID] },
	]);

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: userManager as unknown as UserManager,
				householdService: householdService as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerDashboardRoutes(gui, {
				registry,
				scheduler,
				config,
				modelSelector,
				dataDir: tempDir,
				logger,
			});
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir: tempDir, logger });
			registerSchedulerRoutes(gui, { scheduler, timezone: config.timezone, logger });
			registerLogsRoutes(gui, { dataDir: tempDir, logger });
			registerConfigRoutes(gui, {
				registry,
				config,
				dataDir: tempDir,
				logger,
				settingsWriter: makeNoopSettingsWriter(),
				settingsRegistry: makeStubRegistry(),
			});
			registerLlmUsageRoutes(gui, {
				llm,
				modelSelector,
				modelCatalog,
				providerRegistry,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, appToggle, cronManager, notifier };
}

/** Collect cookies from a Fastify inject response into a key-value map. */
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

async function authenticatedGet(app: Awaited<ReturnType<typeof Fastify>>, url: string) {
	// Login with per-user credentials (D5b-4: routes require platform-admin actor)
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
	});
	const cookies = collectCookies(loginRes);

	// The GET request will set the CSRF cookie via the CSRF middleware
	return app.inject({
		method: 'GET',
		url,
		cookies,
	});
}

async function authenticatedPost(
	app: Awaited<ReturnType<typeof Fastify>>,
	url: string,
	payload: Record<string, unknown>,
) {
	// 1. Login with per-user credentials
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
	});
	const loginCookies = collectCookies(loginRes);

	// 2. GET the dashboard to get the CSRF token cookie (any authenticated page works)
	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);

	// 3. Extract CSRF token from the meta tag
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';

	// 4. POST with CSRF token
	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies: allCookies,
	});
}

describe('GUI Routes', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;
	let appToggle: AppToggleStore;
	let cronManager: CronManager;
	let notifier: JobFailureNotifier;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-'));
		const built = await buildApp(tempDir);
		app = built.app;
		appToggle = built.appToggle;
		cronManager = built.cronManager;
		notifier = built.notifier;
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('GET /gui/login', () => {
		it('stays publicly reachable after admin-only route modules are registered', async () => {
			const res = await app.inject({
				method: 'GET',
				url: '/gui/login',
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('PAS Management');
		});
	});

	describe('GET /gui/ (Dashboard)', () => {
		it('returns 200 with dashboard content', async () => {
			const res = await authenticatedGet(app, '/gui/');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Dashboard');
			expect(res.body).toContain('Uptime');
		});

		it('shows loaded app count', async () => {
			const res = await authenticatedGet(app, '/gui/');
			expect(res.body).toContain('1'); // One loaded app (echo)
		});
	});

	describe('GET /gui/apps', () => {
		it('returns 200 with app list', async () => {
			const res = await authenticatedGet(app, '/gui/apps');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Echo');
		});
	});

	describe('GET /gui/apps/:appId', () => {
		it('returns 200 for existing app', async () => {
			const res = await authenticatedGet(app, '/gui/apps/echo');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Echo');
			expect(res.body).toContain('echo-message');
		});

		it('returns 404 for non-existent app', async () => {
			const res = await authenticatedGet(app, '/gui/apps/nonexistent');
			expect(res.statusCode).toBe(404);
			expect(res.body).toContain('Not Found');
		});
	});

	describe('GET /gui/apps/:appId — system-default effective value (chatbot)', () => {
		// Verifies that when config.chat.logToNotes is true and the user has no
		// per-user override, the GUI renders the effective value (true), not the
		// manifest default (false).
		let chatbotApp: Awaited<ReturnType<typeof Fastify>> | null = null;
		let chatbotTempDir: string;

		beforeEach(async () => {
			chatbotTempDir = await mkdtemp(join(tmpdir(), 'pas-chatbot-gui-'));

			const chatbotRegisteredApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Test' },
					capabilities: { messages: { intents: [] } },
					requirements: { services: ['telegram'] },
					user_config: [
						{ key: 'log_to_notes', type: 'boolean', default: false, description: 'Log to notes' },
					],
				} as RegisteredApp['manifest'],
				module: { init: async () => {}, handleMessage: async () => {} },
				appDir: '/tmp/apps/chatbot',
			};

			const chatbotRegistry = {
				getAll: () => [chatbotRegisteredApp],
				getApp: (id: string) => (id === 'chatbot' ? chatbotRegisteredApp : undefined),
				getLoadedAppIds: () => ['chatbot'],
				getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
			} as unknown as AppRegistry;

			const chatbotConfig: SystemConfig = {
				...createMockConfig(),
				dataDir: chatbotTempDir,
				chat: { logToNotes: true },
			};

			const chatbotToggle = new AppToggleStore({ dataDir: chatbotTempDir });

			chatbotApp = Fastify({ logger: false });
			await chatbotApp.register(fastifyCookie, { secret: AUTH_TOKEN });
			const eta = new Eta();
			await chatbotApp.register(fastifyView, {
				engine: { eta },
				root: viewsDir,
				viewExt: 'eta',
				layout: 'layout',
			});

			const cbCredService = new CredentialService({ dataDir: chatbotTempDir });
			await cbCredService.setPassword(TEST_USER_ID, TEST_PASSWORD);
			const cbUserManager = makeUserManager([
				{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true },
			]);
			const cbHouseholdService = makeHouseholdService({ [TEST_USER_ID]: 'hh-1' }, [
				{ id: 'hh-1', adminUserIds: [TEST_USER_ID] },
			]);

			await chatbotApp.register(
				async (gui) => {
					await registerAuth(gui, {
						authToken: AUTH_TOKEN,
						credentialService: cbCredService,
						userManager: cbUserManager as unknown as UserManager,
						householdService: cbHouseholdService as unknown as HouseholdService,
					});
					await registerCsrfProtection(gui);
					registerAppsRoutes(gui, {
						registry: chatbotRegistry,
						config: chatbotConfig,
						appToggle: chatbotToggle,
						dataDir: chatbotTempDir,
						logger,
					});
				},
				{ prefix: '/gui' },
			);
		});

		afterEach(async () => {
			if (chatbotApp) await chatbotApp.close();
			await rm(chatbotTempDir, { recursive: true, force: true });
		});

		it('renders log_to_notes as true (system default) when user has no override', async () => {
			// No per-user override file exists for user 123.
			// config.chat.logToNotes = true → effective value should be true.
			const loginRes = await chatbotApp!.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const cookies = collectCookies(loginRes);

			const res = await chatbotApp!.inject({
				method: 'GET',
				url: '/gui/apps/chatbot',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			// The "true" option must be selected (system default wins over manifest default false)
			expect(res.body).toContain('value="true" selected');
			// The "false" option must NOT be selected
			expect(res.body).not.toContain('value="false" selected');
		});
	});

	describe('GET /gui/apps/:appId — type=select widget rendering', () => {
		async function buildFoodSelectApp(
			selectTempDir: string,
			userConfigDefs: RegisteredApp['manifest']['user_config'],
		) {
			const foodApp: RegisteredApp = {
				manifest: {
					app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food test' },
					capabilities: { messages: { intents: [] } },
					requirements: { services: [] },
					user_config: userConfigDefs,
				} as RegisteredApp['manifest'],
				module: { init: async () => {}, handleMessage: async () => {} },
				appDir: '/tmp/apps/food',
			};
			const reg = {
				getAll: () => [foodApp],
				getApp: (id: string) => (id === 'food' ? foodApp : undefined),
				getLoadedAppIds: () => ['food'],
				getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
			} as unknown as AppRegistry;
			const cfg = { ...createMockConfig(), dataDir: selectTempDir };
			const toggle = new AppToggleStore({ dataDir: selectTempDir });
			const server = Fastify({ logger: false });
			await server.register(fastifyCookie, { secret: AUTH_TOKEN });
			const etaInst = new Eta();
			await server.register(fastifyView, {
				engine: { eta: etaInst },
				root: viewsDir,
				viewExt: 'eta',
				layout: 'layout',
			});
			const credSvc = new CredentialService({ dataDir: selectTempDir });
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
						registry: reg,
						config: cfg,
						appToggle: toggle,
						dataDir: selectTempDir,
						logger,
					});
				},
				{ prefix: '/gui' },
			);
			return server;
		}

		it('renders <select> with one <option> per options[] entry (default selected)', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-'));
			const server = await buildFoodSelectApp(tempDir, [
				{
					key: 'routing_primary',
					type: 'select',
					default: 'regex',
					options: ['regex', 'shadow'],
					description: 'Primary routing strategy',
				},
			]);
			try {
				const loginRes = await server.inject({
					method: 'POST',
					url: '/gui/login',
					payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
				});
				const cookies = collectCookies(loginRes);
				const res = await server.inject({ method: 'GET', url: '/gui/apps/food', cookies });
				expect(res.statusCode).toBe(200);
				expect(res.body).toMatch(/<select[^>]*name="routing_primary"[^>]*>/);
				expect(res.body).not.toMatch(/<input[^>]*type="text"[^>]*name="routing_primary"/);
				expect(res.body).not.toMatch(/<input[^>]*name="routing_primary"[^>]*type="text"/);
				expect(res.body).toContain('<option value="regex"');
				expect(res.body).toContain('<option value="shadow"');
				expect(res.body).toMatch(/<option value="regex" selected>/);
				expect(res.body).not.toMatch(/<option value="shadow" selected>/);
			} finally {
				await server.close();
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('renders override value as selected when one exists', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-'));
			const server = await buildFoodSelectApp(tempDir, [
				{
					key: 'routing_primary',
					type: 'select',
					default: 'regex',
					options: ['regex', 'shadow'],
					description: 'Primary routing strategy',
				},
			]);
			try {
				const overrideDir = join(tempDir, 'system', 'app-config', 'food');
				await mkdir(overrideDir, { recursive: true });
				await writeFile(join(overrideDir, `${TEST_USER_ID}.yaml`), 'routing_primary: shadow\n');
				const loginRes = await server.inject({
					method: 'POST',
					url: '/gui/login',
					payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
				});
				const cookies = collectCookies(loginRes);
				const res = await server.inject({ method: 'GET', url: '/gui/apps/food', cookies });
				expect(res.statusCode).toBe(200);
				expect(res.body).toMatch(/<option value="shadow" selected>/);
				expect(res.body).not.toMatch(/<option value="regex" selected>/);
			} finally {
				await server.close();
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('renders single-option select correctly', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-'));
			const server = await buildFoodSelectApp(tempDir, [
				{ key: 'mode', type: 'select', default: 'only', options: ['only'], description: 'Mode' },
			]);
			try {
				const loginRes = await server.inject({
					method: 'POST',
					url: '/gui/login',
					payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
				});
				const cookies = collectCookies(loginRes);
				const res = await server.inject({ method: 'GET', url: '/gui/apps/food', cookies });
				expect(res.statusCode).toBe(200);
				expect(res.body).toMatch(/<select[^>]*name="mode"[^>]*>/);
				expect(res.body).toMatch(/<option value="only" selected>only<\/option>/);
			} finally {
				await server.close();
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('renders <select> with no <option> children when options[] is empty (defensive)', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-'));
			const server = await buildFoodSelectApp(tempDir, [
				{ key: 'empty_sel', type: 'select', default: '', options: [], description: 'Empty' },
			]);
			try {
				const loginRes = await server.inject({
					method: 'POST',
					url: '/gui/login',
					payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
				});
				const cookies = collectCookies(loginRes);
				const res = await server.inject({ method: 'GET', url: '/gui/apps/food', cookies });
				expect(res.statusCode).toBe(200);
				expect(res.body).toMatch(/<select[^>]*name="empty_sel"[^>]*>/);
				// No <option> elements inside this select
				const afterOpen = res.body.split(/name="empty_sel"[^>]*>/)[1] ?? '';
				const beforeClose = afterOpen.split('</select>')[0] ?? '';
				expect(beforeClose).not.toMatch(/<option/);
			} finally {
				await server.close();
				await rm(tempDir, { recursive: true, force: true });
			}
		});

		it('renders <select> alongside boolean fields without breaking either widget', async () => {
			const tempDir = await mkdtemp(join(tmpdir(), 'pas-sel-'));
			const server = await buildFoodSelectApp(tempDir, [
				{
					key: 'routing_primary',
					type: 'select',
					default: 'regex',
					options: ['regex', 'shadow'],
					description: 'Routing strategy',
				},
				{ key: 'enabled', type: 'boolean', default: false, description: 'Enabled' },
			]);
			try {
				const loginRes = await server.inject({
					method: 'POST',
					url: '/gui/login',
					payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
				});
				const cookies = collectCookies(loginRes);
				const res = await server.inject({ method: 'GET', url: '/gui/apps/food', cookies });
				expect(res.statusCode).toBe(200);
				// Select widget for routing_primary
				expect(res.body).toMatch(/<select[^>]*name="routing_primary"[^>]*>/);
				expect(res.body).toContain('<option value="regex"');
				expect(res.body).toContain('<option value="shadow"');
				// Boolean widget for enabled (also renders as <select> with true/false)
				expect(res.body).toMatch(/<select[^>]*name="enabled"[^>]*>/);
				expect(res.body).toContain('<option value="true"');
				expect(res.body).toContain('<option value="false"');
				// No text inputs for these fields
				expect(res.body).not.toMatch(/<input[^>]*type="text"[^>]*name="routing_primary"/);
				expect(res.body).not.toMatch(/<input[^>]*name="routing_primary"[^>]*type="text"/);
			} finally {
				await server.close();
				await rm(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe('POST /gui/apps/:appId/toggle', () => {
		it('toggles app state and returns updated button', async () => {
			const res = await authenticatedPost(app, '/gui/apps/echo/toggle', {
				userId: '123',
				enabled: 'true',
			});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Disabled');

			// Verify toggle store was updated
			const overrides = await appToggle.getOverrides('123');
			expect(overrides.echo).toBe(false);
		});
	});

	describe('GET /gui/scheduler', () => {
		it('returns 200 with scheduler content', async () => {
			const res = await authenticatedGet(app, '/gui/scheduler');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Scheduler');
			expect(res.body).toContain('Cron Jobs');
		});

		it('shows disabled cron jobs and allows re-enable', async () => {
			cronManager.register(
				{
					id: 'daily-diff',
					appId: 'system',
					cron: '0 2 * * *',
					handler: 'daily-diff',
					description: 'Generate daily diff',
					userScope: 'system',
				},
				() => async () => {},
			);
			await notifier.onFailure('system', 'daily-diff', 'boom');

			const page = await authenticatedGet(app, '/gui/scheduler');
			expect(page.statusCode).toBe(200);
			expect(page.body).toContain('Disabled');
			expect(page.body).toContain('/gui/scheduler/system/daily-diff/re-enable');

			const reenable = await authenticatedPost(
				app,
				'/gui/scheduler/system/daily-diff/re-enable',
				{},
			);
			expect(reenable.statusCode).toBe(302);
			expect(reenable.headers.location).toBe('/gui/scheduler');

			const refreshed = await authenticatedGet(app, '/gui/scheduler');
			expect(refreshed.body).not.toContain('Disabled');
			expect(refreshed.body).toContain('Active');
		});

		it('rejects invalid scheduler identifiers on re-enable', async () => {
			const res = await authenticatedPost(app, '/gui/scheduler/system/daily.diff/re-enable', {});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid schedule identifier.');
		});

		it('returns 404 when re-enable target does not exist', async () => {
			const res = await authenticatedPost(app, '/gui/scheduler/system/missing/re-enable', {});
			expect(res.statusCode).toBe(404);
			expect(res.body).toContain('Schedule not found.');
		});
	});

	describe('GET /gui/logs', () => {
		it('returns 200 with log viewer', async () => {
			const res = await authenticatedGet(app, '/gui/logs');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Logs');
		});

		it('handles missing log file gracefully', async () => {
			const res = await authenticatedGet(app, '/gui/logs');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('not available');
		});

		it('parses JSON log entries when file exists', async () => {
			const { ensureDir } = await import('../../utils/file.js');
			const logDir = join(tempDir, 'system', 'logs');
			await ensureDir(logDir);
			const logEntry = JSON.stringify({
				level: 30,
				time: Date.now(),
				msg: 'Test log message',
				service: 'test',
			});
			await writeFile(join(logDir, 'pas.log'), `${logEntry}\n`);

			const res = await authenticatedGet(app, '/gui/logs');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test log message');
		});
	});

	describe('GET /gui/logs/entries (D16)', () => {
		it('returns HTML table rows when log file exists', async () => {
			const { ensureDir } = await import('../../utils/file.js');
			const logDir = join(tempDir, 'system', 'logs');
			await ensureDir(logDir);
			const entries = [
				JSON.stringify({ level: 30, time: Date.now(), msg: 'Info message', service: 'test' }),
				JSON.stringify({ level: 50, time: Date.now(), msg: 'Error message', service: 'test' }),
			];
			await writeFile(join(logDir, 'pas.log'), `${entries.join('\n')}\n`);

			const res = await authenticatedGet(app, '/gui/logs/entries');

			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(res.body).toContain('Info message');
			expect(res.body).toContain('Error message');
		});

		it('filters by level parameter', async () => {
			const { ensureDir } = await import('../../utils/file.js');
			const logDir = join(tempDir, 'system', 'logs');
			await ensureDir(logDir);
			const entries = [
				JSON.stringify({ level: 30, time: Date.now(), msg: 'Info only' }),
				JSON.stringify({ level: 50, time: Date.now(), msg: 'Error only' }),
			];
			await writeFile(join(logDir, 'pas.log'), `${entries.join('\n')}\n`);

			const res = await authenticatedGet(app, '/gui/logs/entries?level=error');

			expect(res.body).toContain('Error only');
			expect(res.body).not.toContain('Info only');
		});

		it('respects limit parameter', async () => {
			const { ensureDir } = await import('../../utils/file.js');
			const logDir = join(tempDir, 'system', 'logs');
			await ensureDir(logDir);
			const entries = Array.from({ length: 10 }, (_, i) =>
				JSON.stringify({ level: 30, time: Date.now(), msg: `Msg ${i}` }),
			);
			await writeFile(join(logDir, 'pas.log'), `${entries.join('\n')}\n`);

			const res = await authenticatedGet(app, '/gui/logs/entries?limit=3');

			// Count <tr> elements (each log entry is one row)
			const rowCount = (res.body.match(/<tr/g) ?? []).length;
			expect(rowCount).toBe(3);
		});

		it('caps limit at 500', async () => {
			// Just verify the route doesn't error with a large limit
			const res = await authenticatedGet(app, '/gui/logs/entries?limit=9999');
			expect(res.statusCode).toBe(200);
		});

		it('returns fallback when log file is missing', async () => {
			const res = await authenticatedGet(app, '/gui/logs/entries');

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Log file not available');
		});
	});

	describe('GET /gui/config', () => {
		it('redirects to dashboard', async () => {
			const res = await authenticatedGet(app, '/gui/config');
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/');
		});
	});

	describe('GET /gui/ (Dashboard — merged config)', () => {
		it('shows system config on dashboard', async () => {
			const res = await authenticatedGet(app, '/gui/');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('System Config');
			expect(res.body).toContain('3000'); // port
			expect(res.body).toContain('UTC'); // timezone
		});

		it('shows registered users on dashboard', async () => {
			const res = await authenticatedGet(app, '/gui/');
			expect(res.body).toContain('TestUser');
		});
	});

	describe('POST /gui/config/:appId/:userId (D17)', () => {
		it('rejects invalid appId format', async () => {
			const res = await authenticatedPost(app, '/gui/config/INVALID_APP!/123', {
				key: 'value',
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid app ID');
		});

		it('rejects invalid userId format', async () => {
			const res = await authenticatedPost(app, '/gui/config/echo/bad user!', {
				key: 'value',
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('Invalid user ID');
		});

		it('returns 404 for unknown app', async () => {
			const res = await authenticatedPost(app, '/gui/config/nonexistent/123', {
				key: 'value',
			});
			expect(res.statusCode).toBe(404);
			expect(res.body).toContain('App not found');
		});

		it('returns 400 for unknown user', async () => {
			const res = await authenticatedPost(app, '/gui/config/echo/999999', {
				key: 'value',
			});
			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('User not found');
		});

		it('redirects on successful update (no user_config)', async () => {
			// echo app has no user_config, so validated will be empty but update still works
			const res = await authenticatedPost(app, '/gui/config/echo/123', {
				someKey: 'someValue',
			});
			// Should redirect to app detail page
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/apps/echo');
		});
	});

	describe('POST /gui/config with user_config app (D17)', () => {
		let configApp: Awaited<ReturnType<typeof Fastify>>;
		let configTempDir: string;

		beforeEach(async () => {
			configTempDir = await mkdtemp(join(tmpdir(), 'pas-gui-cfg-'));
		});

		afterEach(async () => {
			if (configApp) await configApp.close();
			await rm(configTempDir, { recursive: true, force: true });
		});

		async function buildConfigApp() {
			const config = createMockConfig();
			config.dataDir = configTempDir;

			const mockAppWithConfig: RegisteredApp = {
				manifest: {
					app: { id: 'myapp', name: 'My App', version: '1.0.0', description: 'Test' },
					capabilities: { messages: { intents: [] } },
					requirements: { services: ['telegram'] },
					user_config: [
						{ key: 'name', type: 'string', description: 'User name' },
						{ key: 'age', type: 'number', description: 'Age' },
						{ key: 'enabled', type: 'boolean', description: 'Enabled' },
					],
				} as RegisteredApp['manifest'],
				module: { init: async () => {}, handleMessage: async () => {} },
				appDir: '/tmp/apps/myapp',
			};

			const registry = {
				getAll: () => [mockAppWithConfig],
				getApp: (id: string) => (id === 'myapp' ? mockAppWithConfig : undefined),
				getLoadedAppIds: () => ['myapp'],
				getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
			} as unknown as AppRegistry;

			const cronMgr = new CronManager(logger, 'UTC', configTempDir);
			const oneOff = new OneOffManager(configTempDir, logger);
			const scheduler = { cron: cronMgr, oneOff } as unknown as SchedulerServiceImpl;

			const fastifyApp = Fastify({ logger: false });
			await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });
			const eta = new Eta();
			await fastifyApp.register(fastifyView, {
				engine: { eta },
				root: viewsDir,
				viewExt: 'eta',
				layout: 'layout',
			});

			// D5b-4: wire per-user auth
			const cfgCredService = new CredentialService({ dataDir: configTempDir });
			await cfgCredService.setPassword(TEST_USER_ID, TEST_PASSWORD);
			const cfgUserManager = makeUserManager([
				{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true },
			]);
			const cfgHouseholdService = makeHouseholdService({ [TEST_USER_ID]: 'hh-1' }, [
				{ id: 'hh-1', adminUserIds: [TEST_USER_ID] },
			]);

			await fastifyApp.register(
				async (gui) => {
					await registerAuth(gui, {
						authToken: AUTH_TOKEN,
						credentialService: cfgCredService,
						userManager: cfgUserManager as unknown as UserManager,
						householdService: cfgHouseholdService as unknown as HouseholdService,
					});
					await registerCsrfProtection(gui);
					registerDashboardRoutes(gui, {
						registry,
						scheduler,
						config,
						modelSelector: {
							getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
						} as unknown as ModelSelector,
						dataDir: configTempDir,
						logger,
					});
					registerConfigRoutes(gui, {
						registry,
						config,
						dataDir: configTempDir,
						logger,
						settingsWriter: makeNoopSettingsWriter(),
						settingsRegistry: makeStubRegistry(),
					});
				},
				{ prefix: '/gui' },
			);

			return fastifyApp;
		}

		async function configPost(
			fastifyApp: Awaited<ReturnType<typeof Fastify>>,
			url: string,
			payload: Record<string, unknown>,
		) {
			const loginRes = await fastifyApp.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const loginCookies = collectCookies(loginRes);

			const getRes = await fastifyApp.inject({
				method: 'GET',
				url: '/gui/',
				cookies: loginCookies,
			});
			const allCookies = collectCookies(loginRes, getRes);
			const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
			const csrfToken = metaMatch?.[1] ?? '';

			return fastifyApp.inject({
				method: 'POST',
				url,
				payload: { ...payload, _csrf: csrfToken },
				cookies: allCookies,
			});
		}

		it('coerces number and boolean types', async () => {
			configApp = await buildConfigApp();

			const res = await configPost(configApp, '/gui/config/myapp/123', {
				name: 'Alice',
				age: '30',
				enabled: 'true',
			});

			expect(res.statusCode).toBe(302);
		});

		it('skips _csrf field and unknown keys', async () => {
			configApp = await buildConfigApp();

			const res = await configPost(configApp, '/gui/config/myapp/123', {
				name: 'Bob',
				unknownField: 'ignored',
			});

			expect(res.statusCode).toBe(302);
		});

		it('returns 400 when a value fails coercion (coerce-user-config reject path)', async () => {
			configApp = await buildConfigApp();

			// 'banana' is not a valid number — coerceUserConfigValue rejects it
			const res = await configPost(configApp, '/gui/config/myapp/123', {
				age: 'banana',
			});

			expect(res.statusCode).toBe(400);
			// Response body should name the failed key
			expect(res.body).toContain('age');
		});

		it('returns 400 when a boolean value fails coercion', async () => {
			configApp = await buildConfigApp();

			// 'maybe' is not a valid boolean
			const res = await configPost(configApp, '/gui/config/myapp/123', {
				enabled: 'maybe',
			});

			expect(res.statusCode).toBe(400);
			expect(res.body).toContain('enabled');
		});
	});

	describe('GET /gui/llm', () => {
		it('returns 200 with empty state when no usage', async () => {
			const res = await authenticatedGet(app, '/gui/llm');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('LLM');
			expect(res.body).toContain('No LLM API usage recorded');
		});
	});

	describe('POST /gui/config/chatbot/:userId — flush_memory_on_idle_reset routes through SettingsWriter', () => {
		let flushApp: Awaited<ReturnType<typeof Fastify>> | null = null;
		let flushTempDir: string;
		let writeBatchSpy: ReturnType<typeof vi.fn>;
		let validateSpy: ReturnType<typeof vi.fn>;

		beforeEach(async () => {
			flushTempDir = await mkdtemp(join(tmpdir(), 'pas-cfg-flush-'));

			validateSpy = vi.fn(
				(req: WriteRequest): WriteResult => ({
					ok: true,
					coerced: req.rawValue === 'true',
				}),
			);
			writeBatchSpy = vi.fn(
				async (
					items: WriteRequest[],
				): Promise<{ perApp: Map<string, BatchAppResult>; perField: Map<string, WriteResult> }> => {
					const perApp = new Map<string, BatchAppResult>();
					const perField = new Map<string, WriteResult>();
					for (const item of items) {
						perField.set(`${item.appId}.${item.key}`, {
							ok: true,
							coerced: item.rawValue === 'true',
						});
					}
					const appIds = [...new Set(items.map((i) => i.appId))];
					for (const appId of appIds) {
						perApp.set(appId, {
							ok: true,
							written: items.filter((i) => i.appId === appId).map((i) => i.key),
						});
					}
					return { perApp, perField };
				},
			);
			const mockWriter = {
				write: vi.fn(),
				validate: validateSpy,
				writeBatch: writeBatchSpy,
				registerPostWriteHook: vi.fn(),
				runHooksForKey: vi.fn(),
			} as unknown as SettingsWriter;

			const stubRegistry = makeStubRegistry([
				{ appId: 'chatbot', key: 'flush_memory_on_idle_reset' },
				{ appId: 'chatbot', key: 'log_to_notes' },
			]);

			const chatbotApp: RegisteredApp = {
				manifest: {
					app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'AI assistant' },
					capabilities: { messages: { intents: [] } },
					requirements: { services: [] },
					user_config: [
						{
							key: 'flush_memory_on_idle_reset',
							type: 'boolean',
							default: false,
							description: 'Flush memory',
						},
						{ key: 'log_to_notes', type: 'boolean', default: false, description: 'Log to notes' },
					],
				} as RegisteredApp['manifest'],
				module: { init: async () => {}, handleMessage: async () => {} },
				appDir: '/tmp/apps/chatbot',
			};

			const flushRegistry = {
				getAll: () => [chatbotApp],
				getApp: (id: string) => (id === 'chatbot' ? chatbotApp : undefined),
				getLoadedAppIds: () => ['chatbot'],
				getManifestCache: () => ({}) as ReturnType<AppRegistry['getManifestCache']>,
			} as unknown as AppRegistry;

			const flushConfig: SystemConfig = {
				port: 3000,
				dataDir: flushTempDir,
				logLevel: 'info',
				timezone: 'UTC',
				telegram: { botToken: 'test' },
				ollama: { url: 'http://localhost:11434', model: 'llama3.2:3b' },
				claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
				gui: { authToken: AUTH_TOKEN },
				cloudflare: {},
				users: [
					{
						id: TEST_USER_ID,
						name: 'TestUser',
						isAdmin: true,
						enabledApps: ['*'],
						sharedScopes: [],
					},
				],
			} as unknown as SystemConfig;

			const credSvc = new CredentialService({ dataDir: flushTempDir });
			await credSvc.setPassword(TEST_USER_ID, TEST_PASSWORD);

			const uMgr = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
			const hhSvc = makeHouseholdService({ [TEST_USER_ID]: 'hh-1' }, [
				{ id: 'hh-1', adminUserIds: [TEST_USER_ID] },
			]);

			flushApp = Fastify({ logger: false });
			await flushApp.register(fastifyCookie, { secret: AUTH_TOKEN });
			const eta = new Eta();
			await flushApp.register(fastifyView, {
				engine: { eta },
				root: viewsDir,
				viewExt: 'eta',
				layout: 'layout',
			});

			const flushToggle = new AppToggleStore({ dataDir: flushTempDir });
			await flushApp.register(
				async (gui) => {
					await registerAuth(gui, {
						authToken: AUTH_TOKEN,
						credentialService: credSvc,
						userManager: uMgr as unknown as UserManager,
						householdService: hhSvc as unknown as HouseholdService,
					});
					await registerCsrfProtection(gui);
					registerAppsRoutes(gui, {
						registry: flushRegistry,
						config: flushConfig,
						appToggle: flushToggle,
						dataDir: flushTempDir,
						logger,
					});
					registerConfigRoutes(gui, {
						registry: flushRegistry,
						config: flushConfig,
						dataDir: flushTempDir,
						logger,
						settingsWriter: mockWriter,
						settingsRegistry: stubRegistry,
					});
				},
				{ prefix: '/gui' },
			);
		});

		afterEach(async () => {
			if (flushApp) {
				await flushApp.close();
				flushApp = null;
			}
			await rm(flushTempDir, { recursive: true, force: true });
		});

		async function flushLogin() {
			const loginRes = await flushApp!.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { userId: TEST_USER_ID, password: TEST_PASSWORD },
			});
			const loginCookies: Record<string, string> = {};
			for (const c of loginRes.cookies as Array<{ name: string; value: string }>) {
				loginCookies[c.name] = c.value;
			}
			// GET a route that needs auth to pick up the CSRF cookie
			const getRes = await flushApp!.inject({
				method: 'GET',
				url: '/gui/apps/chatbot',
				cookies: loginCookies,
			});
			const allCookies = { ...loginCookies };
			for (const c of getRes.cookies as Array<{ name: string; value: string }>) {
				allCookies[c.name] = c.value;
			}
			const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
			const csrfToken = metaMatch?.[1] ?? '';
			return { allCookies, csrfToken };
		}

		it('toggling flush_memory_on_idle_reset routes the write through writeBatch with source=admin-confirmed', async () => {
			const { allCookies, csrfToken } = await flushLogin();

			const res = await flushApp!.inject({
				method: 'POST',
				url: `/gui/config/chatbot/${TEST_USER_ID}`,
				cookies: allCookies,
				payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
			});

			expect(res.statusCode).toBe(302);
			expect(writeBatchSpy).toHaveBeenCalledTimes(1);
			const items = writeBatchSpy.mock.calls[0]![0] as WriteRequest[];
			expect(items).toEqual([
				expect.objectContaining({
					appId: 'chatbot',
					key: 'flush_memory_on_idle_reset',
					rawValue: 'false',
					userId: TEST_USER_ID,
					source: 'admin-confirmed',
				}),
			]);
		});

		it('mixed body batches BOTH chatbot keys into ONE writeBatch call (data-loss regression guard)', async () => {
			const { allCookies, csrfToken } = await flushLogin();

			const res = await flushApp!.inject({
				method: 'POST',
				url: `/gui/config/chatbot/${TEST_USER_ID}`,
				cookies: allCookies,
				payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false', log_to_notes: 'true' },
			});

			expect(res.statusCode).toBe(302);
			expect(writeBatchSpy).toHaveBeenCalledTimes(1);
			const items = writeBatchSpy.mock.calls[0]![0] as WriteRequest[];
			expect(items.map((i) => i.key).sort()).toEqual([
				'flush_memory_on_idle_reset',
				'log_to_notes',
			]);
		});

		it('returns 400 on validation failure without persisting', async () => {
			validateSpy.mockReturnValueOnce({
				ok: false,
				reason: 'coercion failed: not a boolean',
			} as WriteResult);
			const { allCookies, csrfToken } = await flushLogin();

			const res = await flushApp!.inject({
				method: 'POST',
				url: `/gui/config/chatbot/${TEST_USER_ID}`,
				cookies: allCookies,
				payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'garbage' },
			});

			expect(res.statusCode).toBe(400);
			expect(writeBatchSpy).not.toHaveBeenCalled();
		});

		it('returns 500 when writeBatch throws', async () => {
			writeBatchSpy.mockRejectedValueOnce(new Error('disk full'));
			const { allCookies, csrfToken } = await flushLogin();

			const res = await flushApp!.inject({
				method: 'POST',
				url: `/gui/config/chatbot/${TEST_USER_ID}`,
				cookies: allCookies,
				payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
			});

			expect(res.statusCode).toBe(500);
		});

		it('returns 500 when writeBatch reports perApp.ok=false (soft persist failure)', async () => {
			writeBatchSpy.mockResolvedValueOnce({
				perApp: new Map<string, BatchAppResult>([
					['chatbot', { ok: false, reason: 'persist failed', written: [] }],
				]),
				perField: new Map<string, WriteResult>(),
			});
			const { allCookies, csrfToken } = await flushLogin();

			const res = await flushApp!.inject({
				method: 'POST',
				url: `/gui/config/chatbot/${TEST_USER_ID}`,
				cookies: allCookies,
				payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
			});

			expect(res.statusCode).toBe(500);
		});

		it('two concurrent POSTs both delegate to writeBatch (both return 302)', async () => {
			const { allCookies, csrfToken } = await flushLogin();

			const [r1, r2] = await Promise.all([
				flushApp!.inject({
					method: 'POST',
					url: `/gui/config/chatbot/${TEST_USER_ID}`,
					cookies: allCookies,
					payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'true' },
				}),
				flushApp!.inject({
					method: 'POST',
					url: `/gui/config/chatbot/${TEST_USER_ID}`,
					cookies: allCookies,
					payload: { _csrf: csrfToken, flush_memory_on_idle_reset: 'false' },
				}),
			]);

			expect(r1!.statusCode).toBe(302);
			expect(r2!.statusCode).toBe(302);
			// Both requests delegate to writeBatch. Race resolution lives in the lock layer;
			// this test pins only the delegation contract, not final on-disk state.
			expect(writeBatchSpy).toHaveBeenCalled();
		});
	});
});
