/**
 * Sidebar nav regroup (audit UX Hardening plan Batch 1, task 1.5).
 *
 * The sidebar nav is a flat list of unlabeled items. This groups it under
 * plain-language section headers so a nontechnical user can scan it:
 * Home; Automations (Reports, Alerts); People and sharing (Household —
 * visible to members too as of Batch 5 Task 5.2's read-only view, Shared
 * spaces); Your data (Files); System (admin-only: Apps, Scheduler, AI usage,
 * Logs, Regression, Context); Settings + Account for everyone. All existing
 * hrefs are unchanged.
 *
 * Reuses the buildApp harness from admin-route-guards.test.ts (same
 * per-file buildApp pattern per the task brief).
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
import type { AlertService } from '../../services/alerts/index.js';
import type { AppRegistry, RegisteredApp } from '../../services/app-registry/index.js';
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
import type { SettingsRegistry } from '../../services/settings/settings-registry.js';
import type { BatchResult, WriteResult } from '../../services/settings/settings-writer.js';
import type { SettingsWriter } from '../../services/settings/settings-writer.js';
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
import type { NavFlags } from '../view-locals.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_PASS = 'admin-password';
const MEMBER_PASS = 'member-password';
const logger = pino({ level: 'silent' });

function makeNoopSettingsWriter(): SettingsWriter {
	return {
		write: vi.fn(async () => ({ ok: true, coerced: undefined }) as WriteResult),
		validate: vi.fn(() => ({ ok: true, coerced: undefined }) as WriteResult),
		writeBatch: vi.fn(async () => ({ perApp: new Map(), perField: new Map() }) as BatchResult),
		registerPostWriteHook: vi.fn(),
		runHooksForKey: vi.fn(async () => {}),
	} as unknown as SettingsWriter;
}

function makeStubRegistry(): SettingsRegistry {
	return {
		getByAppKey: () => undefined,
		getAll: () => [],
		getByQualifiedKey: () => undefined,
		getForUser: () => [],
		getForCategory: () => [],
		getNlSafeQualifiedKeys: () => new Set<string>(),
	} as unknown as SettingsRegistry;
}
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

function makeHouseholdService(): Pick<
	HouseholdService,
	'getHouseholdForUser' | 'getHousehold' | 'listHouseholds' | 'getMembers'
> {
	return {
		getHouseholdForUser: vi.fn().mockReturnValue('hh-1'),
		getHousehold: vi
			.fn()
			.mockReturnValue({ id: 'hh-1', name: 'Home', adminUserIds: [ADMIN_USER.id] }),
		listHouseholds: vi
			.fn()
			.mockReturnValue([{ id: 'hh-1', name: 'Home', adminUserIds: [ADMIN_USER.id] }]),
		getMembers: vi.fn().mockReturnValue(ALL_USERS),
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

async function buildApp(tempDir: string, navFlags?: Partial<NavFlags>) {
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
			await registerViewLocals(gui, { userManager, navFlags });
			registerAppsRoutes(gui, { registry, config, appToggle, dataDir: tempDir, logger });
			registerSchedulerRoutes(gui, {
				scheduler: makeScheduler(),
				timezone: config.timezone,
				logger,
			});
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
				householdService,
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

async function loginAsAdmin(): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: ADMIN_USER.id, password: ADMIN_PASS },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

async function loginAsMember(): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: MEMBER_USER.id, password: MEMBER_PASS },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-nav-regroup-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('nav regroup', () => {
	it('shows plain-language sections to an admin', async () => {
		const cookies = await loginAsAdmin();
		const res = await app.inject({
			method: 'GET',
			url: '/gui/reports',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		for (const label of [
			'Home',
			'Automations',
			'People and sharing',
			'Your data',
			'System',
			'Reports',
			'Alerts',
			'Household',
			'Shared spaces',
			'Files',
			'Conversations',
			'Activity',
			'AI usage',
			'Backups',
		]) {
			expect(res.body).toContain(label);
		}
		// Old raw label gone.
		expect(res.body).not.toContain('>LLM<');
	});

	it('hides the System section items from a non-admin member', async () => {
		const cookies = await loginAsMember();
		const res = await app.inject({
			method: 'GET',
			url: '/gui/reports',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		for (const label of ['Apps', 'Scheduler', 'Logs', 'Regression', 'Context', 'Backups']) {
			expect(res.body).not.toContain(`>${label}<`);
		}
		// C7 fix: /gui/data (Files) is platform-admin-only server-side
		// (data.ts's route guard, a deliberate R3-phase data-boundary decision
		// that is NOT being changed here) — the nav item must not dangle in
		// front of members who would only get a 403 on click.
		expect(res.body).not.toContain('>Files<');
		// Batch 5, Task 5.2: Household nav item is now visible to members too —
		// the route opened a read-only, own-household-scoped view for non-admins.
		expect(res.body).toContain('>Household<');
		// Batch 6: Conversations + Activity are "Your data" items, visible to
		// every authenticated user (own-scoped), unlike the admin-only System items.
		expect(res.body).toContain('>Conversations<');
		expect(res.body).toContain('>Activity<');
		// Batch 6, Task 6.4: AI usage moved out of the admin-only System group —
		// members now get a scoped, read-only view of their own usage.
		expect(res.body).toContain('>AI usage<');
	});

	it('shows Files to an admin (still platform-admin-only, gated same as System)', async () => {
		const cookies = await loginAsAdmin();
		const res = await app.inject({
			method: 'GET',
			url: '/gui/reports',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('>Files<');
	});
});

// Final Codex review round (Important): nav links to conditionally-registered
// routes (/gui/sessions, /gui/activity, /gui/backups) must not render when
// their backing optional service (chatTranscriptIndex/changeLogPath+
// householdService+spaceService/backupConfig) wasn't provided at
// registration time — otherwise clicking them 404s. gui/index.ts computes
// `navFlags` from the SAME presence checks used to conditionally register
// those routes and passes them to registerViewLocals; layout.eta gates each
// nav item on its flag.
describe('nav availability flags (optional surfaces)', () => {
	let flagsTempDir: string;
	let flagsApp: Awaited<ReturnType<typeof Fastify>>;

	afterEach(async () => {
		await flagsApp.close();
		await rm(flagsTempDir, { recursive: true, force: true });
	});

	it('omits Conversations/Activity/Backups nav links when their deps are absent', async () => {
		flagsTempDir = await mkdtemp(join(tmpdir(), 'pas-nav-flags-off-'));
		flagsApp = await buildApp(flagsTempDir, { sessions: false, activity: false, backups: false });
		const loginRes = await flagsApp.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: ADMIN_USER.id, password: ADMIN_PASS },
		});
		const cookies = collectCookies(loginRes);

		const res = await flagsApp.inject({ method: 'GET', url: '/gui/reports', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('>Conversations<');
		expect(res.body).not.toContain('>Activity<');
		expect(res.body).not.toContain('>Backups<');
		expect(res.body).not.toContain('href="/gui/sessions"');
		expect(res.body).not.toContain('href="/gui/activity"');
		expect(res.body).not.toContain('href="/gui/backups"');
	});

	it('shows Conversations/Activity/Backups nav links when their deps are present (default)', async () => {
		flagsTempDir = await mkdtemp(join(tmpdir(), 'pas-nav-flags-on-'));
		flagsApp = await buildApp(flagsTempDir, { sessions: true, activity: true, backups: true });
		const loginRes = await flagsApp.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: ADMIN_USER.id, password: ADMIN_PASS },
		});
		const cookies = collectCookies(loginRes);

		const res = await flagsApp.inject({ method: 'GET', url: '/gui/reports', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('>Conversations<');
		expect(res.body).toContain('>Activity<');
		expect(res.body).toContain('>Backups<');
	});
});
