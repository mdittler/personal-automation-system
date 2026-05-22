/**
 * Confirm flow route tests — GET/POST /gui/settings/:appId/:key/confirm.
 *
 * REQ-SETTINGS-026: admin-only auth + CSRF on POST.
 * REQ-SETTINGS-027: timing-safe phrase match; mismatch returns 403 with no write.
 * REQ-SETTINGS-034: dangerous resets require confirm flow.
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
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
} from '../../services/config/settings-metadata.js';
import { SystemConfigWriter } from '../../services/config/system-config-writer.js';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import { buildSettingsRegistry } from '../../services/settings/build-registry.js';
import { SettingsWriter } from '../../services/settings/settings-writer.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { AppConfigService, SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** dangerConfirmPrompt for system.chat.sessions.auto_prune */
const AUTO_PRUNE_PROMPT = 'permanently delete expired transcripts';

/** A mock per-user dangerous setting key for testing per-user dangerous resets */
const MOCK_PER_USER_DANGEROUS_KEY = 'dangerous-toggle';
const MOCK_PER_USER_DANGEROUS_PROMPT = 'enable test danger';
const MOCK_APP_ID = 'testapp';

// ---------------------------------------------------------------------------
// Test helpers
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

async function writeSeedYaml(tempDir: string): Promise<string> {
	const p = join(tempDir, 'pas.yaml');
	await writeFile(p, JSON.stringify({ users: [] }), 'utf-8');
	return p;
}

interface SetupOpts {
	isAdmin: boolean;
	/** Override for per-user AppConfigService resolution. */
	mockAppConfigService?: AppConfigService;
}

interface TestSetup {
	app: ReturnType<typeof Fastify>;
	config: SystemConfig;
	tempDir: string;
	configPath: string;
}

async function buildTestServer(opts: SetupOpts): Promise<TestSetup> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-confirm-'));
	const configPath = await writeSeedYaml(tempDir);
	const config = makeConfig();

	const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });

	// Register a mock per-user dangerous setting for per-user confirm tests.
	registry.register({
		appId: MOCK_APP_ID,
		key: MOCK_PER_USER_DANGEROUS_KEY,
		category: 'dangerous',
		label: 'Test Dangerous Toggle',
		help: 'A test dangerous per-user toggle',
		type: 'boolean',
		default: false,
		adminOnly: true,
		dangerous: true,
		dangerConfirmPrompt: MOCK_PER_USER_DANGEROUS_PROMPT,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});

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
		appConfigResolver: opts.mockAppConfigService
			? (appId: string) => (appId === MOCK_APP_ID ? opts.mockAppConfigService : undefined)
			: () => undefined,
		manifestResolver: () => [],
		logger: mockLogger as unknown as Logger,
		systemConfigWriter,
		systemConfig: config as SystemConfig,
	});

	const credService = new CredentialService({ dataDir: tempDir });
	const TEST_USER_ID = 'admin1';
	await credService.setPassword(TEST_USER_ID, 'test-pass-123');

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
		getHouseholdForUser: () => 'hh-1',
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
				appConfigResolver: opts.mockAppConfigService
					? (appId: string) => (appId === MOCK_APP_ID ? opts.mockAppConfigService : undefined)
					: () => undefined,
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
// REQ-SETTINGS-026: auth requirements
// ---------------------------------------------------------------------------

describe('Auth requirements (REQ-SETTINGS-026)', () => {
	let adminSetup: TestSetup;
	let nonAdminSetup: TestSetup;

	beforeEach(async () => {
		[adminSetup, nonAdminSetup] = await Promise.all([
			buildTestServer({ isAdmin: true }),
			buildTestServer({ isAdmin: false }),
		]);
	});

	afterEach(async () => {
		await Promise.all([
			adminSetup.app.close().then(() => rm(adminSetup.tempDir, { recursive: true, force: true })),
			nonAdminSetup.app
				.close()
				.then(() => rm(nonAdminSetup.tempDir, { recursive: true, force: true })),
		]);
	});

	it('non-admin GET /confirm → 403', async () => {
		const { allCookies } = await login(nonAdminSetup.app);
		const res = await nonAdminSetup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm?action=set&value=true',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('non-admin POST /confirm → 403', async () => {
		const { allCookies, csrfToken } = await login(nonAdminSetup.app);
		const res = await nonAdminSetup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				action: 'set',
				phrase: AUTO_PRUNE_PROMPT,
				value: 'true',
			},
		});
		expect(res.statusCode).toBe(403);
	});

	it('admin POST /confirm without CSRF → 403', async () => {
		const { allCookies } = await login(adminSetup.app);
		// POST without _csrf body field
		const res = await adminSetup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			// Deliberately omit _csrf
			payload: {
				action: 'set',
				phrase: AUTO_PRUNE_PROMPT,
				value: 'true',
			},
		});
		expect(res.statusCode).toBe(403);
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-026: GET modal renders correctly
// ---------------------------------------------------------------------------

describe('GET /confirm modal (REQ-SETTINGS-026)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('returns modal HTML with danger prompt, value, and CSRF field', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm?action=set&value=true',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		// Dialog element (no layout wrapper)
		expect(res.body).toContain('<dialog open>');
		// Danger prompt visible
		expect(res.body).toContain('permanently delete expired transcripts');
		// Proposed value visible
		expect(res.body).toContain('<code>true</code>');
		// CSRF field present
		expect(res.body).toContain('name="_csrf"');
		// phrase input
		expect(res.body).toContain('name="phrase"');
	});

	it('modal for reset action shows "reset to default" (no value shown)', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm?action=reset',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('reset to default');
		expect(res.body).not.toContain('Proposed new value');
	});

	it('GET /confirm for non-dangerous key → 400', async () => {
		const { allCookies } = await login(setup.app);
		// routing.verification.enabled is adminOnly but NOT dangerous
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/routing.verification.enabled/confirm?action=set&value=false',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(400);
	});

	it('GET /confirm for unknown key → 404', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/nonexistent-key/confirm?action=set',
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(404);
	});

	it('modal HTML is not wrapped in page layout (no nav, no title tag)', async () => {
		const { allCookies } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'GET',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm?action=set&value=true',
			cookies: allCookies,
		});
		// The partial should not include the full HTML layout
		expect(res.body).not.toContain('<title>');
		expect(res.body).not.toContain('<nav');
	});

	it('XSS in dangerConfirmPrompt is escaped (REQ-SETTINGS-027 output encoding)', async () => {
		// auto_prune prompt doesn't have XSS content, but we can verify escaping
		// on the proposed value field which could contain user input
		const { allCookies } = await login(setup.app);
		const xssValue = '</code><script>alert(1)</script>';
		const res = await setup.app.inject({
			method: 'GET',
			url: `/gui/settings/system/chat.sessions.auto_prune/confirm?action=set&value=${encodeURIComponent(xssValue)}`,
			cookies: allCookies,
		});
		expect(res.statusCode).toBe(200);
		// The raw script tag must NOT appear unescaped
		expect(res.body).not.toContain('<script>alert(1)</script>');
		// The value should appear HTML-escaped
		expect(res.body).toContain('&lt;/code&gt;');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-027: phrase match — happy path
// ---------------------------------------------------------------------------

describe('POST /confirm — exact phrase match (REQ-SETTINGS-027)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('correct phrase for set (system dangerous) → redirect + YAML updated', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				action: 'set',
				phrase: AUTO_PRUNE_PROMPT,
				value: 'true',
			},
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');

		// In-memory config updated
		expect((setup.config.chat as Record<string, unknown>).sessions).toMatchObject(
			expect.objectContaining({ auto_prune: true }),
		);

		// YAML on disk updated
		const raw = await readFile(setup.configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		const sessions = ((parsed.chat as Record<string, unknown>)?.sessions ?? {}) as Record<
			string,
			unknown
		>;
		expect(sessions.auto_prune).toBe(true);
	});

	it('correct phrase for reset (system dangerous) → redirect + key removed from YAML', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		// First write auto_prune = true
		await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: { _csrf: csrfToken, action: 'set', phrase: AUTO_PRUNE_PROMPT, value: 'true' },
		});

		// Re-login for fresh CSRF
		const { allCookies: fresh, csrfToken: freshCsrf } = await login(setup.app);

		// Now reset via confirm
		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: fresh,
			payload: { _csrf: freshCsrf, action: 'reset', phrase: AUTO_PRUNE_PROMPT },
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');

		// Key should be absent from YAML (reset to schema default)
		const raw = await readFile(setup.configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		const sessions = ((parsed.chat as Record<string, unknown>)?.sessions ?? {}) as Record<
			string,
			unknown
		>;
		expect('auto_prune' in sessions).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-027: phrase match — mismatch cases → 403, no write
// ---------------------------------------------------------------------------

describe('POST /confirm — phrase mismatch (REQ-SETTINGS-027)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	async function postConfirmAndCheck(
		app: ReturnType<typeof Fastify>,
		allCookies: Record<string, string>,
		csrfToken: string,
		phrase: string,
	) {
		const yamlBefore = await readFile(setup.configPath, 'utf-8');

		const res = await app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: { _csrf: csrfToken, action: 'set', phrase, value: 'true' },
		});

		const yamlAfter = await readFile(setup.configPath, 'utf-8');

		return {
			res,
			unchangedYaml: parse(yamlBefore) as Record<string, unknown>,
			parsedAfter: parse(yamlAfter) as Record<string, unknown>,
		};
	}

	it('whitespace prefix → 403, no write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			` ${AUTO_PRUNE_PROMPT}`,
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it('whitespace suffix → 403, no write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			`${AUTO_PRUNE_PROMPT} `,
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it('case mismatch (uppercased) → 403, no write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			AUTO_PRUNE_PROMPT.toUpperCase(),
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it('truncated phrase (first half) → 403, no write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const truncated = AUTO_PRUNE_PROMPT.slice(0, Math.floor(AUTO_PRUNE_PROMPT.length / 2));
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			truncated,
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it("cross-key mismatch (different key's prompt) → 403, no write", async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		// Use auto_prune endpoint but submit a different key's prompt
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			MOCK_PER_USER_DANGEROUS_PROMPT,
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it('empty phrase → 403, no write', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const { res, unchangedYaml, parsedAfter } = await postConfirmAndCheck(
			setup.app,
			allCookies,
			csrfToken,
			'',
		);
		expect(res.statusCode).toBe(403);
		expect(parsedAfter).toEqual(unchangedYaml);
	});

	it('mismatch response re-renders modal with error (no redirect)', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: { _csrf: csrfToken, action: 'set', phrase: 'wrong phrase', value: 'true' },
		});
		expect(res.statusCode).toBe(403);
		// Modal re-rendered with error message
		expect(res.body).toContain('Phrase did not match');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-034: dangerous resets go through confirm flow
// ---------------------------------------------------------------------------

describe('Direct POST /reset for dangerous key → 403 (REQ-SETTINGS-034)', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('direct POST reset for system dangerous → 403', async () => {
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
});

// ---------------------------------------------------------------------------
// Per-user dangerous reset via confirm flow
// ---------------------------------------------------------------------------

describe('POST /confirm — per-user dangerous reset', () => {
	let setup: TestSetup;
	let mockOverrides: Record<string, unknown>;
	let removeOverrideCalled: string[];

	beforeEach(async () => {
		mockOverrides = { [MOCK_PER_USER_DANGEROUS_KEY]: true };
		removeOverrideCalled = [];

		const mockAppConfig: AppConfigService = {
			get: async (key: string) => mockOverrides[key],
			getAll: async () => ({ ...mockOverrides }),
			getOverrides: async () => ({ ...mockOverrides }),
			updateOverrides: async (_userId: string, partial: Record<string, unknown>) => {
				Object.assign(mockOverrides, partial);
			},
			removeOverride: async (_userId: string, key: string) => {
				removeOverrideCalled.push(key);
				delete mockOverrides[key];
			},
		};

		setup = await buildTestServer({ isAdmin: true, mockAppConfigService: mockAppConfig });
	});

	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('correct phrase for reset (per-user dangerous) → redirect + override removed', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'POST',
			url: `/gui/settings/${MOCK_APP_ID}/${MOCK_PER_USER_DANGEROUS_KEY}/confirm`,
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				action: 'reset',
				phrase: MOCK_PER_USER_DANGEROUS_PROMPT,
			},
		});

		expect(res.statusCode).toBe(302);
		expect(res.headers.location).toContain('saved=1');
		expect(removeOverrideCalled).toContain(MOCK_PER_USER_DANGEROUS_KEY);
	});

	it('wrong phrase for reset (per-user dangerous) → 403, override NOT removed', async () => {
		const { allCookies, csrfToken } = await login(setup.app);
		const res = await setup.app.inject({
			method: 'POST',
			url: `/gui/settings/${MOCK_APP_ID}/${MOCK_PER_USER_DANGEROUS_KEY}/confirm`,
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				action: 'reset',
				phrase: 'wrong phrase here',
			},
		});

		expect(res.statusCode).toBe(403);
		expect(removeOverrideCalled).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Server-side re-validation (REQ-SETTINGS-027 note: re-validate at POST time)
// ---------------------------------------------------------------------------

describe('Server-side re-validation at POST confirm time', () => {
	let setup: TestSetup;

	beforeEach(async () => {
		setup = await buildTestServer({ isAdmin: true });
	});
	afterEach(async () => {
		await setup.app.close();
		await rm(setup.tempDir, { recursive: true, force: true });
	});

	it('POST with out-of-range value for numeric setting → write rejected', async () => {
		const { allCookies, csrfToken } = await login(setup.app);

		// auto_prune is a boolean — send a value that is invalid
		// The SettingsWriter will try to coerce 'not-a-bool' which should reject
		const res = await setup.app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			payload: {
				_csrf: csrfToken,
				action: 'set',
				phrase: AUTO_PRUNE_PROMPT,
				value: 'not-a-bool',
			},
		});

		// Write should fail with 400 (invalid value)
		expect(res.statusCode).toBe(400);

		// YAML unchanged
		const raw = await readFile(setup.configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		const sessions = ((parsed.chat as Record<string, unknown>)?.sessions ?? {}) as Record<
			string,
			unknown
		>;
		expect('auto_prune' in sessions).toBe(false);
	});
});
