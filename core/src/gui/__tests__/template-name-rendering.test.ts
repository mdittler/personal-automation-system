/**
 * operator GUI templates surface `user.name`, not `user.id`.
 *
 * Render tests assert the new shape on every touched template:
 *   - Delivery checkbox labels (alert-edit, report-edit): label text contains
 *     the user's name and NOT the numeric id; the checkbox `value` attribute
 *     keeps the numeric id (legitimate submit key).
 *   - Source/data user dropdowns (alert-edit, report-edit): <option> text shows
 *     the name only; the option `value` keeps the numeric id.
 *   - Admin debug tables (dashboard, config): name is the primary cell content,
 *     numeric id only appears wrapped in <small>.
 *   - Context page header: name primary, id wrapped in <small>.
 *   - Data browser sidebar: name primary, id wrapped in <small>.
 *   - users/reset-password screen: the page shows the user's name; any rendered
 *     id appears only inside <small>.
 *
 * Plus a regression assertion for the cookie contract: after a
 * username login, the signed session cookie payload still carries the
 * canonical numeric user id.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyFormBody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import { normalizeDisplayName } from '../../services/invite/normalize.js';
import type { SystemConfig } from '../../types/config.js';
import { safeJsonForScript } from '../../utils/escape-html.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAlertRoutes } from '../routes/alerts.js';
import { registerContextRoutes } from '../routes/context.js';
import { registerCredentialRoutes } from '../routes/credentials.js';
import { registerDashboardRoutes } from '../routes/dashboard.js';
import { registerDataRoutes } from '../routes/data.js';
import { registerReportRoutes } from '../routes/reports.js';

const AUTH_TOKEN = 'test-token-batch2b';
const ADMIN_ID = '111';
const ADMIN_NAME = 'Matt';
const ADMIN_PW = 'pw-batch2b';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Shared mock builders
// ---------------------------------------------------------------------------

interface MockUser {
	id: string;
	name: string;
	isAdmin: boolean;
	enabledApps?: string[];
}

function makeUserManager(users: MockUser[]) {
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users as ReadonlyArray<MockUser>,
		findByName: (name: string) => {
			const target = normalizeDisplayName(name);
			if (!target) return undefined;
			return users.find((u) => normalizeDisplayName(u.name) === target) ?? undefined;
		},
	};
}

function makeHouseholdService(userIds: string[]) {
	const userToHh: Record<string, string> = Object.fromEntries(
		userIds.map((id) => [id, `hh-${id}`]),
	);
	const households = userIds.map((id) => ({ id: `hh-${id}`, adminUserIds: [id] }));
	return {
		getHouseholdForUser: (userId: string) => userToHh[userId] ?? null,
		getHousehold: (id: string) => households.find((h) => h.id === id) ?? null,
		listHouseholds: () => households.map((h) => ({ id: h.id, name: h.id })),
	};
}

function makeSystemConfig(users: MockUser[], dataDir: string): SystemConfig {
	return {
		port: 3000,
		dataDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: '', model: '' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: users.map((u) => ({
			id: u.id,
			name: u.name,
			isAdmin: u.isAdmin,
			enabledApps: u.enabledApps ?? ['*'],
			sharedScopes: [],
		})),
	} as unknown as SystemConfig;
}

interface BuiltApp {
	app: Awaited<ReturnType<typeof Fastify>>;
	tempDir: string;
	credService: CredentialService;
}

async function buildAlertReportContextDataApp(
	users: MockUser[] = [{ id: ADMIN_ID, name: ADMIN_NAME, isAdmin: true }],
): Promise<BuiltApp> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-batch2b-render-'));
	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword(ADMIN_ID, ADMIN_PW);

	const userManager = makeUserManager(users);
	const householdService = makeHouseholdService(users.map((u) => u.id));
	const config = makeSystemConfig(users, tempDir);

	const app = Fastify({ logger: false });
	await app.register(fastifyCookie, { secret: AUTH_TOKEN });
	await app.register(fastifyFormBody);

	const eta = new Eta();
	await app.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	// Minimal stubs for the routes that need services.
	const alertService = {
		listAlerts: vi.fn().mockResolvedValue([]),
		getAlert: vi.fn().mockResolvedValue(null),
	};
	const reportService = {
		listReports: vi.fn().mockResolvedValue([{ id: 'daily-summary', name: 'Daily Summary' }]),
		getReport: vi.fn().mockResolvedValue(null),
	};
	const registry = {
		getAll: () => [
			{ manifest: { app: { id: 'grocery', name: 'Grocery' } } },
			{ manifest: { app: { id: 'notes', name: 'Notes' } } },
		],
		getLoadedAppIds: () => ['grocery', 'notes'],
		getApp: () => null,
	};
	const scheduler = {
		cron: { getJobDetails: () => [] },
		oneOff: { getPendingTasks: vi.fn().mockResolvedValue([]) },
	};
	const modelSelector = { getStandardRef: () => ({ model: 'claude-sonnet-4-20250514' }) };

	const contextStore = {
		listForUser: vi.fn().mockResolvedValue([]),
	};

	await app.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService: credService,
				userManager: userManager as Parameters<typeof registerAuth>[1]['userManager'],
				householdService: householdService as Parameters<
					typeof registerAuth
				>[1]['householdService'],
			});
			await registerCsrfProtection(gui);
			registerAlertRoutes(gui, {
				alertService: alertService as any,
				userManager: userManager as any,
				registry: registry as any,
				reportService: reportService as any,
				dataDir: tempDir,
				timezone: 'UTC',
				logger,
			});
			registerReportRoutes(gui, {
				reportService: reportService as any,
				userManager: userManager as any,
				registry: registry as any,
				dataDir: tempDir,
				timezone: 'UTC',
				logger,
			});
			registerDashboardRoutes(gui, {
				registry: registry as any,
				scheduler: scheduler as any,
				config,
				modelSelector: modelSelector as any,
				dataDir: tempDir,
				logger,
			});
			registerContextRoutes(gui, {
				contextStore: contextStore as any,
				config,
				logger,
				householdService: householdService as any,
			});
			registerDataRoutes(gui, {
				config,
				dataDir: tempDir,
				logger,
			});
			registerCredentialRoutes(gui, {
				credentialService: credService,
				userManager: userManager as any,
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	await app.ready();
	return { app, tempDir, credService };
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

async function loginAsAdmin(app: Awaited<ReturnType<typeof Fastify>>, userIdentifier = ADMIN_ID) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: `userId=${encodeURIComponent(userIdentifier)}&password=${encodeURIComponent(ADMIN_PW)}`,
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
	});
	if (loginRes.statusCode !== 302) {
		throw new Error(`Login failed: ${loginRes.statusCode} ${loginRes.body.slice(0, 200)}`);
	}
	return collectCookies(loginRes);
}

/** Extract checkbox labels with class="delivery-cb" from rendered HTML. */
function extractDeliveryCbLabels(html: string): Array<{ checkboxValue: string; text: string }> {
	const results: Array<{ checkboxValue: string; text: string }> = [];
	// Match each <label> whose contents include an <input class="delivery-cb" ... value="...">,
	// capturing the value and the post-input label text.
	const labelRegex = /<label[^>]*>([\s\S]*?)<\/label>/g;
	let m: RegExpExecArray | null;
	while ((m = labelRegex.exec(html)) !== null) {
		const inner = m[1];
		if (!/class="[^"]*delivery-cb[^"]*"/.test(inner)) continue;
		const valueMatch = inner.match(/<input[^>]*value="([^"]*)"/);
		if (!valueMatch) continue;
		// Strip the <input ... /> element; the remaining text is the visible label.
		const text = inner
			.replace(/<input[^>]*\/?>/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		results.push({ checkboxValue: valueMatch[1], text });
	}
	return results;
}

/** Extract every <option> element inside a <select name=...> matching the prefix. */
function extractOptionsForSelect(
	html: string,
	selectNamePrefix: string,
): Array<{ value: string; text: string }> {
	const selectRegex = new RegExp(
		`<select[^>]*name="${selectNamePrefix}[^"]*"[^>]*>([\\s\\S]*?)<\\/select>`,
		'g',
	);
	const results: Array<{ value: string; text: string }> = [];
	let sm: RegExpExecArray | null;
	while ((sm = selectRegex.exec(html)) !== null) {
		const inner = sm[1];
		const optRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g;
		let om: RegExpExecArray | null;
		while ((om = optRegex.exec(inner)) !== null) {
			results.push({ value: om[1], text: om[2].trim() });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operator GUI templates surface user.name, not user.id', () => {
	let built: BuiltApp;

	beforeEach(async () => {
		built = await buildAlertReportContextDataApp();
	});

	afterEach(async () => {
		await built.app.close();
		await rm(built.tempDir, { recursive: true, force: true });
	});

	// --- alert-edit ---

	it('alert-edit delivery checkboxes show name as label text, not numeric id', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({ method: 'GET', url: '/gui/alerts/new', cookies });
		expect(res.statusCode).toBe(200);
		const labels = extractDeliveryCbLabels(res.body);
		expect(labels.length).toBeGreaterThanOrEqual(1);
		const matt = labels.find((l) => l.checkboxValue === ADMIN_ID);
		expect(matt).toBeDefined();
		expect(matt!.text).toBe(ADMIN_NAME);
		expect(matt!.text).not.toContain(ADMIN_ID);
		// The checkbox value (form-submit key) stays the canonical numeric id.
		expect(matt!.checkboxValue).toBe(ADMIN_ID);
	});

	it('alert-edit data-source user dropdown option text shows name only', async () => {
		// The server-side data-source <select> only renders when an alert has
		// sources, so build a small purpose-built app whose AlertService stub
		// returns an alert with one data_sources entry, then GET the edit page.
		const fakeAlert = {
			id: 'a1',
			name: 'A',
			description: '',
			enabled: true,
			schedule: '0 9 * * *',
			delivery: [],
			cooldown: '24 hours',
			condition: {
				type: 'deterministic',
				expression: 'not empty',
				data_sources: [{ app_id: 'grocery', user_id: ADMIN_ID, path: 'list.md' }],
			},
			actions: [],
		};
		const tempDir = await mkdtemp(join(tmpdir(), 'pas-batch2b-alert-ds-'));
		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PW);
		const userManager = makeUserManager([{ id: ADMIN_ID, name: ADMIN_NAME, isAdmin: true }]);
		const householdService = makeHouseholdService([ADMIN_ID]);
		const app = Fastify({ logger: false });
		await app.register(fastifyCookie, { secret: AUTH_TOKEN });
		await app.register(fastifyFormBody);
		const eta = new Eta();
		await app.register(fastifyView, {
			engine: { eta },
			root: viewsDir,
			viewExt: 'eta',
			layout: 'layout',
		});
		const alertService = {
			listAlerts: vi.fn().mockResolvedValue([fakeAlert]),
			getAlert: vi.fn().mockResolvedValue(fakeAlert),
		};
		const registry = {
			getAll: () => [{ manifest: { app: { id: 'grocery', name: 'Grocery' } } }],
		};
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
					registry: registry as any,
					reportService: { listReports: vi.fn().mockResolvedValue([]) } as any,
					dataDir: tempDir,
					timezone: 'UTC',
					logger,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();

		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: `userId=${ADMIN_ID}&password=${ADMIN_PW}`,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
		const cookies = collectCookies(loginRes);
		const res = await app.inject({ method: 'GET', url: '/gui/alerts/a1/edit', cookies });
		expect(res.statusCode).toBe(200);

		// Server-rendered <select name="ds_user_id_0">
		const options = extractOptionsForSelect(res.body, 'ds_user_id_');
		const mattOption = options.find((o) => o.value === ADMIN_ID);
		expect(mattOption).toBeDefined();
		expect(mattOption!.text).toBe(ADMIN_NAME);
		expect(mattOption!.text).not.toContain(ADMIN_ID);

		// Inline JS-built buildUserSelect (used for dynamically-added rows) must
		// also render option text without the id.
		expect(res.body).not.toMatch(/u\.name \+ ' \(' \+ u\.id \+ '\)'/);

		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	// --- report-edit ---

	it('report-edit delivery checkboxes show name as label text, not numeric id', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({ method: 'GET', url: '/gui/reports/new', cookies });
		expect(res.statusCode).toBe(200);
		const labels = extractDeliveryCbLabels(res.body);
		expect(labels.length).toBeGreaterThanOrEqual(1);
		const matt = labels.find((l) => l.checkboxValue === ADMIN_ID);
		expect(matt).toBeDefined();
		expect(matt!.text).toBe(ADMIN_NAME);
		expect(matt!.text).not.toContain(ADMIN_ID);
		expect(matt!.checkboxValue).toBe(ADMIN_ID);
	});

	it('report-edit section user dropdown option text shows name only', async () => {
		// We need an existing report with an app-data section so the server-side
		// dropdown renders. Build a small app with a stubbed report service.
		const tempDir = await mkdtemp(join(tmpdir(), 'pas-batch2b-report-ds-'));
		const credService = new CredentialService({ dataDir: tempDir });
		await credService.setPassword(ADMIN_ID, ADMIN_PW);
		const userManager = makeUserManager([{ id: ADMIN_ID, name: ADMIN_NAME, isAdmin: true }]);
		const householdService = makeHouseholdService([ADMIN_ID]);
		const fakeReport = {
			id: 'r1',
			name: 'R',
			description: '',
			enabled: true,
			schedule: '0 9 * * *',
			delivery: [],
			sections: [
				{
					type: 'app-data',
					label: 'Notes',
					config: { app_id: 'notes', user_id: ADMIN_ID, path: 'daily/{today}.md' },
				},
			],
			llm: { enabled: false },
		};
		const app = Fastify({ logger: false });
		await app.register(fastifyCookie, { secret: AUTH_TOKEN });
		await app.register(fastifyFormBody);
		const eta = new Eta();
		await app.register(fastifyView, {
			engine: { eta },
			root: viewsDir,
			viewExt: 'eta',
			layout: 'layout',
		});
		const reportService = {
			listReports: vi.fn().mockResolvedValue([fakeReport]),
			getReport: vi.fn().mockResolvedValue(fakeReport),
		};
		const registry = {
			getAll: () => [{ manifest: { app: { id: 'notes', name: 'Notes' } } }],
		};
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
					registry: registry as any,
					dataDir: tempDir,
					timezone: 'UTC',
					logger,
				});
			},
			{ prefix: '/gui' },
		);
		await app.ready();

		const loginRes = await app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: `userId=${ADMIN_ID}&password=${ADMIN_PW}`,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
		const cookies = collectCookies(loginRes);
		const res = await app.inject({ method: 'GET', url: '/gui/reports/r1/edit', cookies });
		expect(res.statusCode).toBe(200);

		const options = extractOptionsForSelect(res.body, 'section_user_id_');
		const mattOption = options.find((o) => o.value === ADMIN_ID);
		expect(mattOption).toBeDefined();
		expect(mattOption!.text).toBe(ADMIN_NAME);
		expect(mattOption!.text).not.toContain(ADMIN_ID);

		// Inline JS-built buildUserSelect must also be id-free in displayed text.
		expect(res.body).not.toMatch(/u\.name \+ ' \(' \+ u\.id \+ '\)'/);

		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	// --- dashboard admin table ---

	it('dashboard registered-users table shows name primary, id only inside <small>', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({ method: 'GET', url: '/gui/', cookies });
		expect(res.statusCode).toBe(200);
		// Locate the Registered Users table specifically (not the stat-card h3 of
		// the same name). The dashboard renders <h2>Registered Users</h2> inside
		// a <div class="card"> followed by a <table>...</table> with the user rows.
		const card = res.body.match(/<h2>Registered Users<\/h2>[\s\S]*?<\/table>/);
		expect(card).not.toBeNull();
		const cardBody = card![0];
		// Name appears as the primary cell content.
		expect(cardBody).toMatch(/<td[^>]*>[\s\S]*?Matt[\s\S]*?<\/td>/);
		// Every id appearance inside the card is wrapped in <small>.
		const cardIdHits = [...cardBody.matchAll(new RegExp(ADMIN_ID, 'g'))];
		expect(cardIdHits.length).toBeGreaterThan(0);
		for (const hit of cardIdHits) {
			const surrounding = cardBody.slice(Math.max(0, hit.index! - 80), hit.index! + 80);
			expect(surrounding).toMatch(/<small[^>]*>[\s\S]*?111/);
		}
	});

	// --- context page ---

	it('context page shows user name primary, id wrapped in <small>', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({ method: 'GET', url: '/gui/context', cookies });
		expect(res.statusCode).toBe(200);
		// h2 with name, then <small> wrapping the id.
		expect(res.body).toMatch(/<h2>[\s\S]*?Matt[\s\S]*?<small>[\s\S]*?111[\s\S]*?<\/small>/);
	});

	// --- data sidebar ---

	it('data browser sidebar shows user name primary, id wrapped in <small>', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({ method: 'GET', url: '/gui/data', cookies });
		expect(res.statusCode).toBe(200);
		// <summary><strong>Matt</strong> <small>(111)</small></summary>
		expect(res.body).toMatch(
			/<summary[^>]*>[\s\S]*?<strong>Matt<\/strong>[\s\S]*?<small[^>]*>[\s\S]*?111[\s\S]*?<\/small>/,
		);
	});

	// --- reset-password screen ---

	it('users/reset-password page shows name; any displayed id is wrapped in <small>', async () => {
		const cookies = await loginAsAdmin(built.app);
		const res = await built.app.inject({
			method: 'GET',
			url: `/gui/users/${ADMIN_ID}/reset-password`,
			cookies,
		});
		expect(res.statusCode).toBe(200);
		// The user's name appears in the body text.
		expect(res.body).toContain(ADMIN_NAME);
		// Any visible appearance of the id in the form-action URL is unavoidable
		// (it's the path key), but in the descriptive paragraph the id must be
		// inside <small> if present at all.
		const intro = res.body.match(/Resetting the password[\s\S]*?<\/p>/);
		expect(intro).not.toBeNull();
		const introBlock = intro![0];
		const introIdHits = [...introBlock.matchAll(new RegExp(ADMIN_ID, 'g'))];
		for (const hit of introIdHits) {
			const surrounding = introBlock.slice(Math.max(0, hit.index! - 80), hit.index! + 80);
			expect(surrounding).toMatch(/<small[^>]*>[\s\S]*?111/);
		}
	});

	// --- Gate #6: session cookie still carries the canonical numeric id ---

	it('after username login, session cookie payload still carries the numeric user id', async () => {
		const loginRes = await built.app.inject({
			method: 'POST',
			url: '/gui/login',
			payload: `userId=${encodeURIComponent(ADMIN_NAME)}&password=${encodeURIComponent(ADMIN_PW)}`,
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
		});
		expect(loginRes.statusCode).toBe(302);
		const cookie = (loginRes.cookies as Array<{ name: string; value: string }>).find(
			(c) => c.name === 'pas_auth',
		);
		expect(cookie).toBeDefined();
		const { unsign } = await import('@fastify/cookie');
		const result = unsign(cookie!.value, AUTH_TOKEN);
		expect(result.valid).toBe(true);
		const payload = JSON.parse(result.value!) as { userId: string };
		expect(payload.userId).toBe(ADMIN_ID);
		// Defensive: payload userId is the canonical numeric id, never the name.
		expect(payload.userId).not.toBe(ADMIN_NAME);
	});
});

// ---------------------------------------------------------------------------
// config.eta — not routed (merged into dashboard) but still present in the
// repo. Render the template directly via Eta to verify the same id-in-<small>
// shape as a regression guard.
// ---------------------------------------------------------------------------

describe('config.eta direct render', () => {
	it('renders user table with name primary and id inside <small>', async () => {
		const eta = new Eta({ views: viewsDir, autoEscape: true });
		const html = (await eta.renderAsync('config', {
			systemConfig: {
				port: 3000,
				logLevel: 'info',
				timezone: 'UTC',
				ollamaUrl: 'n/a',
				ollamaModel: 'n/a',
				claudeModel: 'claude',
			},
			users: [
				{
					id: ADMIN_ID,
					name: ADMIN_NAME,
					isAdmin: true,
					enabledApps: ['*'],
				},
			],
			appConfigs: [],
			csrfToken: '',
			safeJsonForScript,
		})) as string;

		// Name appears.
		expect(html).toContain(ADMIN_NAME);
		// Any id appearance is wrapped in <small>.
		const idHits = [...html.matchAll(new RegExp(ADMIN_ID, 'g'))];
		expect(idHits.length).toBeGreaterThan(0);
		for (const hit of idHits) {
			const surrounding = html.slice(Math.max(0, hit.index! - 60), hit.index! + 60);
			expect(surrounding).toMatch(/<small[^>]*>[\s\S]*?111/);
		}
	});
});
