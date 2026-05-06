/**
 * Handler-level integration tests — settings discoverability pipeline.
 *
 * Proves the full handler pipeline:
 *   PAS classifier → buildContextSnapshot → system prompt construction
 *   → LLM call → <config-set> processing → updateOverrides → delivery.
 *
 * Two tests:
 *   1. settings-catalog block appears in system prompt when settingsCandidate=true
 *   2. config-set response writes to correct app and tag is stripped before delivery
 *
 * Pattern follows handle-message.test.ts exactly — real SettingsRegistry +
 * SettingsWriter with mock AppConfigService; full handleMessage invocation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { SettingsRegistry } from '../../settings/settings-registry.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { handleMessage } from '../handle-message.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeChatSessions(): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({
			sessionId: 'session-1',
			isNew: true,
			snapshot: undefined,
		}),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
	};
}

/** Build a minimal SettingsRegistry with food.seasonal_nudges registered. */
function makeRegistryWithFoodSetting(): SettingsRegistry {
	const reg = new SettingsRegistry();
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
		// Regex matches the user message used in tests below
		nlIntentRegex: /(turn|switch|enable|disable|stop|start).*(seasonal|season)/i,
	});
	return reg;
}

const FOOD_MANIFEST_ENTRIES: ManifestUserConfig[] = [
	{
		key: 'seasonal_nudges',
		type: 'boolean',
		default: true,
		description: 'Send seasonal produce suggestions',
	},
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('handleMessage — settings-catalog in system prompt (P3 handler-level)', () => {
	let services: ReturnType<typeof createMockCoreServices>;
	let chatSessions: ChatSessionStore;

	beforeEach(() => {
		services = createMockCoreServices();
		chatSessions = makeChatSessions();
	});

	it('settings catalog appears in system prompt when settingsCandidate=true', async () => {
		const registry = makeRegistryWithFoodSetting();
		const foodCfg = {
			updateOverrides: vi.fn().mockResolvedValue(undefined),
			getOverrides: vi.fn().mockResolvedValue({}),
			getAll: vi.fn().mockResolvedValue({}),
			setAll: vi.fn(),
			get: vi.fn(),
		};
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (appId) => (appId === 'food' ? (foodCfg as never) : undefined),
			manifestResolver: (appId) => (appId === 'food' ? FOOD_MANIFEST_ENTRIES : undefined),
			logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		});

		// Snapshot with settingsCatalog
		const retrieval = {
			buildContextSnapshot: vi.fn().mockResolvedValue({
				failures: [],
				settingsCatalog:
					'## Your settings\n- Seasonal recipe suggestions (food.seasonal_nudges): ON',
				settingsTrustedInstructions: 'food.seasonal_nudges (boolean)',
			}),
			buildMemorySnapshot: vi.fn().mockResolvedValue({
				content: '',
				status: 'empty',
				builtAt: '',
				entryCount: 0,
			}),
			buildSettingsCatalog: vi.fn().mockResolvedValue({ catalog: '', trustedInstructions: '' }),
			searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
			hasSessionSearch: vi.fn().mockReturnValue(false),
		};

		// auto_detect_pas ON so classifyPASMessage is called
		const config = {
			getAll: vi.fn().mockResolvedValue({ auto_detect_pas: true }),
			getOverrides: vi.fn().mockResolvedValue({}),
			updateOverrides: vi.fn().mockResolvedValue(undefined),
		} as never;

		// Stub LLM:
		//   call 1 — PAS classifier → YES_SETTINGS YES (triggers settingsCandidate=true)
		//   call 2 — main LLM answer
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES_SETTINGS YES')
			.mockResolvedValueOnce('Sure thing!');

		const ctx = createTestMessageContext({
			text: 'how do I change my seasonal nudges setting?',
		});

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
			config,
			conversationRetrieval: retrieval as never,
			settingsRegistry: registry,
			settingsWriter: writer,
		});

		// 1. buildContextSnapshot was called with settingsCandidate=true
		expect(retrieval.buildContextSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ settingsCandidate: true }),
		);

		// 2. The SECOND llm.complete call (main call) received a system prompt
		//    containing the settings-catalog memory block.
		const allCalls = vi.mocked(services.llm.complete).mock.calls;
		// The main LLM call is call index 1 (after classifier at index 0)
		const mainSystemPrompt = allCalls[1]?.[1]?.systemPrompt ?? '';
		expect(mainSystemPrompt).toContain('<memory-context label="settings-catalog">');
		expect(mainSystemPrompt).toContain('food.seasonal_nudges');
	});

	it('config-set response writes to correct app and is stripped before delivery', async () => {
		const registry = makeRegistryWithFoodSetting();
		const foodCfg = {
			updateOverrides: vi.fn().mockResolvedValue(undefined),
			getOverrides: vi.fn().mockResolvedValue({}),
			getAll: vi.fn().mockResolvedValue({}),
			setAll: vi.fn(),
			get: vi.fn(),
		};
		const writer = new SettingsWriter({
			registry,
			appConfigResolver: (appId) => (appId === 'food' ? (foodCfg as never) : undefined),
			manifestResolver: (appId) => (appId === 'food' ? FOOD_MANIFEST_ENTRIES : undefined),
			logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		});

		const retrieval = {
			buildContextSnapshot: vi.fn().mockResolvedValue({
				failures: [],
				settingsCatalog:
					'## Your settings\n- Seasonal recipe suggestions (food.seasonal_nudges): ON',
				settingsTrustedInstructions: 'food.seasonal_nudges (boolean)',
			}),
			buildMemorySnapshot: vi.fn().mockResolvedValue({
				content: '',
				status: 'empty',
				builtAt: '',
				entryCount: 0,
			}),
			buildSettingsCatalog: vi.fn().mockResolvedValue({ catalog: '', trustedInstructions: '' }),
			searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
			hasSessionSearch: vi.fn().mockReturnValue(false),
		};

		const config = {
			getAll: vi.fn().mockResolvedValue({ auto_detect_pas: true }),
			getOverrides: vi.fn().mockResolvedValue({}),
			updateOverrides: vi.fn().mockResolvedValue(undefined),
		} as never;

		// Stub LLM:
		//   call 1 — classifier returns YES_SETTINGS YES
		//   call 2 — main response contains a config-set tag for food.seasonal_nudges
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES_SETTINGS YES')
			.mockResolvedValueOnce(
				'Sure! I have disabled seasonal nudges for you. <config-set key="food.seasonal_nudges" value="false"/>',
			);

		// User message matches the food.seasonal_nudges nlIntentRegex
		const ctx = createTestMessageContext({
			text: 'turn off seasonal nudges',
		});

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
			config,
			conversationRetrieval: retrieval as never,
			settingsRegistry: registry,
			settingsWriter: writer,
		});

		// 1. food.updateOverrides was called with seasonal_nudges=false
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith(
			expect.any(String),
			{ seasonal_nudges: false },
		);

		// 2. The response delivered to Telegram does NOT contain the raw <config-set tag
		expect(services.telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			expect.not.stringContaining('<config-set'),
		);
	});
});
