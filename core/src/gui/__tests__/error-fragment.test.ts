/**
 * Styled htmx error fragment (audit I5).
 *
 * Any htmx-triggered request (`hx-request: true`) that fails validation
 * must come back as a styled `.pas-error-card` HTML fragment with a
 * plain-language title/hint — never a raw plain-text error string, and
 * never a stack trace or "Error: ..." message.
 *
 * Uses the smallest existing failing-validation POST among the
 * settings/alerts/reports routes: POST /gui/settings/:appId/:key/confirm
 * with an out-of-range value for a boolean setting (settings.ts ~line 691,
 * `Write failed: ${result.reason}` on a 400). That route is driven by
 * `hx-post` from the confirm modal (settings.ts buildConfirmModalHtml),
 * so it is genuinely htmx-facing.
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
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'tok';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const AUTO_PRUNE_PROMPT = 'permanently delete expired transcripts';

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

async function buildApp() {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-error-fragment-'));
	const configPath = await writeSeedYaml(tempDir);
	const config = makeConfig();

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
				? { id: TEST_USER_ID, name: 'AdminUser', isAdmin: true, telegramId: 1 }
				: null,
		getAllUsers: () => [{ id: TEST_USER_ID, name: 'AdminUser', isAdmin: true, telegramId: 1 }],
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
			await registerViewLocals(gui, { userManager: userManager as unknown as UserManager });
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

	return { app, tempDir };
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

describe('styled htmx error fragment (I5)', () => {
	let app: Awaited<ReturnType<typeof buildApp>>['app'];
	let tempDir: string;

	beforeEach(async () => {
		const setup = await buildApp();
		app = setup.app;
		tempDir = setup.tempDir;
	});

	afterEach(async () => {
		await app.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('renders a styled error card instead of a plain-text failure for an htmx request', async () => {
		const { allCookies, csrfToken } = await login(app);
		const res = await app.inject({
			method: 'POST',
			url: '/gui/settings/system/chat.sessions.auto_prune/confirm',
			cookies: allCookies,
			headers: { 'hx-request': 'true' },
			payload: {
				_csrf: csrfToken,
				action: 'set',
				phrase: AUTO_PRUNE_PROMPT,
				value: 'not-a-bool',
			},
		});

		expect(res.statusCode).toBeGreaterThanOrEqual(400);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('pas-error-card');
		// No raw technical error text or stack traces reach the user.
		expect(res.body).not.toMatch(/Error:|at .*\.ts:\d+/);
	});
});
