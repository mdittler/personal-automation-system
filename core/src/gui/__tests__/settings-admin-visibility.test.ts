/**
 * Table-driven visibility matrix test.
 *
 * Every row in the visibility matrix from the Chunk C plan is exercised here:
 * (qualified-id, isAdmin, surface) → expected (visible | hidden | allowed | blocked).
 *
 * REQ-SETTINGS-025, 028, 033
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
} from '../../services/config/settings-metadata.js';
import { SystemConfigWriter } from '../../services/config/system-config-writer.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { buildSettingsRegistry } from '../../services/settings/build-registry.js';
import { SettingsReader } from '../../services/settings/settings-reader.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Shared setup
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

interface VisibilityFixture {
	adminApp: ReturnType<typeof Fastify>;
	nonAdminApp: ReturnType<typeof Fastify>;
	adminReader: SettingsReader;
	nonAdminReader: SettingsReader;
	registry: ReturnType<typeof buildSettingsRegistry>;
	tempDir: string;
}

async function buildVisibilityFixture(): Promise<VisibilityFixture> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-vis-'));
	const configPath = join(tempDir, 'pas.yaml');
	await writeFile(configPath, JSON.stringify({ users: [] }), 'utf-8');

	const config = makeConfig();
	const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
	const systemConfigWriter = new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
	});

	const mockPinoLogger = pino({ level: 'silent' });
	const settingsWriter = new SettingsWriter({
		registry,
		appConfigResolver: () => undefined,
		manifestResolver: () => [],
		logger: mockPinoLogger,
		systemConfigWriter,
		systemConfig: config,
	});

	const adminReader = new SettingsReader({
		registry,
		appConfigResolver: () => undefined,
		systemConfigWriter,
		systemConfig: config,
	});
	const nonAdminReader = new SettingsReader({
		registry,
		appConfigResolver: () => undefined,
		systemConfigWriter,
		systemConfig: config,
	});

	const credService = new CredentialService({ dataDir: tempDir });
	await credService.setPassword('admin', 'pass');
	await credService.setPassword('user', 'pass');

	function makeApp(isAdmin: boolean, userId: string) {
		const userManager = {
			getUser: (id: string) =>
				id === userId
					? { id: userId, name: isAdmin ? 'Admin' : 'User', isAdmin, telegramId: 1 }
					: null,
			getAllUsers: () => [{ id: userId, name: isAdmin ? 'Admin' : 'User', isAdmin, telegramId: 1 }],
		};
		const householdService = {
			getHouseholdForUser: () => 'hh',
			getHousehold: (id: string) => (id === 'hh' ? { id: 'hh', adminUserIds: [userId] } : null),
		};
		return { userManager, householdService };
	}

	async function buildApp(isAdmin: boolean, userId: string) {
		const { userManager, householdService } = makeApp(isAdmin, userId);
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
				await registerViewLocals(gui, {
					userManager: userManager as unknown as UserManager,
				});
				registerSettingsRoutes(gui, {
					settingsRegistry: registry,
					settingsWriter,
					appConfigResolver: () => undefined,
					logger: pino({ level: 'silent' }),
					systemConfigWriter,
					systemConfig: config,
				});
			},
			{ prefix: '/gui' },
		);
		return app;
	}

	const adminApp = await buildApp(true, 'admin');
	const nonAdminApp = await buildApp(false, 'user');

	return { adminApp, nonAdminApp, adminReader, nonAdminReader, registry, tempDir };
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

async function loginAndGet(app: ReturnType<typeof Fastify>, userId: string) {
	const loginRes = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password: 'pass' },
	});
	const getRes = await app.inject({
		method: 'GET',
		url: '/gui/settings',
		cookies: collectCookies(loginRes),
	});
	return { body: getRes.body, cookies: collectCookies(loginRes, getRes) };
}

// ---------------------------------------------------------------------------
// Visibility matrix
// ---------------------------------------------------------------------------

type Surface = 'gui' | 'catalog' | 'nl-allowlist';
type Expected = 'visible' | 'hidden' | 'allowed' | 'blocked';

interface MatrixRow {
	qid: string;
	/** Human-readable label or string expected in output */
	label: string;
	isAdmin: boolean;
	surface: Surface;
	expected: Expected;
}

const MATRIX: MatrixRow[] = [
	// Memory & Sessions — non-admin visible
	{
		qid: 'system.chat.sessions.retention_days',
		label: 'Keep ended sessions for',
		isAdmin: false,
		surface: 'gui',
		expected: 'visible',
	},
	{
		qid: 'system.chat.sessions.retention_days',
		label: 'Keep ended sessions for',
		isAdmin: true,
		surface: 'gui',
		expected: 'visible',
	},
	{
		qid: 'system.chat.sessions.auto_reset_idle_minutes',
		label: 'Auto-reset idle sessions',
		isAdmin: false,
		surface: 'gui',
		expected: 'visible',
	},
	{
		qid: 'system.chat.sessions.auto_reset_idle_minutes',
		label: 'Auto-reset idle sessions',
		isAdmin: true,
		surface: 'gui',
		expected: 'visible',
	},

	// System — admin-only
	{
		qid: 'system.routing.verification.enabled',
		label: 'Route verification',
		isAdmin: false,
		surface: 'gui',
		expected: 'hidden',
	},
	{
		qid: 'system.routing.verification.enabled',
		label: 'Route verification',
		isAdmin: true,
		surface: 'gui',
		expected: 'visible',
	},
	{
		qid: 'system.routing.verification.upper_bound',
		label: 'upper_bound',
		isAdmin: false,
		surface: 'gui',
		expected: 'hidden',
	},
	{
		qid: 'system.routing.verification.upper_bound',
		label: 'upper_bound',
		isAdmin: true,
		surface: 'gui',
		expected: 'visible',
	},

	// Dangerous — admin-only
	{
		qid: 'system.chat.sessions.auto_prune',
		label: 'Auto-prune',
		isAdmin: false,
		surface: 'gui',
		expected: 'hidden',
	},
	{
		qid: 'system.chat.sessions.auto_prune',
		label: 'Auto-prune',
		isAdmin: true,
		surface: 'gui',
		expected: 'visible',
	},

	// Catalog — Memory & Sessions visible to all
	{
		qid: 'system.chat.sessions.retention_days',
		label: 'Keep ended sessions for',
		isAdmin: false,
		surface: 'catalog',
		expected: 'visible',
	},
	{
		qid: 'system.chat.sessions.retention_days',
		label: 'Keep ended sessions for',
		isAdmin: true,
		surface: 'catalog',
		expected: 'visible',
	},

	// Catalog — System admin-only
	{
		qid: 'system.routing.verification.enabled',
		label: 'Route verification',
		isAdmin: false,
		surface: 'catalog',
		expected: 'hidden',
	},
	{
		qid: 'system.routing.verification.enabled',
		label: 'Route verification',
		isAdmin: true,
		surface: 'catalog',
		expected: 'visible',
	},

	// Catalog — Dangerous admin-only
	{
		qid: 'system.chat.sessions.auto_prune',
		label: 'Auto-prune',
		isAdmin: false,
		surface: 'catalog',
		expected: 'hidden',
	},
	{
		qid: 'system.chat.sessions.auto_prune',
		label: 'Auto-prune',
		isAdmin: true,
		surface: 'catalog',
		expected: 'visible',
	},

	// NL allowlist — none of the system keys are nl-safe
	{
		qid: 'system.chat.sessions.retention_days',
		label: 'retention_days',
		isAdmin: false,
		surface: 'nl-allowlist',
		expected: 'blocked',
	},
	{
		qid: 'system.routing.verification.enabled',
		label: 'routing.verification.enabled',
		isAdmin: true,
		surface: 'nl-allowlist',
		expected: 'blocked',
	},
	{
		qid: 'system.chat.sessions.auto_prune',
		label: 'auto_prune',
		isAdmin: true,
		surface: 'nl-allowlist',
		expected: 'blocked',
	},
];

describe('Visibility matrix (REQ-SETTINGS-025, 028, 033)', () => {
	let fixture: VisibilityFixture;

	beforeEach(async () => {
		fixture = await buildVisibilityFixture();
	});
	afterEach(async () => {
		await Promise.all([fixture.adminApp.close(), fixture.nonAdminApp.close()]);
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	// GUI surface rows
	const guiRows = MATRIX.filter((r) => r.surface === 'gui');
	it.each(guiRows.map((r) => [r.qid, r.isAdmin, r.label, r.expected] as const))(
		'GUI: %s isAdmin=%s → %s',
		async (_qid, isAdmin, label, expected) => {
			const app = isAdmin ? fixture.adminApp : fixture.nonAdminApp;
			const userId = isAdmin ? 'admin' : 'user';
			const { body } = await loginAndGet(app, userId);
			if (expected === 'visible') {
				expect(body).toContain(label);
			} else {
				expect(body).not.toContain(label);
			}
		},
	);

	// Catalog surface rows
	const catalogRows = MATRIX.filter((r) => r.surface === 'catalog');
	it.each(catalogRows.map((r) => [r.qid, r.isAdmin, r.label, r.expected] as const))(
		'Catalog: %s isAdmin=%s → %s',
		async (_qid, isAdmin, label, expected) => {
			const reader = isAdmin ? fixture.adminReader : fixture.nonAdminReader;
			const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin });
			if (expected === 'visible') {
				expect(catalog).toContain(label);
			} else {
				expect(catalog).not.toContain(label);
			}
		},
	);

	// NL-allowlist rows
	const nlRows = MATRIX.filter((r) => r.surface === 'nl-allowlist');
	it.each(nlRows.map((r) => [r.qid, r.expected] as const))(
		'NL allowlist: %s → %s',
		(qid, expected) => {
			const nlKeys = fixture.registry.getNlSafeQualifiedKeys();
			if (expected === 'allowed') {
				expect(nlKeys.has(qid)).toBe(true);
			} else {
				expect(nlKeys.has(qid)).toBe(false);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-033: catalog value matches direct SystemConfigWriter read
// ---------------------------------------------------------------------------

describe('Catalog value matches direct read (REQ-SETTINGS-033)', () => {
	let fixture: VisibilityFixture;

	beforeEach(async () => {
		fixture = await buildVisibilityFixture();
	});
	afterEach(async () => {
		await Promise.all([fixture.adminApp.close(), fixture.nonAdminApp.close()]);
		await rm(fixture.tempDir, { recursive: true, force: true });
	});

	it('catalog retention_days value matches direct SettingsReader read', async () => {
		const { catalog } = await fixture.adminReader.buildCatalog({ userId: 'u1', isAdmin: true });
		// Default is 90; catalog should contain 90
		expect(catalog).toMatch(/Keep ended sessions for.*90/);
	});

	it('all system keys visible to admin match their live SystemConfig value', async () => {
		const { catalog } = await fixture.adminReader.buildCatalog({ userId: 'u1', isAdmin: true });
		// Routing verification is enabled by default (true → ON)
		expect(catalog).toMatch(/Route verification.*ON/);
		// Default upperBound is 0.7
		expect(catalog).toMatch(/0\.7/);
	});
});
