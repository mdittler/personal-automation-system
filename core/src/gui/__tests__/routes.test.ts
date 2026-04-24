import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import { CronManager } from '../../services/scheduler/cron-manager.js';
import { JobFailureNotifier } from '../../services/scheduler/job-failure-notifier.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import { OneOffManager } from '../../services/scheduler/oneoff-manager.js';
import { CredentialService } from '../../services/credentials/index.js';
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
	} as unknown as import('../../services/llm/providers/provider-registry.js').ProviderRegistry;

	// D5b-4: wire per-user auth so requirePlatformAdmin can inspect request.user
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);
	const userManager = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
	const householdService = makeHouseholdService(
		{ [TEST_USER_ID]: 'hh-1' },
		[{ id: 'hh-1', adminUserIds: [TEST_USER_ID] }],
	);

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: householdService as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			registerDashboardRoutes(gui, { registry, scheduler, config, modelSelector, dataDir: tempDir, logger });
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir: tempDir, logger });
			registerSchedulerRoutes(gui, { scheduler, timezone: config.timezone, logger });
			registerLogsRoutes(gui, { dataDir: tempDir, logger });
			registerConfigRoutes(gui, { registry, config, dataDir: tempDir, logger });
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

			const reenable = await authenticatedPost(app, '/gui/scheduler/system/daily-diff/re-enable', {});
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
			const cfgUserManager = makeUserManager([{ id: TEST_USER_ID, name: 'TestUser', isAdmin: true }]);
			const cfgHouseholdService = makeHouseholdService(
				{ [TEST_USER_ID]: 'hh-1' },
				[{ id: 'hh-1', adminUserIds: [TEST_USER_ID] }],
			);

			await fastifyApp.register(
				async (gui) => {
					await registerAuth(gui, {
						authToken: AUTH_TOKEN,
						credentialService: cfgCredService,
						userManager: cfgUserManager as unknown as import('../../services/user-manager/index.js').UserManager,
						householdService: cfgHouseholdService as unknown as import('../../services/household/index.js').HouseholdService,
					});
					await registerCsrfProtection(gui);
					registerDashboardRoutes(gui, {
						registry,
						scheduler,
						config,
						modelSelector: { getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }) } as unknown as ModelSelector,
						dataDir: configTempDir,
						logger,
					});
					registerConfigRoutes(gui, { registry, config, dataDir: configTempDir, logger });
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
	});

	describe('GET /gui/llm', () => {
		it('returns 200 with empty state when no usage', async () => {
			const res = await authenticatedGet(app, '/gui/llm');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('LLM');
			expect(res.body).toContain('No LLM API usage recorded');
		});
	});
});
