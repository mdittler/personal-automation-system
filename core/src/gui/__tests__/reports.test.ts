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
import { registerReportRoutes } from '../routes/reports.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

let tempDir: string;
let app: Awaited<ReturnType<typeof Fastify>>;
let reportService: ReportService;
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
		complete: vi.fn().mockResolvedValue('Summary here.'),
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
			{ manifest: { app: { id: 'notes', name: 'Notes' } } },
			{ manifest: { app: { id: 'echo', name: 'Echo' } } },
		],
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
	const cronManager = new CronManager(logger, 'UTC');

	reportService = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore: makeContextStore(),
		llm: makeLLM(),
		telegram,
		userManager: makeUserManager(),
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
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerReportRoutes(gui, {
				reportService,
				userManager: makeUserManager(),
				registry: makeRegistry(),
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
		url: '/gui/reports',
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
	tempDir = await mkdtemp(join(tmpdir(), 'pas-gui-reports-'));
	app = await buildApp();
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

async function createReport(id = 'test-report', name = 'Test Report') {
	await reportService.saveReport({
		id,
		name,
		description: 'A test report',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['123456789'],
		sections: [{ type: 'custom', label: 'Intro', config: { text: 'Hello from report' } }],
		llm: { enabled: false },
	});
}

describe('Report GUI Routes', () => {
	// --- List ---

	describe('GET /gui/reports', () => {
		it('returns 200 with empty report list', async () => {
			const res = await authenticatedGet('/gui/reports');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Reports');
		});

		it('shows existing reports', async () => {
			await createReport();
			const res = await authenticatedGet('/gui/reports');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Report');
		});

		it('shows schedule and section count', async () => {
			await createReport();
			const res = await authenticatedGet('/gui/reports');
			// Raw cron removed from list; human-readable schedule shown instead
			expect(res.body).toContain('Monday');
			expect(res.body).toContain('1'); // section count
		});
	});

	// --- New form ---

	describe('GET /gui/reports/new', () => {
		it('returns 200 with create form', async () => {
			const res = await authenticatedGet('/gui/reports/new');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Create Report');
		});

		it('includes user checkboxes for delivery', async () => {
			const res = await authenticatedGet('/gui/reports/new');
			expect(res.body).toContain('Test User');
			expect(res.body).toContain('123456789');
			expect(res.body).toContain('delivery-cb');
		});

		it('includes app options for sections', async () => {
			const res = await authenticatedGet('/gui/reports/new');
			expect(res.body).toContain('PAS_APPS');
			expect(res.body).toContain('"notes"');
			expect(res.body).toContain('"echo"');
		});
	});

	// --- Edit form ---

	describe('GET /gui/reports/:id/edit', () => {
		it('returns 200 for existing report', async () => {
			await createReport();
			const res = await authenticatedGet('/gui/reports/test-report/edit');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Report');
		});

		it('returns 404 for nonexistent report', async () => {
			const res = await authenticatedGet('/gui/reports/nonexistent/edit');
			expect(res.statusCode).toBe(404);
		});
	});

	// --- Create (POST /reports) ---

	describe('POST /gui/reports', () => {
		it('creates a report and redirects', async () => {
			const res = await authenticatedPost('/gui/reports', {
				id: 'new-report',
				name: 'New Report',
				description: 'Created via form',
				enabled: 'true',
				schedule: '0 9 * * 1',
				delivery: '123456789',
				section_type_0: 'custom',
				section_label_0: 'Intro',
				section_text_0: 'Hello',
				llm_enabled: 'false',
			});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/reports/new-report/edit');

			const report = await reportService.getReport('new-report');
			expect(report).not.toBeNull();
			expect(report?.name).toBe('New Report');
		});

		it('re-renders form on validation error', async () => {
			const res = await authenticatedPost('/gui/reports', {
				id: '',
				name: '',
				schedule: '',
				delivery: '',
			});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Create Report');
		});
	});

	// --- Update (POST /reports/:id) ---

	describe('POST /gui/reports/:id', () => {
		it('updates an existing report', async () => {
			await createReport();

			const res = await authenticatedPost('/gui/reports/test-report', {
				id: 'test-report',
				name: 'Updated Name',
				enabled: 'true',
				schedule: '0 10 * * *',
				delivery: '123456789',
				section_type_0: 'custom',
				section_label_0: 'Intro',
				section_text_0: 'Updated text',
				llm_enabled: 'false',
			});
			expect(res.statusCode).toBe(302);

			const report = await reportService.getReport('test-report');
			expect(report?.name).toBe('Updated Name');
		});

		it('forces ID from URL param', async () => {
			await createReport();

			const res = await authenticatedPost('/gui/reports/test-report', {
				id: 'different-id',
				name: 'Updated',
				enabled: 'true',
				schedule: '0 9 * * 1',
				delivery: '123456789',
				section_type_0: 'custom',
				section_label_0: 'Intro',
				section_text_0: 'Text',
				llm_enabled: 'false',
			});
			expect(res.statusCode).toBe(302);
			// The URL param ID should be used, not the body ID
			expect(res.headers.location).toBe('/gui/reports/test-report/edit');
		});
	});

	// --- Delete ---

	describe('POST /gui/reports/:id/delete', () => {
		it('deletes a report and redirects', async () => {
			await createReport();

			const res = await authenticatedPost('/gui/reports/test-report/delete', {});
			expect(res.statusCode).toBe(302);
			expect(res.headers.location).toBe('/gui/reports');

			const report = await reportService.getReport('test-report');
			expect(report).toBeNull();
		});
	});

	// --- Toggle ---

	describe('POST /gui/reports/:id/toggle', () => {
		it('toggles report enabled state', async () => {
			await createReport();

			const res = await authenticatedPost('/gui/reports/test-report/toggle', {});
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');

			const report = await reportService.getReport('test-report');
			expect(report?.enabled).toBe(false);
		});

		it('returns 404 for nonexistent report', async () => {
			const res = await authenticatedPost('/gui/reports/nonexistent/toggle', {});
			expect(res.statusCode).toBe(404);
		});
	});

	// --- Preview ---

	describe('POST /gui/reports/:id/preview', () => {
		it('returns preview HTML', async () => {
			await createReport();

			const res = await authenticatedPost('/gui/reports/test-report/preview', {});
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(res.body).toContain('Preview');
			expect(res.body).toContain('Test Report');
		});

		it('returns not found for nonexistent report', async () => {
			const res = await authenticatedPost('/gui/reports/nonexistent/preview', {});
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Report not found');
		});

		it('does not send via Telegram', async () => {
			await createReport();
			await authenticatedPost('/gui/reports/test-report/preview', {});
			expect(telegram.send).not.toHaveBeenCalled();
		});
	});

	// --- History ---

	describe('GET /gui/reports/:id/history', () => {
		it('returns history page for existing report', async () => {
			await createReport();

			const res = await authenticatedGet('/gui/reports/test-report/history');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('Test Report');
		});

		it('returns 404 for nonexistent report', async () => {
			const res = await authenticatedGet('/gui/reports/nonexistent/history');
			expect(res.statusCode).toBe(404);
		});

		it('lists history files', async () => {
			await createReport();
			// Run the report to generate history
			await reportService.run('test-report');

			const res = await authenticatedGet('/gui/reports/test-report/history');
			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('.md');
		});
	});

	// --- History detail ---

	describe('GET /gui/reports/:id/history/:file', () => {
		it('returns history file content', async () => {
			await createReport();
			await reportService.run('test-report');

			// Find the history file
			const { readdir: rd } = await import('node:fs/promises');
			const historyDir = join(tempDir, 'system', 'report-history', 'test-report');
			const files = await rd(historyDir);
			const file = files.find((f) => f.endsWith('.md'));

			const res = await authenticatedGet(`/gui/reports/test-report/history/${file}`);
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toContain('text/html');
			expect(res.body).toContain('Test Report');
		});

		it('rejects path traversal in file name', async () => {
			await createReport();

			const res = await authenticatedGet(
				'/gui/reports/test-report/history/..%2F..%2Fetc%2Fpasswd.md',
			);
			expect(res.statusCode).toBe(400);
		});

		it('rejects non-.md files', async () => {
			const res = await authenticatedGet('/gui/reports/test-report/history/file.txt');
			expect(res.statusCode).toBe(400);
		});

		it('returns 404 for missing history file', async () => {
			const res = await authenticatedGet('/gui/reports/test-report/history/2026-01-01_000000.md');
			expect(res.statusCode).toBe(404);
		});
	});

	// --- XSS protection ---

	describe('XSS protection', () => {
		it('escapes HTML in toggle response', async () => {
			await reportService.saveReport({
				id: 'xss-test',
				name: 'XSS<script>alert(1)</script>',
				description: 'test',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123456789'],
				sections: [{ type: 'custom', label: 'X', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await authenticatedPost('/gui/reports/xss-test/toggle', {});
			expect(res.statusCode).toBe(200);
			// The ID should be escaped in the HTML output
			expect(res.body).not.toContain('<script>');
		});

		it('escapes HTML in preview response', async () => {
			await reportService.saveReport({
				id: 'xss-preview',
				name: '<img onerror=alert(1)>',
				description: 'test',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123456789'],
				sections: [{ type: 'custom', label: 'X', config: { text: '<b>bold</b>' } }],
				llm: { enabled: false },
			});

			const res = await authenticatedPost('/gui/reports/xss-preview/preview', {});
			expect(res.body).not.toContain('<img onerror');
			expect(res.body).toContain('&lt;img');
		});
	});
});
