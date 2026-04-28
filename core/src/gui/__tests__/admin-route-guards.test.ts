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
import type { AppRegistry, RegisteredApp } from '../../services/app-registry/index.js';
import type { AlertService } from '../../services/alerts/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import type { ContextStoreServiceImpl } from '../../services/context-store/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import type { ReportService } from '../../services/reports/index.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { UserMutationService } from '../../services/user-manager/user-mutation-service.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAlertRoutes } from '../routes/alerts.js';
import { registerAppsRoutes } from '../routes/apps.js';
import { registerConfigRoutes } from '../routes/config.js';
import { registerContextRoutes } from '../routes/context.js';
import { registerLlmUsageRoutes } from '../routes/llm-usage.js';
import { registerLogsRoutes } from '../routes/logs.js';
import { registerReportRoutes } from '../routes/reports.js';
import { registerSchedulerRoutes } from '../routes/scheduler.js';
import { registerSpaceRoutes } from '../routes/spaces.js';
import { registerUserRoutes } from '../routes/users.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_PASS = 'admin-password';
const MEMBER_PASS = 'member-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_USER = {
	id: '123',
	name: 'Admin',
	isAdmin: true,
	enabledApps: ['*'],
	sharedScopes: [],
};
const MEMBER_USER = {
	id: '456',
	name: 'Member',
	isAdmin: false,
	enabledApps: ['*'],
	sharedScopes: [],
};
const ALL_USERS = [ADMIN_USER, MEMBER_USER];

function makeUserManager(): UserManager {
	return {
		getUser: vi.fn().mockImplementation((id: string) => ALL_USERS.find((u) => u.id === id) ?? null),
		getAllUsers: vi.fn().mockReturnValue(ALL_USERS),
		isRegistered: vi.fn().mockImplementation((id: string) => ALL_USERS.some((u) => u.id === id)),
	} as unknown as UserManager;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: vi.fn().mockReturnValue('hh-1'),
		getHousehold: vi.fn().mockReturnValue({ id: 'hh-1', name: 'Home', adminUserIds: [ADMIN_USER.id] }),
	};
}

function createMockConfig(tempDir: string): SystemConfig {
	return {
		port: 3000,
		dataDir: tempDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'llama3.2:3b' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: ALL_USERS,
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
			capabilities: { messages: { intents: [] } },
			requirements: { services: ['telegram'] },
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

function makeScheduler(): SchedulerServiceImpl {
	return {
		cron: { getJobDetails: () => [] },
		oneOff: { getPendingTasks: async () => [] },
	} as unknown as SchedulerServiceImpl;
}

function makeLlm(): LLMServiceImpl {
	return {
		costTracker: { readUsage: async () => '' },
	} as unknown as LLMServiceImpl;
}

function makeModelSelector(): ModelSelector {
	return {
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
}

function makeContextStore() {
	return {
		listForUser: vi.fn().mockResolvedValue([]),
		getForUser: vi.fn().mockResolvedValue(null),
		setForUser: vi.fn().mockResolvedValue(undefined),
		deleteForUser: vi.fn().mockResolvedValue(false),
	};
}

function makeReportService() {
	return {
		listReports: vi.fn().mockResolvedValue([]),
		getReport: vi.fn().mockResolvedValue(null),
		saveReport: vi.fn().mockResolvedValue([]),
		deleteReport: vi.fn().mockResolvedValue(false),
		toggleReport: vi.fn().mockResolvedValue(null),
		previewReport: vi.fn().mockResolvedValue(''),
	};
}

function makeAlertService() {
	return {
		listAlerts: vi.fn().mockResolvedValue([]),
		getAlert: vi.fn().mockResolvedValue(null),
		saveAlert: vi.fn().mockResolvedValue([]),
		deleteAlert: vi.fn().mockResolvedValue(false),
		toggleAlert: vi.fn().mockResolvedValue(null),
		testAlert: vi.fn().mockResolvedValue({ fired: false, message: 'Not fired' }),
	};
}

function makeUserMutationService(): UserMutationService {
	return {
		updateUserApps: vi.fn().mockResolvedValue(undefined),
		updateUserSharedScopes: vi.fn().mockResolvedValue(undefined),
		removeUser: vi.fn().mockResolvedValue(undefined),
	} as unknown as UserMutationService;
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies) {
			result[c.name] = c.value;
		}
	}
	return result;
}

async function buildApp(tempDir: string) {
	const config = createMockConfig(tempDir);
	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	const credentialService = new CredentialService({ dataDir: tempDir });
	await credentialService.setPassword(ADMIN_USER.id, ADMIN_PASS);
	await credentialService.setPassword(MEMBER_USER.id, MEMBER_PASS);

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();
	const registry = createMockRegistry();
	const appToggle = new AppToggleStore({ dataDir: tempDir, logger });
	const spaceService = new SpaceService({
		dataDir: tempDir,
		userManager,
		householdService,
		logger,
	});
	await spaceService.init();

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager,
				householdService,
			});
			await registerCsrfProtection(gui);
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir: tempDir, logger });
			registerSchedulerRoutes(gui, { scheduler: makeScheduler(), timezone: config.timezone, logger });
			registerLogsRoutes(gui, { dataDir: tempDir, logger });
			registerConfigRoutes(gui, { registry, config, dataDir: tempDir, logger });
			registerLlmUsageRoutes(gui, {
				llm: makeLlm(),
				modelSelector: makeModelSelector(),
				modelCatalog: { getModels: async () => [] } as unknown as ModelCatalog,
				providerRegistry: {
					getAll: () => [],
					getProviderIds: () => [],
					has: () => false,
				} as unknown as ProviderRegistry,
				logger,
			});
			registerUserRoutes(gui, {
				userManager,
				userMutationService: makeUserMutationService(),
				registry,
				spaceService,
				logger,
			});
			registerContextRoutes(gui, {
				contextStore: makeContextStore() as unknown as ContextStoreServiceImpl,
				config,
				logger,
				householdService,
			});
			registerSpaceRoutes(gui, { spaceService, userManager, logger });
			registerReportRoutes(gui, {
				reportService: makeReportService() as unknown as ReportService,
				userManager,
				registry,
				spaceService,
				dataDir: tempDir,
				timezone: config.timezone,
				logger,
			});
			registerAlertRoutes(gui, {
				alertService: makeAlertService() as unknown as AlertService,
				userManager,
				registry,
				reportService: { listReports: vi.fn().mockResolvedValue([]) },
				spaceService,
				dataDir: tempDir,
				timezone: config.timezone,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return app;
}

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;

async function loginAsMember(): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: MEMBER_USER.id, password: MEMBER_PASS },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

async function getCsrf(cookies: Record<string, string>) {
	const res = await app.inject({
		method: 'GET',
		url: '/gui/reports',
		cookies,
	});
	expect(res.statusCode).toBe(200);

	const allCookies = { ...cookies, ...collectCookies(res) };
	const metaMatch = res.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	expect(csrfToken).not.toBe('');
	return { cookies: allCookies, csrfToken };
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-admin-route-guards-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('GUI admin route guards', () => {
	it('keeps the login page publicly reachable', async () => {
		const res = await app.inject({
			method: 'GET',
			url: '/gui/login',
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('PAS Management');
	});

	it.each([
		'/gui/apps',
		'/gui/scheduler',
		'/gui/logs',
		'/gui/config',
		'/gui/llm',
		'/gui/users',
		'/gui/context',
	])('returns 403 for member access to %s', async (url) => {
		const cookies = await loginAsMember();
		const res = await app.inject({
			method: 'GET',
			url,
			cookies,
		});

		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('Insufficient Privileges');
	});

	it.each([
		{
			url: '/gui/spaces',
			payload: {
				isNew: 'true',
				id: 'family',
				name: 'Family',
				description: 'Family space',
				members: [MEMBER_USER.id],
			},
		},
		{
			url: '/gui/reports',
			payload: {
				id: 'daily-report',
				name: 'Daily Report',
				description: 'Daily summary',
				enabled: 'true',
				schedule: '0 9 * * *',
				delivery: [MEMBER_USER.id],
			},
		},
		{
			url: '/gui/alerts',
			payload: {
				id: 'daily-alert',
				name: 'Daily Alert',
				description: 'Daily alert',
				enabled: 'true',
				schedule: '0 9 * * *',
				delivery: [MEMBER_USER.id],
			},
		},
	])('returns 403 for member access to admin-only POST $url', async ({ url, payload }) => {
		const loginCookies = await loginAsMember();
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url,
			payload: { ...payload, _csrf: csrfToken },
			cookies,
		});

		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('Forbidden');
	});
});
