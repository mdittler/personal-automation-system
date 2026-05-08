/**
 * Persona tests — system settings discoverability and NL blocking.
 *
 * Verifies that:
 * - Admin users see system + dangerous settings in the catalog.
 * - Non-admin users do NOT see adminOnly/dangerous system settings.
 * - Non-admin users DO see non-adminOnly system settings (retention_days,
 *   auto_reset_idle_minutes).
 * - NL <config-set> is blocked for all system-scope keys regardless of admin.
 * - systemConfigBackingKey effective-default resolver: log_to_notes shows
 *   chat.logToNotes value when no user override exists.
 *
 * Oracle: registry.getForUser() for visibility; catalog string for values.
 *
 * REQ-SETTINGS-025, 028, 029, 033
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { AppConfigService, SystemConfig } from '../../../types/config.js';
import { SYSTEM_KEY_RUNTIME_PATH, SYSTEM_SETTING_DEFS } from '../../config/settings-metadata.js';
import type { SystemConfigWriter } from '../../config/system-config-writer.js';
import { buildSettingsRegistry } from '../../settings/build-registry.js';
import { SettingsReader } from '../../settings/settings-reader.js';
import { type SettingsRegistry, qualifiedKey } from '../../settings/settings-registry.js';
import { SettingsWriter } from '../../settings/settings-writer.js';

// ---------------------------------------------------------------------------
// Helpers
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
	} as AppLogger;
}

function makeAppConfig(overrides: Record<string, unknown> | null = null): AppConfigService {
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		removeOverride: vi.fn().mockResolvedValue(undefined),
	} as unknown as AppConfigService;
}

function makeSystemConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: '' },
		claude: { apiKey: '', model: '' },
		cloudflare: {},
		llm: {
			providers: {},
			tiers: {
				fast: { provider: 'claude', model: '' },
				standard: { provider: 'claude', model: '' },
			},
		},
		gui: { authToken: '' },
		api: { token: '' },
		n8n: { dispatchUrl: '' },
		routing: { verification: { enabled: true, upperBound: 0.7 } },
		users: [],
		webhooks: [],
		backup: { enabled: false, path: '/tmp', schedule: '0 3 * * *', retentionCount: 7 },
		chat: {
			logToNotes: false,
			memory: { strict_durable_kinds: false },
			sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
			recall: { max_window_days: 365 },
		},
		...overrides,
	} as unknown as SystemConfig;
}

interface TestContext {
	registry: SettingsRegistry;
	reader: SettingsReader;
	writer: SettingsWriter;
	systemConfig: SystemConfig;
	chatbotConfig: AppConfigService;
}

function buildContext(
	opts: {
		chatbotOverrides?: Record<string, unknown> | null;
		systemConfigOverrides?: Partial<SystemConfig>;
		mockSystemConfigWriter?: SystemConfigWriter;
	} = {},
): TestContext {
	const systemConfig = makeSystemConfig(opts.systemConfigOverrides);

	const registry = buildSettingsRegistry({
		installedApps: [],
		systemDefs: SYSTEM_SETTING_DEFS,
	});

	const chatbotConfig = makeAppConfig(opts.chatbotOverrides ?? null);
	const appConfigResolver = (appId: string): AppConfigService | undefined => {
		if (appId === 'chatbot') return chatbotConfig;
		return undefined;
	};

	// Use a no-op SystemConfigWriter (reads from systemConfig directly via dotGet)
	const systemConfigWriter =
		opts.mockSystemConfigWriter ??
		({
			read: (key: string, cfg: SystemConfig) => {
				// Simple dot-path reader for test purposes
				const parts = SYSTEM_KEY_RUNTIME_PATH[key]?.split('.') ?? key.split('.');
				let val: unknown = cfg;
				for (const part of parts) {
					if (val == null || typeof val !== 'object') return undefined;
					val = (val as Record<string, unknown>)[part];
				}
				return val;
			},
			write: vi.fn().mockResolvedValue(undefined),
			resetToSchemaDefault: vi.fn().mockResolvedValue(undefined),
		} as unknown as SystemConfigWriter);

	const reader = new SettingsReader({
		registry,
		appConfigResolver,
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig,
	});

	const writer = new SettingsWriter({
		registry,
		appConfigResolver,
		manifestResolver: () => [],
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig,
	});

	return { registry, reader, writer, systemConfig, chatbotConfig };
}

// Helper: extract qualified keys visible to a user from the registry.
function visibleKeys(registry: SettingsRegistry, isAdmin: boolean): string[] {
	return registry.getForUser(isAdmin).map((d) => qualifiedKey(d.appId, d.key));
}

// Helper: extract the catalog string value for a specific qualified key.
// Catalog line format: "- Label (qualified.key): value"
function catalogValue(catalogStr: string, qKey: string): string | undefined {
	const lines = catalogStr.split('\n');
	for (const line of lines) {
		const match = new RegExp(`\\(${qKey.replace(/\./g, '\\.')}\\): (.+)$`).exec(line);
		if (match) return match[1].trim();
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// REQ-SETTINGS-025: admin vs non-admin catalog visibility
// ---------------------------------------------------------------------------

describe('Admin vs non-admin catalog visibility (REQ-SETTINGS-025, 033)', () => {
	it('non-admin catalog includes non-adminOnly system settings (retention_days, auto_reset_idle_minutes)', () => {
		const { registry } = buildContext();
		const keys = visibleKeys(registry, false);

		expect(keys).toContain('system.chat.sessions.retention_days');
		expect(keys).toContain('system.chat.sessions.auto_reset_idle_minutes');
	});

	it('non-admin catalog excludes adminOnly system settings (routing.verification.*)', () => {
		const { registry } = buildContext();
		const keys = visibleKeys(registry, false);

		expect(keys).not.toContain('system.routing.verification.enabled');
		expect(keys).not.toContain('system.routing.verification.upper_bound');
	});

	it('non-admin catalog excludes dangerous system settings (auto_prune)', () => {
		const { registry } = buildContext();
		const keys = visibleKeys(registry, false);

		expect(keys).not.toContain('system.chat.sessions.auto_prune');
	});

	it('admin catalog includes all system settings including adminOnly and dangerous', () => {
		const { registry } = buildContext();
		const keys = visibleKeys(registry, true);

		expect(keys).toContain('system.chat.sessions.retention_days');
		expect(keys).toContain('system.chat.sessions.auto_reset_idle_minutes');
		expect(keys).toContain('system.routing.verification.enabled');
		expect(keys).toContain('system.routing.verification.upper_bound');
		expect(keys).toContain('system.chat.sessions.auto_prune');
	});

	it('admin catalog entry for retention_days shows the live system value', async () => {
		const { reader } = buildContext({
			systemConfigOverrides: {
				chat: {
					logToNotes: false,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: false, retention_days: 180, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: true });
		const value = catalogValue(catalog, 'system.chat.sessions.retention_days');
		expect(value).toBe('180');
	});

	it('admin catalog auto_prune entry reflects live system config value', async () => {
		const { reader } = buildContext({
			systemConfigOverrides: {
				chat: {
					logToNotes: false,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: true, retention_days: 90, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: true });
		const value = catalogValue(catalog, 'system.chat.sessions.auto_prune');
		expect(value).toBe('ON');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-028: NL allowlist blocks all system keys
// ---------------------------------------------------------------------------

describe('NL allowlist blocks system-scope keys (REQ-SETTINGS-028)', () => {
	it('system.chat.sessions.retention_days is NOT in NL allowlist', () => {
		const { registry } = buildContext();
		const nlKeys = registry.getNlSafeQualifiedKeys();
		expect(nlKeys.has('system.chat.sessions.retention_days')).toBe(false);
	});

	it('system.chat.sessions.auto_reset_idle_minutes is NOT in NL allowlist', () => {
		const { registry } = buildContext();
		const nlKeys = registry.getNlSafeQualifiedKeys();
		expect(nlKeys.has('system.chat.sessions.auto_reset_idle_minutes')).toBe(false);
	});

	it('system.routing.verification.enabled is NOT in NL allowlist', () => {
		const { registry } = buildContext();
		const nlKeys = registry.getNlSafeQualifiedKeys();
		expect(nlKeys.has('system.routing.verification.enabled')).toBe(false);
	});

	it('system.chat.sessions.auto_prune is NOT in NL allowlist', () => {
		const { registry } = buildContext();
		const nlKeys = registry.getNlSafeQualifiedKeys();
		expect(nlKeys.has('system.chat.sessions.auto_prune')).toBe(false);
	});

	it('writer source=nl rejects system.chat.sessions.retention_days', () => {
		const { writer } = buildContext();
		const result = writer.validate({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.retention_days',
			rawValue: '365',
			source: 'nl',
		});
		expect(result.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-029: effective-default resolver for log_to_notes
// ---------------------------------------------------------------------------

describe('Effective-default resolver for log_to_notes (REQ-SETTINGS-029)', () => {
	it('no user override + chat.logToNotes=true → catalog shows true', async () => {
		const { reader } = buildContext({
			chatbotOverrides: null, // no overrides
			systemConfigOverrides: {
				chat: {
					logToNotes: true,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		const value = catalogValue(catalog, 'chatbot.log_to_notes');
		expect(value).toBeDefined();
		expect(value).toBe('ON');
	});

	it('no user override + chat.logToNotes=false → catalog shows false (manifest default)', async () => {
		const { reader } = buildContext({
			chatbotOverrides: null,
			systemConfigOverrides: {
				chat: {
					logToNotes: false,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		const value = catalogValue(catalog, 'chatbot.log_to_notes');
		expect(value).toBeDefined();
		expect(value).toBe('OFF');
	});

	it('user override (false) beats system value (true)', async () => {
		const { reader } = buildContext({
			chatbotOverrides: { log_to_notes: false },
			systemConfigOverrides: {
				chat: {
					logToNotes: true,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		const value = catalogValue(catalog, 'chatbot.log_to_notes');
		expect(value).toBe('OFF');
	});

	it('user override (true) beats system value (false)', async () => {
		const { reader } = buildContext({
			chatbotOverrides: { log_to_notes: true },
			systemConfigOverrides: {
				chat: {
					logToNotes: false,
					memory: { strict_durable_kinds: false },
					sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
					recall: { max_window_days: 365 },
				},
			} as unknown as Partial<SystemConfig>,
		});
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });
		const value = catalogValue(catalog, 'chatbot.log_to_notes');
		expect(value).toBe('ON');
	});

	it('log_to_notes has systemConfigBackingKey set in registry', () => {
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const def = registry.getByAppKey('chatbot', 'log_to_notes');
		expect(def).toBeDefined();
		expect(def?.systemConfigBackingKey).toBe('chat.logToNotes');
	});
});

// ---------------------------------------------------------------------------
// REQ-SETTINGS-030: hot-update hook wires to Router.setIdleMinutes
// (interaction with router tested in system-settings-integration.test.ts)
// Verified here: hook fires on admin-confirmed write of auto_reset_idle_minutes
// ---------------------------------------------------------------------------

describe('Hot-update hook: auto_reset_idle_minutes (REQ-SETTINGS-030)', () => {
	it('post-write hook receives newValue when writer writes auto_reset_idle_minutes', async () => {
		const { writer, systemConfig } = buildContext();
		const hookFn = vi.fn().mockResolvedValue(undefined);
		writer.registerPostWriteHook('system.chat.sessions.auto_reset_idle_minutes', hookFn);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: '60',
			source: 'admin-confirmed',
		});

		expect(hookFn).toHaveBeenCalledOnce();
		expect(hookFn).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'chat.sessions.auto_reset_idle_minutes',
				newValue: 60,
			}),
		);
	});

	it('post-write hook receives null newValue when auto_reset_idle_minutes set to blank', async () => {
		const { writer } = buildContext();
		const hookFn = vi.fn().mockResolvedValue(undefined);
		writer.registerPostWriteHook('system.chat.sessions.auto_reset_idle_minutes', hookFn);

		await writer.write({
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_reset_idle_minutes',
			rawValue: '',
			source: 'admin-confirmed',
		});

		expect(hookFn).toHaveBeenCalledWith(expect.objectContaining({ newValue: null }));
	});
});

// ---------------------------------------------------------------------------
// Should NOT match — system settings catalog is NOT accessible via NL for any user
// ---------------------------------------------------------------------------

describe('Should NOT match: system key NL attempts blocked (REQ-SETTINGS-028)', () => {
	const systemKeys = [
		'system.chat.sessions.retention_days',
		'system.chat.sessions.auto_reset_idle_minutes',
		'system.chat.sessions.auto_prune',
		'system.routing.verification.enabled',
		'system.routing.verification.upper_bound',
	];

	it.each(systemKeys)('%s is not in NL-safe allowlist', (qKey) => {
		const registry = buildSettingsRegistry({ installedApps: [], systemDefs: SYSTEM_SETTING_DEFS });
		const nlKeys = registry.getNlSafeQualifiedKeys();
		expect(nlKeys.has(qKey)).toBe(false);
	});

	it.each(systemKeys)('writer rejects source=nl for %s', (qKey) => {
		const { writer } = buildContext();
		const [appId, ...keyParts] = qKey.split('.');
		const key = keyParts.join('.');
		const result = writer.validate({ userId: 'u1', appId, key, rawValue: 'true', source: 'nl' });
		expect(result.ok).toBe(false);
	});
});
