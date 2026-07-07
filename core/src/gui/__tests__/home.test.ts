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
import type { ChatTranscriptIndex } from '../../services/chat-transcript-index/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { CostTracker } from '../../services/llm/cost-tracker.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { SchedulerServiceImpl } from '../../services/scheduler/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { LLMSafeguardsConfig, SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerDashboardRoutes } from '../routes/dashboard.js';
import { registerViewLocals } from '../view-locals.js';

/**
 * Fully legacy-only auth harness (final Codex review round, Important):
 * `registerAuth` with ONLY `{ authToken }` — no credentialService/
 * userManager/householdService — is the mode where `request.user` stays
 * `undefined` for the entire request (see auth.ts's `hasPerUserAuth`
 * branch and auth.test.ts's identical harness). There is no per-user model
 * at all in this mode: the single shared token IS the admin session.
 */
async function buildLegacyOnlyApp(tempDir: string) {
	const config = makeConfig(tempDir);
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
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
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

async function legacyLogin(app: ReturnType<typeof Fastify>): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	expect(res.statusCode).toBe(302);
	const cookies: Record<string, string> = {};
	for (const c of res.cookies as Array<{ name: string; value: string }>) {
		cookies[c.name] = c.value;
	}
	return cookies;
}

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

function makeHouseholdService(): Pick<
	HouseholdService,
	'getHouseholdForUser' | 'getHousehold' | 'listHouseholds' | 'getMembers'
> {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: (id: string) =>
			id === 'hh-1' ? { id: 'hh-1', name: 'Household', adminUserIds: [ADMIN_ID] } : null,
		listHouseholds: () => [{ id: 'hh-1', name: 'Household', adminUserIds: [ADMIN_ID] }],
		getMembers: () => [],
	} as unknown as Pick<
		HouseholdService,
		'getHouseholdForUser' | 'getHousehold' | 'listHouseholds' | 'getMembers'
	>;
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

interface BuildAppExtras {
	costTracker?: Pick<CostTracker, 'getMonthlyHouseholdCost'>;
	llmSafeguards?: LLMSafeguardsConfig;
	chatTranscriptIndex?: Pick<ChatTranscriptIndex, 'countMessagesByDay'>;
}

async function buildApp(
	tempDir: string,
	configOverrides: Partial<SystemConfig> = {},
	extras: BuildAppExtras = {},
) {
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
				householdService: householdService as unknown as HouseholdService,
				costTracker: extras.costTracker as CostTracker | undefined,
				llmSafeguards: extras.llmSafeguards,
				chatTranscriptIndex: extras.chatTranscriptIndex as ChatTranscriptIndex | undefined,
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

	it('topbar link labels itself "Home", not "Dashboard" (C3 fix — nav already says Home)', async () => {
		const app = await buildApp(tempDir);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		const topbarSection = res.body.slice(
			res.body.indexOf('pas-topbar-left'),
			res.body.indexOf('pas-topbar-right'),
		);
		expect(topbarSection).not.toMatch(/>\s*Dashboard\s*</);
		expect(topbarSection).toMatch(/>\s*Home\s*</);
		await app.close();
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
		const sinceIso = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
		const chatTranscriptIndex: Pick<ChatTranscriptIndex, 'countMessagesByDay'> = {
			countMessagesByDay: async (opts) => {
				if (opts.userId === ADMIN_ID) return [{ date: sinceIso.slice(0, 10), count: 4 }];
				if (opts.userId === MEMBER_ID) return [{ date: sinceIso.slice(0, 10), count: 2 }];
				// Admin path (no userId filter): total across all users.
				return [{ date: sinceIso.slice(0, 10), count: 6 }];
			},
		};
		const app = await buildApp(tempDir, {}, { chatTranscriptIndex });
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/\$1\.23|1\.23/);
		expect(res.body).toMatch(/Messages this week/i);
		// Admin sees the total across all users (6), not just their own (4).
		expect(res.body).toMatch(/<h3>Messages this week<\/h3>\s*<div class="value">6<\/div>/);
		await app.close();
	});

	it('shows only the requesting member\'s own message count in "Messages this week"', async () => {
		const sinceIso = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
		const chatTranscriptIndex: Pick<ChatTranscriptIndex, 'countMessagesByDay'> = {
			countMessagesByDay: async (opts) => {
				if (opts.userId === ADMIN_ID) return [{ date: sinceIso.slice(0, 10), count: 4 }];
				if (opts.userId === MEMBER_ID) return [{ date: sinceIso.slice(0, 10), count: 2 }];
				return [{ date: sinceIso.slice(0, 10), count: 6 }];
			},
		};
		const app = await buildApp(tempDir, {}, { chatTranscriptIndex });
		const cookies = await login(app, MEMBER_ID, 'member-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/<h3>Messages this week<\/h3>\s*<div class="value">2<\/div>/);
		await app.close();
	});

	it('handles a missing chat transcript index by showing 0 messages, not an error', async () => {
		const app = await buildApp(tempDir);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/<h3>Messages this week<\/h3>\s*<div class="value">0<\/div>/);
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

	it('recent-activity snippet shows the truly newest entry first, regardless of raw JSONL append order', async () => {
		// Regression: collectChanges preserves raw JSONL order (append order in
		// the file) — it does NOT sort by timestamp. dashboard.ts built the
		// snippet via `entries.slice(-5).reverse()`, which only reflects
		// newest-first if the file itself happens to be chronological. Write
		// the truly newest entry FIRST in the file (as if it were appended out
		// of order, or as if an older backfill entry landed after it) and
		// confirm the snippet still leads with the newest by timestamp.
		const changeLogPath = join(tempDir, 'system', 'change-log.jsonl');
		const now = Date.now();
		const entries = [
			// Newest entry written FIRST in the file.
			{
				timestamp: new Date(now).toISOString(),
				operation: 'write',
				path: 'newest-file.md',
				appId: 'food',
				userId: ADMIN_ID,
			},
			// Four older entries written after it, descending in age — this
			// mimics an out-of-chronological-order file where naive
			// slice(-5).reverse() would surface a stale entry first.
			{
				timestamp: new Date(now - 1000).toISOString(),
				operation: 'write',
				path: 'older-1.md',
				appId: 'food',
				userId: ADMIN_ID,
			},
			{
				timestamp: new Date(now - 2000).toISOString(),
				operation: 'write',
				path: 'older-2.md',
				appId: 'food',
				userId: ADMIN_ID,
			},
			{
				timestamp: new Date(now - 3000).toISOString(),
				operation: 'write',
				path: 'older-3.md',
				appId: 'food',
				userId: ADMIN_ID,
			},
			{
				timestamp: new Date(now - 4000).toISOString(),
				operation: 'write',
				path: 'older-4.md',
				appId: 'food',
				userId: ADMIN_ID,
			},
		];
		await writeFile(changeLogPath, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf-8');
		const app = await buildApp(tempDir);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		const listStart = res.body.indexOf('Recent activity');
		const listSection = res.body.slice(listStart, listStart + 2000);
		const newestPos = listSection.indexOf('newest-file.md');
		const older1Pos = listSection.indexOf('older-1.md');
		expect(newestPos).toBeGreaterThan(-1);
		expect(older1Pos).toBeGreaterThan(-1);
		expect(newestPos).toBeLessThan(older1Pos);
		await app.close();
	});

	it('shows a spend-vs-cap attention banner to an admin when monthly spend is at or above 80% of the household cap', async () => {
		const costTracker: Pick<CostTracker, 'getMonthlyHouseholdCost'> = {
			getMonthlyHouseholdCost: (householdId: string) => (householdId === 'hh-1' ? 85 : 0),
		};
		const llmSafeguards: LLMSafeguardsConfig = {
			defaultRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultMonthlyCostCap: 50,
			globalMonthlyCostCap: 500,
			defaultHouseholdRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultHouseholdMonthlyCostCap: 100,
		};
		const app = await buildApp(tempDir, {}, { costTracker, llmSafeguards });
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/AI spending is at \$85(\.00)? of the \$100(\.00)? monthly cap/i);
		expect(res.body).toContain('Household');
		await app.close();
	});

	it('hides the spend-vs-cap banner when monthly spend is below 80% of the household cap', async () => {
		const costTracker: Pick<CostTracker, 'getMonthlyHouseholdCost'> = {
			getMonthlyHouseholdCost: () => 79,
		};
		const llmSafeguards: LLMSafeguardsConfig = {
			defaultRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultMonthlyCostCap: 50,
			globalMonthlyCostCap: 500,
			defaultHouseholdRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultHouseholdMonthlyCostCap: 100,
		};
		const app = await buildApp(
			tempDir,
			{
				backup: {
					enabled: true,
					path: join(tempDir, 'backups'),
					schedule: '0 3 * * *',
					retentionCount: 7,
				},
			} as Partial<SystemConfig>,
			{ costTracker, llmSafeguards },
		);
		await mkdir(join(tempDir, 'backups'), { recursive: true });
		await writeFile(
			join(tempDir, 'backups', 'pas-backup-2026-07-06T00-00-00.tar.gz'),
			'x',
			'utf-8',
		);
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toMatch(/AI spending is at/i);
		expect(res.body).toContain('All systems normal');
		await app.close();
	});

	it('hides the spend-vs-cap banner from non-admin members', async () => {
		const costTracker: Pick<CostTracker, 'getMonthlyHouseholdCost'> = {
			getMonthlyHouseholdCost: () => 95,
		};
		const llmSafeguards: LLMSafeguardsConfig = {
			defaultRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultMonthlyCostCap: 50,
			globalMonthlyCostCap: 500,
			defaultHouseholdRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultHouseholdMonthlyCostCap: 100,
		};
		const app = await buildApp(tempDir, {}, { costTracker, llmSafeguards });
		const cookies = await login(app, MEMBER_ID, 'member-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toMatch(/AI spending is at/i);
		await app.close();
	});

	it('does not 500 when the cost-cap banner probe fails', async () => {
		const costTracker: Pick<CostTracker, 'getMonthlyHouseholdCost'> = {
			getMonthlyHouseholdCost: () => {
				throw new Error('boom');
			},
		};
		const llmSafeguards: LLMSafeguardsConfig = {
			defaultRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultMonthlyCostCap: 50,
			globalMonthlyCostCap: 500,
			defaultHouseholdRateLimit: { maxRequests: 100, windowSeconds: 60 },
			defaultHouseholdMonthlyCostCap: 100,
		};
		const app = await buildApp(tempDir, {}, { costTracker, llmSafeguards });
		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toMatch(/AI spending is at/i);
		await app.close();
	});

	// Final Codex review round (Important): legacy shared-token admin mode
	// (no per-user auth deps at all — request.user stays undefined for the
	// whole request) must still get the admin view here, not a member-scoped
	// empty view. Boolean(actor?.isPlatformAdmin) previously resolved to
	// false when actor was undefined, silently degrading a legitimate legacy
	// admin session.
	it('legacy shared-token session (no request.user) shows admin banners, not an empty member view', async () => {
		const app = await buildLegacyOnlyApp(tempDir);
		const cookies = await legacyLogin(app);

		const res = await app.inject({ method: 'GET', url: '/gui/', cookies });

		expect(res.statusCode).toBe(200);
		// Zone 1 (attention banners) only renders AT ALL when isAdmin is true —
		// here it surfaces the "not backed up" warning (backups aren't
		// configured in this harness), proving the admin branch ran rather
		// than silently rendering nothing for a member-scoped view.
		expect(res.body).toContain('isn&#39;t being backed up');
		// Admin-only "Loaded apps" stat card also only renders when isAdmin.
		expect(res.body).toContain('Loaded apps');
		await app.close();
	});
});

describe('GET /gui/login (unauthenticated chrome — C5 fix)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-home-login-'));
		await mkdir(join(tempDir, 'system'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('renders neither the sidebar nav nor the Logout button for an unauthenticated visitor', async () => {
		// Regression: layout.eta always rendered the full app chrome (sidebar
		// nav + Logout form) regardless of authentication state. On the login
		// page this is confusing (nav links to pages the visitor can't reach
		// yet) and the Logout button was the first submit button in the DOM —
		// a stray Enter keypress in the login form could trigger it via
		// button-order quirks in some browsers. it.currentUser is unset for an
		// unauthenticated request (view-locals.ts only sets it when
		// request.user resolves), so layout.eta must gate both on it.currentUser.
		const app = await buildApp(tempDir);

		const res = await app.inject({ method: 'GET', url: '/gui/login' });

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('Logout');
		expect(res.body).not.toContain('nav-section-label');
		await app.close();
	});

	it('still renders the brand and theme toggle for an unauthenticated visitor', async () => {
		const app = await buildApp(tempDir);

		const res = await app.inject({ method: 'GET', url: '/gui/login' });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pas-brand');
		expect(res.body).toContain('theme-toggle');
		await app.close();
	});
});
