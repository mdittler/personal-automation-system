/**
 * Tests for SettingsWriter system-scope branch.
 *
 * REQ-SETTINGS-028: WriteSource policy — 'nl' rejects system keys, 'gui' rejects
 * dangerous/hidden, 'admin-confirmed' permits all.
 * REQ-SETTINGS-022: system writes persist to pas.yaml via SystemConfigWriter.
 * REQ-SETTINGS-023: system writes mutate in-memory config.
 * REQ-SETTINGS-024: concurrent system writes both persist.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import {
	IDLE_MINUTES_MAX,
	IDLE_MINUTES_MIN,
	RETENTION_DAYS_MAX,
	RETENTION_DAYS_MIN,
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
	UPPER_BOUND_MAX,
	UPPER_BOUND_MIN,
} from '../../config/settings-metadata.js';
import { SystemConfigWriter } from '../../config/system-config-writer.js';
import { buildSettingsRegistry } from '../build-registry.js';
import { SettingsWriter } from '../settings-writer.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
	tempDir = await mkdtemp(join(tmpdir(), 'pas-sw-sys-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function makeSeedFile(extra: Record<string, unknown> = {}): Promise<string> {
	const p = join(tempDir, 'pas.yaml');
	await writeFile(p, JSON.stringify({ users: [], ...extra }), 'utf-8');
	return p;
}

function makeSystemWriter(configPath: string): SystemConfigWriter {
	return new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
	});
}

function makeWriter(configPath: string) {
	const config = makeConfig();
	const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
	const systemConfigWriter = makeSystemWriter(configPath);
	const writer = new SettingsWriter({
		registry,
		appConfigResolver: () => undefined,
		manifestResolver: () => [],
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig: config,
	});
	return { writer, config, registry };
}

// ---------------------------------------------------------------------------
// Source policy — REQ-SETTINGS-028
// ---------------------------------------------------------------------------

describe("WriteSource 'nl' policy", () => {
	it.each(SYSTEM_SETTING_DEFS.map((d) => [d.key, d] as const))(
		'rejects system key %s via nl source',
		async (key) => {
			const p = await makeSeedFile();
			const { writer } = makeWriter(p);
			const result = await writer.write({
				userId: 'u1',
				appId: 'system',
				key,
				rawValue: 'true',
				source: 'nl',
			});
			expect(result.ok).toBe(false);
			expect((result as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
		},
	);

	it("rejects system key via validate() with source 'nl'", () => {
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined,
			manifestResolver: () => [],
			logger: makeLogger(),
		});
		const result = writer.validate({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '90',
			source: 'nl',
		});
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
	});
});

describe("WriteSource 'gui' policy", () => {
	it('rejects dangerous system key (auto_prune)', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_prune',
			rawValue: 'true',
			source: 'gui',
		});
		expect(result.ok).toBe(false);
		expect((result as { ok: false; reason: string }).reason).toMatch(/admin-confirmed/);
	});

	it('allows adminOnly non-dangerous system key (routing.verification.enabled)', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.enabled',
			rawValue: 'false',
			source: 'gui',
		});
		expect(result.ok).toBe(true);
	});

	it('allows non-adminOnly system key (chat.sessions.retention_days)', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'gui',
		});
		expect(result.ok).toBe(true);
	});
});

describe("WriteSource 'admin-confirmed' policy", () => {
	it('permits dangerous system key (auto_prune)', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_prune',
			rawValue: 'true',
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validate() is pure (no I/O)
// ---------------------------------------------------------------------------

describe('validate() does not call SystemConfigWriter.write', () => {
	it('returns ok without touching the writer', () => {
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const mockWriter = {
			write: vi.fn(),
			read: vi.fn(),
			resetToSchemaDefault: vi.fn(),
		} as unknown as SystemConfigWriter;
		const config = makeConfig();
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined,
			manifestResolver: () => [],
			logger: makeLogger(),
			systemConfigWriter: mockWriter,
			systemConfig: config,
		});
		const result = writer.validate({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(true);
		expect(mockWriter.write).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// System-scope write — persistence + in-memory mutation
// ---------------------------------------------------------------------------

describe('system-scope write() — persistence', () => {
	it('persists retention_days to YAML and mutates config (REQ-SETTINGS-022, REQ-SETTINGS-023)', async () => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);

		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(true);
		expect(config.chat?.sessions?.retention_days).toBe(180);
	});

	it('persists routing.verification.upperBound via upper_bound key', async () => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.upper_bound',
			rawValue: '0.5',
			source: 'admin-confirmed',
		});
		expect(config.routing?.verification?.upperBound).toBe(0.5);
	});

	it('writes null for nullable auto_reset_idle_minutes (empty string)', async () => {
		const p = await makeSeedFile({ chat: { sessions: { auto_reset_idle_minutes: 60 } } });
		const { writer, config } = makeWriter(p);
		if (config.chat?.sessions) config.chat.sessions.auto_reset_idle_minutes = 60;

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: '',
			source: 'admin-confirmed',
		});
		expect(config.chat?.sessions?.auto_reset_idle_minutes).toBeNull();
	});

	it("writes null for nullable auto_reset_idle_minutes (literal 'null')", async () => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: 'null',
			source: 'admin-confirmed',
		});
		expect(config.chat?.sessions?.auto_reset_idle_minutes).toBeNull();
	});

	it('returns ok: false when YAML file does not exist (rollback)', async () => {
		const missing = join(tempDir, 'nonexistent.yaml');
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const systemConfigWriter = makeSystemWriter(missing);
		const config = makeConfig();
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined,
			manifestResolver: () => [],
			logger: makeLogger(),
			systemConfigWriter,
			systemConfig: config,
		});

		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '999',
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(false);
		// In-memory rolled back to original value
		expect(config.chat?.sessions?.retention_days).toBe(90);
	});
});

// ---------------------------------------------------------------------------
// Coercion edge cases (testing-standards rule 7)
// ---------------------------------------------------------------------------

describe('system-scope coercion edge cases', () => {
	it.each([
		['min boundary', RETENTION_DAYS_MIN],
		['max boundary', RETENTION_DAYS_MAX],
	])('retention_days at %s: %d', async (_label, value) => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);
		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: String(value),
			source: 'admin-confirmed',
		});
		expect(config.chat?.sessions?.retention_days).toBe(value);
	});

	it.each([
		['below min', RETENTION_DAYS_MIN - 1],
		['above max', RETENTION_DAYS_MAX + 1],
	])('retention_days rejects %s: %d', async (_label, value) => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: String(value),
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(false);
	});

	it.each([
		['min', IDLE_MINUTES_MIN],
		['max', IDLE_MINUTES_MAX],
	])('auto_reset_idle_minutes at %s boundary: %d', async (_label, value) => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);
		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: String(value),
			source: 'admin-confirmed',
		});
		expect(config.chat?.sessions?.auto_reset_idle_minutes).toBe(value);
	});

	it.each([0.0, 0.5, 1.0])('upper_bound valid value %d', async (value) => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);
		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.upper_bound',
			rawValue: String(value),
			source: 'admin-confirmed',
		});
		expect(config.routing?.verification?.upperBound).toBe(value);
	});

	it.each([
		['below min', UPPER_BOUND_MIN - 0.1],
		['above max', UPPER_BOUND_MAX + 0.1],
	])('upper_bound rejects %s: %d', async (_label, value) => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'routing.verification.upper_bound',
			rawValue: String(value),
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(false);
	});

	it.each(['NaN', 'Infinity', '-Infinity', '0.5abc', '600abc'])(
		'rejects non-numeric %s for retention_days',
		async (rawValue) => {
			const p = await makeSeedFile();
			const { writer } = makeWriter(p);
			const result = await writer.write({
				userId: 'u1',
				appId: 'system',
				key: 'chat.sessions.retention_days',
				rawValue,
				source: 'admin-confirmed',
			});
			expect(result.ok).toBe(false);
		},
	);

	it('rejects unknown system key', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);
		const result = await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'unknown.key',
			rawValue: 'value',
			source: 'admin-confirmed',
		});
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Hooks fire on system write
// ---------------------------------------------------------------------------

describe('post-write hooks on system keys', () => {
	it('fires hook after successful system write', async () => {
		const p = await makeSeedFile();
		const { writer } = makeWriter(p);

		const hook = vi.fn();
		writer.registerPostWriteHook('system.chat.sessions.retention_days', hook);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '120',
			source: 'admin-confirmed',
		});

		expect(hook).toHaveBeenCalledOnce();
		expect(hook).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: 'system',
				key: 'chat.sessions.retention_days',
				newValue: 120,
			}),
		);
	});

	it('does not fire hook when write fails', async () => {
		const missing = join(tempDir, 'missing.yaml');
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const systemConfigWriter = makeSystemWriter(missing);
		const config = makeConfig();
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined,
			manifestResolver: () => [],
			logger: makeLogger(),
			systemConfigWriter,
			systemConfig: config,
		});

		const hook = vi.fn();
		writer.registerPostWriteHook('system.chat.sessions.retention_days', hook);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '180',
			source: 'admin-confirmed',
		});
		expect(hook).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// writeBatch with system items
// ---------------------------------------------------------------------------

describe('writeBatch — system items', () => {
	it('persists two system keys in a batch (REQ-SETTINGS-024)', async () => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);

		const result = await writer.writeBatch([
			{
				userId: 'u1',
				appId: 'system',
				key: 'chat.sessions.retention_days',
				rawValue: '120',
				source: 'admin-confirmed',
			},
			{
				userId: 'u1',
				appId: 'system',
				key: 'routing.verification.enabled',
				rawValue: 'false',
				source: 'admin-confirmed',
			},
		]);

		expect(result.perField.get('system.chat.sessions.retention_days')?.ok).toBe(true);
		expect(result.perField.get('system.routing.verification.enabled')?.ok).toBe(true);
		expect(config.chat?.sessions?.retention_days).toBe(120);
		expect(config.routing?.verification?.enabled).toBe(false);
	});

	it('validation-atomic: dangerous key in gui batch blocks all persistence', async () => {
		const p = await makeSeedFile();
		const { writer, config } = makeWriter(p);
		const original = config.chat?.sessions?.retention_days;

		const result = await writer.writeBatch([
			{
				userId: 'u1',
				appId: 'system',
				key: 'chat.sessions.retention_days',
				rawValue: '180',
				source: 'gui',
			},
			// auto_prune is dangerous — gui source should reject it
			{
				userId: 'u1',
				appId: 'system',
				key: 'chat.sessions.auto_prune',
				rawValue: 'true',
				source: 'gui',
			},
		]);

		// auto_prune rejected by 'gui' source policy
		expect(result.perField.get('system.chat.sessions.auto_prune')?.ok).toBe(false);
		// validation-atomic: nothing persisted (perApp empty, config unchanged)
		expect(result.perApp.size).toBe(0);
		expect(config.chat?.sessions?.retention_days).toBe(original);
	});

	it('mixed per-user + system items in one batch both persist', async () => {
		const p = await makeSeedFile();
		const config = makeConfig();
		// Use a fresh SettingsRegistry (not buildSettingsRegistry which includes chatbot virtual manifest)
		const { SettingsRegistry: Reg } = await import('../settings-registry.js');
		const registry = new Reg();
		for (const def of SYSTEM_SETTING_DEFS) registry.register({ ...def, appId: 'system' });
		registry.register({
			key: 'note_pref',
			appId: 'notes',
			category: 'notes',
			label: 'Note pref',
			help: 'h',
			type: 'boolean',
			default: false,
			adminOnly: false,
			dangerous: false,
			hidden: false,
			scope: 'per-user',
			nlSafe: false,
		});
		const notesCfg = {
			updateOverrides: vi.fn().mockResolvedValue(undefined),
			getOverrides: vi.fn().mockResolvedValue({}),
		};
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (id) => (id === 'notes' ? (notesCfg as never) : undefined),
			manifestResolver: (id) =>
				id === 'notes'
					? [{ key: 'note_pref', type: 'boolean', default: false, description: 'd' }]
					: [],
			logger: makeLogger(),
			systemConfigWriter: makeSystemWriter(p),
			systemConfig: config,
		});

		const result = await writer.writeBatch([
			{ userId: 'u1', appId: 'notes', key: 'note_pref', rawValue: 'true', source: 'gui' },
			{
				userId: 'u1',
				appId: 'system',
				key: 'chat.sessions.retention_days',
				rawValue: '120',
				source: 'admin-confirmed',
			},
		]);

		expect(result.perField.get('notes.note_pref')?.ok).toBe(true);
		expect(result.perField.get('system.chat.sessions.retention_days')?.ok).toBe(true);
		expect(notesCfg.updateOverrides).toHaveBeenCalledWith('u1', { note_pref: true });
		expect(config.chat?.sessions?.retention_days).toBe(120);
	});
});
