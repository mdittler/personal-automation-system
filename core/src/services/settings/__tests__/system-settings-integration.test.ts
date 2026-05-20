/**
 * Integration tests for system-scope settings end-to-end.
 *
 * Uses real SettingsRegistry + SettingsWriter + SettingsReader + SystemConfigWriter.
 * No mocks at the system boundary — all I/O hits real temp files.
 *
 * REQ-SETTINGS-021: registry registers system defs with appId='system'.
 * REQ-SETTINGS-022: writes persist atomically to pas.yaml.
 * REQ-SETTINGS-023: writes mutate in-memory config immediately.
 * REQ-SETTINGS-028: NL source blocked for all system keys.
 * REQ-SETTINGS-029: effective-default resolver for per-user defs with systemConfigBackingKey.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { AppLogger } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import { SYSTEM_KEY_RUNTIME_PATH, SYSTEM_SETTING_DEFS } from '../../config/settings-metadata.js';
import { SystemConfigWriter } from '../../config/system-config-writer.js';
import { buildSettingsRegistry } from '../build-registry.js';
import { SettingsReader } from '../settings-reader.js';
import { SettingsWriter } from '../settings-writer.js';

function makeLogger(): AppLogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

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

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-sys-int-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function writeSeedYaml(extra: Record<string, unknown> = {}): Promise<string> {
	const p = join(tempDir, 'pas.yaml');
	await writeFile(p, JSON.stringify({ users: [], ...extra }), 'utf-8');
	return p;
}

function makeAll(configPath: string) {
	const config = makeConfig();
	const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
	const systemConfigWriter = new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
	});
	const writer = new SettingsWriter({
		registry,
		appConfigResolver: () => undefined,
		manifestResolver: () => [],
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig: config,
	});
	const reader = new SettingsReader({
		registry,
		appConfigResolver: () => undefined,
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig: config,
	});
	return { config, registry, systemConfigWriter, writer, reader };
}

// ---------------------------------------------------------------------------
// REQ-SETTINGS-021: registry coverage
// ---------------------------------------------------------------------------

describe('SettingsRegistry — system defs (REQ-SETTINGS-021)', () => {
	it('registers all SYSTEM_SETTING_DEFS with appId="system"', async () => {
		const p = await writeSeedYaml();
		const { registry } = makeAll(p);

		for (const def of SYSTEM_SETTING_DEFS) {
			const found = registry.getByAppKey('system', def.key);
			expect(found, `expected system.${def.key} in registry`).toBeDefined();
			expect(found?.appId).toBe('system');
			expect(found?.scope).toBe('system');
		}
	});

	it('exposes all SYSTEM_SETTING_DEFS qualified keys', async () => {
		const p = await writeSeedYaml();
		const { registry } = makeAll(p);
		const all = registry.getAll().map((d) => `${d.appId}.${d.key}`);
		for (const def of SYSTEM_SETTING_DEFS) {
			expect(all).toContain(`system.${def.key}`);
		}
	});

	it('no system key appears in NL-safe allowlist (system keys are never nlSafe)', async () => {
		const p = await writeSeedYaml();
		const { registry } = makeAll(p);
		const nlSafe = registry.getNlSafeQualifiedKeys();
		for (const def of SYSTEM_SETTING_DEFS) {
			expect(nlSafe.has(`system.${def.key}`)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-028: NL source blocked e2e
// ---------------------------------------------------------------------------

describe('NL source blocked for system keys (REQ-SETTINGS-028)', () => {
	it.each(SYSTEM_SETTING_DEFS.map((d) => d.key))(
		'NL write for system.%s returns ok=false',
		async (key) => {
			const p = await writeSeedYaml();
			const { writer } = makeAll(p);
			const result = await writer.write({
				userId: 'u1',
				appId: 'system',
				key,
				rawValue: 'true',
				source: 'nl',
			});
			expect(result.ok).toBe(false);
		},
	);
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-022 + REQ-SETTINGS-023: e2e write
// ---------------------------------------------------------------------------

describe('admin-confirmed e2e write', () => {
	it('persists retention_days to YAML and in-memory config', async () => {
		const p = await writeSeedYaml();
		const { writer, config, reader } = makeAll(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'admin-confirmed',
		});

		// In-memory
		expect(config.chat?.sessions?.retention_days).toBe(180);

		// YAML on disk
		const raw = await readFile(p, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed['chat'] as Record<string, unknown>)['sessions'] as Record<string, unknown>)[
				'retention_days'
			],
		).toBe(180);

		// Reader catalog reflects new value
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: true });
		expect(catalog).toMatch(/180/);
	});

	it('persists routing.verification.enabled=false to YAML and config', async () => {
		const p = await writeSeedYaml();
		const { writer, config } = makeAll(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.enabled',
			rawValue: 'false',
			source: 'admin-confirmed',
		});

		expect(config.routing?.verification?.enabled).toBe(false);
		const raw = await readFile(p, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed['routing'] as Record<string, unknown>)['verification'] as Record<string, unknown>)[
				'enabled'
			],
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Catalog reflects system config (admin vs non-admin visibility)
// ---------------------------------------------------------------------------

describe('catalog reflects system config values', () => {
	it('non-admin catalog includes non-adminOnly system keys', async () => {
		const p = await writeSeedYaml();
		const { writer, reader } = makeAll(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'admin-confirmed',
		});

		const { catalog: nonAdminCatalog } = await reader.buildCatalog({
			userId: 'u1',
			isAdmin: false,
		});
		expect(nonAdminCatalog).toMatch(/Keep ended sessions for/);
		expect(nonAdminCatalog).toMatch(/180/);
	});

	it('non-admin catalog excludes adminOnly system keys (routing.verification.*)', async () => {
		const p = await writeSeedYaml();
		const { reader } = makeAll(p);
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		expect(catalog).not.toMatch(/routing\.verification/);
		expect(catalog).not.toMatch(/Route verification/);
	});

	it('admin catalog includes adminOnly system keys', async () => {
		const p = await writeSeedYaml();
		const { reader } = makeAll(p);
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: true });
		expect(catalog).toMatch(/routing\.verification/);
		expect(catalog).toMatch(/Route verification/);
	});

	it('admin catalog shows live upperBound value after write', async () => {
		const p = await writeSeedYaml();
		const { writer, reader } = makeAll(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.upper_bound',
			rawValue: '0.5',
			source: 'admin-confirmed',
		});

		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: true });
		expect(catalog).toMatch(/0\.5/);
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-029: effective-default resolver (per-user with systemConfigBackingKey)
// ---------------------------------------------------------------------------

describe('effective-default resolver (REQ-SETTINGS-029)', () => {
	/** Build a minimal registry with system defs + one per-user def with systemConfigBackingKey. */
	async function makeEffectiveDefaultRegistry(systemConfigBackingKey: string) {
		const { SettingsRegistry: Reg } = await import('../settings-registry.js');
		const registry = new Reg();
		// Register system defs under 'system' appId
		for (const def of SYSTEM_SETTING_DEFS) registry.register({ ...def, appId: 'system' });
		// Register a per-user def backed by a system config value
		registry.register({
			key: 'log_to_notes',
			appId: 'myapp',
			category: 'personal',
			label: 'Daily notes logging',
			help: 'Toggle daily notes.',
			type: 'boolean',
			default: false,
			adminOnly: false,
			dangerous: false,
			hidden: false,
			scope: 'per-user',
			nlSafe: false,
			systemConfigBackingKey,
		});
		return registry;
	}

	it('displays system config value when no user override — backing key via camelCase dotpath', async () => {
		const p = await writeSeedYaml();
		const config = makeConfig();
		// Set system config logToNotes to true
		if (config.chat) config.chat.logToNotes = true;

		const registry = await makeEffectiveDefaultRegistry('chat.logToNotes');
		const systemConfigWriter = new SystemConfigWriter({
			configPath: p,
			runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
			keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
		});
		const reader = new SettingsReader({
			registry,
			appConfigResolver: () => undefined,
			logger: makeLogger(),
			systemConfigWriter,
			systemConfig: config,
		});

		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		// log_to_notes has no user override → should display system config value (ON)
		expect(catalog).toMatch(/Daily notes logging.*ON/);
	});

	it('user override beats system config backing key', async () => {
		const p = await writeSeedYaml();
		const config = makeConfig();
		// System config: logToNotes = true
		if (config.chat) config.chat.logToNotes = true;

		const registry = await makeEffectiveDefaultRegistry('chat.logToNotes');
		const userCfg = {
			getOverrides: vi.fn().mockResolvedValue({ log_to_notes: false }), // user override = OFF
			updateOverrides: vi.fn(),
		};
		const systemConfigWriter = new SystemConfigWriter({
			configPath: p,
			runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
			keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
		});
		const reader = new SettingsReader({
			registry,
			appConfigResolver: (id) => (id === 'myapp' ? (userCfg as never) : undefined),
			logger: makeLogger(),
			systemConfigWriter,
			systemConfig: config,
		});

		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		// User override (false → OFF) beats system default (true → ON)
		expect(catalog).toMatch(/Daily notes logging.*OFF/);
	});
});

// ---------------------------------------------------------------------------
// Hot-update hook fires on auto_reset_idle_minutes write (REQ-SETTINGS-030)
// ---------------------------------------------------------------------------

describe('hot-update hook (REQ-SETTINGS-030)', () => {
	it('fires registered hook after auto_reset_idle_minutes write', async () => {
		const p = await writeSeedYaml();
		const { writer } = makeAll(p);

		const hookFn = vi.fn();
		writer.registerPostWriteHook('system.chat.sessions.auto_reset_idle_minutes', hookFn);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: '30',
			source: 'admin-confirmed',
		});

		expect(hookFn).toHaveBeenCalledOnce();
		expect(hookFn).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: 'system',
				key: 'chat.sessions.auto_reset_idle_minutes',
				newValue: 30,
			}),
		);
	});
});
