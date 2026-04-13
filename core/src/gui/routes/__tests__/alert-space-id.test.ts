/**
 * Tests for D39 fix: GUI alert form preserves space_id on round-trip.
 *
 * Verifies that:
 * - parseFormToAlert correctly parses ds_scope=space + ds_space_id (no user_id)
 * - parseFormToAlert correctly parses ds_scope=user + ds_user_id (no space_id)
 * - fallback: no scope field but space_id present → treated as space scope
 * - space dropdown renders when spaceService is provided
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
import { AlertService } from '../../../services/alerts/index.js';
import { ReportService } from '../../../services/reports/index.js';
import { registerAuth } from '../../auth.js';
import { registerCsrfProtection } from '../../csrf.js';
import { registerAlertRoutes } from '../alerts.js';
import type { LLMService } from '../../../types/llm.js';
import type { TelegramService } from '../../../types/telegram.js';
import type { ContextStoreService } from '../../../types/context-store.js';

const AUTH_TOKEN = 'test-token-d39-alert';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..', '..');
const viewsDir = join(moduleDir, 'views');

let tempDir: string;
let app: ReturnType<typeof Fastify>;
let alertService: AlertService;

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
	const llm = { complete: vi.fn(), classify: vi.fn(), extractStructured: vi.fn() } as unknown as LLMService;
	const telegram = { send: vi.fn(), sendPhoto: vi.fn(), sendOptions: vi.fn() } as unknown as TelegramService;
	const contextStore = { get: vi.fn(), search: vi.fn() } as unknown as ContextStoreService;
	const reportService = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore,
		llm,
		telegram,
		userManager,
		cronManager,
		timezone: 'UTC',
		logger,
	});
	const as = new AlertService({
		dataDir: tempDir,
		llm,
		telegram,
		userManager,
		cronManager,
		reportService,
		timezone: 'UTC',
		logger,
	});
	alertService = as;

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			await registerCsrfProtection(gui);
			registerAlertRoutes(gui, {
				alertService: as,
				userManager,
				spaceService,
				reportService,
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
		url: '/gui/alerts',
		cookies: loginCookies,
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return { cookies: allCookies, csrfToken };
}

function makeValidAlertPayload(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		id: 'test-alert',
		name: 'Test Alert',
		enabled: 'true',
		trigger_type: 'scheduled',
		schedule: '0 9 * * 1',
		delivery: '123',
		condition_type: 'deterministic',
		condition_expression: 'line count > 0',
		ds_app_id_0: 'notes',
		ds_scope_0: 'user',
		ds_user_id_0: '123',
		ds_path_0: 'notes.md',
		action_type_0: 'telegram_message',
		'action_message_0': 'Alert!',
		cooldown: '1 hour',
		...overrides,
	};
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-d39-'));
});

afterEach(async () => {
	if (app) await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('D39: Alert form space_id round-trip', () => {
	describe('scope=space parsing', () => {
		it('parses space scope — space_id set, user_id omitted', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			// Save the alert first with valid data so it exists for update path
			await alertService.saveAlert({
				id: 'test-alert',
				name: 'Test Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: { type: 'deterministic', expression: 'line count > 0', data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }] },
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			const payload = makeValidAlertPayload({
				ds_scope_0: 'space',
				ds_space_id_0: 'family',
			});
			// Remove user_id from payload (space mode doesn't submit it)
			delete (payload as any)['ds_user_id_0'];

			const res = await app.inject({
				method: 'POST',
				url: '/gui/alerts/test-alert',
				payload: { ...payload, _csrf: csrfToken },
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await alertService.getAlert('test-alert');
			expect(saved).not.toBeNull();
			const ds = saved!.condition.data_sources[0];
			expect(ds.space_id).toBe('family');
			expect(ds.user_id).toBeUndefined();
		});
	});

	describe('scope=user parsing', () => {
		it('parses user scope — user_id set, space_id omitted', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			await alertService.saveAlert({
				id: 'test-alert',
				name: 'Test Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: { type: 'deterministic', expression: 'line count > 0', data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }] },
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			const res = await app.inject({
				method: 'POST',
				url: '/gui/alerts/test-alert',
				payload: { ...makeValidAlertPayload(), _csrf: csrfToken },
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await alertService.getAlert('test-alert');
			expect(saved).not.toBeNull();
			const ds = saved!.condition.data_sources[0];
			expect(ds.user_id).toBe('123');
			expect(ds.space_id).toBeUndefined();
		});
	});

	describe('fallback scope detection', () => {
		it('treats as space scope when scope field absent but space_id present', async () => {
			app = await buildApp();
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			await alertService.saveAlert({
				id: 'test-alert',
				name: 'Test Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: { type: 'deterministic', expression: 'line count > 0', data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }] },
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			// No ds_scope_0, only ds_space_id_0
			const payload = { ...makeValidAlertPayload(), _csrf: csrfToken, ds_space_id_0: 'household' };
			delete (payload as any)['ds_scope_0'];
			delete (payload as any)['ds_user_id_0'];

			const res = await app.inject({
				method: 'POST',
				url: '/gui/alerts/test-alert',
				payload,
				cookies,
			});

			expect(res.statusCode).toBe(302);

			const saved = await alertService.getAlert('test-alert');
			const ds = saved!.condition.data_sources[0];
			expect(ds.space_id).toBe('household');
			expect(ds.user_id).toBeUndefined();
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

			await alertService.saveAlert({
				id: 'test-alert',
				name: 'Test Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: { type: 'deterministic', expression: 'line count > 0', data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }] },
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			const res = await app.inject({
				method: 'GET',
				url: '/gui/alerts/test-alert/edit',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('family');
			expect(res.body).toContain('Family');
		});
	});

	describe('D39 regression: API-created space-scoped alert round-trip', () => {
		it('retains space_id after GUI edit and save', async () => {
			const spaceService = { listSpaces: () => [{ id: 'family', name: 'Family' }] };
			app = await buildApp(spaceService);
			const { cookies, csrfToken } = await loginAndGetCsrf(app);

			// Simulate an API/YAML-created space-scoped alert
			await alertService.saveAlert({
				id: 'space-alert',
				name: 'Space Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: {
					type: 'deterministic',
					expression: 'line count > 0',
					data_sources: [{ app_id: 'notes', space_id: 'family', path: 'notes.md' }],
				},
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			// Verify space_id in original
			const original = await alertService.getAlert('space-alert');
			expect((original!.condition.data_sources[0] as any).space_id).toBe('family');

			// Simulate user opening in GUI and saving (scope=space selected)
			const saveRes = await app.inject({
				method: 'POST',
				url: '/gui/alerts/space-alert',
				payload: {
					_csrf: csrfToken,
					id: 'space-alert',
					name: 'Space Alert',
					enabled: 'true',
					trigger_type: 'scheduled',
					schedule: '0 9 * * 1',
					delivery: '123',
					condition_type: 'deterministic',
					condition_expression: 'line count > 0',
					ds_app_id_0: 'notes',
					ds_scope_0: 'space',
					ds_space_id_0: 'family',
					ds_path_0: 'notes.md',
					action_type_0: 'telegram_message',
					action_message_0: 'Alert!',
					cooldown: '1 hour',
				},
				cookies,
			});
			expect(saveRes.statusCode).toBe(302);

			// Verify space_id still present after round-trip
			const saved = await alertService.getAlert('space-alert');
			expect(saved).not.toBeNull();
			const ds = saved!.condition.data_sources[0];
			expect(ds.space_id).toBe('family');
			expect(ds.user_id).toBeUndefined();
		});
	});

	describe('D14: list route tolerance', () => {
		it('renders list page without crash when a structurally invalid alert exists on disk', async () => {
			app = await buildApp();
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			// Write a structurally invalid alert directly to disk (bypasses service validation)
			await mkdir(join(tempDir, 'system', 'alerts'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'alerts', 'bad-alert.yaml'),
				'id: bad-alert\nname: Bad Alert\nenabled: true\n',
			);

			const res = await app.inject({
				method: 'GET',
				url: '/gui/alerts',
				cookies,
			});

			expect(res.statusCode).toBe(200);
			expect(res.body).toContain('bad-alert');
			// Validation warning badge is present
			expect(res.body).toContain('&#9888; Invalid');
		});
	});

	describe('D14: validation error banner', () => {
		it('edit page shows structural error banner for an invalid alert', async () => {
			app = await buildApp();
			const loginRes = await app.inject({
				method: 'POST',
				url: '/gui/login',
				payload: { token: AUTH_TOKEN },
			});
			const cookies = collectCookies(loginRes);

			// Write a structurally invalid alert directly to disk
			await mkdir(join(tempDir, 'system', 'alerts'), { recursive: true });
			await writeFile(
				join(tempDir, 'system', 'alerts', 'invalid-alert.yaml'),
				'id: invalid-alert\nname: Invalid Alert\nenabled: true\n',
			);

			const res = await app.inject({
				method: 'GET',
				url: '/gui/alerts/invalid-alert/edit',
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

			await alertService.saveAlert({
				id: 'test-alert',
				name: 'Test Alert',
				enabled: true,
				schedule: '0 9 * * 1',
				delivery: ['123'],
				condition: { type: 'deterministic', expression: 'line count > 0', data_sources: [{ app_id: 'notes', user_id: '123', path: 'notes.md' }] },
				actions: [{ type: 'telegram_message', config: { message: 'Alert!' } }],
				cooldown: '1 hour',
			});

			const res = await app.inject({
				method: 'POST',
				url: '/gui/alerts/test-alert',
				payload: {
					...makeValidAlertPayload({
						ds_scope_0: 'space',
						ds_space_id_0: '', // empty space_id
					}),
					_csrf: csrfToken,
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
