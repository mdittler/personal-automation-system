/**
 * System-scope settings GUI route tests.
 *
 * Tests admin visibility, restart-required badge, server-side dangerous tampering
 * check, system-scope reads/writes via SystemConfigWriter, and reset flow.
 *
 * REQ-SETTINGS-022, 023, 025, 031, 034, 035, 036
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
} from '../../services/config/settings-metadata.js';
import { SystemConfigWriter } from '../../services/config/system-config-writer.js';
import { CredentialService } from '../../services/credentials/index.js';
import { buildSettingsRegistry } from '../../services/settings/build-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'tok' },
		claude: { apiKey: '', model: 'm' },
		cloudflare: {},
		llm: {
			providers: {},
			tiers: {
				fast: { provider: 'claude', model: 'm' },
				standard: { provider: 'claude', model: 'm' },
			},
		},
		gui: { authToken: 'tok' },
		api: { token: '' },
		n8n: { dispatchUrl: '' },
		routing: { verification: { enabled: true, upperBound: 0.7 } },
		users: [],
		webhooks: [],
		backup: { enabled: false, path: '/tmp/backups', schedule: '0 3 * * *', retentionCount: 7 },
		chat: {
			logToNotes: false,
			memory: { strict_durable_kinds: false },
			sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
			recall: { max_window_days: 365 },
		},
	} as unknown as SystemConfig;
}

async function writeSeedYaml(
	tempDir: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const p = join(tempDir, 'pas.yaml');
	await writeFile(p, JSON.stringify({ users: [], ...extra }), 'utf-8');
	return p;
}

interface TestSetup {
	app: ReturnType<typeof Fastify>;
	config: SystemConfig;
	tempDir: string;
	configPath: string;
}

async function buildTestServer(opts: {
	isAdmin: boolean;
	configOverride?: Partial<SystemConfig>;
}): Promise<TestSetup> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-sys-gui-'));
	const configPath = await writeSeedYaml(tempDir);

	const config = { ...makeConfig(), ...opts.configOverride };
	const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });

	const systemConfigWriter = new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
	});

	const mockLogger = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	const settingsWriter = new SettingsWriter({
		registry,
		appConfigResolver: () => undefined,
		manifestResolver: () => [],
		logger: mockLogger as unknown as import('pino').Logger,
		systemConfigWriter,
		systemConfig: config as SystemConfig,
	});

	const credService = new CredentialService({ dataDir: tempDir });
	const TEST_USER_ID = 'admin1';
	const TEST_PASSWORD = 'test-pass-123';
	await credService.setPassword(TEST_USER_ID, TEST_PASSWORD);

	const userManager = {
		getUser: (id: string) =>
			id === TEST_USER_ID
				? { id: TEST_USER_ID, name: 'AdminUser', isAdmin: opts.isAdmin, telegramId: 1 }
				: null,
		getAllUsers: () => [
			{ id: TEST_USER_ID, name: 'AdminUser', isAdmin: opts.isAdmin, telegramId: 1 },
		],
	};

	const householdService = {
		getHouseholdForUser: (_id: string) => 'hh-1',
		getHousehold: (id: string) =>
			id === 'hh-1' ? { id: 'hh-1', adminUserIds: [TEST_USER_ID] } : null,
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
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
				householdService: householdService as unknown as import('../../services/household/index.js').HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, {
				userManager: userManager as unknown as import('../../services/user-manager/index.js').UserManager,
			});
			registerSettingsRoutes(gui, {
				settingsRegistry: registry,
				settingsWriter,
				appConfigResolver: () => undefined,
				logger,
				systemConfigWriter,
				systemConfig: config as SystemConfig,
			});
		},
		{ prefix: '/gui' },
	);

	return { app, config: config as SystemConfig, tempDir, configPath };
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

async function login(app: ReturnType<typeof Fastify>) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId: 'admin1', password: 'test-pass-123' },
	});
	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/settings',
		cookies: collectCookies(loginRes),
	});
	const allCookies = collectCookies(loginRes, getRes);
	const metaMatch = getRes.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	return { allCookies, csrfToken };
}

// ---------------------------------------------------------------------------
// REQ-SETTINGS-025: non-admin vs admin visibility
// ---------------------------------------------------------------------------

describe('Admin/non-admin category visibility (REQ-SETTINGS-025)', () => {
	let nonAdminSetup: TestSetup;
	let adminSetup: TestSetup;

	beforeEach(async () => {
		[nonAdminSetup, adminSetup] = await Promise.all([
			buildTestServer({ isAdmin: false }),
			buildTestServer({ isAdmin: true }),
		]);
	});

	afterEach(async () => {
		await Promise.all([
			nonAdminSetup.app
				.close()
				.then(() => rm(nonAdminSetup.tempDir, { recursive: true, force: true })),
			adminSetup.app.close().then(() => rm(adminSetup.tempDir, { recursive: true, force: true })),
		]);
	});

	it('non-admin GET /gui/settings: no System or Dangerous accordion', async () => {
		const { allCookies } = await login(nonAdminSetup.app);
		const res = await nonAdminSetup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		// No dangerous/system accordions
		expect(res.body).not.toContain('Dangerous');
		expect(res.body).not.toMatch(/System-wide settings/);
		expect(res.body).not.toContain('routing.verification');
		expect(res.body).not.toContain('auto_prune');
	});

	it('non-admin GET: Memory & Sessions accordion IS present', async () => {
		const { allCookies } = await login(nonAdminSetup.app);
		const res = await nonAdminSetup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Memory &amp; Sessions');
		expect(res.body).toContain('Keep ended sessions for');
	});

	it('admin GET /gui/settings: System and Dangerous accordions present', async () => {
		const { allCookies } = await login(adminSetup.app);
		const res = await adminSetup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('System-wide settings');
		expect(res.body).toContain('Dangerous');
		expect(res.body).toContain('routing.verification');
	});

	it('admin GET: auto_prune visible in Dangerous section', async () => {
		const { allCookies } = await login(adminSetup.app);
		const res = await adminSetup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.body).toContain('auto_prune');
		expect(res.body).toContain('Auto-prune');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-031: restart-required badge
// ---------------------------------------------------------------------------

describe('Restart-required badge (REQ-SETTINGS-031)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('restart badge present for routing.verification.enabled', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		expect(res.body).toContain('restart-badge');
		// routing.verification.enabled has restartRequired: true
		expect(res.body).toContain('Restart required');
	});

	it('restart badge absent for auto_reset_idle_minutes', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: allCookies,
		});
		// The auto_reset_idle_minutes row should not have restart badge
		// (restartRequired: false). We check that the badge text appears
		// fewer times than the number of restartRequired=true keys.
		const badgeCount = (res.body.match(/Restart required/g) ?? []).length;
		// Only restartRequired:true keys should have badges
		const requiredCount = SYSTEM_SETTING_DEFS.filter((d) => d.restartRequired).length;
		expect(badgeCount).toBe(requiredCount);
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-022 + REQ-SETTINGS-023: admin system write via single-form POST
// ---------------------------------------------------------------------------

describe('Admin system write via single-form POST', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('admin saves retention_days=180 → persists to YAML and in-memory', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				'system__chat.sessions.retention_days__present': '1',
				'system__chat.sessions.retention_days': '180',
			},
		});

		// PRG redirect on success
		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');

		// In-memory config updated
		expect((setup.config.chat as Record<string, unknown>).sessions).toMatchObject(
			expect.objectContaining({ retention_days: 180 }),
		);

		// YAML on disk updated
		const raw = await readFile(setup.configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed['chat'] as Record<string, unknown>)['sessions'] as Record<string, unknown>)[
				'retention_days'
			],
		).toBe(180);
	});

	it('admin saves routing.verification.enabled=false → persists', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				// Boolean: present sentinel present, no value field → false
				'system__routing.verification.enabled__present': '1',
			},
		});

		expect(res.statusCode).toBe(302);

		// In-memory
		expect((setup.config.routing as Record<string, unknown>).verification).toMatchObject(
			expect.objectContaining({ enabled: false }),
		);
	});

	it('system settings appear in GET after write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				'system__chat.sessions.retention_days__present': '1',
				'system__chat.sessions.retention_days': '365',
			},
		});

		// Re-login to get fresh cookies after redirect
		const { allCookies: fresh } = await login(setup.app);
		const getRes = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings',
			cookies: fresh,
		});
		expect(getRes.body).toContain('365');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-035: dangerous tampering check — single-form POST rejects dangerous
// ---------------------------------------------------------------------------

describe('Dangerous tampering check (REQ-SETTINGS-035)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('POST /gui/settings with dangerous field in body → 400', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				// system.chat.sessions.auto_prune is dangerous
				'system__chat.sessions.auto_prune__present': '1',
				'system__chat.sessions.auto_prune': 'true',
			},
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('confirm flow');
	});

	it('dangerous tampering does not modify pas.yaml', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const before = await readFile(setup.configPath, 'utf-8');

		await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				'system__chat.sessions.auto_prune__present': '1',
				'system__chat.sessions.auto_prune': 'true',
			},
		});

		const after = await readFile(setup.configPath, 'utf-8');
		expect(parse(after)).toEqual(parse(before));
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-034 + REQ-SETTINGS-036: reset endpoint
// ---------------------------------------------------------------------------

describe('Reset endpoint', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('admin resets system non-dangerous key → removes from YAML; row HTML returned', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		// First write a value
		await setup.app.inject({
			method: 'POST',
			url: '/gui/settings',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				'system__chat.sessions.retention_days__present': '1',
				'system__chat.sessions.retention_days': '365',
			},
		});

		// Re-read CSRF (cookies change after PRG)
		const { allCookies: fresh2, csrfToken: csrf2 } = await login(setup.app);

		// Now reset
		const resetRes = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.retention_days/reset',
			cookies: fresh2,
			payload: { _csrf: csrf2 },
		});

		expect(resetRes.statusCode).toBe(200);
		expect(resetRes.headers['content-type']).toContain('text/html');
		// Should contain default value (90)
		expect(resetRes.body).toContain('90');

		// YAML key removed
		const raw = await readFile(setup.configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		const sessions = ((parsed['chat'] as Record<string, unknown>)?.['sessions'] ?? {}) as Record<
			string,
			unknown
		>;
		expect('retention_days' in sessions).toBe(false);
	});

	it('non-admin reset of system adminOnly key → 403', async () => {
		const nonAdmin = await buildTestServer({ isAdmin: false });
		try {
			const { allCookies: naCookies, csrfToken: naCsrf } = await login(nonAdmin.app);
			const res = await nonAdmin.app.inject({
				method: 'POST',
				url: '/gui/settings/system/routing.verification.enabled/reset',
				cookies: naCookies,
				payload: { _csrf: naCsrf },
			});
			expect(res.statusCode).toBe(403);
		} finally {
			await nonAdmin.app.close();
			await rm(nonAdmin.tempDir, { recursive: true, force: true });
		}
	});

	it('admin direct POST reset of dangerous key → 403 (must use confirm flow)', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/reset',
			cookies: allCookies,
			payload: { _csrf: csrfToken },
		});

		expect(res.statusCode).toBe(403);
		expect(res.body).toContain('confirm flow');
	});

	it('reset of unknown key → 404', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/nonexistent-key/reset',
			cookies: allCookies,
			payload: { _csrf: csrfToken },
		});
		expect(res.statusCode).toBe(404);
	});
});

// REQ-SETTINGS-032 (food pseudo-field deletion) is verified in C.6 after
// the manifest entries are removed from apps/food/manifest.yaml.
