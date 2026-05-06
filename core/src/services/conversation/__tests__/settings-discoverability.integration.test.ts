/**
 * Integration tests — real AppConfigServiceImpl backed by temp-dir filesystem.
 *
 * Proves cross-write isolation and live catalog reads using real disk I/O.
 *
 * These tests do NOT mock AppConfigServiceImpl. Every write goes to a real
 * temp directory; every read comes back from the same directory.
 *
 * Four invariants under test:
 * 1. food.seasonal_nudges config-set → food YAML changes; chatbot YAML untouched.
 * 2. log_to_notes bare-key config-set → chatbot YAML changes; food YAML untouched.
 * 3. buildCatalog after both writes reflects live values (REQ-SETTINGS-012).
 * 4. Cross-write isolation: each YAML file holds only its own app's keys.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigServiceImpl } from '../../config/app-config-service.js';
import { SettingsRegistry } from '../../settings/settings-registry.js';
import { SettingsReader } from '../../settings/settings-reader.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import { processConfigSetTags, NOTES_INTENT_REGEX, MEMORY_FLUSH_INTENT_REGEX } from '../control-tags.js';
import { SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX } from '../control-tags/session-search-instruction.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import type { AppLogger } from '../../../types/app-module.js';

// ---------------------------------------------------------------------------
// Manifest entries (bare keys — as used by AppConfigServiceImpl defaults)
// ---------------------------------------------------------------------------

const CHATBOT_MANIFEST_ENTRIES: ManifestUserConfig[] = [
	{
		key: 'log_to_notes',
		type: 'boolean',
		default: false,
		description: 'Append every message to a daily-notes file',
	},
	{
		key: 'flush_memory_on_idle_reset',
		type: 'boolean',
		default: false,
		description: 'Save session summary on idle reset',
	},
	{
		key: 'session_search_tool_enabled',
		type: 'boolean',
		default: true,
		description: 'Allow mid-reply session search',
	},
];

const FOOD_MANIFEST_ENTRIES: ManifestUserConfig[] = [
	{
		key: 'seasonal_nudges',
		type: 'boolean',
		default: true,
		description: 'Send seasonal produce suggestions',
	},
	{
		key: 'default_store',
		type: 'string',
		default: '',
		description: 'Your preferred grocery store',
	},
];

// ---------------------------------------------------------------------------
// Registry builder (chatbot + food, NL-safe)
// ---------------------------------------------------------------------------

function makeRegistry(): SettingsRegistry {
	const reg = new SettingsRegistry();

	// Chatbot settings
	reg.register({
		key: 'log_to_notes',
		appId: 'chatbot',
		category: 'personal',
		label: 'Daily notes logging',
		help: 'Append each message to your daily notes.',
		type: 'boolean',
		default: false,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: NOTES_INTENT_REGEX,
	});
	reg.register({
		key: 'flush_memory_on_idle_reset',
		appId: 'chatbot',
		category: 'memory-sessions',
		label: 'Memory flush on session reset',
		help: 'Summarize session on idle reset.',
		type: 'boolean',
		default: false,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: MEMORY_FLUSH_INTENT_REGEX,
	});
	reg.register({
		key: 'session_search_tool_enabled',
		appId: 'chatbot',
		category: 'memory-sessions',
		label: 'Session search tool',
		help: 'Allow mid-reply session search.',
		type: 'boolean',
		default: true,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX,
	});

	// Food settings
	reg.register({
		key: 'seasonal_nudges',
		appId: 'food',
		category: 'food',
		label: 'Seasonal recipe suggestions',
		help: 'Weekly suggestions based on seasonal produce.',
		type: 'boolean',
		default: true,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'per-user',
		nlSafe: true,
		nlIntentRegex: /(turn|switch|enable|disable|stop|start).*(seasonal|season)/i,
	});
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
		nlIntentRegex: /(set|change|update).*default.*(store|grocery)/i,
	});

	return reg;
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('settings integration — real AppConfigServiceImpl (Task 3.9)', () => {
	let tempDir: string;
	let chatbotConfig: AppConfigServiceImpl;
	let foodConfig: AppConfigServiceImpl;
	let registry: SettingsRegistry;
	let reader: SettingsReader;
	let writer: SettingsWriter;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'settings-integration-'));

		// Real AppConfigServiceImpl instances pointing at the temp directory.
		// YAML paths resolve to:
		//   {tempDir}/system/app-config/chatbot/u1.yaml
		//   {tempDir}/system/app-config/food/u1.yaml
		chatbotConfig = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			defaults: CHATBOT_MANIFEST_ENTRIES,
		});
		foodConfig = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: FOOD_MANIFEST_ENTRIES,
		});

		registry = makeRegistry();

		const appConfigResolver = (id: string): AppConfigServiceImpl | undefined => {
			if (id === 'chatbot') return chatbotConfig;
			if (id === 'food') return foodConfig;
			return undefined;
		};

		const manifestResolver = (id: string): ManifestUserConfig[] | undefined => {
			if (id === 'chatbot') return CHATBOT_MANIFEST_ENTRIES;
			if (id === 'food') return FOOD_MANIFEST_ENTRIES;
			return undefined;
		};

		reader = new SettingsReader({
			registry,
			appConfigResolver,
			logger: makeLogger(),
		});

		writer = new SettingsWriter({
			registry,
			appConfigResolver,
			manifestResolver,
			logger: makeLogger(),
		});
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── Test 1 ────────────────────────────────────────────────────────────────
	it('food config-set writes to food YAML only; chatbot YAML untouched', async () => {
		// Process a food.seasonal_nudges config-set tag with a seasonal intent message.
		await processConfigSetTags(
			'<config-set key="food.seasonal_nudges" value="false"/>',
			{
				userId: 'u1',
				userMessage: 'turn off seasonal nudges',
				logger: makeLogger(),
				settingsRegistry: registry,
				settingsWriter: writer,
			},
		);

		// Food YAML was written with seasonal_nudges: false.
		const foodOverrides = await foodConfig.getOverrides('u1');
		expect(foodOverrides).not.toBeNull();
		expect(foodOverrides!.seasonal_nudges).toBe(false);

		// Chatbot YAML was NOT touched — getOverrides returns null (file absent).
		const chatbotOverrides = await chatbotConfig.getOverrides('u1');
		expect(chatbotOverrides).toBeNull();
	});

	// ── Test 2 ────────────────────────────────────────────────────────────────
	it('chatbot bare-key config-set writes to chatbot YAML only; food YAML untouched', async () => {
		// Process a bare log_to_notes config-set tag with a daily-notes intent message.
		await processConfigSetTags(
			'<config-set key="log_to_notes" value="true"/>',
			{
				userId: 'u1',
				userMessage: 'turn on daily notes',
				logger: makeLogger(),
				settingsRegistry: registry,
				settingsWriter: writer,
			},
		);

		// Chatbot YAML was written with log_to_notes: true.
		const chatbotOverrides = await chatbotConfig.getOverrides('u1');
		expect(chatbotOverrides).not.toBeNull();
		expect(chatbotOverrides!.log_to_notes).toBe(true);

		// Food YAML was NOT touched — getOverrides returns null (file absent).
		const foodOverrides = await foodConfig.getOverrides('u1');
		expect(foodOverrides).toBeNull();
	});

	// ── Test 3 ────────────────────────────────────────────────────────────────
	it('catalog reflects both live writes after direct updateOverrides (REQ-SETTINGS-012)', async () => {
		// Write both overrides directly (bypasses processConfigSetTags intent gates —
		// we're testing that buildCatalog reads LIVE values, not that NL flow works).
		await foodConfig.updateOverrides('u1', { seasonal_nudges: false });
		await chatbotConfig.updateOverrides('u1', { log_to_notes: true });

		// Build catalog and verify both values are reflected.
		const { catalog } = await reader.buildCatalog({ userId: 'u1', isAdmin: false });

		// Chatbot log_to_notes=true → ON (format: "- <label> (<appId>.<key>): <value>")
		expect(catalog).toContain('Daily notes logging (chatbot.log_to_notes): ON');
		// Food seasonal_nudges=false → OFF
		expect(catalog).toContain('Seasonal recipe suggestions (food.seasonal_nudges): OFF');
	});

	// ── Test 4 ────────────────────────────────────────────────────────────────
	it('cross-write isolation: each YAML file holds only its own app keys', async () => {
		// Write to both AppConfigServiceImpl instances.
		await chatbotConfig.updateOverrides('u1', { log_to_notes: true });
		await foodConfig.updateOverrides('u1', { seasonal_nudges: false });

		// Chatbot YAML should only contain chatbot keys.
		const chatbotOverrides = await chatbotConfig.getOverrides('u1');
		expect(chatbotOverrides).not.toBeNull();
		expect(chatbotOverrides!.log_to_notes).toBe(true);
		// Food key must NOT appear in the chatbot file.
		expect(chatbotOverrides!.seasonal_nudges).toBeUndefined();

		// Food YAML should only contain food keys.
		const foodOverrides = await foodConfig.getOverrides('u1');
		expect(foodOverrides).not.toBeNull();
		expect(foodOverrides!.seasonal_nudges).toBe(false);
		// Chatbot key must NOT appear in the food file.
		expect(foodOverrides!.log_to_notes).toBeUndefined();
	});
});
