/**
 * Guided report wizard (Batch 3, Task 3.3).
 *
 * `GET /gui/reports/new` renders the wizard shell + step 1. Each step posts
 * to `/gui/reports/new/step` with `step` + all prior fields as hidden
 * inputs; the server validates, then re-renders the same step (with an
 * inline error, values intact) or advances to the next step. The final
 * (Review) step renders a plain form whose hidden fields are EXACTLY the
 * existing `POST /gui/reports` contract — the existing create handler in
 * reports.ts is the only writer, so wizard-created and legacy-form-created
 * reports must be indistinguishable (the CONTRACT test below).
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts, with real CredentialService-backed
 * admin/member login (unlike reports.test.ts's legacy single-token auth,
 * which can't distinguish admin from member).
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { CredentialService } from '../../services/credentials/index.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import type { HouseholdService } from '../../services/household/index.js';
import { ReportService } from '../../services/reports/index.js';
import { CronManager } from '../../services/scheduler/cron-manager.js';
import { UserManager } from '../../services/user-manager/index.js';
import type { ContextStoreService } from '../../types/context-store.js';
import type { LLMService } from '../../types/llm.js';
import type { ReportDefinition } from '../../types/report.js';
import type { TelegramService } from '../../types/telegram.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerReportWizardRoutes } from '../routes/report-wizard.js';
import { registerReportRoutes } from '../routes/reports.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const ADMIN_PASS = 'admin-password';
const MEMBER_PASS = 'member-password';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_USER = { id: 'admin1', name: 'Admin', isAdmin: true, enabledApps: ['*'] };
const MEMBER_USER = { id: 'member1', name: 'Member', isAdmin: false, enabledApps: ['*'] };
const ALL_USERS = [ADMIN_USER, MEMBER_USER];

function makeTelegram(): TelegramService {
	return {
		send: async () => {},
		sendPhoto: async () => {},
		sendOptions: async () => '',
	} as unknown as TelegramService;
}

function makeLLM(): LLMService {
	return {
		complete: async () => 'Summary here.',
		classify: async () => {},
		extractStructured: async () => {},
	} as unknown as LLMService;
}

function makeContextStore(): ContextStoreService {
	return {
		get: async () => null,
		search: async () => [],
	} as unknown as ContextStoreService;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: () => ({ id: 'hh-1', name: 'Home', adminUserIds: [ADMIN_USER.id] }),
	};
}

function makeRegistry() {
	return {
		getAll: () => [
			{ manifest: { app: { id: 'notes', name: 'Notes' } } },
			{ manifest: { app: { id: 'echo', name: 'Echo' } } },
		],
	};
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

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let reportService: ReportService;

async function buildApp(dir: string) {
	const userManager = new UserManager({
		config: { users: ALL_USERS } as any,
		appToggle: new AppToggleStore({ dataDir: dir, logger }),
		logger,
	});
	const householdService = makeHouseholdService();

	const credentialService = new CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_USER.id, ADMIN_PASS);
	await credentialService.setPassword(MEMBER_USER.id, MEMBER_PASS);

	const cronManager = new CronManager(logger, 'UTC', dir);
	reportService = new ReportService({
		dataDir: dir,
		changeLog: new ChangeLog(dir),
		contextStore: makeContextStore(),
		llm: makeLLM(),
		telegram: makeTelegram(),
		userManager,
		cronManager,
		timezone: 'UTC',
		logger,
	});

	const fastifyApp = Fastify({ logger: false });
	await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await fastifyApp.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager,
				householdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, { userManager });
			registerReportRoutes(gui, {
				reportService,
				userManager,
				registry: makeRegistry(),
				dataDir: dir,
				timezone: 'UTC',
				logger,
			});
			registerReportWizardRoutes(gui, {
				reportService,
				userManager,
				registry: makeRegistry(),
				dataDir: dir,
				timezone: 'UTC',
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
}

async function login(userId: string, password: string): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

async function getCsrf(cookies: Record<string, string>) {
	const res = await app.inject({ method: 'GET', url: '/gui/reports', cookies });
	expect(res.statusCode).toBe(200);
	const allCookies = { ...cookies, ...collectCookies(res) };
	const metaMatch = res.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	expect(csrfToken).not.toBe('');
	return { cookies: allCookies, csrfToken };
}

/** Extract hidden `<input type="hidden" name="X" value="Y">` fields from an HTML fragment. */
function extractHiddenFields(html: string): Record<string, string> {
	const fields: Record<string, string> = {};
	const re = /<input[^>]*type="hidden"[^>]*>/g;
	const nameRe = /name="([^"]+)"/;
	const valueRe = /value="([^"]*)"/;
	for (const match of html.match(re) ?? []) {
		const name = match.match(nameRe)?.[1];
		const value = match.match(valueRe)?.[1] ?? '';
		if (name) fields[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
	}
	return fields;
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-report-wizard-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('GET /gui/reports/new (wizard entry)', () => {
	it('renders step 1 for an admin', async () => {
		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/reports/new', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Recent changes');
	});

	it('returns 403 for a member (creation is admin-only)', async () => {
		const cookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/reports/new', cookies });
		expect(res.statusCode).toBe(403);
	});
});

describe('POST /gui/reports/new/step', () => {
	it('valid step-1 POST returns step 2 with step-1 values as hidden fields', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies,
			payload: {
				_csrf: csrfToken,
				step: '1',
				section_type_0: 'changes',
				section_label_0: 'Recent changes',
				section_lookback_0: '24',
			},
		});

		expect(res.statusCode).toBe(200);
		const hidden = extractHiddenFields(res.body);
		expect(hidden.section_type_0).toBe('changes');
		expect(hidden.section_label_0).toBe('Recent changes');
		expect(hidden.section_lookback_0).toBe('24');
		expect(hidden.step).toBe('2');
	});

	it('invalid step POST re-renders the SAME step with values intact and a styled error', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		// Step 1 requires at least one section — submit none.
		const res = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies,
			payload: { _csrf: csrfToken, step: '1' },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('pas-error-card');
		const hidden = extractHiddenFields(res.body);
		expect(hidden.step).toBe('1');
	});

	it('requires auth + CSRF on every wizard POST', async () => {
		const noAuth = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			payload: { step: '1' },
		});
		expect([302, 401, 403]).toContain(noAuth.statusCode);

		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const noCsrf = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies: loginCookies,
			payload: { step: '1' },
		});
		expect(noCsrf.statusCode).toBe(403);
	});

	it('wizard step POSTs are admin-only (member → 403)', async () => {
		const loginCookies = await login(MEMBER_USER.id, MEMBER_PASS);
		// A member has no CSRF cookie from an admin-only page; fetch one from a
		// page the member CAN see to isolate the admin-guard check from CSRF.
		const csrfRes = await app.inject({
			method: 'GET',
			url: '/gui/reports',
			cookies: loginCookies,
		});
		const allCookies = { ...loginCookies, ...collectCookies(csrfRes) };
		const metaMatch = csrfRes.body.match(/name="csrf-token" content="([^"]+)"/);
		const csrfToken = metaMatch?.[1] ?? '';

		const res = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies: allCookies,
			payload: { _csrf: csrfToken, step: '1' },
		});
		expect(res.statusCode).toBe(403);
	});
});

describe('Review step contract', () => {
	async function walkToReview(cookies: Record<string, string>, csrfToken: string) {
		const step1 = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies,
			payload: {
				_csrf: csrfToken,
				step: '1',
				section_type_0: 'changes',
				section_label_0: 'Recent changes',
				section_lookback_0: '24',
			},
		});
		expect(step1.statusCode).toBe(200);
		const s1 = extractHiddenFields(step1.body);

		const step2 = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies,
			payload: { ...s1, _csrf: csrfToken, schedule_advanced: '0 7 * * *' },
		});
		expect(step2.statusCode).toBe(200);
		const s2 = extractHiddenFields(step2.body);
		expect(s2.step).toBe('3');

		const step3 = await app.inject({
			method: 'POST',
			url: '/gui/reports/new/step',
			cookies,
			payload: {
				...s2,
				_csrf: csrfToken,
				delivery_user: ADMIN_USER.id,
				llm_enabled: 'false',
				id: 'wizard-report',
				name: 'Wizard Report',
			},
		});
		expect(step3.statusCode).toBe(200);
		const s3 = extractHiddenFields(step3.body);
		expect(s3.step).toBe('4');
		return { body: step3.body, fields: s3 };
	}

	it('review step renders hidden fields matching the existing POST contract', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken);

		expect(fields.name).toBe('Wizard Report');
		expect(fields.id).toBe('wizard-report');
		expect(fields.schedule).toBe('0 7 * * *');
		expect(fields.delivery).toBe(ADMIN_USER.id);
		expect(fields.enabled).toBeDefined();
		expect(fields.section_type_0).toBe('changes');
		expect(fields.section_label_0).toBe('Recent changes');
		expect(fields.section_lookback_0).toBe('24');
	});

	it('CONTRACT: submitting the review form creates a report identical to one created via the legacy form fields', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken);

		// Submit the wizard's review-step contract via the existing create route.
		const wizardSubmit = await app.inject({
			method: 'POST',
			url: '/gui/reports',
			cookies,
			payload: { ...fields, _csrf: csrfToken },
		});
		expect(wizardSubmit.statusCode).toBe(302);
		const wizardReport = await reportService.getReport('wizard-report');
		expect(wizardReport).not.toBeNull();

		// Hand-build the equivalent legacy form fields for the same logical report.
		const legacyPayload: Record<string, string> = {
			_csrf: csrfToken,
			id: 'legacy-report',
			name: 'Wizard Report',
			schedule: '0 7 * * *',
			delivery: ADMIN_USER.id,
			enabled: 'true',
			llm_enabled: 'false',
			section_type_0: 'changes',
			section_label_0: 'Recent changes',
			section_lookback_0: '24',
		};
		const legacySubmit = await app.inject({
			method: 'POST',
			url: '/gui/reports',
			cookies,
			payload: legacyPayload,
		});
		expect(legacySubmit.statusCode).toBe(302);
		const legacyReport = await reportService.getReport('legacy-report');
		expect(legacyReport).not.toBeNull();

		const normalize = (r: ReportDefinition | null) => {
			const { id, updatedAt, ...rest } = r as ReportDefinition & { updatedAt?: string };
			return rest;
		};
		expect(normalize(wizardReport)).toEqual(normalize(legacyReport));
	});

	it('edit-wizard prefills from an existing definition, including custom cron → Advanced', async () => {
		await reportService.saveReport({
			id: 'existing-report',
			name: 'Existing Report',
			enabled: true,
			schedule: '*/7 3 * * 2',
			delivery: [ADMIN_USER.id],
			sections: [{ type: 'custom', label: 'Notes', config: { text: 'hello' } }],
			llm: { enabled: false },
		});
		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({
			method: 'GET',
			url: '/gui/reports/existing-report/edit-wizard',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Notes');
		expect(res.body).toContain('*/7 3 * * 2');
	});
});
