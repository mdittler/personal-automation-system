/**
 * Permission-scoped JSON metrics endpoints powering Home/AI-usage charts (Batch 2).
 *
 * GET /gui/api/metrics/llm-daily      — per-day cost/token totals from data/system/llm-usage.md
 * GET /gui/api/metrics/activity-daily — per-day message counts + alert firings
 *
 * Both endpoints scope to the requesting member's own rows unless the
 * requester is a platform admin (in which case all rows/users are included).
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own minimal Fastify app via the same per-file `buildApp`
 * pattern as admin-route-guards.test.ts / error-fragment.test.ts.
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
import type { AlertService } from '../../services/alerts/index.js';
import type { ChatTranscriptIndex } from '../../services/chat-transcript-index/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerMetricsRoutes } from '../routes/metrics.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_ID = 'admin1';
const MEMBER_A_ID = 'member-a';
const MEMBER_B_ID = 'member-b';

// Header/separator constants matching the 6/8/9-column variants the real
// llm-usage.md log can contain (core/src/services/llm/__tests__/cost-tracker.test.ts).
const HEADER_6 = '| Timestamp | Model | Input Tokens | Output Tokens | Cost ($) | App |';
const SEP_6 = '|-----------|-------|-------------|---------------|----------|-----|';
const HEADER_8 =
	'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User |';
const SEP_8 =
	'|-----------|----------|-------|-------------|---------------|----------|-----|------|';
const HEADER_9 =
	'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User | Household |';
const SEP_9 =
	'|-----------|----------|-------|-------------|---------------|----------|-----|------|-----------|';

function row6(timestamp: string, model: string, cost: string, app: string): string {
	return `| ${timestamp} | ${model} | 100 | 50 | ${cost} | ${app} |`;
}
function row8(
	timestamp: string,
	provider: string,
	model: string,
	cost: string,
	app: string,
	user: string,
): string {
	return `| ${timestamp} | ${provider} | ${model} | 100 | 50 | ${cost} | ${app} | ${user} |`;
}
function row9(
	timestamp: string,
	provider: string,
	model: string,
	cost: string,
	app: string,
	user: string,
	household: string,
): string {
	return `| ${timestamp} | ${provider} | ${model} | 100 | 50 | ${cost} | ${app} | ${user} | ${household} |`;
}

function makeUserManager(): Pick<UserManager, 'getUser' | 'getAllUsers'> {
	const users = [
		{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_A_ID, name: 'Member A', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_B_ID, name: 'Member B', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
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

async function buildApp(
	tempDir: string,
	opts: { alertService?: Pick<AlertService, 'listAlerts'> } = {},
) {
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN_ID, 'admin-pass-123');
	await credService.setPassword(MEMBER_A_ID, 'member-a-pass');
	await credService.setPassword(MEMBER_B_ID, 'member-b-pass');

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();

	// Minimal stub transcript index — only countMessagesByDay is exercised here.
	const transcriptIndex: Pick<ChatTranscriptIndex, 'countMessagesByDay'> = {
		countMessagesByDay: async (opts) => {
			if (opts.userId === MEMBER_A_ID) {
				return [{ date: '2026-07-01', count: 3 }];
			}
			if (opts.userId) return [];
			// Admin (no userId filter): aggregate across all users
			return [{ date: '2026-07-01', count: 5 }];
		},
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
				userManager: userManager as unknown as UserManager,
				householdService: householdService as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, { userManager: userManager as unknown as UserManager });
			registerMetricsRoutes(gui, {
				dataDir: tempDir,
				chatTranscriptIndex: transcriptIndex as ChatTranscriptIndex,
				alertService: opts.alertService as AlertService | undefined,
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

describe('GET /gui/api/metrics/llm-daily', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof buildApp>>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-metrics-'));
		await mkdir(join(tempDir, 'system'), { recursive: true });
		app = await buildApp(tempDir);
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('requires auth', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/api/metrics/llm-daily' });
		expect([301, 302, 401]).toContain(res.statusCode);
	});

	it('sets a private, short-lived Cache-Control header (per-user data must never be shared-cached)', async () => {
		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('private, max-age=30');
	});

	it('returns per-day cost/token totals for the requesting member, own rows only', async () => {
		const usageLines = [
			HEADER_8,
			SEP_8,
			row8('2026-07-01T10:00:00Z', 'anthropic', 'claude', '0.10', 'food', MEMBER_A_ID),
			row8('2026-07-01T11:00:00Z', 'anthropic', 'claude', '0.20', 'food', MEMBER_B_ID),
			row8('2026-07-02T10:00:00Z', 'anthropic', 'claude', '0.05', 'food', MEMBER_A_ID),
		];
		await writeFile(join(tempDir, 'system', 'llm-usage.md'), `${usageLines.join('\n')}\n`, 'utf-8');

		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.days).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ date: '2026-07-01', cost: 0.1 }),
				expect.objectContaining({ date: '2026-07-02', cost: 0.05 }),
			]),
		);
		// Member B's cost never appears in member A's totals.
		const totalCost = body.days.reduce((sum: number, d: { cost: number }) => sum + d.cost, 0);
		expect(totalCost).toBeCloseTo(0.15, 5);
		expect(body.perUser).toBeUndefined();
	});

	it('returns all users aggregated for a platform admin, with per-user breakdown', async () => {
		const usageLines = [
			HEADER_9,
			SEP_9,
			row9('2026-07-01T10:00:00Z', 'anthropic', 'claude', '0.10', 'food', MEMBER_A_ID, 'hh-1'),
			row9('2026-07-01T11:00:00Z', 'anthropic', 'claude', '0.20', 'food', MEMBER_B_ID, 'hh-1'),
		];
		await writeFile(join(tempDir, 'system', 'llm-usage.md'), `${usageLines.join('\n')}\n`, 'utf-8');

		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const day = body.days.find((d: { date: string }) => d.date === '2026-07-01');
		expect(day.cost).toBeCloseTo(0.3, 5);
		expect(body.perUser).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ user: MEMBER_A_ID }),
				expect.objectContaining({ user: MEMBER_B_ID }),
			]),
		);
	});

	it('handles a missing usage file with an empty series, not an error', async () => {
		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.days).toEqual([]);
	});

	it('handles a 6-column legacy usage log (no provider/user columns)', async () => {
		const usageLines = [HEADER_6, SEP_6, row6('2026-07-01T10:00:00Z', 'claude', '0.42', 'food')];
		await writeFile(join(tempDir, 'system', 'llm-usage.md'), `${usageLines.join('\n')}\n`, 'utf-8');

		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.days[0].cost).toBeCloseTo(0.42, 5);
	});
});

describe('GET /gui/api/metrics/activity-daily', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof buildApp>>;

	// Two alerts with different delivery targets — member A should only see
	// firings for the alert delivered to them, never member B's alert.
	const alertService: Pick<AlertService, 'listAlerts'> = {
		listAlerts: async () =>
			[
				{ id: 'alert-a', name: 'Alert A', enabled: true, delivery: [MEMBER_A_ID] },
				{ id: 'alert-b', name: 'Alert B', enabled: true, delivery: [MEMBER_B_ID] },
			] as unknown as Awaited<ReturnType<AlertService['listAlerts']>>,
	};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-metrics-activity-'));
		await mkdir(join(tempDir, 'system'), { recursive: true });
		app = await buildApp(tempDir, { alertService });
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('requires auth', async () => {
		const res = await app.inject({ method: 'GET', url: '/gui/api/metrics/activity-daily' });
		expect([301, 302, 401]).toContain(res.statusCode);
	});

	it('sets a private, short-lived Cache-Control header (per-user data must never be shared-cached)', async () => {
		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers['cache-control']).toBe('private, max-age=30');
	});

	it('returns member-scoped message + alert-firing counts', async () => {
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-a'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-a', '2026-07-01_09-00-00-000.md'),
			'fired\n',
			'utf-8',
		);

		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const day = body.days.find((d: { date: string }) => d.date === '2026-07-01');
		expect(day.messages).toBe(3); // from the stubbed transcript index, member A path
		expect(day.alertFirings).toBe(1);
	});

	it("does not count another member's alert firings", async () => {
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-a'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-a', '2026-07-01_09-00-00-000.md'),
			'fired\n',
			'utf-8',
		);
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-b'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-b', '2026-07-01_09-05-00-000.md'),
			'fired\n',
			'utf-8',
		);
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-b', '2026-07-01_09-06-00-000.md'),
			'fired\n',
			'utf-8',
		);

		const cookies = await login(app, MEMBER_A_ID, 'member-a-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const day = body.days.find((d: { date: string }) => d.date === '2026-07-01');
		// Member A only sees alert-a's single firing, never alert-b's two firings.
		expect(day.alertFirings).toBe(1);
	});

	it('returns an aggregated admin view including all alerts', async () => {
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-a'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-a', '2026-07-01_09-00-00-000.md'),
			'fired\n',
			'utf-8',
		);
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-b'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-b', '2026-07-01_09-05-00-000.md'),
			'fired\n',
			'utf-8',
		);

		const cookies = await login(app, ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const day = body.days.find((d: { date: string }) => d.date === '2026-07-01');
		expect(day?.messages).toBe(5); // stubbed admin (all-users) path
		expect(day?.alertFirings).toBe(2); // both alert-a and alert-b counted for admin
	});

	it('handles no activity with an empty series, not an error', async () => {
		// No alert history seeded in this tempDir, and the stubbed transcript
		// index returns [] for member B (no fixture data configured for them).
		const cookies = await login(app, MEMBER_B_ID, 'member-b-pass');
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.json().days).toEqual([]);
	});
});

// Final Codex review round (Important): legacy shared-token admin mode (no
// per-user auth deps at all — request.user stays undefined for the whole
// request, see auth.ts's hasPerUserAuth branch) must return unscoped admin
// data here, not member-scoped (empty/self-only) data.
describe('legacy shared-token session (no request.user)', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof buildLegacyOnlyApp>>;

	async function buildLegacyOnlyApp(dir: string) {
		const transcriptIndex: Pick<ChatTranscriptIndex, 'countMessagesByDay'> = {
			countMessagesByDay: async (opts) => {
				// Only the admin (unscoped, userId undefined) path returns rows —
				// proves the endpoint took the admin branch rather than scoping to
				// a (nonexistent) actor.userId.
				if (opts.userId === undefined) return [{ date: '2026-07-01', count: 7 }];
				return [];
			},
		};
		// Neither alert is delivered to any real userId — a member-scoped branch
		// (`delivery.includes(actor?.userId ?? '')`) would filter BOTH out,
		// since actor is undefined and '' never appears in a real delivery
		// list. Only the admin (unscoped) branch counts every alert's history.
		const alertService: Pick<AlertService, 'listAlerts'> = {
			listAlerts: async () =>
				[
					{ id: 'alert-a', delivery: [ADMIN_ID] },
					{ id: 'alert-b', delivery: [MEMBER_A_ID] },
				] as unknown as Awaited<ReturnType<AlertService['listAlerts']>>,
		};

		const legacyApp = Fastify({ logger: false });
		await legacyApp.register(fastifyCookie, { secret: AUTH_TOKEN });
		const eta = new Eta();
		await legacyApp.register(fastifyView, {
			engine: { eta },
			root: viewsDir,
			viewExt: 'eta',
			layout: 'layout',
		});

		await legacyApp.register(
			async (gui) => {
				await registerAuth(gui, { authToken: AUTH_TOKEN });
				await registerCsrfProtection(gui);
				registerMetricsRoutes(gui, {
					dataDir: dir,
					chatTranscriptIndex: transcriptIndex as ChatTranscriptIndex,
					alertService: alertService as AlertService,
					logger,
				});
			},
			{ prefix: '/gui' },
		);

		return legacyApp;
	}

	async function legacyLogin(): Promise<Record<string, string>> {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { token: AUTH_TOKEN },
		});
		expect(res.statusCode).toBe(302);
		return collectCookies(res);
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-metrics-legacy-'));
		await mkdir(join(tempDir, 'system'), { recursive: true });
		app = await buildLegacyOnlyApp(tempDir);
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('llm-daily returns unscoped admin data (perUser breakdown present)', async () => {
		await writeFile(
			join(tempDir, 'system', 'llm-usage.md'),
			[
				HEADER_8,
				SEP_8,
				row8('2026-07-01T09:00:00Z', 'anthropic', 'claude', '0.05', 'food', 'u1'),
			].join('\n'),
			'utf-8',
		);
		const cookies = await legacyLogin();
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/llm-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		// perUser is only populated on the admin branch.
		expect(body.perUser).toBeDefined();
		expect(body.days[0]?.cost).toBeCloseTo(0.05);
	});

	it('activity-daily returns unscoped admin message + alert-firing counts (not zeroed by a missing actor.userId)', async () => {
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-a'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-a', '2026-07-01_09-00-00-000.md'),
			'fired\n',
			'utf-8',
		);
		await mkdir(join(tempDir, 'system', 'alert-history', 'alert-b'), { recursive: true });
		await writeFile(
			join(tempDir, 'system', 'alert-history', 'alert-b', '2026-07-01_09-05-00-000.md'),
			'fired\n',
			'utf-8',
		);

		const cookies = await legacyLogin();
		const res = await app.inject({
			method: 'GET',
			url: '/gui/api/metrics/activity-daily',
			cookies,
		});

		expect(res.statusCode).toBe(200);
		const body = res.json();
		const day = body.days.find((d: { date: string }) => d.date === '2026-07-01');
		expect(day?.messages).toBe(7);
		// Both alert-a and alert-b counted — a member-scoped branch would only
		// see alerts whose delivery includes actor.userId, which is undefined
		// here, so it would count neither.
		expect(day?.alertFirings).toBe(2);
	});
});
