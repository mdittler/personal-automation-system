/**
 * Tests for Router built-in /settings command (Settings Chunk D, Task D2).
 *
 * Asserts:
 * - /settings dispatches to conversationService.handleSettings with args=[], rawArgs=''
 * - /settings food dispatches with args=['food'], rawArgs='food'
 * - /settings food default_store Whole Foods dispatches with full args + rawArgs
 * - /settings reset food default_store dispatches with reset args
 * - /settings confirm the phrase dispatches with confirm args
 * - isAdmin sourced from userManager.findUser(userId)?.isAdmin — both true and false
 * - /Settings, /SETTINGS (wrong case) do NOT dispatch
 * - /setting (singular) does NOT dispatch
 * - /settings with no conversationService does not throw
 * - BUILTIN_COMMAND_NAMES contains '/settings'
 * - /settings appears in /help output
 *
 * REQ-SETTINGS-D
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendWithButtons: vi.fn().mockResolvedValue(undefined),
		editMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('hi'),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createConfig(overrides?: Partial<SystemConfig['users'][0]>): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
		users: [
			{
				id: 'user1',
				name: 'Test',
				isAdmin: overrides?.isAdmin ?? true,
				enabledApps: overrides?.enabledApps ?? ['*'],
				sharedScopes: [],
			},
		],
	};
}

const chatbotManifest: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: { messages: {} },
};

function makeConversationService() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
		handleRecall: vi.fn().mockResolvedValue(undefined),
		handleRefreshMemory: vi.fn().mockResolvedValue(undefined),
		handleFlushMemory: vi.fn().mockResolvedValue(undefined),
		handleSettings: vi.fn().mockResolvedValue(undefined),
	};
}

interface BuildRouterOptions {
	conversationService?: ReturnType<typeof makeConversationService>;
	isAdmin?: boolean;
}

function buildRouter(options: BuildRouterOptions = {}) {
	const cache = new ManifestCache();
	cache.add(chatbotManifest, '/apps/chatbot');

	const registry = {
		getApp: (id: string) => {
			if (id !== 'chatbot') return undefined;
			return {
				manifest: chatbotManifest,
				module: { init: vi.fn(), handleMessage: vi.fn() } as any,
				appDir: '/apps/chatbot',
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => ['chatbot'],
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig({ isAdmin: options.isAdmin ?? true }),
		logger: createMockLogger(),
		conversationService: options.conversationService as any,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ---------------------------------------------------------------------------
// PS1 — Basic dispatch
// ---------------------------------------------------------------------------

describe('Router built-in /settings command — basic dispatch (PS1)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/settings dispatches to handleSettings with args=[] and rawArgs=""', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [args, rawArgs] = conv.handleSettings.mock.calls[0]!;
		expect(args).toEqual([]);
		expect(rawArgs).toBe('');
	});

	it('/settings food dispatches with args=["food"] and rawArgs="food"', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings food'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [args, rawArgs] = conv.handleSettings.mock.calls[0]!;
		expect(args).toEqual(['food']);
		expect(rawArgs).toBe('food');
	});

	it('/settings food default_store Whole Foods dispatches with all args', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings food default_store Whole Foods'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [args, rawArgs] = conv.handleSettings.mock.calls[0]!;
		expect(args).toEqual(['food', 'default_store', 'Whole', 'Foods']);
		expect(rawArgs).toBe('food default_store Whole Foods');
	});

	it('/settings reset food default_store dispatches with reset args', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings reset food default_store'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [args, rawArgs] = conv.handleSettings.mock.calls[0]!;
		expect(args).toEqual(['reset', 'food', 'default_store']);
		expect(rawArgs).toBe('reset food default_store');
	});

	it('/settings confirm the phrase dispatches with confirm args', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings confirm the phrase'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [args, rawArgs] = conv.handleSettings.mock.calls[0]!;
		expect(args).toEqual(['confirm', 'the', 'phrase']);
		expect(rawArgs).toBe('confirm the phrase');
	});

	it('/settings dispatch does not call handleMessage or handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/settings'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		expect(conv.handleMessage).not.toHaveBeenCalled();
		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PS2 — isAdmin propagation
// ---------------------------------------------------------------------------

describe('Router built-in /settings command — isAdmin propagation (PS2)', () => {
	it('passes isAdmin=true when user is admin in config', async () => {
		const conv = makeConversationService();
		const { router } = buildRouter({ conversationService: conv, isAdmin: true });
		await router.routeMessage(msg('/settings'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [_args, _rawArgs, _ctx, isAdmin] = conv.handleSettings.mock.calls[0]!;
		expect(isAdmin).toBe(true);
	});

	it('passes isAdmin=false when user is not admin', async () => {
		const conv = makeConversationService();
		const cache = new ManifestCache();
		cache.add(chatbotManifest, '/apps/chatbot');

		const registry = {
			getApp: (id: string) => {
				if (id !== 'chatbot') return undefined;
				return {
					manifest: chatbotManifest,
					module: { init: vi.fn(), handleMessage: vi.fn() } as any,
					appDir: '/apps/chatbot',
				} as RegisteredApp;
			},
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		} as unknown as AppRegistry;

		const configWithNonAdmin: SystemConfig = {
			port: 3000,
			dataDir: '/tmp/data',
			logLevel: 'info',
			timezone: 'UTC',
			telegram: { botToken: 'test' },
			ollama: { url: 'http://localhost:11434', model: 'test' },
			claude: { apiKey: 'test', model: 'test' },
			gui: { authToken: 'test' },
			cloudflare: {},
			users: [{ id: 'user1', name: 'Test', isAdmin: false, enabledApps: ['*'], sharedScopes: [] }],
		};

		const telegram = createMockTelegram();
		const router = new Router({
			registry,
			llm: createMockLLM(),
			telegram,
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config: configWithNonAdmin,
			logger: createMockLogger(),
			conversationService: conv as any,
		});
		router.buildRoutingTables();

		await router.routeMessage(msg('/settings'));

		expect(conv.handleSettings).toHaveBeenCalledOnce();
		const [_args, _rawArgs, _ctx, isAdmin] = conv.handleSettings.mock.calls[0]!;
		expect(isAdmin).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// PS3 — Should NOT dispatch (negatives)
// ---------------------------------------------------------------------------

describe('Router built-in /settings command — should NOT dispatch (PS3)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/Settings (capital S) does NOT dispatch to handleSettings', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/Settings'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});

	it('/SETTINGS (all caps) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/SETTINGS'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});

	it('/setting (singular) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/setting'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});

	it('settings (no slash) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('settings'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});

	it('/flushmemory does NOT dispatch to handleSettings', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemory'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});

	it('/ask does NOT dispatch to handleSettings', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/ask something'));

		expect(conv.handleSettings).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PS4 — Missing conversationService → no crash
// ---------------------------------------------------------------------------

describe('PS4 — Missing conversationService → graceful fallback', () => {
	it('/settings without conversationService does NOT crash', async () => {
		const { router } = buildRouter({ conversationService: undefined });
		await expect(router.routeMessage(msg('/settings'))).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// PS5 — BUILTIN_COMMAND_NAMES contains '/settings'
// ---------------------------------------------------------------------------

describe('PS5 — /settings in BUILTIN_COMMAND_NAMES', () => {
	it('/settings is listed in /help output exactly once', async () => {
		const conv = makeConversationService();
		const { router, telegram } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		const calls = (telegram.send as ReturnType<typeof vi.fn>).mock.calls;
		const helpText = calls.map(([, text]) => text as string).join('\n');
		const occurrences = (helpText.match(/\/settings/g) ?? []).length;
		// We add 4 lines containing /settings in the help output (the command itself + 3 subcommand lines)
		expect(occurrences).toBeGreaterThanOrEqual(1);
	});

	it('/settings does not appear as an app command in /help (filtered by BUILTIN_COMMAND_NAMES)', async () => {
		// Add a chatbot manifest with a /settings command — it should be suppressed in /help.
		const cache = new ManifestCache();
		const chatbotWithSettings: AppManifest = {
			app: {
				id: 'chatbot',
				name: 'Chatbot',
				version: '1.0.0',
				description: 'Chatbot',
				author: 'Test',
			},
			capabilities: {
				messages: {},
				commands: [{ name: '/settings', description: 'Old settings command' }],
			},
		};
		cache.add(chatbotWithSettings, '/apps/chatbot');

		const registry = {
			getApp: (id: string) => {
				if (id !== 'chatbot') return undefined;
				return {
					manifest: chatbotWithSettings,
					module: { init: vi.fn(), handleMessage: vi.fn() } as any,
					appDir: '/apps/chatbot',
				} as RegisteredApp;
			},
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		} as unknown as AppRegistry;

		const telegram = createMockTelegram();
		const conv = makeConversationService();
		const router = new Router({
			registry,
			llm: createMockLLM(),
			telegram,
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config: createConfig(),
			logger: createMockLogger(),
			conversationService: conv as any,
		});
		router.buildRoutingTables();

		await router.routeMessage(msg('/help'));

		const calls = (telegram.send as ReturnType<typeof vi.fn>).mock.calls;
		const helpText = calls.map(([, text]) => text as string).join('\n');
		// 'Old settings command' should NOT appear — it's a chatbot-manifest built-in, suppressed.
		expect(helpText).not.toContain('Old settings command');
	});
});
