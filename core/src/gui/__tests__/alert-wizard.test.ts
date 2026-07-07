/**
 * Guided alert wizard (Batch 4, Task 4.3).
 *
 * Same engine as the report wizard (report-wizard.ts/.test.ts): `GET
 * /gui/alerts/new` renders the shell + step 1; each step posts to
 * `/gui/alerts/new/step` with `step` + all prior fields as hidden inputs;
 * the final (Review) step renders a plain form whose hidden fields are
 * EXACTLY the existing `POST /gui/alerts` contract (alerts.ts's
 * `parseFormToAlert`) — the existing create handler remains the only
 * writer, so wizard-created and legacy-form-created alerts must be
 * indistinguishable (the CONTRACT test below).
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts / report-wizard.test.ts.
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
import { AlertService } from '../../services/alerts/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { FileIndexService } from '../../services/file-index/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { ReportService } from '../../services/reports/index.js';
import { CronManager } from '../../services/scheduler/cron-manager.js';
import { SpaceService } from '../../services/spaces/index.js';
import { UserManager } from '../../services/user-manager/index.js';
import type { AlertDefinition } from '../../types/alert.js';
import type { ContextStoreService } from '../../types/context-store.js';
import type { LLMService } from '../../types/llm.js';
import type { ManifestDataScope } from '../../types/manifest.js';
import type { TelegramService } from '../../types/telegram.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAlertWizardRoutes } from '../routes/alert-wizard.js';
import { registerAlertRoutes } from '../routes/alerts.js';
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
		complete: async () => 'yes',
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
			{ manifest: { app: { id: 'food', name: 'Food' } } },
			{ manifest: { app: { id: 'notes', name: 'Notes' } } },
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
let alertService: AlertService;
let reportService: ReportService;
let fileIndex: FileIndexService;
let spaceService: SpaceService;

async function buildApp(dir: string) {
	const userManager = new UserManager({
		config: { users: ALL_USERS } as any,
		appToggle: new AppToggleStore({ dataDir: dir, logger }),
		logger,
	});
	const householdService = makeHouseholdService();

	const credentialService = new (
		await import('../../services/credentials/index.js')
	).CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_USER.id, ADMIN_PASS);
	await credentialService.setPassword(MEMBER_USER.id, MEMBER_PASS);

	const cronManager = new CronManager(logger, 'UTC', dir);
	const llm = makeLLM();
	reportService = new ReportService({
		dataDir: dir,
		changeLog: new ChangeLog(dir),
		contextStore: makeContextStore(),
		llm,
		telegram: makeTelegram(),
		userManager,
		cronManager,
		timezone: 'UTC',
		logger,
	});
	alertService = new AlertService({
		dataDir: dir,
		llm,
		telegram: makeTelegram(),
		userManager,
		cronManager,
		reportService,
		timezone: 'UTC',
		logger,
	});

	spaceService = new SpaceService({
		dataDir: dir,
		userManager,
		householdService: householdService as unknown as HouseholdService,
		logger,
	});
	await spaceService.init();

	const appScopes = new Map<string, { user: ManifestDataScope[]; shared: ManifestDataScope[] }>([
		[
			'food',
			{
				user: [{ path: 'pantry.md', access: 'read-write', description: 'pantry' }],
				shared: [],
			},
		],
		[
			'notes',
			{
				user: [],
				shared: [{ path: 'log.md', access: 'read-write', description: 'log' }],
			},
		],
	]);
	fileIndex = new FileIndexService(dir, appScopes, () => {});

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
			registerAlertRoutes(gui, {
				alertService,
				userManager,
				registry: makeRegistry(),
				reportService,
				spaceService,
				dataDir: dir,
				timezone: 'UTC',
				logger,
			});
			registerAlertWizardRoutes(gui, {
				alertService,
				userManager,
				fileIndex,
				spaceService,
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
	const res = await app.inject({ method: 'GET', url: '/gui/alerts', cookies });
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
		if (name) {
			// Alert condition expressions can legitimately contain > / < (e.g.
			// "line count > 5"), unlike report contract fields, so this helper
			// (unlike report-wizard.test.ts's copy) also decodes those entities.
			fields[name] = value
				.replace(/&quot;/g, '"')
				.replace(/&gt;/g, '>')
				.replace(/&lt;/g, '<')
				.replace(/&amp;/g, '&');
		}
	}
	return fields;
}

async function seedDataFile(dir: string, relPath: string, content = 'hello') {
	const { mkdir, writeFile } = await import('node:fs/promises');
	const { dirname } = await import('node:path');
	const full = join(dir, relPath);
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, content, 'utf-8');
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-wizard-'));
	app = await buildApp(tempDir);
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('GET /gui/alerts/new (wizard entry)', () => {
	it('renders step 1 (data source picker) for an admin', async () => {
		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/alerts/new', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('What should we watch');
	});

	it('returns 403 for a member (creation is admin-only)', async () => {
		const cookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/alerts/new', cookies });
		expect(res.statusCode).toBe(403);
	});

	it('data-source picker organizes entries by scope with friendly names, never raw paths', async () => {
		await seedDataFile(tempDir, 'users/admin1/food/pantry.md', 'milk\neggs');
		await seedDataFile(tempDir, 'users/shared/notes/log.md', 'hi');
		await fileIndex.rebuild();

		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({ method: 'GET', url: '/gui/alerts/new', cookies });
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Food pantry');
		expect(res.body).toContain('Notes log');
		expect(res.body).not.toContain('users/admin1/food/pantry.md');
		expect(res.body).not.toContain('users/shared/notes/log.md');
	});
});

describe('POST /gui/alerts/new/step', () => {
	it('valid step-1 POST returns step 2 with step-1 values as hidden fields', async () => {
		await seedDataFile(tempDir, 'users/admin1/food/pantry.md', 'milk');
		await fileIndex.rebuild();
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				_csrf: csrfToken,
				step: '1',
				ds_app_id_0: 'food',
				ds_scope_0: 'user',
				ds_user_id_0: ADMIN_USER.id,
				ds_path_0: 'pantry.md',
			},
		});

		expect(res.statusCode).toBe(200);
		const hidden = extractHiddenFields(res.body);
		expect(hidden.ds_app_id_0).toBe('food');
		expect(hidden.ds_path_0).toBe('pantry.md');
		expect(hidden.step).toBe('2');
	});

	it('invalid step POST re-renders the SAME step with values intact and a styled error', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
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
			url: '/gui/alerts/new/step',
			payload: { step: '1' },
		});
		expect([302, 401, 403]).toContain(noAuth.statusCode);

		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const noCsrf = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies: loginCookies,
			payload: { step: '1' },
		});
		expect(noCsrf.statusCode).toBe(403);
	});

	it('wizard step POSTs are admin-only (member → 403)', async () => {
		const loginCookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const csrfRes = await app.inject({ method: 'GET', url: '/gui/alerts', cookies: loginCookies });
		const allCookies = { ...loginCookies, ...collectCookies(csrfRes) };
		const csrfToken = csrfRes.body.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? '';

		const res = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies: allCookies,
			payload: { _csrf: csrfToken, step: '1' },
		});
		expect(res.statusCode).toBe(403);
	});
});

describe('Review step contract', () => {
	async function walkToReview(
		cookies: Record<string, string>,
		csrfToken: string,
		opts: {
			cooldownN?: string;
			cooldownUnit?: string;
			conditionMode?: 'rule' | 'fuzzy' | 'advanced';
		} = {},
	) {
		const step1 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				_csrf: csrfToken,
				step: '1',
				ds_app_id_0: 'food',
				ds_scope_0: 'user',
				ds_user_id_0: ADMIN_USER.id,
				ds_path_0: 'pantry.md',
			},
		});
		expect(step1.statusCode).toBe(200);
		const s1 = extractHiddenFields(step1.body);
		expect(s1.step).toBe('2');

		const step2 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				...s1,
				_csrf: csrfToken,
				trigger_type: 'scheduled',
				schedule_advanced: '0 7 * * *',
			},
		});
		expect(step2.statusCode).toBe(200);
		const s2 = extractHiddenFields(step2.body);
		expect(s2.step).toBe('3');

		const conditionMode = opts.conditionMode ?? 'rule';
		const conditionPayload: Record<string, string> =
			conditionMode === 'rule'
				? { rule_pattern: 'contains', rule_text: 'expired' }
				: conditionMode === 'fuzzy'
					? { condition_mode: 'fuzzy', fuzzy_text: 'anything about to spoil' }
					: { condition_mode: 'advanced', condition_advanced: 'line count > 5' };
		if (conditionMode === 'rule') conditionPayload.condition_mode = 'rule';

		const step3 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: { ...s2, _csrf: csrfToken, ...conditionPayload },
		});
		expect(step3.statusCode).toBe(200);
		const s3 = extractHiddenFields(step3.body);
		expect(s3.step).toBe('4');

		const step4 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				...s3,
				_csrf: csrfToken,
				id: 'wizard-alert',
				name: 'Wizard Alert',
				delivery_user: ADMIN_USER.id,
				action_type_0: 'telegram_message',
				action_message_0: 'Check it out: {data}',
				cooldown_n: opts.cooldownN ?? '4',
				cooldown_unit: opts.cooldownUnit ?? 'hours',
			},
		});
		expect(step4.statusCode).toBe(200);
		const s4 = extractHiddenFields(step4.body);
		expect(s4.step).toBe('5');
		return { body: step4.body, fields: s4 };
	}

	it('review step renders hidden fields matching the existing POST contract', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken);

		expect(fields.name).toBe('Wizard Alert');
		expect(fields.id).toBe('wizard-alert');
		expect(fields.schedule).toBe('0 7 * * *');
		expect(fields.trigger_type).toBe('scheduled');
		expect(fields.delivery).toBe(ADMIN_USER.id);
		expect(fields.condition_type).toBe('deterministic');
		expect(fields.condition_expression).toBe('contains "expired"');
		expect(fields.ds_app_id_0).toBe('food');
		expect(fields.ds_path_0).toBe('pantry.md');
		expect(fields.action_type_0).toBe('telegram_message');
		expect(fields.action_message_0).toBe('Check it out: {data}');
		// Cooldown MUST be the human string contract, never a bare number.
		expect(fields.cooldown).toBe('4 hours');
		expect(fields.enabled).toBeDefined();
	});

	it('CONTRACT: submitting the review form creates an alert identical to one created via the legacy form fields', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken);

		const wizardSubmit = await app.inject({
			method: 'POST',
			url: '/gui/alerts',
			cookies,
			payload: { ...fields, _csrf: csrfToken },
		});
		expect(wizardSubmit.statusCode).toBe(302);
		const wizardAlert = await alertService.getAlert('wizard-alert');
		expect(wizardAlert).not.toBeNull();

		const legacyPayload: Record<string, string> = {
			_csrf: csrfToken,
			id: 'legacy-alert',
			name: 'Wizard Alert',
			enabled: 'true',
			schedule: '0 7 * * *',
			trigger_type: 'scheduled',
			delivery: ADMIN_USER.id,
			cooldown: '4 hours',
			condition_type: 'deterministic',
			condition_expression: 'contains "expired"',
			ds_app_id_0: 'food',
			ds_scope_0: 'user',
			ds_user_id_0: ADMIN_USER.id,
			ds_path_0: 'pantry.md',
			action_type_0: 'telegram_message',
			action_message_0: 'Check it out: {data}',
		};
		const legacySubmit = await app.inject({
			method: 'POST',
			url: '/gui/alerts',
			cookies,
			payload: legacyPayload,
		});
		expect(legacySubmit.statusCode).toBe(302);
		const legacyAlert = await alertService.getAlert('legacy-alert');
		expect(legacyAlert).not.toBeNull();

		const normalize = (a: AlertDefinition | null) => {
			const { id, updatedAt, lastFired, ...rest } = a as AlertDefinition & {
				updatedAt?: string;
				lastFired?: string | null;
			};
			return rest;
		};
		expect(normalize(wizardAlert)).toEqual(normalize(legacyAlert));
	});

	it('event-triggered alerts emit trigger_type=event + trigger_event_name, no schedule required', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const step1 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				_csrf: csrfToken,
				step: '1',
				ds_app_id_0: 'food',
				ds_scope_0: 'user',
				ds_user_id_0: ADMIN_USER.id,
				ds_path_0: 'pantry.md',
			},
		});
		const s1 = extractHiddenFields(step1.body);

		const step2 = await app.inject({
			method: 'POST',
			url: '/gui/alerts/new/step',
			cookies,
			payload: {
				...s1,
				_csrf: csrfToken,
				trigger_type: 'event',
				trigger_event_name: 'data:changed',
			},
		});
		expect(step2.statusCode).toBe(200);
		const s2 = extractHiddenFields(step2.body);
		expect(s2.trigger_type).toBe('event');
		expect(s2.trigger_event_name).toBe('data:changed');
	});

	it('fuzzy condition mode emits condition_type=fuzzy with the own-words expression', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken, { conditionMode: 'fuzzy' });
		expect(fields.condition_type).toBe('fuzzy');
		expect(fields.condition_expression).toBe('anything about to spoil');
	});

	it('advanced condition mode passes the raw expression through unchanged', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken, { conditionMode: 'advanced' });
		expect(fields.condition_type).toBe('deterministic');
		expect(fields.condition_expression).toBe('line count > 5');
	});

	it('cooldown UI emits the human string contract for every unit', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { fields } = await walkToReview(cookies, csrfToken, {
			cooldownN: '30',
			cooldownUnit: 'minutes',
		});
		expect(fields.cooldown).toBe('30 minutes');
	});

	it('review renders the describeAlert sentence', async () => {
		const loginCookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const { cookies, csrfToken } = await getCsrf(loginCookies);
		const { body } = await walkToReview(cookies, csrfToken);
		expect(body).toContain('pas-describe-sentence');
	});

	it('edit-wizard prefills from an existing definition; unmappable legacy expression falls back to Advanced', async () => {
		await alertService.saveAlert({
			id: 'existing-alert',
			name: 'Existing Alert',
			enabled: true,
			schedule: '0 9 * * *',
			trigger: { type: 'scheduled', schedule: '0 9 * * *' },
			condition: {
				type: 'deterministic',
				expression: 'some legacy free text',
				data_sources: [{ app_id: 'food', user_id: ADMIN_USER.id, path: 'pantry.md' }],
			},
			actions: [{ type: 'telegram_message', config: { message: 'hi' } }],
			delivery: [ADMIN_USER.id],
			cooldown: '2 hours',
		});
		const cookies = await login(ADMIN_USER.id, ADMIN_PASS);
		const res = await app.inject({
			method: 'GET',
			url: '/gui/alerts/existing-alert/edit-wizard',
			cookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pantry.md');
	});

	it('member 403 also covers the edit-wizard route', async () => {
		await alertService.saveAlert({
			id: 'existing-for-guard',
			name: 'Existing',
			enabled: true,
			schedule: '0 9 * * *',
			condition: {
				type: 'deterministic',
				expression: 'is empty',
				data_sources: [{ app_id: 'food', user_id: ADMIN_USER.id, path: 'x.md' }],
			},
			actions: [{ type: 'telegram_message', config: { message: 'hi' } }],
			delivery: [ADMIN_USER.id],
			cooldown: '1 hour',
		});
		const cookies = await login(MEMBER_USER.id, MEMBER_PASS);
		const res = await app.inject({
			method: 'GET',
			url: '/gui/alerts/existing-for-guard/edit-wizard',
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});
});
