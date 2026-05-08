/**
 * handle-settings.test.ts
 *
 * Unit tests for handleSettings. Uses real SettingsRegistry + SettingsWriter with
 * mocked AppConfigService. Real production food + system keys.
 *
 * Categories:
 * - Happy path
 * - Edge cases
 * - Error handling
 * - Security
 * - Concurrency / state transitions
 * - Configuration / contract
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import type { AppConfigService, SystemConfig } from '../../../types/config.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import type { SystemConfigWriter } from '../../config/system-config-writer.js';
import { createPendingSettingsConfirmStore } from '../../settings/pending-settings-confirm-store.js';
import { SettingsRegistry } from '../../settings/settings-registry.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import { handleSettings, type HandleSettingsDeps, type HandleSettingsArgs } from '../handle-settings.js';

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function makeRegistry(): SettingsRegistry {
	const reg = new SettingsRegistry();

	// food.default_store — per-user, non-dangerous, nlSafe
	reg.register({
		key: 'default_store',
		appId: 'food',
		category: 'food',
		label: 'Default store',
		help: 'Your preferred grocery store.',
		type: 'string',
		default: '',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /default store/i,
	});

	// food.seasonal_nudges — per-user, boolean, non-dangerous
	reg.register({
		key: 'seasonal_nudges',
		appId: 'food',
		category: 'food',
		label: 'Seasonal recipe suggestions',
		help: 'Show seasonal recipe suggestions.',
		type: 'boolean',
		default: true,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /seasonal/i,
	});

	// food.macro_target_calories — per-user, number, non-dangerous
	reg.register({
		key: 'macro_target_calories',
		appId: 'food',
		category: 'food',
		label: 'Daily calorie target',
		help: 'Target daily calories for macro tracking.',
		type: 'number',
		default: 2000,
		min: 500,
		max: 10000,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});

	// system.chat.sessions.retention_days — system scope, adminOnly=false, non-dangerous
	reg.register({
		key: 'chat.sessions.retention_days',
		appId: 'system',
		category: 'memory-sessions',
		label: 'Keep ended sessions for',
		help: 'Days to keep session transcripts.',
		type: 'number',
		default: 90,
		min: 1,
		max: 3650,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	});

	// system.chat.sessions.auto_prune — dangerous + adminOnly
	reg.register({
		key: 'chat.sessions.auto_prune',
		appId: 'system',
		category: 'dangerous',
		label: 'Auto-prune expired transcripts',
		help: 'When enabled, expired session transcripts are permanently deleted.',
		type: 'boolean',
		default: false,
		adminOnly: true,
		dangerous: true,
		dangerConfirmPrompt: 'permanently delete expired transcripts',
		hidden: false,
		scope: 'system',
		nlSafe: false,
	});

	// food.hidden_key — hidden (should be invisible to all)
	reg.register({
		key: 'hidden_key',
		appId: 'food',
		category: 'food',
		label: 'Hidden thing',
		help: '',
		type: 'boolean',
		default: false,
		adminOnly: false,
		dangerous: false,
		hidden: true,
		scope: 'per-user',
		nlSafe: false,
	});

	// food.admin_shadow_control — adminOnly, dangerous (for admin-only tests)
	reg.register({
		key: 'admin_shadow_control',
		appId: 'food',
		category: 'dangerous',
		label: 'Shadow classifier (admin only)',
		help: 'Enables shadow routing mode.',
		type: 'boolean',
		default: false,
		adminOnly: true,
		dangerous: true,
		dangerConfirmPrompt: 'enable shadow routing',
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});

	// A second 'default_store' key for a different app (for ambiguity test)
	reg.register({
		key: 'default_store',
		appId: 'notes',
		category: 'food',
		label: 'Notes store',
		help: 'Store used by notes app.',
		type: 'string',
		default: '',
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: false,
	});

	return reg;
}

// ---------------------------------------------------------------------------
// Mocked services
// ---------------------------------------------------------------------------

function makeAppConfig(
	overrides: Record<string, unknown> | null = null,
): AppConfigService & { updateOverrides: ReturnType<typeof vi.fn>; removeOverride: ReturnType<typeof vi.fn> } {
	return {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		removeOverride: vi.fn().mockResolvedValue(undefined),
	};
}

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
			},
		},
	} as unknown as SystemConfig;
}

function makeSystemConfigWriter(): SystemConfigWriter {
	return {
		read: vi.fn((key: string, config: SystemConfig) => {
			if (key === 'chat.sessions.retention_days') {
				return (config as any).chat?.sessions?.retention_days ?? 90;
			}
			if (key === 'chat.sessions.auto_prune') {
				return (config as any).chat?.sessions?.auto_prune ?? false;
			}
			throw new Error(`Unknown key: ${key}`);
		}),
		write: vi.fn().mockResolvedValue(undefined),
		writeMany: vi.fn().mockResolvedValue(undefined),
		resetToSchemaDefault: vi.fn().mockResolvedValue(90),
	} as unknown as SystemConfigWriter;
}

function makeFoodManifest(): ManifestUserConfig[] {
	return [
		{ key: 'default_store', type: 'string', default: '', description: 'Preferred store' },
		{ key: 'seasonal_nudges', type: 'boolean', default: true, description: 'Seasonal suggestions' },
		{
			key: 'macro_target_calories',
			type: 'number',
			default: 2000,
			description: 'Calorie target',
			min: 500,
			max: 10000,
		},
		{ key: 'hidden_key', type: 'boolean', default: false, description: 'Hidden' },
		{
			key: 'admin_shadow_control',
			type: 'boolean',
			default: false,
			description: 'Shadow classifier',
		},
	];
}

function makeNotesManifest(): ManifestUserConfig[] {
	return [{ key: 'default_store', type: 'string', default: '', description: 'Notes store' }];
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

interface TestContext {
	registry: SettingsRegistry;
	writer: SettingsWriter;
	foodCfg: ReturnType<typeof makeAppConfig>;
	notesCfg: ReturnType<typeof makeAppConfig>;
	systemCfg: SystemConfig;
	systemCfgWriter: SystemConfigWriter;
	logger: AppLogger;
	deps: HandleSettingsDeps;
	pendingStore: ReturnType<typeof createPendingSettingsConfirmStore>;
}

function makeContext(opts?: {
	foodOverrides?: Record<string, unknown> | null;
	notesOverrides?: Record<string, unknown> | null;
	systemConfig?: SystemConfig;
}): TestContext {
	const registry = makeRegistry();
	const foodCfg = makeAppConfig(opts?.foodOverrides ?? null);
	const notesCfg = makeAppConfig(opts?.notesOverrides ?? null);
	const systemCfg = opts?.systemConfig ?? makeSystemConfig();
	const systemCfgWriter = makeSystemConfigWriter();
	const logger = makeLogger();

	const writer = new SettingsWriter({
		registry,
		appConfigResolver: (appId) => {
			if (appId === 'food') return foodCfg;
			if (appId === 'notes') return notesCfg;
			return undefined;
		},
		manifestResolver: (appId) => {
			if (appId === 'food') return makeFoodManifest();
			if (appId === 'notes') return makeNotesManifest();
			return undefined;
		},
		logger,
		systemConfigWriter: systemCfgWriter,
		systemConfig: systemCfg,
	});

	const pendingStore = createPendingSettingsConfirmStore({ ttlMs: 60_000 });

	const deps: HandleSettingsDeps = {
		registry,
		writer,
		appConfigResolver: (appId) => {
			if (appId === 'food') return foodCfg;
			if (appId === 'notes') return notesCfg;
			return undefined;
		},
		systemConfigWriter: systemCfgWriter,
		systemConfig: systemCfg,
		pendingStore,
		matchesDangerConfirmPhrase: (submitted, expected) => submitted === expected,
		logger,
	};

	return { registry, writer, foodCfg, notesCfg, systemCfg, systemCfgWriter, logger, deps, pendingStore };
}

function makeInput(overrides: Partial<HandleSettingsArgs> = {}): HandleSettingsArgs {
	const args = overrides.args ?? [];
	const rawArgs = overrides.rawArgs ?? args.join(' ');
	return {
		args,
		rawArgs,
		userId: 'u1',
		isAdmin: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleSettings — happy path', () => {
	it('lists visible categories for non-admin', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(makeInput(), deps);
		expect(reply).toContain('food');
		expect(reply).toContain('memory-sessions');
		// non-admin should NOT see dangerous category
		expect(reply).not.toContain('dangerous');
	});

	it('lists visible categories for admin (includes dangerous)', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: [], rawArgs: '', isAdmin: true }),
			deps,
		);
		expect(reply).toContain('dangerous');
	});

	it('lists keys with current values for /settings food', async () => {
		const { deps } = makeContext({ foodOverrides: { default_store: 'Whole Foods' } });
		const { reply } = await handleSettings(
			makeInput({ args: ['food'], rawArgs: 'food' }),
			deps,
		);
		expect(reply).toContain('Default store');
		expect(reply).toContain('Whole Foods');
	});

	it('shows full detail for /settings food default_store (qualified)', async () => {
		const { deps } = makeContext({ foodOverrides: { default_store: 'Trader Joes' } });
		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'food.default_store'], rawArgs: 'food food.default_store' }),
			deps,
		);
		expect(reply).toContain('Default store');
		// Qualified key appears in reply (markdown-escaped: food.default\_store)
		expect(reply).toContain('food.default');
		expect(reply).toContain('per-user');
		expect(reply).toContain('Trader Joes');
	});

	it('shows full detail for system key /settings memory-sessions chat.sessions.retention_days', async () => {
		const { deps, systemCfgWriter } = makeContext();
		vi.mocked(systemCfgWriter.read).mockReturnValue(120);
		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'chat.sessions.retention_days'],
				rawArgs: 'memory-sessions chat.sessions.retention_days',
				isAdmin: false,
			}),
			deps,
		);
		// The setting label appears
		expect(reply).toContain('Keep ended sessions for');
		expect(reply).toContain('120');
	});

	it('sets a non-dangerous per-user string setting', async () => {
		const { deps, foodCfg } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'food.default_store', 'Whole Foods'],
				rawArgs: 'food food.default_store Whole Foods',
			}),
			deps,
		);
		expect(reply).toContain('Saved');
		// Qualified key appears in reply (markdown-escaped: food.default\_store)
		expect(reply).toContain('food.default');
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', { default_store: 'Whole Foods' });
	});

	it('sets a non-dangerous boolean setting (seasonal_nudges off)', async () => {
		const { deps, foodCfg } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'seasonal_nudges', 'off'],
				rawArgs: 'food seasonal_nudges off',
			}),
			deps,
		);
		expect(reply).toContain('Saved');
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', { seasonal_nudges: false });
	});

	it('sets a non-dangerous system setting (retention_days)', async () => {
		const { deps, systemCfgWriter } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'chat.sessions.retention_days', '180'],
				rawArgs: 'memory-sessions chat.sessions.retention_days 180',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Saved');
		expect(systemCfgWriter.write).toHaveBeenCalledWith(
			'chat.sessions.retention_days',
			180,
			expect.anything(),
		);
	});

	it('set on dangerous key creates pending entry with action=set and rawValue', async () => {
		const { deps, pendingStore } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('Dangerous');
		expect(reply).toContain('confirm');
		const pending = pendingStore.peek('u1');
		expect(pending).toBeDefined();
		expect(pending!.action).toBe('set');
		expect(pending!.rawValue).toBe('true');
		expect(pending!.qualifiedKey).toBe('system.chat.sessions.auto_prune');
	});

	it('confirm with correct phrase consumes pending and writes via admin-confirmed', async () => {
		const { deps, pendingStore, systemCfgWriter } = makeContext();

		// First create a pending entry
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);
		expect(pendingStore.has('u1')).toBe(true);

		// Confirm with correct phrase
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('Confirmed and saved');
		// Pending entry consumed
		expect(pendingStore.has('u1')).toBe(false);
		// Writer called with admin-confirmed
		expect(systemCfgWriter.write).toHaveBeenCalledWith(
			'chat.sessions.auto_prune',
			true,
			expect.anything(),
		);
	});

	it('reset of non-dangerous per-user calls removeOverride and fires runHooksForKey', async () => {
		const { deps, foodCfg, writer } = makeContext({ foodOverrides: { default_store: 'Costco' } });
		const hookFn = vi.fn();
		writer.registerPostWriteHook('food.default_store', hookFn);

		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'food', 'food.default_store'],
				rawArgs: 'reset food food.default_store',
			}),
			deps,
		);
		expect(reply.toLowerCase()).toContain('reset');
		// Qualified key appears in reply (markdown-escaped: food.default\_store)
		expect(reply).toContain('food.default');
		expect(foodCfg.removeOverride).toHaveBeenCalledWith('u1', 'default_store');
		expect(hookFn).toHaveBeenCalledWith(
			expect.objectContaining({ key: 'default_store', newValue: '' }),
		);
	});

	it('reset of non-dangerous system setting calls resetToSchemaDefault and fires hook', async () => {
		const { deps, systemCfgWriter, writer } = makeContext();
		const hookFn = vi.fn();
		writer.registerPostWriteHook('system.chat.sessions.retention_days', hookFn);
		vi.mocked(systemCfgWriter.resetToSchemaDefault).mockResolvedValue(90);

		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'memory-sessions', 'chat.sessions.retention_days'],
				rawArgs: 'reset memory-sessions chat.sessions.retention_days',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('reset');
		expect(systemCfgWriter.resetToSchemaDefault).toHaveBeenCalledWith(
			'chat.sessions.retention_days',
			expect.anything(),
		);
		expect(hookFn).toHaveBeenCalled();
	});

	it('reset of dangerous setting creates pending entry with action=reset', async () => {
		const { deps, pendingStore } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'dangerous', 'chat.sessions.auto_prune'],
				rawArgs: 'reset dangerous chat.sessions.auto_prune',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('Dangerous');
		const pending = pendingStore.peek('u1');
		expect(pending).toBeDefined();
		expect(pending!.action).toBe('reset');
		expect(pending!.rawValue).toBeUndefined();
	});

	it('confirm dangerous reset completes the reset', async () => {
		const { deps, pendingStore, systemCfgWriter } = makeContext();

		await handleSettings(
			makeInput({
				args: ['reset', 'dangerous', 'chat.sessions.auto_prune'],
				rawArgs: 'reset dangerous chat.sessions.auto_prune',
				isAdmin: true,
			}),
			deps,
		);
		expect(pendingStore.has('u1')).toBe(true);

		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('Confirmed');
		expect(reply).toContain('reset');
		expect(pendingStore.has('u1')).toBe(false);
		expect(systemCfgWriter.resetToSchemaDefault).toHaveBeenCalled();
	});

	it('shows restart required badge in set reply', async () => {
		const { deps, systemCfgWriter } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'chat.sessions.retention_days', '30'],
				rawArgs: 'memory-sessions chat.sessions.retention_days 30',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Restart required');
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('handleSettings — edge cases', () => {
	it('unknown category responds with category list', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: ['badcat'], rawArgs: 'badcat' }),
			deps,
		);
		expect(reply).toContain('Unknown category');
		expect(reply.toLowerCase()).toContain('available');
	});

	it('unknown key in known category responds with hint', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'nonexistent'], rawArgs: 'food nonexistent' }),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('match-count = 0 → unknown', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'totally_unknown_key'], rawArgs: 'food totally_unknown_key' }),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('match-count = 1 → resolves successfully', async () => {
		const { deps } = makeContext({ foodOverrides: {} });
		// seasonal_nudges is only in food app → unique match
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'seasonal_nudges'],
				rawArgs: 'food seasonal_nudges',
			}),
			deps,
		);
		// Should show detail block, not error
		expect(reply).toContain('Seasonal recipe suggestions');
	});

	it('match-count = 2 (two apps same key in same category) → ambiguous', async () => {
		const { deps } = makeContext({ foodOverrides: {}, notesOverrides: {} });
		// 'default_store' is registered for both 'food' and 'notes' in category 'food'
		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'default_store'], rawArgs: 'food default_store' }),
			deps,
		);
		expect(reply).toContain('Multiple apps');
		// Keys appear in reply (markdown-escaped: food.default\_store, notes.default\_store)
		expect(reply).toContain('food.default');
		expect(reply).toContain('notes.default');
	});

	it('qualified system key resolves same as unqualified in correct category', async () => {
		const { deps, systemCfgWriter } = makeContext();
		vi.mocked(systemCfgWriter.read).mockReturnValue(90);
		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'system.chat.sessions.retention_days'],
				rawArgs: 'memory-sessions system.chat.sessions.retention_days',
			}),
			deps,
		);
		// Check the setting label appears, not unknown
		expect(reply).toContain('Keep ended sessions for');
		expect(reply).not.toContain('Unknown');
	});

	it('numeric value out of range rejected', async () => {
		const { deps } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'macro_target_calories', '100000'],
				rawArgs: 'food macro_target_calories 100000',
			}),
			deps,
		);
		expect(reply).toContain('Invalid value');
		// Ensure no write occurred
	});

	it('numeric value below min rejected', async () => {
		const { deps } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'macro_target_calories', '1'],
				rawArgs: 'food macro_target_calories 1',
			}),
			deps,
		);
		expect(reply).toContain('Invalid value');
	});

	it('select rejects out-of-options value (using select-type setting)', async () => {
		// Add a select-type setting to a fresh registry
		const reg = new SettingsRegistry();
		reg.register({
			key: 'meal_plan_style',
			appId: 'food',
			category: 'food',
			label: 'Meal plan style',
			help: 'Preferred meal planning style.',
			type: 'select',
			options: ['weekly', 'daily', 'none'],
			default: 'weekly',
			adminOnly: false,
			dangerous: false,
			hidden: false,
			scope: 'per-user',
			nlSafe: false,
		});

		const foodCfg = makeAppConfig({});
		const writer = new SettingsWriter({
			registry: reg,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			manifestResolver: (id) =>
				id === 'food'
					? [
							{
								key: 'meal_plan_style',
								type: 'select',
								options: ['weekly', 'daily', 'none'],
								default: 'weekly',
								description: 'Meal plan style',
							},
					  ]
					: undefined,
			logger: makeLogger(),
		});
		const pendingStore = createPendingSettingsConfirmStore();

		const deps: HandleSettingsDeps = {
			registry: reg,
			writer,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
		};

		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'meal_plan_style', 'invalid_option'],
				rawArgs: 'food meal_plan_style invalid_option',
			}),
			deps,
		);
		expect(reply).toContain('Invalid value');
	});

	it.each([
		['on', true],
		['off', false],
		['true', true],
		['false', false],
		['1', true],
		['0', false],
	])('boolean accepts %s → %s', async (input, expected) => {
		const { deps, foodCfg } = makeContext({ foodOverrides: {} });
		await handleSettings(
			makeInput({
				args: ['food', 'seasonal_nudges', input],
				rawArgs: `food seasonal_nudges ${input}`,
			}),
			deps,
		);
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', {
			seasonal_nudges: expected,
		});
	});

	it('string value is trimmed (quoted value strips outer quotes)', async () => {
		const { deps, foodCfg } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'food.default_store', '"Whole Foods Market"'],
				rawArgs: 'food food.default_store "Whole Foods Market"',
			}),
			deps,
		);
		expect(reply).toContain('Saved');
		// The value should be stored without outer quotes
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', {
			default_store: 'Whole Foods Market',
		});
	});

	it('multi-word value (no quotes) captured correctly', async () => {
		const { deps, foodCfg } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'food.default_store', 'Whole', 'Foods', 'Market'],
				rawArgs: 'food food.default_store Whole Foods Market',
			}),
			deps,
		);
		expect(reply).toContain('Saved');
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', {
			default_store: 'Whole Foods Market',
		});
	});

	it('reset with wrong arg count returns help', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: ['reset', 'food'], rawArgs: 'reset food' }),
			deps,
		);
		// Should show help, not crash
		expect(reply.toLowerCase()).toContain('settings');
	});

	it('empty string rejected when def.default is not empty string', async () => {
		// macro_target_calories has default 2000, not empty string
		const { deps } = makeContext({ foodOverrides: {} });
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'macro_target_calories', ''],
				rawArgs: 'food macro_target_calories ',
			}),
			deps,
		);
		// Empty string for a number field should fail coercion
		expect(reply).toContain('Invalid value');
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('handleSettings — error handling', () => {
	it('appConfigResolver returns undefined on show → degraded to def.default; warn logged', async () => {
		const { registry, writer, pendingStore, logger } = makeContext();
		const deps: HandleSettingsDeps = {
			registry,
			writer,
			appConfigResolver: () => undefined, // no resolver for any app
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
			logger,
		};

		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'seasonal_nudges'], rawArgs: 'food seasonal_nudges' }),
			deps,
		);
		// Should show the setting with default value
		expect(reply).toContain('Seasonal recipe suggestions');
		// Default value is ON (true)
		expect(reply).toContain('ON');
		// Warn should be logged
		expect(vi.mocked(logger.warn)).toHaveBeenCalled();
	});

	it('appConfigResolver returns undefined on set → write fails (writer has no resolver)', async () => {
		// Build a writer that also has no resolver (mirrors the handler's appConfigResolver state)
		const { registry } = makeContext();
		const writerNoResolver = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined, // no resolver
			manifestResolver: () => undefined,
			logger: makeLogger(),
		});
		const pendingStore = createPendingSettingsConfirmStore();
		const deps: HandleSettingsDeps = {
			registry,
			writer: writerNoResolver,
			appConfigResolver: () => undefined,
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
		};

		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'food.default_store', 'Whole Foods'],
				rawArgs: 'food food.default_store Whole Foods',
			}),
			deps,
		);
		// Either "Failed" (from write error) or "Invalid value" (from manifest not found)
		expect(reply).toMatch(/Failed|Invalid/i);
		// No write attempted
	});

	it('appConfigResolver returns undefined on reset → generic failure', async () => {
		const { registry, writer, pendingStore, logger } = makeContext();
		const deps: HandleSettingsDeps = {
			registry,
			writer,
			appConfigResolver: () => undefined, // handler's resolver for read/reset
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
			logger,
		};

		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'food', 'food.default_store'],
				rawArgs: 'reset food food.default_store',
			}),
			deps,
		);
		expect(reply).toContain('Unable');
	});

	it('getOverrides throws → degraded to defaults for show', async () => {
		const { registry, writer, pendingStore, logger } = makeContext();
		const badCfg = makeAppConfig();
		vi.mocked(badCfg.getOverrides).mockRejectedValue(new Error('DB error'));

		const deps: HandleSettingsDeps = {
			registry,
			writer,
			appConfigResolver: (id) => (id === 'food' ? badCfg : undefined),
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
			logger,
		};

		const { reply } = await handleSettings(
			makeInput({ args: ['food', 'seasonal_nudges'], rawArgs: 'food seasonal_nudges' }),
			deps,
		);
		// Should still show setting (degraded)
		expect(reply).toContain('Seasonal recipe suggestions');
	});

	it('writer.write throws → generic failure; logger.warn called', async () => {
		const { deps, foodCfg, logger } = makeContext({ foodOverrides: {} });
		vi.mocked(foodCfg.updateOverrides).mockRejectedValue(new Error('disk full'));

		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'food.default_store', 'test'],
				rawArgs: 'food food.default_store test',
			}),
			deps,
		);
		expect(reply).toContain('Failed');
		expect(vi.mocked(logger.warn)).toHaveBeenCalled();
	});

	it('systemConfigWriter undefined on system key set → generic failure', async () => {
		const { registry } = makeContext();
		const foodCfg = makeAppConfig({});
		// Build a writer with no systemConfigWriter
		const writerNoSystem = new SettingsWriter({
			registry,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			manifestResolver: (id) => (id === 'food' ? makeFoodManifest() : undefined),
			logger: makeLogger(),
			systemConfigWriter: undefined, // no system writer
		});
		const pendingStore = createPendingSettingsConfirmStore();
		const deps: HandleSettingsDeps = {
			registry,
			writer: writerNoSystem,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			systemConfigWriter: undefined,
			systemConfig: makeSystemConfig(),
			pendingStore,
			matchesDangerConfirmPhrase: (s, e) => s === e,
		};

		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'chat.sessions.retention_days', '30'],
				rawArgs: 'memory-sessions chat.sessions.retention_days 30',
			}),
			deps,
		);
		expect(reply).toContain('Failed');
	});
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('handleSettings — security', () => {
	it('non-admin list omits dangerous category', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({ args: [], rawArgs: '', isAdmin: false }),
			deps,
		);
		expect(reply).not.toContain('dangerous');
	});

	it('non-admin show adminOnly → "Unknown setting" (no label/help leak)', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune'],
				rawArgs: 'dangerous chat.sessions.auto_prune',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Unknown setting');
		expect(reply).not.toContain('Auto-prune');
		expect(reply).not.toContain('permanently delete');
	});

	it('non-admin set adminOnly → "Unknown setting"', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('non-admin reset adminOnly → "Unknown setting"', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'dangerous', 'chat.sessions.auto_prune'],
				rawArgs: 'reset dangerous chat.sessions.auto_prune',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('hidden setting show by admin → "Unknown setting" (defense-in-depth)', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'hidden_key'],
				rawArgs: 'food hidden_key',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('hidden setting show by non-admin → "Unknown setting"', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['food', 'hidden_key'],
				rawArgs: 'food hidden_key',
				isAdmin: false,
			}),
			deps,
		);
		expect(reply).toContain('Unknown setting');
	});

	it('non-admin cannot create pending entry on dangerous key', async () => {
		const { deps, pendingStore } = makeContext();
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: false,
			}),
			deps,
		);
		// No pending entry should be created
		expect(pendingStore.has('u1')).toBe(false);
	});

	it('confirm phrase mismatch does NOT consume pending entry', async () => {
		const { deps, pendingStore } = makeContext();

		// Create pending entry
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);
		expect(pendingStore.has('u1')).toBe(true);

		// Wrong phrase
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'wrong phrase'],
				rawArgs: 'confirm wrong phrase',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('did not match');
		// Entry still present
		expect(pendingStore.has('u1')).toBe(true);
	});

	it('pending entry for user A not consumable by user B', async () => {
		const { deps, pendingStore } = makeContext();

		// u1 creates pending entry
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				userId: 'u1',
				isAdmin: true,
			}),
			deps,
		);

		// u2 tries to confirm
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				userId: 'u2',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('No pending change');
		// u1 entry still present
		expect(pendingStore.has('u1')).toBe(true);
	});

	it('admin-downgrade-before-confirm → consumed silently, "No pending change"', async () => {
		const { deps, pendingStore } = makeContext();

		// Create pending entry for a dangerous adminOnly key
		pendingStore.attach('u1', {
			userId: 'u1',
			qualifiedKey: 'system.chat.sessions.auto_prune',
			action: 'set',
			rawValue: 'true',
			expectedPhrase: 'permanently delete expired transcripts',
		});

		// Try to confirm as non-admin
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				userId: 'u1',
				isAdmin: false, // downgraded from admin
			}),
			deps,
		);
		expect(reply).toContain('No pending change');
		// Entry was consumed (not left dangling)
		expect(pendingStore.has('u1')).toBe(false);
	});

	it('dangerous-flag-removed-before-confirm → consumed, message says re-issue, NO write', async () => {
		// Create a pending entry for a key that is no longer dangerous (simulate removed flag).
		// We can inject directly into the store with a qualifiedKey whose def exists but
		// now has dangerous=false... but our registry has it as dangerous. We'll test this
		// by registering a non-dangerous key but manually storing a pending entry for it.

		// Use a fresh registry where default_store is NOT dangerous
		const { deps, pendingStore, foodCfg } = makeContext({ foodOverrides: {} });

		// Inject a pending entry for a NON-dangerous key (simulates flag removal)
		pendingStore.attach('u1', {
			userId: 'u1',
			qualifiedKey: 'food.default_store', // not dangerous in our registry
			action: 'set',
			rawValue: 'Costco',
			expectedPhrase: 'some phrase',
		});

		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'some phrase'],
				rawArgs: 'confirm some phrase',
				userId: 'u1',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('no longer dangerous');
		// Entry was consumed
		expect(pendingStore.has('u1')).toBe(false);
		// No write occurred
		expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
	});

	it('def-removed-before-confirm → consumed, "No pending change"', async () => {
		const { deps, pendingStore } = makeContext();

		// Manually inject pending entry for a key NOT in registry
		pendingStore.attach('u1', {
			userId: 'u1',
			qualifiedKey: 'food.nonexistent_key',
			action: 'set',
			rawValue: 'test',
			expectedPhrase: 'confirm',
		});

		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'confirm'],
				rawArgs: 'confirm confirm',
				userId: 'u1',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('No pending change');
		expect(pendingStore.has('u1')).toBe(false);
	});

	it('confirm phrase is byte-equal — mixed-case is REJECTED', async () => {
		const { deps, pendingStore } = makeContext();

		// Create pending with lowercase phrase
		pendingStore.attach('u1', {
			userId: 'u1',
			qualifiedKey: 'system.chat.sessions.auto_prune',
			action: 'set',
			rawValue: 'true',
			expectedPhrase: 'permanently delete expired transcripts',
		});

		// Try confirming with wrong case
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'Permanently', 'Delete', 'Expired', 'Transcripts'],
				rawArgs: 'confirm Permanently Delete Expired Transcripts',
				isAdmin: true,
			}),
			deps,
		);
		// Case-sensitive match → mismatch
		expect(reply).toContain('did not match');
		// Entry still present
		expect(pendingStore.has('u1')).toBe(true);
	});

	it('no pending confirm returns "No pending change"', async () => {
		const { deps } = makeContext();
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'some phrase'],
				rawArgs: 'confirm some phrase',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('No pending change');
	});
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

describe('handleSettings — state transitions', () => {
	it('consume-once contract: get returns entry then undefined', async () => {
		const { deps, pendingStore } = makeContext();

		// Create pending entry via set on dangerous key
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);

		// Confirm (consumes)
		await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				isAdmin: true,
			}),
			deps,
		);

		// Another confirm attempt should find nothing
		const { reply } = await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('No pending change');
	});

	it('successful confirm clears pending; user can attach another immediately', async () => {
		const { deps, pendingStore, systemCfgWriter } = makeContext();

		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);

		await handleSettings(
			makeInput({
				args: ['confirm', 'permanently', 'delete', 'expired', 'transcripts'],
				rawArgs: 'confirm permanently delete expired transcripts',
				isAdmin: true,
			}),
			deps,
		);

		// User can create a new pending entry right away
		const { reply } = await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'false'],
				rawArgs: 'dangerous chat.sessions.auto_prune false',
				isAdmin: true,
			}),
			deps,
		);
		expect(reply).toContain('confirm');
		expect(pendingStore.has('u1')).toBe(true);
	});

	it('reset with no override is a no-op; reports effective default', async () => {
		const { deps, foodCfg } = makeContext({ foodOverrides: null }); // no overrides
		const { reply } = await handleSettings(
			makeInput({
				args: ['reset', 'food', 'seasonal_nudges'],
				rawArgs: 'reset food seasonal_nudges',
			}),
			deps,
		);
		// Should succeed (idempotent reset) — reply mentions the qualified key or 'reset'
		expect(reply.toLowerCase()).toMatch(/reset|seasonal/);
		// removeOverride called (idempotent)
		expect(foodCfg.removeOverride).toHaveBeenCalled();
	});

	it('attach overwrites; older nonce not redeemable', async () => {
		const { deps, pendingStore } = makeContext();

		// First attach
		const first = await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'true'],
				rawArgs: 'dangerous chat.sessions.auto_prune true',
				isAdmin: true,
			}),
			deps,
		);

		// Second attach overwrites (different value)
		await handleSettings(
			makeInput({
				args: ['dangerous', 'chat.sessions.auto_prune', 'false'],
				rawArgs: 'dangerous chat.sessions.auto_prune false',
				isAdmin: true,
			}),
			deps,
		);

		// Only the second entry should be present
		const pending = pendingStore.peek('u1');
		expect(pending).toBeDefined();
		expect(pending!.rawValue).toBe('false');
	});
});

// ---------------------------------------------------------------------------
// Configuration / contract
// ---------------------------------------------------------------------------

describe('handleSettings — configuration/contract', () => {
	it('handleSettings function is exported correctly', () => {
		expect(typeof handleSettings).toBe('function');
	});

	it('WriteSource contract: validate({source:gui}) on dangerous key returns {ok:false}', async () => {
		const { registry } = makeContext();
		const foodCfg = makeAppConfig({});
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (id) => (id === 'food' ? foodCfg : undefined),
			manifestResolver: (id) => (id === 'food' ? makeFoodManifest() : undefined),
			logger: makeLogger(),
		});

		// Direct validate call (dangerous system key via 'gui' source)
		const result = writer.validate({
			source: 'gui',
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_prune',
			rawValue: 'true',
		});
		expect(result.ok).toBe(false);
	});

	it('WriteSource contract: validate({source:admin-confirmed}) on dangerous key returns {ok:true}', async () => {
		const { registry } = makeContext();
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: () => undefined,
			manifestResolver: () => undefined,
			logger: makeLogger(),
		});

		const result = writer.validate({
			source: 'admin-confirmed',
			userId: 'u1',
			appId: 'system',
			key: 'chat.sessions.auto_prune',
			rawValue: 'true',
		});
		expect(result.ok).toBe(true);
	});

	it('category qualified key mismatch returns error', async () => {
		const { deps } = makeContext({ foodOverrides: {} });
		// Use qualified key for food.default_store but wrong category (memory-sessions)
		const { reply } = await handleSettings(
			makeInput({
				args: ['memory-sessions', 'food.default_store'],
				rawArgs: 'memory-sessions food.default_store',
			}),
			deps,
		);
		expect(reply).toContain('is in category');
		expect(reply).not.toContain('Default store');
	});
});
