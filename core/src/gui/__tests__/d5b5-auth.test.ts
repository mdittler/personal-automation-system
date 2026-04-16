/**
 * D5b-5: GUI tenant/data route filtering tests.
 *
 * Verifies actor-based resource-kind enforcement on data/browse, reports,
 * alerts, and spaces routes.
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
import { CredentialService } from '../../services/credentials/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAlertRoutes } from '../routes/alerts.js';
import { registerDataRoutes } from '../routes/data.js';
import { registerReportRoutes } from '../routes/reports.js';
import { registerSpaceRoutes } from '../routes/spaces.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_ID = 'admin-1';
const MEMBER_ID = 'member-1';
const OTHER_MEMBER_ID = 'member-2';
const HOUSEHOLD_ID = 'hh-1';
const OTHER_HOUSEHOLD_ID = 'hh-2';
const ADMIN_PASSWORD = 'admin-pass';
const MEMBER_PASSWORD = 'member-pass';

const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

function makeUserManager() {
	const users = [
		{ id: ADMIN_ID, name: 'Admin', isAdmin: true },
		{ id: MEMBER_ID, name: 'Member', isAdmin: false },
		{ id: OTHER_MEMBER_ID, name: 'Other', isAdmin: false },
	];
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<{ id: string; name: string; isAdmin: boolean }>,
	};
}

function makeHouseholdService() {
	const userToHousehold: Record<string, string> = {
		[ADMIN_ID]: HOUSEHOLD_ID,
		[MEMBER_ID]: HOUSEHOLD_ID,
		[OTHER_MEMBER_ID]: OTHER_HOUSEHOLD_ID,
	};
	const households = [
		{ id: HOUSEHOLD_ID, adminUserIds: [ADMIN_ID] },
		{ id: OTHER_HOUSEHOLD_ID, adminUserIds: [] },
	];
	return {
		getHouseholdForUser: (userId: string) => userToHousehold[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
		listHouseholds: () => households,
	};
}

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: '', model: '' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			{ id: MEMBER_ID, name: 'Member', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
		],
	};
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

// ─── Data browse tests ────────────────────────────────────────────────────────

describe('D5b-5: data/browse actor-based authorization', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	async function makeSpaceServiceForData() {
		return {
			getSpace: vi.fn().mockReturnValue({ id: 'sp-1', kind: 'household', householdId: HOUSEHOLD_ID }),
			isMember: vi.fn().mockImplementation((_spaceId: string, userId: string) => userId === MEMBER_ID),
		};
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b5-data-'));
		const config = createMockConfig();
		config.dataDir = tempDir;

		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PASSWORD);
		await credService.setPassword(MEMBER_ID, MEMBER_PASSWORD);
		const userManager = makeUserManager();
		const householdService = makeHouseholdService();
		const spaceService = await makeSpaceServiceForData();

		app = Fastify({ logger: false });
		await app.register(fastifyCookie, { secret: AUTH_TOKEN });
		const eta = new Eta();
		await app.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta', layout: 'layout' });

		await app.register(
			async (gui) => {
				await registerAuth(gui, {
					authToken: AUTH_TOKEN,
					credentialService: credService,
					userManager: userManager as any,
					householdService: householdService as any,
				});
				await registerCsrfProtection(gui);
				registerDataRoutes(gui, {
					config,
					dataDir: tempDir,
					logger,
					householdService: householdService as any,
					spaceService: spaceService as any,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	async function loginAs(userId: string, password: string) {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId, password },
		});
		return collectCookies(res);
	}

	it('non-admin GET /gui/data/browse?scope=user&userId=self → 200', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=user&userId=${MEMBER_ID}`,
			cookies,
		});
		expect(res.statusCode).toBe(200);
	});

	it('non-admin GET /gui/data/browse?scope=user&userId=other → 403', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=user&userId=${ADMIN_ID}`,
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('non-admin GET /gui/data/browse?scope=shared&householdId=own → 200', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=shared&householdId=${HOUSEHOLD_ID}`,
			cookies,
		});
		expect(res.statusCode).toBe(200);
	});

	it('non-admin GET /gui/data/browse?scope=shared&householdId=other → 403', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=shared&householdId=${OTHER_HOUSEHOLD_ID}`,
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('non-admin GET /gui/data/browse?scope=space&userId=joined-space → 200', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=space&userId=sp-1`,
			cookies,
		});
		expect(res.statusCode).toBe(200);
	});

	// space not-joined → 403 is tested in the sub-describe below (requires a different isMember mock)

	it('non-admin GET /gui/data/browse?scope=system → 403', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=system`,
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('admin GET /gui/data/browse with any scope → 200', async () => {
		const cookies = await loginAs(ADMIN_ID, ADMIN_PASSWORD);
		const systemRes = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=system`,
			cookies,
		});
		expect(systemRes.statusCode).toBe(200);
	});
});

// Sub-describe: space 403 for non-member
describe('D5b-5: data/browse space not-joined → 403', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b5-space-'));
		const config = createMockConfig();
		config.dataDir = tempDir;

		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(MEMBER_ID, MEMBER_PASSWORD);
		const userManager = makeUserManager();
		const householdService = makeHouseholdService();

		// This spaceService: MEMBER_ID is NOT a member of any space
		const spaceService = {
			getSpace: vi.fn().mockReturnValue({ id: 'sp-x', kind: 'household', householdId: HOUSEHOLD_ID }),
			isMember: vi.fn().mockReturnValue(false),
		};

		app = Fastify({ logger: false });
		await app.register(fastifyCookie, { secret: AUTH_TOKEN });
		const eta = new Eta();
		await app.register(fastifyView, { engine: { eta }, root: viewsDir, viewExt: 'eta', layout: 'layout' });

		await app.register(
			async (gui) => {
				await registerAuth(gui, {
					authToken: AUTH_TOKEN,
					credentialService: credService,
					userManager: userManager as any,
					householdService: householdService as any,
				});
				await registerCsrfProtection(gui);
				registerDataRoutes(gui, {
					config,
					dataDir: tempDir,
					logger,
					householdService: householdService as any,
					spaceService: spaceService as any,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('non-admin GET /gui/data/browse?scope=space&userId=not-joined → 403', async () => {
		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: MEMBER_ID, password: MEMBER_PASSWORD },
		});
		const cookies = collectCookies(loginRes);

		const res = await app.inject({
			method: 'GET',
			url: `/gui/data/browse?scope=space&userId=sp-x`,
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});
});

// ─── Reports filtering tests ──────────────────────────────────────────────────

describe('D5b-5: reports actor-based authorization', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	// Mock ReportService: one report visible to MEMBER_ID, one not
	function makeReportService() {
		const visibleReport = {
			id: 'rpt-visible',
			name: 'Visible Report',
			enabled: true,
			schedule: '0 8 * * *',
			delivery: [MEMBER_ID],
			sections: [],
			llm: { enabled: false },
		};
		const hiddenReport = {
			id: 'rpt-hidden',
			name: 'Hidden Report',
			enabled: true,
			schedule: '0 9 * * *',
			delivery: [ADMIN_ID],
			sections: [],
			llm: { enabled: false },
		};
		return {
			listReports: vi.fn().mockResolvedValue([visibleReport, hiddenReport]),
			getReport: vi.fn().mockImplementation(async (id: string) => {
				if (id === 'rpt-visible') return visibleReport;
				if (id === 'rpt-hidden') return hiddenReport;
				return null;
			}),
			saveReport: vi.fn().mockResolvedValue([]),
			deleteReport: vi.fn().mockResolvedValue(undefined),
			run: vi.fn().mockResolvedValue({ markdown: 'preview' }),
		};
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b5-reports-'));
		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PASSWORD);
		await credService.setPassword(MEMBER_ID, MEMBER_PASSWORD);
		const userManager = makeUserManager();
		const householdService = makeHouseholdService();
		const reportService = makeReportService();

		app = Fastify({ logger: false });
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
					userManager: userManager as any,
					householdService: householdService as any,
				});
				await registerCsrfProtection(gui);
				registerReportRoutes(gui, {
					reportService: reportService as any,
					userManager: userManager as any,
					dataDir: tempDir,
					timezone: 'UTC',
					logger,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	async function loginAs(userId: string, password: string) {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId, password },
		});
		return collectCookies(res);
	}

	async function csrfPost(cookies: Record<string, string>, url: string) {
		const getRes = await app.inject({
			method: 'GET',
			url: '/gui/reports',
			cookies,
		});
		const allCookies = collectCookies({ cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })) }, getRes);
		const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
		const csrfToken = metaMatch?.[1] ?? '';
		return app.inject({
			method: 'POST',
			url,
			payload: { _csrf: csrfToken },
			cookies: allCookies,
		});
	}

	it('non-admin GET /gui/reports → list filtered to delivery-list membership', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({ method: 'GET', url: '/gui/reports', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Visible Report');
		expect(res.body).not.toContain('Hidden Report');
	});

	it('non-admin GET /gui/reports/:id/edit when not in delivery list → 403', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({
			method: 'GET',
			url: '/gui/reports/rpt-hidden/edit',
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('non-admin POST /gui/reports/:id/preview → 403 even if visible', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await csrfPost(cookies, '/gui/reports/rpt-visible/preview');
		expect(res.statusCode).toBe(403);
	});
});

// ─── Alerts filtering tests ───────────────────────────────────────────────────

describe('D5b-5: alerts actor-based authorization', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	function makeAlertService() {
		const visibleAlert = {
			id: 'alrt-visible',
			name: 'Visible Alert',
			enabled: true,
			schedule: '0 8 * * *',
			delivery: [MEMBER_ID],
			condition: { type: 'deterministic', expression: 'true', data_sources: [] },
			actions: [],
		};
		const hiddenAlert = {
			id: 'alrt-hidden',
			name: 'Hidden Alert',
			enabled: true,
			schedule: '0 9 * * *',
			delivery: [ADMIN_ID],
			condition: { type: 'deterministic', expression: 'true', data_sources: [] },
			actions: [],
		};
		return {
			listAlerts: vi.fn().mockResolvedValue([visibleAlert, hiddenAlert]),
			getAlert: vi.fn().mockImplementation(async (id: string) => {
				if (id === 'alrt-visible') return visibleAlert;
				if (id === 'alrt-hidden') return hiddenAlert;
				return null;
			}),
			saveAlert: vi.fn().mockResolvedValue([]),
			deleteAlert: vi.fn().mockResolvedValue(undefined),
			evaluate: vi.fn().mockResolvedValue({ conditionMet: false }),
		};
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b5-alerts-'));
		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PASSWORD);
		await credService.setPassword(MEMBER_ID, MEMBER_PASSWORD);
		const userManager = makeUserManager();
		const householdService = makeHouseholdService();
		const alertService = makeAlertService();

		app = Fastify({ logger: false });
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
					userManager: userManager as any,
					householdService: householdService as any,
				});
				await registerCsrfProtection(gui);
				registerAlertRoutes(gui, {
					alertService: alertService as any,
					userManager: userManager as any,
					dataDir: tempDir,
					timezone: 'UTC',
					logger,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('non-admin GET /gui/alerts → list filtered to delivery-list membership', async () => {
		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId: MEMBER_ID, password: MEMBER_PASSWORD },
		});
		const cookies = collectCookies(loginRes);
		const res = await app.inject({ method: 'GET', url: '/gui/alerts', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Visible Alert');
		expect(res.body).not.toContain('Hidden Alert');
	});
});

// ─── Spaces filtering + create gate tests ────────────────────────────────────

describe('D5b-5: spaces actor-based authorization', () => {
	let tempDir: string;
	let app: Awaited<ReturnType<typeof Fastify>>;

	function makeSpaceServiceForSpaces(): SpaceService {
		const memberSpace = {
			id: 'sp-member',
			name: 'Member Space',
			description: '',
			members: [MEMBER_ID],
			createdBy: ADMIN_ID,
			createdAt: '2026-01-01T00:00:00.000Z',
			kind: 'household' as const,
		};
		const adminSpace = {
			id: 'sp-admin',
			name: 'Admin Space',
			description: '',
			members: [ADMIN_ID],
			createdBy: ADMIN_ID,
			createdAt: '2026-01-01T00:00:00.000Z',
			kind: 'household' as const,
		};
		return {
			listSpaces: vi.fn().mockReturnValue([memberSpace, adminSpace]),
			getSpace: vi.fn().mockReturnValue(null),
			saveSpace: vi.fn().mockResolvedValue([]),
			deleteSpace: vi.fn().mockResolvedValue(true),
			addMember: vi.fn().mockResolvedValue([]),
			removeMember: vi.fn().mockResolvedValue([]),
			isMember: vi.fn().mockReturnValue(false),
			getSpacesForUser: vi.fn().mockReturnValue([]),
			getActiveSpace: vi.fn().mockReturnValue(null),
			setActiveSpace: vi.fn().mockResolvedValue([]),
			init: vi.fn().mockResolvedValue(undefined),
		} as unknown as SpaceService;
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-d5b5-spaces-'));
		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PASSWORD);
		await credService.setPassword(MEMBER_ID, MEMBER_PASSWORD);
		const userManager = makeUserManager();
		const householdService = makeHouseholdService();
		const spaceService = makeSpaceServiceForSpaces();

		app = Fastify({ logger: false });
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
					userManager: userManager as any,
					householdService: householdService as any,
				});
				await registerCsrfProtection(gui);
				registerSpaceRoutes(gui, {
					spaceService,
					userManager: userManager as any,
					logger,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	async function loginAs(userId: string, password: string) {
		const res = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: { userId, password },
		});
		return collectCookies(res);
	}

	it('non-admin GET /gui/spaces → only spaces they are a member of', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);
		const res = await app.inject({ method: 'GET', url: '/gui/spaces', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Member Space');
		expect(res.body).not.toContain('Admin Space');
	});

	it('non-admin POST /gui/spaces with isNew=true → 403', async () => {
		const cookies = await loginAs(MEMBER_ID, MEMBER_PASSWORD);

		// Get CSRF token
		const getRes = await app.inject({ method: 'GET', url: '/gui/spaces', cookies });
		const allCookies = collectCookies({ cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })) }, getRes);
		const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
		const csrfToken = metaMatch?.[1] ?? '';

		const res = await app.inject({
			method: 'POST',
			url: '/gui/spaces',
			payload: {
				_csrf: csrfToken,
				id: 'new-space',
				name: 'New Space',
				description: '',
				isNew: 'true',
			},
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('admin GET /gui/spaces → sees all spaces', async () => {
		const cookies = await loginAs(ADMIN_ID, ADMIN_PASSWORD);
		const res = await app.inject({ method: 'GET', url: '/gui/spaces', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Member Space');
		expect(res.body).toContain('Admin Space');
	});
});
