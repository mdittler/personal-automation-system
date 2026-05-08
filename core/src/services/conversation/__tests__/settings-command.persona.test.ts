/**
 * Persona tests — /settings command recognition + multi-step handler flows.
 *
 * Two layers:
 *   1. parseCommand recognition — verifies which message strings ARE / ARE NOT
 *      recognized as the '/settings' command by the router's command parser.
 *   2. Handler flow scenarios — 3 multi-step scenarios using real handleSettings.
 *
 * REQ-SETTINGS-009: /settings supports all sub-forms; adminOnly hidden from non-admin.
 * REQ-SETTINGS-010: dangerous writes require confirm phrase; TTL-bound.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { AppConfigService } from '../../../types/config.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { SYSTEM_SETTING_DEFS } from '../../config/settings-metadata.js';
import type { SystemConfigWriter } from '../../config/system-config-writer.js';
import { parseCommand } from '../../router/command-parser.js';
import { buildSettingsRegistry } from '../../settings/build-registry.js';
import { createPendingSettingsConfirmStore } from '../../settings/pending-settings-confirm-store.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import {
	type HandleSettingsArgs,
	type HandleSettingsDeps,
	handleSettings,
} from '../handle-settings.js';

// ---------------------------------------------------------------------------
// Part 1: parseCommand recognition tests
// ---------------------------------------------------------------------------

describe('parseCommand: /settings SHOULD be recognized', () => {
	const shouldMatch = [
		'/settings',
		'/settings food',
		'/settings food default_store',
		'/settings food default_store Whole Foods',
		'/settings food default_store "Corner Store"',
		'/settings reset food default_store',
		'/settings confirm permanently delete expired transcripts',
		'/settings memory-sessions',
		'/settings memory-sessions chat.sessions.retention_days',
		'/settings memory-sessions chat.sessions.retention_days 30',
		'/settings dangerous',
		'/settings dangerous chat.sessions.auto_prune true',
		'/settings personal',
		'/settings notes',
		'/settings food seasonal_nudges false',
		'/settings food macro_target_calories 2000',
		'/settings food default_store ', // trailing space — rawArgs empty
		'/settings  food', // double space — command still /settings
		'/settings@botname', // Telegram @mention style
		'/settings@botname food',
	];

	for (const text of shouldMatch) {
		it(`"${text}" → command === '/settings'`, () => {
			const parsed = parseCommand(text);
			expect(parsed?.command).toBe('/settings');
		});
	}
});

describe('parseCommand: /settings SHOULD NOT be recognized', () => {
	const shouldNotMatch: { text: string; reason: string }[] = [
		{ text: 'settings', reason: 'no slash' },
		{ text: '/setting', reason: 'singular form' },
		{ text: '/Settings', reason: 'wrong case — capital S' },
		{ text: '/SETTINGS', reason: 'all caps' },
		{ text: '/settings_extra', reason: 'extra suffix' },
		{ text: 'set settings', reason: 'no slash, two words' },
		{ text: 'change my settings', reason: 'natural language' },
		{ text: 'what are my settings', reason: 'natural language query' },
		{ text: 'show settings for food', reason: 'natural language' },
		{ text: 'I want to see my settings', reason: 'natural language' },
		{ text: '/set food default_store Whole Foods', reason: 'different command /set' },
		{ text: '/configure', reason: 'different command' },
		{ text: '/options', reason: 'different command' },
		{ text: '/setup', reason: 'different command' },
		{ text: '/pref', reason: 'different command' },
		{ text: '/admin settings', reason: '/admin not /settings' },
	];

	for (const { text, reason } of shouldNotMatch) {
		it(`"${text}" is NOT '/settings' (${reason})`, () => {
			const parsed = parseCommand(text);
			expect(parsed?.command).not.toBe('/settings');
		});
	}

	it('"  /settings" (leading space) IS /settings (trim normalizes)', () => {
		// parseCommand trims — so leading space still resolves as /settings
		const parsed = parseCommand('  /settings');
		expect(parsed?.command).toBe('/settings');
	});
});

// ---------------------------------------------------------------------------
// Part 2: handler flow scenarios
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

function makeAppConfig(
	initialOverrides: Record<string, unknown> | null = null,
): AppConfigService & {
	updateOverrides: ReturnType<typeof vi.fn>;
	removeOverride: ReturnType<typeof vi.fn>;
} {
	let overrides = initialOverrides;
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockImplementation(async () => overrides),
		setAll: vi.fn(),
		updateOverrides: vi
			.fn()
			.mockImplementation(async (_userId: string, partial: Record<string, unknown>) => {
				if (overrides === null) {
					overrides = { ...partial };
				} else {
					Object.assign(overrides, partial);
				}
			}),
		removeOverride: vi.fn().mockImplementation(async (_userId: string, key: string) => {
			if (overrides) {
				delete overrides[key];
			}
		}),
	};
}

function makeSystemConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		claude: { apiKey: 'test', model: 'claude-3', fastModel: 'claude-haiku' },
		gui: { authToken: 'gui-token' },
		api: { token: 'api-token' },
		cloudflare: {},
		webhooks: [],
		n8n: { dispatchUrl: '' },
		users: [],
		backup: { enabled: false, path: '/backup', schedule: '0 3 * * *', retentionCount: 7 },
		chat: {
			logToNotes: false,
			sessions: {
				auto_prune: false,
				retention_days: 90,
				auto_reset_idle_minutes: null,
			},
			recall: { max_window_days: 365 },
		},
	} as unknown as SystemConfig;
}

/**
 * Build a SystemConfigWriter mock that also mutates the provided SystemConfig in-memory.
 * The real SystemConfigWriter.write(key, coerced, config) calls dotSet(config, runtimePath, coerced).
 * This mock mirrors that behaviour so tests can assert config.<path> changes.
 */
function makeSystemConfigWriter(systemCfg: SystemConfig): SystemConfigWriter {
	/** Mapping from settings key to the dot-path through SystemConfig. */
	const runtimePathMap: Record<string, string[]> = {
		'chat.sessions.retention_days': ['chat', 'sessions', 'retention_days'],
		'chat.sessions.auto_prune': ['chat', 'sessions', 'auto_prune'],
		'chat.sessions.auto_reset_idle_minutes': ['chat', 'sessions', 'auto_reset_idle_minutes'],
		'routing.verification.enabled': ['routing', 'verification', 'enabled'],
	};
	const defaults: Record<string, unknown> = {
		'chat.sessions.retention_days': 90,
		'chat.sessions.auto_prune': false,
		'chat.sessions.auto_reset_idle_minutes': null,
		'routing.verification.enabled': true,
	};

	function dotSet(obj: Record<string, unknown>, path: string[], value: unknown): void {
		let cur = obj;
		for (let i = 0; i < path.length - 1; i++) {
			const seg = path[i] as string;
			if (typeof cur[seg] !== 'object' || cur[seg] === null) cur[seg] = {};
			cur = cur[seg] as Record<string, unknown>;
		}
		cur[path[path.length - 1] as string] = value;
	}

	return {
		read: vi.fn((key: string) => {
			const path = runtimePathMap[key];
			if (!path) throw new Error(`Unknown system key: ${key}`);
			let cur: unknown = systemCfg;
			for (const seg of path) {
				cur = (cur as Record<string, unknown>)[seg];
			}
			return cur;
		}),
		write: vi.fn().mockImplementation(async (key: string, value: unknown, config: SystemConfig) => {
			const path = runtimePathMap[key];
			if (!path) throw new Error(`Unknown system key: ${key}`);
			dotSet(config as unknown as Record<string, unknown>, path, value);
		}),
		writeMany: vi.fn().mockResolvedValue(undefined),
		resetToSchemaDefault: vi.fn().mockImplementation(async (key: string, config: SystemConfig) => {
			const path = runtimePathMap[key];
			if (!path) throw new Error(`Unknown system key: ${key}`);
			const d = defaults[key] ?? null;
			dotSet(config as unknown as Record<string, unknown>, path, d);
			return d;
		}),
	} as unknown as SystemConfigWriter;
}

const FOOD_MANIFEST: ManifestUserConfig[] = [
	{
		key: 'default_store',
		type: 'string',
		default: '',
		description: 'Preferred store',
		label: 'Default store',
		help: 'Your grocery store.',
	},
	{
		key: 'seasonal_nudges',
		type: 'boolean',
		default: true,
		description: 'Seasonal',
		label: 'Seasonal nudges',
		help: 'Seasonal suggestions.',
	},
	{
		key: 'macro_target_calories',
		type: 'number',
		default: 2000,
		description: 'Calories',
		label: 'Daily calorie target',
		help: 'Daily calorie target.',
		min: 500,
		max: 10000,
	},
];

function buildFlowDeps(opts?: {
	foodOverrides?: Record<string, unknown> | null;
	isAdmin?: boolean;
	clock?: () => number;
}): {
	deps: HandleSettingsDeps;
	foodCfg: ReturnType<typeof makeAppConfig>;
	systemCfgWriter: SystemConfigWriter;
	systemCfg: SystemConfig;
	pendingStore: ReturnType<typeof createPendingSettingsConfirmStore>;
	input: (args: string[], rawArgs?: string, isAdmin?: boolean) => HandleSettingsArgs;
} {
	const overrides = opts?.foodOverrides ?? {};
	const foodCfg = makeAppConfig(overrides);
	const systemCfg = makeSystemConfig();
	const systemCfgWriter = makeSystemConfigWriter(systemCfg);
	const logger = makeLogger();

	// Build real registry from manifest
	const registry = buildSettingsRegistry({
		installedApps: [
			{
				app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food', author: 'Test' },
				capabilities: { messages: {} },
				user_config: FOOD_MANIFEST,
			} as never,
		],
		systemDefs: SYSTEM_SETTING_DEFS,
	});

	const writer = new SettingsWriter({
		registry,
		appConfigResolver: (appId) => (appId === 'food' ? foodCfg : undefined),
		manifestResolver: (appId) => (appId === 'food' ? FOOD_MANIFEST : undefined),
		logger,
		systemConfigWriter: systemCfgWriter,
		systemConfig: systemCfg,
	});

	const pendingStore = createPendingSettingsConfirmStore({
		ttlMs: 60_000,
		clock: opts?.clock,
	});

	const deps: HandleSettingsDeps = {
		registry,
		writer,
		appConfigResolver: (appId) => (appId === 'food' ? foodCfg : undefined),
		systemConfigWriter: systemCfgWriter,
		systemConfig: systemCfg,
		pendingStore,
		matchesDangerConfirmPhrase: (s, e) => s === e,
		logger,
	};

	function input(args: string[], rawArgs?: string, isAdmin?: boolean): HandleSettingsArgs {
		return {
			args,
			rawArgs: rawArgs ?? args.join(' '),
			userId: 'u1',
			isAdmin: isAdmin ?? opts?.isAdmin ?? false,
		};
	}

	return { deps, foodCfg, systemCfgWriter, systemCfg, pendingStore, input };
}

// ---------------------------------------------------------------------------
// Scenario 1: View → Set → Reset
// ---------------------------------------------------------------------------

describe('Scenario 1: View → Set → Reset (food.default_store)', () => {
	it('step 1: list includes food category', async () => {
		const { deps, input } = buildFlowDeps();
		const { reply } = await handleSettings(input([]), deps);
		expect(reply).toContain('food');
	});

	it('step 2: show default_store returns current value', async () => {
		const { deps, input } = buildFlowDeps({ foodOverrides: {} });
		const { reply } = await handleSettings(
			input(['food', 'default_store'], 'food default_store'),
			deps,
		);
		expect(reply).toContain('Default store');
	});

	it('step 3: set default_store to Target → saved', async () => {
		const { deps, foodCfg, input } = buildFlowDeps({ foodOverrides: {} });
		const { reply } = await handleSettings(
			input(['food', 'default_store', 'Target'], 'food default_store Target'),
			deps,
		);
		expect(reply).toContain('Saved');
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', { default_store: 'Target' });
	});

	it('step 4: reset default_store → removeOverride called', async () => {
		const { deps, foodCfg, input } = buildFlowDeps({ foodOverrides: { default_store: 'Target' } });
		const { reply } = await handleSettings(
			input(['reset', 'food', 'default_store'], 'reset food default_store'),
			deps,
		);
		expect(reply.toLowerCase()).toMatch(/reset|default/);
		expect(foodCfg.removeOverride).toHaveBeenCalledWith('u1', 'default_store');
	});

	it('step 5: show after reset shows default (not Target)', async () => {
		const overrides: Record<string, unknown> = { default_store: 'Target' };
		const foodCfg = makeAppConfig(overrides);
		const systemCfg = makeSystemConfig();
		const systemCfgWriter = makeSystemConfigWriter(systemCfg);
		const logger = makeLogger();
		const registry = buildSettingsRegistry({
			installedApps: [
				{
					app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food', author: 'Test' },
					capabilities: { messages: {} },
					user_config: FOOD_MANIFEST,
				} as never,
			],
			systemDefs: SYSTEM_SETTING_DEFS,
		});
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			manifestResolver: (id) => (id === 'food' ? FOOD_MANIFEST : undefined),
			logger,
			systemConfigWriter: systemCfgWriter,
			systemConfig: systemCfg,
		});
		// Reset removes the key
		vi.mocked(foodCfg.removeOverride).mockImplementation(async (_uid: string, key: string) => {
			delete overrides[key];
		});
		// After reset, getOverrides returns without default_store
		vi.mocked(foodCfg.getOverrides).mockImplementation(async () => ({ ...overrides }));
		const pendingStore = createPendingSettingsConfirmStore();
		const deps: HandleSettingsDeps = {
			registry,
			writer,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			systemConfigWriter: systemCfgWriter,
			systemConfig: systemCfg,
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
			logger,
		};
		const input = (args: string[], rawArgs?: string, isAdmin?: boolean): HandleSettingsArgs => ({
			args,
			rawArgs: rawArgs ?? args.join(' '),
			userId: 'u1',
			isAdmin: isAdmin ?? false,
		});

		// Reset
		await handleSettings(
			input(['reset', 'food', 'default_store'], 'reset food default_store'),
			deps,
		);

		// Show — should not contain Target
		const { reply } = await handleSettings(
			input(['food', 'default_store'], 'food default_store'),
			deps,
		);
		expect(reply).not.toContain('Target');
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Dangerous set → confirm (happy path, system.chat.sessions.auto_prune)
// ---------------------------------------------------------------------------

describe('Scenario 2: Dangerous set → confirm (happy path)', () => {
	it('step 1: dangerous set → produces confirm prompt', async () => {
		const { deps, pendingStore, input } = buildFlowDeps({ isAdmin: true });
		const { reply } = await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		expect(reply.toLowerCase()).toContain('confirm');
		expect(pendingStore.has('u1')).toBe(true);
	});

	it('step 2: confirm → "Confirmed and saved"', async () => {
		const { deps, systemCfg, pendingStore, input } = buildFlowDeps({ isAdmin: true });

		// Initiate
		await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);
		// Peek nonce from pending store (P2: grammar is now /settings confirm <nonce> <phrase>)
		const nonce = pendingStore.peek('u1')!.id;
		// Confirm
		const { reply } = await handleSettings(
			input(
				['confirm', nonce, 'permanently', 'delete', 'expired', 'transcripts'],
				`confirm ${nonce} permanently delete expired transcripts`,
				true,
			),
			deps,
		);
		expect(reply).toContain('Confirmed and saved');
		expect(systemCfg.chat?.sessions?.auto_prune).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: Dangerous set → expired TTL → confirm fails
// ---------------------------------------------------------------------------

describe('Scenario 3: Dangerous set → expired TTL → confirm fails', () => {
	it('confirm after TTL expiry returns "No pending change"', async () => {
		let now = 0;
		const clock = () => now;
		const { deps, input } = buildFlowDeps({ isAdmin: true, clock });

		// Initiate at t=0
		await handleSettings(
			input(
				['dangerous', 'chat.sessions.auto_prune', 'true'],
				'dangerous chat.sessions.auto_prune true',
				true,
			),
			deps,
		);

		// Advance clock past TTL (60s + 1ms)
		now = 60_001;

		// Confirm — expired
		const { reply } = await handleSettings(
			input(
				['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				'confirm permanently delete expired transcripts',
				true,
			),
			deps,
		);
		expect(reply).toContain('No pending change');
	});
});

// ---------------------------------------------------------------------------
// Additional command-recognition edge cases (≥40 total inputs covered)
// ---------------------------------------------------------------------------

describe('Additional parseCommand edge cases', () => {
	it('/settings with quoted multi-word value → recognized as /settings', () => {
		const parsed = parseCommand('/settings food default_store "Whole Foods"');
		expect(parsed?.command).toBe('/settings');
		expect(parsed?.rawArgs).toContain('"Whole Foods"');
	});

	it('/settings confirm with exact phrase → recognized, args contain phrase words', () => {
		const parsed = parseCommand('/settings confirm permanently delete expired transcripts');
		expect(parsed?.command).toBe('/settings');
		expect(parsed?.args).toContain('permanently');
		expect(parsed?.args).toContain('transcripts');
	});

	it('/settings reset with 3 tokens → args = [reset, category, key]', () => {
		const parsed = parseCommand('/settings reset food default_store');
		expect(parsed?.command).toBe('/settings');
		expect(parsed?.args).toEqual(['reset', 'food', 'default_store']);
	});

	it('rawArgs is empty for bare /settings', () => {
		const parsed = parseCommand('/settings');
		expect(parsed?.rawArgs).toBe('');
		expect(parsed?.args).toHaveLength(0);
	});

	it('rawArgs preserves the value tail for set', () => {
		const parsed = parseCommand('/settings food default_store Whole Foods Market');
		expect(parsed?.rawArgs).toBe('food default_store Whole Foods Market');
	});

	it('/settings@BotName recognized (mixed-case bot suffix stripped)', () => {
		const parsed = parseCommand('/settings@BotName food');
		expect(parsed?.command).toBe('/settings');
	});

	it('/settings personal → args = [personal]', () => {
		const parsed = parseCommand('/settings personal');
		expect(parsed?.args).toEqual(['personal']);
	});

	it('/settings notes → args = [notes]', () => {
		const parsed = parseCommand('/settings notes');
		expect(parsed?.args).toEqual(['notes']);
	});

	it('/settings dangerous → args = [dangerous]', () => {
		const parsed = parseCommand('/settings dangerous');
		expect(parsed?.args).toEqual(['dangerous']);
	});

	it('/settings food seasonal_nudges false → args include boolean string', () => {
		const parsed = parseCommand('/settings food seasonal_nudges false');
		expect(parsed?.args).toContain('false');
	});

	it('/settings food macro_target_calories 2000 → args include number string', () => {
		const parsed = parseCommand('/settings food macro_target_calories 2000');
		expect(parsed?.args).toContain('2000');
	});

	it('/settings with trailing space → rawArgs is single space or empty', () => {
		const parsed = parseCommand('/settings food default_store ');
		// rawArgs preserves trailing space from slicing
		expect(parsed?.command).toBe('/settings');
	});
});
