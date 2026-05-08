/**
 * Integration tests for handleSettings — full production-shape stack.
 *
 * Uses:
 *   - Real SettingsRegistry (via buildSettingsRegistry)
 *   - Real SettingsWriter (routes to real AppConfigServiceImpl or SystemConfigWriter)
 *   - Real AppConfigServiceImpl writing to temp dirs
 *   - Real SystemConfigWriter writing to temp pas.yaml
 *
 * No mocks at the I/O boundary — all writes hit real temp files.
 *
 * REQ-SETTINGS-009: /settings command supports all sub-forms; adminOnly hidden
 * REQ-SETTINGS-010: dangerous writes require typed-phrase confirm with TTL
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { matchesDangerConfirmPhrase } from '../../../gui/routes/settings-confirm-helpers.js';
import type { AppLogger } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { AppManifest } from '../../../types/manifest.js';
import { AppConfigServiceImpl } from '../../config/app-config-service.js';
import { SYSTEM_KEY_RUNTIME_PATH, SYSTEM_SETTING_DEFS } from '../../config/settings-metadata.js';
import { SystemConfigWriter } from '../../config/system-config-writer.js';
import { buildSettingsRegistry } from '../../settings/build-registry.js';
import { createPendingSettingsConfirmStore } from '../../settings/pending-settings-confirm-store.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import {
	type HandleSettingsArgs,
	type HandleSettingsDeps,
	handleSettings,
} from '../handle-settings.js';

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
		backup: {
			enabled: false,
			path: '/tmp/backups',
			schedule: '0 3 * * *',
			retentionCount: 7,
		},
		chat: {
			logToNotes: false,
			memory: { strict_durable_kinds: false },
			sessions: { auto_prune: false, retention_days: 90, auto_reset_idle_minutes: null },
			recall: { max_window_days: 365 },
		},
	} as unknown as SystemConfig;
}

/** Minimal food manifest (subset of keys for integration test). */
function makeFoodManifest(): AppManifest {
	return {
		app: {
			id: 'food',
			name: 'Food',
			version: '1.0.0',
			description: 'Food management',
			author: 'Test',
		},
		capabilities: { messages: {} },
		user_config: [
			{
				key: 'default_store',
				type: 'string',
				default: '',
				label: 'Default grocery store',
				help: 'Your preferred grocery store.',
				category: 'food',
				nlSafe: true,
				nlIntentRegex: '(set|change|update).*default.*(store|grocery)',
			},
			{
				key: 'seasonal_nudges',
				type: 'boolean',
				default: true,
				label: 'Seasonal nudges',
				help: 'Show seasonal recipe suggestions.',
				category: 'food',
				nlSafe: true,
				nlIntentRegex: '(turn|switch|enable|disable|stop|start).*(seasonal|season)',
			},
			{
				key: 'macro_target_calories',
				type: 'number',
				default: 2000,
				label: 'Daily calorie target',
				help: 'Target daily calories for macro tracking.',
				category: 'food',
				min: 500,
				max: 10000,
				nlSafe: false,
			},
		],
	} as AppManifest;
}

async function writeSeedYaml(
	tempDir: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const p = join(tempDir, 'pas.yaml');
	await writeFile(p, JSON.stringify({ users: [], ...extra }), 'utf-8');
	return p;
}

/** Construct a full production-shaped test context with real I/O. */
async function makeIntegrationContext(opts?: { isAdmin?: boolean }) {
	const tempDir = await mkdtemp(join(tmpdir(), 'settings-int-'));
	const configPath = await writeSeedYaml(tempDir);
	const config = makeConfig();

	const foodManifest = makeFoodManifest();
	const registry = buildSettingsRegistry({
		installedApps: [foodManifest],
		systemDefs: SYSTEM_SETTING_DEFS,
	});

	const systemConfigWriter = new SystemConfigWriter({
		configPath,
		runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
		keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
	});

	const foodAppConfig = new AppConfigServiceImpl({
		dataDir: tempDir,
		appId: 'food',
		defaults: (foodManifest.user_config ?? []).map((u) => ({
			...u,
			description: u.help ?? '',
		})) as never,
	});

	const writer = new SettingsWriter({
		registry,
		appConfigResolver: (appId) => (appId === 'food' ? foodAppConfig : undefined),
		manifestResolver: (appId) =>
			appId === 'food' ? (foodManifest.user_config as never) : undefined,
		logger: makeLogger(),
		systemConfigWriter,
		systemConfig: config,
	});

	const pendingStore = createPendingSettingsConfirmStore({ ttlMs: 60_000 });
	const logger = makeLogger();

	const deps: HandleSettingsDeps = {
		registry,
		writer,
		appConfigResolver: (appId) => (appId === 'food' ? foodAppConfig : undefined),
		systemConfigWriter,
		systemConfig: config,
		pendingStore,
		matchesDangerConfirmPhrase,
		logger,
	};

	function input(args: string[], rawArgs?: string, isAdmin?: boolean): HandleSettingsArgs {
		return {
			args,
			rawArgs: rawArgs ?? args.join(' '),
			userId: 'testuser',
			isAdmin: isAdmin ?? opts?.isAdmin ?? false,
		};
	}

	return {
		tempDir,
		config,
		registry,
		writer,
		foodAppConfig,
		systemConfigWriter,
		pendingStore,
		deps,
		input,
		configPath,
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) {
		await rm(d, { recursive: true, force: true });
	}
});

async function ctx(opts?: { isAdmin?: boolean }) {
	const c = await makeIntegrationContext(opts);
	tempDirs.push(c.tempDir);
	return c;
}

// ---------------------------------------------------------------------------
// IT-01: Registry boots — food + system keys present
// ---------------------------------------------------------------------------

describe('IT-01: Registry boots with food + system keys', () => {
	it('food.default_store is registered', async () => {
		const { registry } = await ctx();
		const def = registry.getByAppKey('food', 'default_store');
		expect(def).toBeDefined();
		expect(def?.scope).toBe('per-user');
		expect(def?.category).toBe('food');
	});

	it('system.chat.sessions.retention_days is registered', async () => {
		const { registry } = await ctx();
		const def = registry.getByAppKey('system', 'chat.sessions.retention_days');
		expect(def).toBeDefined();
		expect(def?.scope).toBe('system');
		expect(def?.category).toBe('memory-sessions');
	});

	it('system.chat.sessions.auto_prune is registered and dangerous', async () => {
		const { registry } = await ctx();
		const def = registry.getByAppKey('system', 'chat.sessions.auto_prune');
		expect(def).toBeDefined();
		expect(def?.dangerous).toBe(true);
		expect(def?.adminOnly).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// IT-02: List categories — non-admin omits dangerous
// ---------------------------------------------------------------------------

describe('IT-02: List categories', () => {
	it('non-admin sees food and memory-sessions but not dangerous', async () => {
		const { deps, input } = await ctx();
		const { reply } = await handleSettings(input([]), deps);
		expect(reply).toContain('food');
		expect(reply).toContain('memory-sessions');
		expect(reply).not.toContain('dangerous');
	});

	it('admin sees dangerous category', async () => {
		const { deps, input } = await ctx({ isAdmin: true });
		const { reply } = await handleSettings(input([], '', true), deps);
		expect(reply).toContain('dangerous');
	});
});

// ---------------------------------------------------------------------------
// IT-03: Show a food setting — default since no override
// ---------------------------------------------------------------------------

describe('IT-03: Show a food setting', () => {
	it('shows default_store with default value (not set)', async () => {
		const { deps, input } = await ctx();
		const { reply } = await handleSettings(
			input(['food', 'default_store'], 'food default_store'),
			deps,
		);
		expect(reply).toContain('Default grocery store');
		// No override → empty string default → should be "not set" or empty
		expect(reply.toLowerCase()).toMatch(/not set|default|food\.default/);
	});

	it('shows seasonal_nudges with default ON', async () => {
		const { deps, input } = await ctx();
		const { reply } = await handleSettings(
			input(['food', 'seasonal_nudges'], 'food seasonal_nudges'),
			deps,
		);
		expect(reply).toContain('Seasonal nudges');
		expect(reply).toContain('ON');
	});
});

// ---------------------------------------------------------------------------
// IT-04: Set a food setting (per-user) — verify written to disk
// ---------------------------------------------------------------------------

describe('IT-04: Set and read back a food setting', () => {
	it('sets default_store and getOverrides reflects it', async () => {
		const { deps, foodAppConfig, input } = await ctx();
		const { reply } = await handleSettings(
			input(['food', 'default_store', 'Whole', 'Foods'], 'food default_store Whole Foods'),
			deps,
		);
		expect(reply).toContain('Saved');
		expect(reply).toContain('food.default');

		// Real filesystem: override was persisted
		const overrides = await foodAppConfig.getOverrides('testuser');
		expect(overrides?.default_store).toBe('Whole Foods');
	});

	it('show after set reflects the override', async () => {
		const { deps, input } = await ctx();
		await handleSettings(
			input(['food', 'default_store', 'Target'], 'food default_store Target'),
			deps,
		);

		const { reply } = await handleSettings(
			input(['food', 'default_store'], 'food default_store'),
			deps,
		);
		expect(reply).toContain('Target');
	});
});

// ---------------------------------------------------------------------------
// IT-05: Reset a food setting — override removed from disk
// ---------------------------------------------------------------------------

describe('IT-05: Reset a food setting', () => {
	it('reset removes override; getOverrides no longer has the key', async () => {
		const { deps, foodAppConfig, input } = await ctx();

		// Set first
		await handleSettings(
			input(['food', 'default_store', 'Costco'], 'food default_store Costco'),
			deps,
		);
		const before = await foodAppConfig.getOverrides('testuser');
		expect(before?.default_store).toBe('Costco');

		// Reset
		const { reply } = await handleSettings(
			input(['reset', 'food', 'default_store'], 'reset food default_store'),
			deps,
		);
		expect(reply.toLowerCase()).toMatch(/reset|default/);

		// Override removed
		const after = await foodAppConfig.getOverrides('testuser');
		expect(after?.default_store).toBeUndefined();
	});

	it('show after reset shows default (not set or empty)', async () => {
		const { deps, input } = await ctx();
		await handleSettings(
			input(['food', 'default_store', 'Walmart'], 'food default_store Walmart'),
			deps,
		);
		await handleSettings(
			input(['reset', 'food', 'default_store'], 'reset food default_store'),
			deps,
		);

		const { reply } = await handleSettings(
			input(['food', 'default_store'], 'food default_store'),
			deps,
		);
		// After reset, no override → shows default value
		expect(reply).not.toContain('Walmart');
	});
});

// ---------------------------------------------------------------------------
// IT-06: Set a system setting — persists to pas.yaml and in-memory config
// ---------------------------------------------------------------------------

describe('IT-06: Set a system setting', () => {
	it('sets retention_days: persists to YAML and in-memory config', async () => {
		const { deps, config, configPath, input } = await ctx({ isAdmin: true });
		const { reply } = await handleSettings(
			input(
				['memory-sessions', 'chat.sessions.retention_days', '30'],
				'memory-sessions chat.sessions.retention_days 30',
				true,
			),
			deps,
		);
		expect(reply).toContain('Saved');

		// In-memory config
		expect(config.chat?.sessions?.retention_days).toBe(30);

		// YAML on disk
		const raw = await readFile(configPath, 'utf-8');
		const parsed = parse(raw) as Record<string, unknown>;
		expect(
			((parsed.chat as Record<string, unknown>)?.sessions as Record<string, unknown>)
				?.retention_days,
		).toBe(30);
	});

	it('restart required badge appears in set reply for retention_days', async () => {
		const { deps, input } = await ctx({ isAdmin: true });
		const { reply } = await handleSettings(
			input(
				['memory-sessions', 'chat.sessions.retention_days', '180'],
				'memory-sessions chat.sessions.retention_days 180',
				true,
			),
			deps,
		);
		expect(reply).toContain('Restart required');
	});

	it('non-admin cannot set a system setting', async () => {
		const { deps, input } = await ctx();
		const { reply } = await handleSettings(
			input(
				['memory-sessions', 'chat.sessions.retention_days', '30'],
				'memory-sessions chat.sessions.retention_days 30',
				false,
			),
			deps,
		);
		expect(reply).toContain('administrators');
		expect(reply).not.toContain('Saved');
	});
});

// ---------------------------------------------------------------------------
// IT-07: Reset a system setting
// ---------------------------------------------------------------------------

describe('IT-07: Reset a system setting', () => {
	it('resets retention_days back to schema default', async () => {
		const { deps, config, input } = await ctx({ isAdmin: true });

		// Set to custom value first
		await handleSettings(
			input(
				['memory-sessions', 'chat.sessions.retention_days', '30'],
				'memory-sessions chat.sessions.retention_days 30',
				true,
			),
			deps,
		);
		expect(config.chat?.sessions?.retention_days).toBe(30);

		// Reset
		const { reply } = await handleSettings(
			input(
				['reset', 'memory-sessions', 'chat.sessions.retention_days'],
				'reset memory-sessions chat.sessions.retention_days',
				true,
			),
			deps,
		);
		expect(reply.toLowerCase()).toMatch(/reset|default/);

		// In-memory reverted to default (90)
		expect(config.chat?.sessions?.retention_days).toBe(90);
	});
});

// ---------------------------------------------------------------------------
// IT-08: Dangerous set → confirm (happy path)
// ---------------------------------------------------------------------------

describe('IT-08: Dangerous set with confirm — happy path', () => {
	it('step a: dangerous set creates pending entry with confirm prompt', async () => {
		const { deps, pendingStore, input } = await ctx({ isAdmin: true });
		const { reply } = await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		expect(reply.toLowerCase()).toContain('dangerous');
		expect(reply.toLowerCase()).toContain('confirm');

		const pending = pendingStore.peek('testuser');
		expect(pending).toBeDefined();
		expect(pending?.action).toBe('set');
		expect(pending?.rawValue).toBe('true');
		expect(pending?.qualifiedKey).toBe('system.chat.sessions.auto_prune');
	});

	it('step b: confirm with correct phrase writes and mutates in-memory config', async () => {
		const { deps, pendingStore, config, input } = await ctx({ isAdmin: true });

		// Create pending entry
		await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		expect(pendingStore.has('testuser')).toBe(true);

		const nonce = pendingStore.peek('testuser')!.id;

		// Confirm with nonce + phrase
		const { reply } = await handleSettings(
			input(
				['confirm', nonce, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce} permanently delete expired transcripts`,
				true,
			),
			deps,
		);
		expect(reply).toContain('Confirmed and saved');
		expect(pendingStore.has('testuser')).toBe(false);
		expect(config.chat?.sessions?.auto_prune).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// IT-09: Dangerous reset → confirm
// ---------------------------------------------------------------------------

describe('IT-09: Dangerous reset with confirm', () => {
	it('step a: dangerous reset creates pending entry with action=reset', async () => {
		const { deps, pendingStore, input } = await ctx({ isAdmin: true });

		// First set auto_prune to true (with confirm)
		await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		const nonce1 = pendingStore.peek('testuser')!.id;
		await handleSettings(
			input(
				['confirm', nonce1, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce1} permanently delete expired transcripts`,
				true,
			),
			deps,
		);

		// Now issue a reset on the dangerous key
		const { reply } = await handleSettings(
			input(
				['reset', 'dangerous', 'chat.sessions.auto_prune'],
				'reset dangerous chat.sessions.auto_prune',
				true,
			),
			deps,
		);
		expect(reply.toLowerCase()).toContain('confirm');
		const pending = pendingStore.peek('testuser');
		expect(pending).toBeDefined();
		expect(pending?.action).toBe('reset');
		expect(pending?.rawValue).toBeUndefined();
	});

	it('step b: confirm of reset reverts in-memory config to false', async () => {
		const { deps, config, pendingStore, input } = await ctx({ isAdmin: true });

		// Set it to true first (full confirm flow)
		await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		const nonce1 = pendingStore.peek('testuser')!.id;
		await handleSettings(
			input(
				['confirm', nonce1, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce1} permanently delete expired transcripts`,
				true,
			),
			deps,
		);
		expect(config.chat?.sessions?.auto_prune).toBe(true);

		// Issue reset
		await handleSettings(
			input(
				['reset', 'dangerous', 'chat.sessions.auto_prune'],
				'reset dangerous chat.sessions.auto_prune',
				true,
			),
			deps,
		);
		// Confirm reset with new nonce
		const nonce2 = pendingStore.peek('testuser')!.id;
		const { reply } = await handleSettings(
			input(
				['confirm', nonce2, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce2} permanently delete expired transcripts`,
				true,
			),
			deps,
		);
		expect(reply).toContain('Confirmed');
		expect(config.chat?.sessions?.auto_prune).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// IT-10: Non-admin walk — adminOnly / dangerous inaccessible
// ---------------------------------------------------------------------------

describe('IT-10: Non-admin walk for adminOnly/dangerous keys', () => {
	it('non-admin cannot see dangerous key by show', async () => {
		const { deps, input } = await ctx();
		const { reply } = await handleSettings(
			input(['dangerous', 'chat.sessions.auto_prune'], 'dangerous chat.sessions.auto_prune', false),
			deps,
		);
		expect(reply).toContain('Unknown setting');
		expect(reply).not.toContain('auto_prune');
		expect(reply).not.toContain('permanently delete');
	});

	it('non-admin cannot set a dangerous key', async () => {
		const { deps, pendingStore, input } = await ctx();
		const { reply } = await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				false,
			),
			deps,
		);
		expect(reply).toContain('Unknown setting');
		expect(pendingStore.has('testuser')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// IT-11: Post-write hook fires on per-user write
// ---------------------------------------------------------------------------

describe('IT-11: Post-write hook fires on set', () => {
	it('hook receives correct prevValue and newValue after per-user write', async () => {
		const { deps, writer, input } = await ctx();

		const hookFn = vi.fn();
		writer.registerPostWriteHook('food.default_store', hookFn);

		await handleSettings(
			input(['food', 'default_store', 'Safeway'], 'food default_store Safeway'),
			deps,
		);

		expect(hookFn).toHaveBeenCalledOnce();
		expect(hookFn).toHaveBeenCalledWith(
			expect.objectContaining({
				appId: 'food',
				key: 'default_store',
				newValue: 'Safeway',
			}),
		);
	});

	it('hook fires with userId for per-user write', async () => {
		const { deps, writer, input } = await ctx();

		const hookFn = vi.fn();
		writer.registerPostWriteHook('food.default_store', hookFn);

		await handleSettings(
			input(['food', 'default_store', 'Kroger'], 'food default_store Kroger'),
			deps,
		);

		expect(hookFn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'testuser' }));
	});
});

// ---------------------------------------------------------------------------
// IT-12: Dangerous set → TTL expiry → confirm fails
// ---------------------------------------------------------------------------

describe('IT-12: Dangerous set → expired TTL → confirm rejected', () => {
	it('expired pending entry is not redeemable', async () => {
		const tempDir = await mkdtemp(join(tmpdir(), 'settings-ttl-'));
		tempDirs.push(tempDir);
		const configPath = await writeSeedYaml(tempDir);
		const config = makeConfig();

		const foodManifest = makeFoodManifest();
		const registry = buildSettingsRegistry({
			installedApps: [foodManifest],
			systemDefs: SYSTEM_SETTING_DEFS,
		});
		const systemConfigWriter = new SystemConfigWriter({
			configPath,
			runtimePathTable: SYSTEM_KEY_RUNTIME_PATH,
			keyDefaults: Object.fromEntries(SYSTEM_SETTING_DEFS.map((d) => [d.key, d.default])),
		});
		const foodAppConfig = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: [],
		});
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (appId) => (appId === 'food' ? foodAppConfig : undefined),
			manifestResolver: () => undefined,
			logger: makeLogger(),
			systemConfigWriter,
			systemConfig: config,
		});

		// Short TTL: 100ms
		let now = 0;
		const clock = () => now;
		const pendingStore = createPendingSettingsConfirmStore({ ttlMs: 100, clock });

		const deps: HandleSettingsDeps = {
			registry,
			writer,
			appConfigResolver: (appId) => (appId === 'food' ? foodAppConfig : undefined),
			systemConfigWriter,
			systemConfig: config,
			pendingStore,
			matchesDangerConfirmPhrase,
		};

		function adminInput(args: string[], rawArgs?: string): HandleSettingsArgs {
			return { args, rawArgs: rawArgs ?? args.join(' '), userId: 'testuser', isAdmin: true };
		}

		// Create pending entry at t=0
		now = 0;
		await handleSettings(
			adminInput(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
			),
			deps,
		);
		expect(pendingStore.has('testuser')).toBe(true);
		const nonce = pendingStore.peek('testuser')!.id;

		// Advance clock past TTL
		now = 200;

		// Confirm should fail — entry expired (nonce check never reached)
		const { reply } = await handleSettings(
			adminInput(
				['confirm', nonce, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce} permanently delete expired transcripts`,
			),
			deps,
		);
		expect(reply).toContain('No pending change');
		expect(pendingStore.has('testuser')).toBe(false);
		// in-memory config should NOT have changed
		expect(config.chat?.sessions?.auto_prune).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// IT-13: Production registry — chatbot keys with systemConfigBackingKey
// ---------------------------------------------------------------------------

describe('IT-13: Production registry — systemConfigBackingKey effective default in category list', () => {
	it('buildSettingsRegistry includes chatbot.log_to_notes with systemConfigBackingKey', async () => {
		const { registry } = await ctx();
		const def = registry.getByAppKey('chatbot', 'log_to_notes');
		expect(def).toBeDefined();
		expect(def?.systemConfigBackingKey).toBe('chat.logToNotes');
		expect(def?.scope).toBe('per-user');
		expect(def?.category).toBe('personal');
	});

	it('category list shows system config value (ON) via systemConfigBackingKey when no user override', async () => {
		const { deps, config, input } = await ctx();
		// Override system config in-memory to logToNotes = true
		config.chat.logToNotes = true;

		const { reply } = await handleSettings(input(['personal'], 'personal'), deps);
		// log_to_notes def has systemConfigBackingKey = 'chat.logToNotes' = true
		// Category list should show ON (not OFF which is the manifest default).
		expect(reply).toContain('Daily notes logging');
		expect(reply).toContain('ON');
	});

	it('category list shows manifest default (OFF) when systemConfig has logToNotes = false', async () => {
		const { deps, config, input } = await ctx();
		config.chat.logToNotes = false;

		const { reply } = await handleSettings(input(['personal'], 'personal'), deps);
		expect(reply).toContain('Daily notes logging');
		expect(reply).toContain('OFF');
	});
});
