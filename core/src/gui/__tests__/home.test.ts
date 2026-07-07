/**
 * Home page (Batch 2 of the GUI UX redesign) — replaces the ops dashboard
 * with a three-zone layout: attention banners, glance metrics, and a recent
 * activity snippet, plus registry-driven chart slots.
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own minimal Fastify app via the per-file `buildApp` pattern.
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
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerDashboardRoutes } from '../routes/dashboard.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_ID = 'admin1';
const MEMBER_ID = 'member1';

function makeConfig(tempDir: string, overrides: Partial<SystemConfig> = {}): SystemConfig {
	return {
		port: 3000,
		dataDir: tempDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'tok' },
		ollama: undefined,
		claude: { apiKey: '', model: 'm' },
		cloudflare: {},
		gui: { authToken: AUTH_TOKEN },
		users: [
			{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			{ id: MEMBER_ID, name: 'Member', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
		],
		backup: {
			enabled: false,
			path: join(tempDir, 'backups'),
			schedule: '0 3 * * *',
			retentionCount: 7,
		},
		...overrides,
	} as unknown as SystemConfig;
}

function makeUserManager(): Pick<UserManager, 'getUser' | 'getAllUsers'> {
	const users = [
		{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_ID, name: 'Member', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
	];
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
	} as unknown as Pick<UserManager, 'getUser' | 'getAllUsers'>;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: (id: string) => (id === 'hh-1' ? { id: 'hh-1', adminUserIds: [ADMIN_ID] } : null),
	};
}

function makeScheduler(): SchedulerServiceImpl {
	return {
		cron: { getJobDetails: () => [] },
		oneOff: { getPendingTasks: async () => [] },
	} as unknown as SchedulerServiceImpl;
}

function makeModelSelector(): ModelSelector {
	return {
		getStandardRef: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
	} as unknown as ModelSelector;
}

function makeRegistry(): AppRegistry {
	return {
		getAll: () => [] as RegisteredApp[],
		getApp: () => undefined,
		getLoadedAppIds: () => ['food'],
	} as unknown as AppRegistry;
}

async function buildApp(tempDir: string, configOverrides: Partial<SystemConfig> = {}) {
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN_ID, 'admin-pass-123');
	await credService.setPassword(MEMBER_ID, 'member-pass-123');

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();
	const config = makeConfig(tempDir, configOverrides);

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
			await registerViewLocals(gui, { userManager: userManager as unknown as UserManager });
			registerDashboardRoutes(gui, {
				registry: makeRegistry(),
				scheduler: makeScheduler(),
				config,
				modelSelector: makeModelSelector(),
				dataDir: tempDir,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return app;
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

async function login(
	app: ReturnType<typeof Fastify>,
	userId: string,
	password: string,
): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

describe('GET /gui/ (home)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-home-'));
		await mkdir(join(tempDir, 'system'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('shows a backup warning banner to an admin when backups are disabled', async () => {
		const app = await buildApp(tempDir, {
			backup: {
				enabled: false,
				path: join(tempDir, 'backups'),
				schedule: '0 3 * * *',
				retentionCount: 7,
			},
		} as Partial<SystemConfig>);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('isn&#39;t being backed up');
		expect(res.body).toContain('backup:');
		await app.close();
	});

	it('shows "All systems normal" when nothing needs attention', async () => {
		const app = await buildApp(tempDir, {
			backup: {
				enabled: true,
				path: join(tempDir, 'backups'),
				schedule: '0 3 * * *',
				retentionCount: 7,
			},
		} as Partial<SystemConfig>);
		await mkdir(join(tempDir, 'backups'), { recursive: true });
		await writeFile(
			join(tempDir, 'backups', 'pas-backup-2026-07-06T00-00-00.tar.gz'),
			'x',
			'utf-8',
		);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('All systems normal');
		await app.close();
	});

	it('hides system-health banners from members but shows their own glance metrics', async () => {
		const app = await buildApp(tempDir);
		const cookies = await login(app, MEMBER_ID, 'member-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('isn&#39;t being backed up');
		// Member still gets glance cards (their own scope).
		expect(res.body).toMatch(/AI spend|messages|alerts/i);
		await app.close();
	});

	it('renders glance cards: AI spend this month, messages this week, active alerts, next report', async () => {
		await writeFile(
			join(tempDir, 'system', 'llm-usage.md'),
			[
				'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User |',
				'|-----------|----------|-------|-------------|---------------|----------|-----|------|',
				`| ${new Date().toISOString()} | anthropic | claude | 100 | 50 | 1.23 | food | ${ADMIN_ID} |`,
			].join('\n'),
			'utf-8',
		);
		const app = await buildApp(tempDir);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/\$1\.23|1\.23/);
		await app.close();
	});

	it('escapes user-controlled names in the recent-activity list', async () => {
		const changeLogPath = join(tempDir, 'system', 'change-log.jsonl');
		const entry = {
			timestamp: new Date().toISOString(),
			operation: 'write',
			path: '<script>alert(1)</script>.md',
			appId: 'food',
			userId: ADMIN_ID,
		};
		await writeFile(changeLogPath, `${JSON.stringify(entry)}\n`, 'utf-8');
		const app = await buildApp(tempDir);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('<script>alert(1)</script>');
		await app.close();
	});
});
