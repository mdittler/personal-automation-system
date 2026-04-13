/**
 * Tests for D39 fix: GUI report form preserves space_id on round-trip.
 *
 * Verifies that:
 * - parseFormToReport correctly parses scope=space + space_id (no user_id)
 * - parseFormToReport correctly parses scope=user + user_id (no space_id)
 * - fallback: no scope field but space_id present → treated as space scope
 * - space dropdown renders when spaceService is provided
 * - API/YAML-created space-scoped report retains space_id after GUI edit
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToggleStore } from '../../../services/app-toggle/index.js';
import { ChangeLog } from '../../../services/data-store/change-log.js';
import { CronManager } from '../../../services/scheduler/cron-manager.js';
import { UserManager } from '../../../services/user-manager/index.js';
import { ReportService } from '../../../services/reports/index.js';
import { registerAuth } from '../../auth.js';
import { registerCsrfProtection } from '../../csrf.js';
import { registerReportRoutes } from '../reports.js';
import type { LLMService } from '../../../types/llm.js';
import type { TelegramService } from '../../../types/telegram.js';
import type { ContextStoreService } from '../../../types/context-store.js';

const AUTH_TOKEN = 'test-token-d39';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..', '..');
const viewsDir = join(moduleDir, 'views');

let tempDir: string;
let app: ReturnType<typeof Fastify>;
let reportService: ReportService;

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

async function buildApp(spaceService?: { listSpaces(): Array<{ id: string; name: string }> }) {
	const fastifyApp = Fastify({ logger: false });
	await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await fastifyApp.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	const userManager = new UserManager({
		config: { users: [{ id: '123', name: 'Alice', enabledApps: ['*'] }] } as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
	const cronManager = new CronManager(logger, 'UTC', tempDir);
	const rs = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore: { get: vi.fn(), search: vi.fn() } as unknown as ContextStoreService,
		llm: { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as unknown as LLMService,
		telegram: {
			send: vi.fn(),
			sendPhoto: vi.fn(),
			sendOptions: vi.fn(),
		} as unknown as TelegramService,
		userManager,
		cronManager,
		timezone: 'UTC',
		logger,
	});
	reportService = rs;

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerReportRoutes(gui, {
				reportService: rs,
				userManager,
				spaceService,
				dataDir: tempDir,
				timezone: 'UTC',
				logger,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
}

async function loginAndGetCsrf(targetApp: ReturnType<typeof Fastify>) {
	const loginRes = await targetApp.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const loginCookies = collectCookies(loginRes);

	const getRes = await targetApp.inject({
		method: 'GET',
		url: '/gui/reports',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return { cookies: allCookies, csrfToken };
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-report-d39-'));
});

afterEach(async () => {
	if (app) await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('D39: Report form space_id round-trip', () => {
	describe('scope=space parsing', () => {
		it('parses space scope — space_id set, user_id omitted', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			// Pre-create a report to enable the update path
			await reportService.saveReport({
				id: 'r1',
				name: 'R1',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await app.inject({
				method: 'POST',
				url: '/gui/reports/r1',
				payload: {
					_csrf: csrfToken,
					id: 'r1',
					name: 'Space Report',
					enabled: 'true',
					schedule: '0 9 * * 1',
					delivery: '123',
					section_type_0: 'app-data',
					section_label_0: 'My Section',
					section_app_id_0: 'notes',
					section_scope_0: 'space',
					section_space_id_0: 'family',
					section_path_0: 'notes.md',
					llm_enabled: 'false',
				},
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await reportService.getReport('r1');
			expect(saved).not.toBeNull();
			const section = saved!.sections[0];
			expect(section.type).toBe('app-data');
			expect((section.config as any).space_id).toBe('family');
			expect((section.config as any).user_id).toBeUndefined();
		});
	});

	describe('scope=user parsing', () => {
		it('parses user scope — user_id set, space_id omitted', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			await reportService.saveReport({
				id: 'r2',
				name: 'R2',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await app.inject({
				method: 'POST',
				url: '/gui/reports/r2',
				payload: {
					_csrf: csrfToken,
					id: 'r2',
					name: 'User Report',
					enabled: 'true',
					schedule: '0 9 * * 1',
					delivery: '123',
					section_type_0: 'app-data',
					section_label_0: 'My Section',
					section_app_id_0: 'notes',
					section_scope_0: 'user',
					section_user_id_0: '123',
					section_path_0: 'notes.md',
					llm_enabled: 'false',
				},
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await reportService.getReport('r2');
			expect(saved).not.toBeNull();
			const section = saved!.sections[0];
			expect((section.config as any).user_id).toBe('123');
			expect((section.config as any).space_id).toBeUndefined();
		});
	});

	describe('fallback scope detection', () => {
		it('treats as space scope when scope field absent but space_id present', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			await reportService.saveReport({
				id: 'r3',
				name: 'R3',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			// Omit section_scope_0 — only provide space_id (simulates old form submission)
			const res = await app.inject({
				method: 'POST',
				url: '/gui/reports/r3',
				payload: {
					_csrf: csrfToken,
					id: 'r3',
					name: 'Fallback Report',
					enabled: 'true',
					schedule: '0 9 * * 1',
					delivery: '123',
					section_type_0: 'app-data',
					section_label_0: 'My Section',
					section_app_id_0: 'notes',
					section_space_id_0: 'household',
					section_path_0: 'notes.md',
					llm_enabled: 'false',
				},
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await reportService.getReport('r3');
			const section = saved!.sections[0];
			expect((section.config as any).space_id).toBe('household');
			expect((section.config as any).user_id).toBeUndefined();
		});
	});

	describe('space dropdown', () => {
		it('edit page includes space options when spaceService is provided', async () => {
			const spaceService = { listSpaces: () => [{ id: 'family', name: 'Family' }] };
			app = await buildApp(spaceService);
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			await reportService.saveReport({
				id: 'r4',
				name: 'R4',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await app.inject({
				method: 'GET',
				url: '/gui/reports/r4/edit',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('family');
			expect(res.body).toContain('Family');
		});

		it('edit page renders without errors when spaceService is absent', async () => {
			app = await buildApp(); // no spaceService
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			await reportService.saveReport({
				id: 'r5',
				name: 'R5',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await app.inject({
				method: 'GET',
				url: '/gui/reports/r5/edit',
				cookies,
			});

			expect(res.statusCode).toBe(200);
		});
	});

	describe('D39 regression: API-created space-scoped report round-trip', () => {
		it('retains space_id after GUI edit and save', async () => {
			const spaceService = { listSpaces: () => [{ id: 'family', name: 'Family' }] };
			app = await buildApp(spaceService);
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			// Simulate an API/YAML-created space-scoped report
			await reportService.saveReport({
				id: 'space-report',
				name: 'Space Report',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [
					{
						type: 'app-data',
						label: 'Space Data',
						config: { app_id: 'notes', space_id: 'family', path: 'notes.md' } as any,
					},
				],
				llm: { enabled: false },
			});

			// Verify space_id in original
			const original = await reportService.getReport('space-report');
			expect((original!.sections[0].config as any).space_id).toBe('family');

			// Simulate user opening in GUI and saving (scope=space selected)
			const saveRes = await app.inject({
				method: 'POST',
				url: '/gui/reports/space-report',
				payload: {
					_csrf: csrfToken,
					id: 'space-report',
					name: 'Space Report',
					enabled: 'true',
					schedule: '0 9 * * 1',
					delivery: '123',
					section_type_0: 'app-data',
					section_label_0: 'Space Data',
					section_app_id_0: 'notes',
					section_scope_0: 'space',
					section_space_id_0: 'family',
					section_path_0: 'notes.md',
					llm_enabled: 'false',
				},
				cookies,
			});
			expect(saveRes.statusCode).toBe(302);

			// Verify space_id still present after round-trip
			const saved = await reportService.getReport('space-report');
			expect(saved).not.toBeNull();
			const section = saved!.sections[0];
			expect((section.config as any).space_id).toBe('family');
			expect((section.config as any).user_id).toBeUndefined();
		});
	});

	describe('D14: list route tolerance', () => {
		it('renders list page without crash when a structurally invalid report exists on disk', async () => {
			app = await buildApp();
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			// Write a structurally invalid report directly to disk (bypasses service validation)
			await mkdir(join(tempDir, 'system', 'reports'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'reports', 'bad-report.yaml'),
				'id: bad-report\nname: Bad Report\nenabled: true\n',
			);

			const res = await app.inject({
				method: 'GET',
				url: '/gui/reports',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('bad-report');
			// Validation warning badge is present
			expect(res.body).toContain('&#9888; Invalid');
		});
	});

	describe('D14: validation error banner', () => {
		it('edit page shows structural error banner for an invalid report', async () => {
			app = await buildApp();
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			// Write a structurally invalid report directly to disk
			await mkdir(join(tempDir, 'system', 'reports'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'reports', 'invalid-report.yaml'),
				'id: invalid-report\nname: Invalid Report\nenabled: true\n',
			);

			const res = await app.inject({
				method: 'GET',
				url: '/gui/reports/invalid-report/edit',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('structural errors');
		});
	});

	describe('D39: empty space_id edge case', () => {
		it('rejects empty space_id — re-renders form with validation error, no redirect', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			await reportService.saveReport({
				id: 'r6',
				name: 'R6',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				sections: [{ type: 'custom', label: 'Intro', config: { text: 'hello' } }],
				llm: { enabled: false },
			});

			const res = await app.inject({
				method: 'POST',
				url: '/gui/reports/r6',
				payload: {
					_csrf: csrfToken,
					id: 'r6',
					name: 'R6',
					enabled: 'true',
					schedule: '0 9 * * 1',
					delivery: '123',
					section_type_0: 'app-data',
					section_label_0: 'My Section',
					section_app_id_0: 'notes',
					section_scope_0: 'space',
					section_space_id_0: '', // empty space_id
					section_path_0: 'notes.md',
					llm_enabled: 'false',
				},
				cookies,
			});

			// Should re-render the form (not redirect)
			expect(res.statusCode).not.toBe(302);
			// Should contain space_id error, not the misleading user_id error
			expect(res.body).toContain('space_id');
			expect(res.body).not.toContain('user_id is required when space_id is not set');
		});
	});
});
