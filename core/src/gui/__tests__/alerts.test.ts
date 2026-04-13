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
import { AlertService } from '../../services/alerts/index.js';
import { AppToggleStore } from '../../services/app-toggle/index.js';
import { ChangeLog } from '../../services/data-store/change-log.js';
import { ReportService } from '../../services/reports/index.js';
import { CronManager } from '../../services/scheduler/cron-manager.js';
import { UserManager } from '../../services/user-manager/index.js';
import type { ContextStoreService } from '../../types/context-store.js';
import type { LLMService } from '../../types/llm.js';
import type { TelegramService } from '../../types/telegram.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerAlertRoutes } from '../routes/alerts.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let alertService: AlertService;
let telegram: TelegramService;

function makeTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	} as unknown as TelegramService;
}

function makeLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('yes'),
		classify: vi.fn(),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

function makeContextStore(): ContextStoreService {
	return {
		get: vi.fn().mockResolvedValue(null),
		search: vi.fn().mockResolvedValue([]),
	};
}

function makeRegistry() {
	return {
		getAll: () => [
			{ manifest: { app: { id: 'grocery', name: 'Grocery' } } },
			{ manifest: { app: { id: 'notes', name: 'Notes' } } },
		],
	};
}

function makeReportService() {
	return {
		listReports: vi.fn().mockResolvedValue([{ id: 'daily-summary', name: 'Daily Summary' }]),
	};
}

function makeUserManager(): UserManager {
	return new UserManager({
		config: {
			users: [{ id: '123456789', name: 'Test User', enabledApps: ['*'] }],
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
}

async function buildApp() {
	telegram = makeTelegram();
	const cronManager = new CronManager(logger, 'UTC', tempDir);
	const llm = makeLLM();

	const reportService = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore: makeContextStore(),
		llm,
		telegram,
		userManager: makeUserManager(),
		cronManager,
		timezone: 'UTC',
		logger,
	});

	alertService = new AlertService({
		dataDir: tempDir,
		llm,
		telegram,
		userManager: makeUserManager(),
		cronManager,
		reportService,
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
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerAlertRoutes(gui, {
				alertService,
				userManager: makeUserManager(),
				registry: makeRegistry(),
				reportService: makeReportService() as any,
				dataDir: tempDir,
				timezone: 'UTC',
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
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

async function authenticatedGet(url: string) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const cookies = collectCookies(loginRes);
	return app.inject({ method: 'GET', url, cookies });
}

async function authenticatedPost(url: string, payload: Record<string, unknown>) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const loginCookies = collectCookies(loginRes);

	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/alerts',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';

	return app.inject({
		method: 'POST',
		url,
		payload: { ...payload, _csrf: csrfToken },
		cookies: allCookies,
	});
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-alerts-'));
	app = await buildApp();
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

async function createAlert(id = 'test-alert', name = 'Test Alert') {
	await alertService.saveAlert({
		id,
		name,
		description: 'A test alert',
		enabled: true,
		schedule: '0 18 * * *',
		delivery: ['123456789'],
		condition: {
			type: 'deterministic',
			expression: 'not empty',
			data_sources: [{ app_id: 'grocery', user_id: '123456789', path: 'list.md' }],
		},
		actions: [{ type: 'telegram_message', config: { message: 'Alert triggered!' } }],
		cooldown: '24 hours',
	});
}

describe('Alert GUI Routes', () => {
	// --- List ---

	describe('GET /gui/alerts', () => {
		it('returns 200 with empty alert list', async () => {
			const res = await authenticatedGet('/gui/alerts');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Alerts');
		});

		it('shows existing alerts', async () => {
			await createAlert();
			const res = await authenticatedGet('/gui/alerts');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Alert');
		});

		it('shows schedule and condition', async () => {
			await createAlert();
			const res = await authenticatedGet('/gui/alerts');
			// Raw cron removed; human-readable schedule shown
			expect(res.body).toContain('06:00 PM');
			expect(res.body).toContain('deterministic');
		});
	});

	// --- New form ---

	describe('GET /gui/alerts/new', () => {
		it('returns 200 with create form', async () => {
			const res = await authenticatedGet('/gui/alerts/new');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Create Alert');
		});

		it('includes user checkboxes for delivery', async () => {
			const res = await authenticatedGet('/gui/alerts/new');
			expect(res.body).toContain('Test User');
			expect(res.body).toContain('123456789');
			expect(res.body).toContain('delivery-cb');
		});

		it('includes app options for data sources', async () => {
			const res = await authenticatedGet('/gui/alerts/new');
			expect(res.body).toContain('PAS_APPS');
			expect(res.body).toContain('"grocery"');
			expect(res.body).toContain('"notes"');
		});

		it('includes report options for run_report actions', async () => {
			const res = await authenticatedGet('/gui/alerts/new');
			expect(res.body).toContain('PAS_REPORTS');
			expect(res.body).toContain('"daily-summary"');
		});
	});

	// --- Edit form ---

	describe('GET /gui/alerts/:id/edit', () => {
		it('returns 200 for existing alert', async () => {
			await createAlert();
			const res = await authenticatedGet('/gui/alerts/test-alert/edit');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Alert');
		});

		it('returns 404 for nonexistent alert', async () => {
			const res = await authenticatedGet('/gui/alerts/nonexistent/edit');
			expect(res.statusCode).toBe(404);
		});
	});

	// --- Create (POST /alerts) ---

	describe('POST /gui/alerts', () => {
		it('creates an alert and redirects', async () => {
			const res = await authenticatedPost('/gui/alerts', {
				id: 'new-alert',
				name: 'New Alert',
				description: 'Created via form',
				enabled: 'true',
				schedule: '0 18 * * *',
				delivery: '123456789',
				cooldown: '24 hours',
				condition_type: 'deterministic',
				condition_expression: 'not empty',
				ds_app_id_0: 'grocery',
				ds_user_id_0: '123456789',
				ds_path_0: 'list.md',
				action_type_0: 'telegram_message',
				action_message_0: 'Alert!',
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/alerts/new-alert/edit');

			const alert = await alertService.getAlert('new-alert');
			expect(alert).not.toBeNull();
			expect(alert?.name).toBe('New Alert');
		});

		it('re-renders form on validation error', async () => {
			const res = await authenticatedPost('/gui/alerts', {
				id: '',
				name: '',
				schedule: '',
				delivery: '',
				cooldown: '',
				condition_type: 'deterministic',
				condition_expression: '',
			});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Create Alert');
		});
	});

	// --- Update (POST /alerts/:id) ---

	describe('POST /gui/alerts/:id', () => {
		it('updates an existing alert', async () => {
			await createAlert();

			const res = await authenticatedPost('/gui/alerts/test-alert', {
				id: 'test-alert',
				name: 'Updated Name',
				enabled: 'true',
				schedule: '0 10 * * *',
				delivery: '123456789',
				cooldown: '12 hours',
				condition_type: 'deterministic',
				condition_expression: 'not empty',
				ds_app_id_0: 'grocery',
				ds_user_id_0: '123456789',
				ds_path_0: 'list.md',
				action_type_0: 'telegram_message',
				action_message_0: 'Updated alert!',
			});
			expect(res.statusCode).toBe(302);

			const alert = await alertService.getAlert('test-alert');
			expect(alert?.name).toBe('Updated Name');
		});

		it('forces ID from URL param', async () => {
			await createAlert();

			const res = await authenticatedPost('/gui/alerts/test-alert', {
				id: 'different-id',
				name: 'Updated',
				enabled: 'true',
				schedule: '0 18 * * *',
				delivery: '123456789',
				cooldown: '24 hours',
				condition_type: 'deterministic',
				condition_expression: 'not empty',
				ds_app_id_0: 'grocery',
				ds_user_id_0: '123456789',
				ds_path_0: 'list.md',
				action_type_0: 'telegram_message',
				action_message_0: 'Alert!',
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/alerts/test-alert/edit');
		});
	});

	// --- Delete ---

	describe('POST /gui/alerts/:id/delete', () => {
		it('deletes an alert and redirects', async () => {
			await createAlert();

			const res = await authenticatedPost('/gui/alerts/test-alert/delete', {});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/alerts');

			const alert = await alertService.getAlert('test-alert');
			expect(alert).toBeNull();
		});
	});

	// --- Toggle ---

	describe('POST /gui/alerts/:id/toggle', () => {
		it('toggles alert enabled state', async () => {
			await createAlert();

			const res = await authenticatedPost('/gui/alerts/test-alert/toggle', {});
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');

			const alert = await alertService.getAlert('test-alert');
			expect(alert?.enabled).toBe(false);
		});

		it('returns 404 for nonexistent alert', async () => {
			const res = await authenticatedPost('/gui/alerts/nonexistent/toggle', {});
			expect(res.statusCode).toBe(404);
		});
	});

	// --- Test (preview) ---

	describe('POST /gui/alerts/:id/test', () => {
		it('returns test result HTML', async () => {
			await createAlert();

			const res = await authenticatedPost('/gui/alerts/test-alert/test', {});
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(res.body).toContain('Condition');
		});

		it('does not execute actions', async () => {
			await createAlert();
			await authenticatedPost('/gui/alerts/test-alert/test', {});
			expect(telegram.send).not.toHaveBeenCalled();
		});
	});

	// --- History ---

	describe('GET /gui/alerts/:id/history', () => {
		it('returns history page for existing alert', async () => {
			await createAlert();

			const res = await authenticatedGet('/gui/alerts/test-alert/history');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Alert');
		});

		it('returns 404 for nonexistent alert', async () => {
			const res = await authenticatedGet('/gui/alerts/nonexistent/history');
			expect(res.statusCode).toBe(404);
		});
	});

	// --- History detail ---

	describe('GET /gui/alerts/:id/history/:file', () => {
		it('rejects path traversal in file name', async () => {
			await createAlert();

			const res = await authenticatedGet(
				'/gui/alerts/test-alert/history/..%2F..%2Fetc%2Fpasswd.md',
			);
			expect(res.statusCode).toBe(400);
		});

		it('rejects non-.md files', async () => {
			const res = await authenticatedGet('/gui/alerts/test-alert/history/file.txt');
			expect(res.statusCode).toBe(400);
		});

		it('returns 404 for missing history file', async () => {
			const res = await authenticatedGet('/gui/alerts/test-alert/history/2026-01-01_000000.md');
			expect(res.statusCode).toBe(404);
		});

		it('rejects path traversal in alert id parameter', async () => {
			const res = await authenticatedGet('/gui/alerts/..%2F..%2Fetc/history/2026-01-01_000000.md');
			expect(res.statusCode).toBe(400);
		});
	});

	// --- XSS protection ---

	describe('XSS protection', () => {
		it('escapes HTML in toggle response', async () => {
			await alertService.saveAlert({
				id: 'xss-test',
				name: 'XSS<script>alert(1)</script>',
				description: 'test',
				enabled: true,
				schedule: '0 18 * * *',
				delivery: ['123456789'],
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'a', user_id: '123456789', path: 'x.md' }],
				},
				actions: [{ type: 'telegram_message', config: { message: 'hi' } }],
				cooldown: '24 hours',
			});

			const res = await authenticatedPost('/gui/alerts/xss-test/toggle', {});
			expect(res.statusCode).toBe(200);
			expect(res.body).not.toContain('<script>');
		});

		it('escapes HTML in test response', async () => {
			await alertService.saveAlert({
				id: 'xss-test2',
				name: '<img onerror=alert(1)>',
				description: 'test',
				enabled: true,
				schedule: '0 18 * * *',
				delivery: ['123456789'],
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'a', user_id: '123456789', path: 'x.md' }],
				},
				actions: [{ type: 'telegram_message', config: { message: 'hi' } }],
				cooldown: '24 hours',
			});

			const res = await authenticatedPost('/gui/alerts/xss-test2/test', {});
			expect(res.body).not.toContain('<img onerror');
		});

		it('safeJsonForScript escapes </script> breakout in alert edit-page PAS_EXISTING_ACTIONS inline JSON (Gap 12+13)', async () => {
			// PAS_EXISTING_ACTIONS in alert-edit embeds action configs via safeJsonForScript.
			// A telegram_message action with a malicious message is a direct injection vector.
			await alertService.saveAlert({
				id: 'xss-edit',
				name: 'Safe Alert Name',
				description: 'test',
				enabled: true,
				schedule: '0 18 * * *',
				delivery: ['123456789'],
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [{ app_id: 'a', user_id: '123456789', path: 'x.md' }],
				},
				actions: [
					{
						type: 'telegram_message',
						config: { message: '</script><script>window.__pasXss=1</script>' },
					},
				],
				cooldown: '24 hours',
			});

			const res = await authenticatedGet('/gui/alerts/xss-edit/edit');
			expect(res.statusCode).toBe(200);

			// Literal attacker payload must not appear in the page
			expect(res.body).not.toContain('</script><script>window.__pasXss=1</script>');

			// The '<' in the action message must be escaped as \u003c in PAS_EXISTING_ACTIONS
			expect(res.body).toContain('\\u003c');
		});
	});
});
