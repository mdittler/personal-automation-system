/**
 * Tests for Router built-in conversation commands (/ask, /edit, /notes).
 *
 * Asserts:
 * - each command dispatches to the correct ConversationService method
 * - route metadata is source:'command' with the correct intent
 * - @botname suffix is handled by the parser (pass-through)
 * - commands work regardless of chatbot toggle state
 * - /help lists conversation commands exactly once, with no duplicates
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
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

function createConfig(): SystemConfig {
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
		users: [{ id: 'user1', name: 'Test', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};
}

/** Minimal chatbot manifest with /ask, /edit, /notes as app commands (pre-Chunk-D state). */
const chatbotManifestWithCommands: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: {
		messages: {
			commands: [
				{ name: '/ask', description: 'Ask a question' },
				{ name: '/edit', description: 'Edit a file' },
				{ name: '/notes', description: 'Toggle daily notes' },
			],
		},
	},
};

/** Chatbot manifest with NO commands (post-Chunk-D state, for testing filter). */
const chatbotManifestNoCommands: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: { messages: {} },
};

function makeConversationService() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
	};
}

function buildRouter(options: {
	conversationService?: ReturnType<typeof makeConversationService>;
	chatbotManifest?: AppManifest;
	appToggle?: AppToggleStore;
}) {
	const cache = new ManifestCache();
	const manifest = options.chatbotManifest ?? chatbotManifestWithCommands;
	cache.add(manifest, '/apps/chatbot');

	const registry = {
		getApp: (id: string) => {
			if (id !== 'chatbot') return undefined;
			return { manifest, module: { init: vi.fn(), handleMessage: vi.fn() } as any, appDir: '/apps/chatbot' } as RegisteredApp;
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
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: options.conversationService as any,
		appToggle: options.appToggle,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

describe('Router built-in conversation commands', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	// ---------------------------------------------------------------------------
	// Happy path — each command dispatches to the correct method
	// ---------------------------------------------------------------------------

	it('/ask dispatches to handleAsk with parsed args and command route', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/ask what apps do I have'));

		expect(conv.handleAsk).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleAsk.mock.calls[0]!;
		expect(args).toEqual(['what', 'apps', 'do', 'I', 'have']);
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('ask');
		expect(ctx.route?.appId).toBe('chatbot');
		expect(ctx.route?.confidence).toBe(1.0);
	});

	it('/edit dispatches to handleEdit with parsed args and command route', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/edit fix typo in notes'));

		expect(conv.handleEdit).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleEdit.mock.calls[0]!;
		expect(args).toEqual(['fix', 'typo', 'in', 'notes']);
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('edit');
	});

	it('/notes dispatches to handleNotes with parsed args and command route', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/notes on'));

		expect(conv.handleNotes).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleNotes.mock.calls[0]!;
		expect(args).toEqual(['on']);
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('notes');
	});

	// ---------------------------------------------------------------------------
	// @botname suffix handling
	// ---------------------------------------------------------------------------

	it('/ask@PASBot dispatches correctly (parser strips @botname)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/ask@PASBot what is the cost'));

		expect(conv.handleAsk).toHaveBeenCalledOnce();
		const [args] = conv.handleAsk.mock.calls[0]!;
		expect(args).toEqual(['what', 'is', 'the', 'cost']);
	});

	it('/notes@PASBot status dispatches correctly', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/notes@PASBot status'));

		expect(conv.handleNotes).toHaveBeenCalledOnce();
		const [args] = conv.handleNotes.mock.calls[0]!;
		expect(args).toEqual(['status']);
	});

	it('/edit@PASBot fix typo dispatches correctly', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/edit@PASBot fix typo'));

		expect(conv.handleEdit).toHaveBeenCalledOnce();
		const [args] = conv.handleEdit.mock.calls[0]!;
		expect(args).toEqual(['fix', 'typo']);
	});

	// ---------------------------------------------------------------------------
	// Fall-through when ConversationService is not wired
	// ---------------------------------------------------------------------------

	it('/ask falls through to lookupCommand when conversationService is absent', async () => {
		// Build router with no conversationService — /ask is in the chatbot manifest,
		// so it should be dispatched via the legacy handleCommand path.
		const chatbotModule: AppModule = {
			init: vi.fn(),
			handleMessage: vi.fn(),
			handleCommand: vi.fn().mockResolvedValue(undefined),
		};
		const cache = new ManifestCache();
		cache.add(chatbotManifestWithCommands, '/apps/chatbot');
		const registry = {
			getApp: (id: string) =>
				id === 'chatbot'
					? ({ manifest: chatbotManifestWithCommands, module: chatbotModule, appDir: '/apps/chatbot' } as RegisteredApp)
					: undefined,
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		} as unknown as AppRegistry;
		const telegram = createMockTelegram();
		const router = new Router({
			registry,
			llm: createMockLLM(),
			telegram,
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config: createConfig(),
			logger: createMockLogger(),
			// no conversationService
		});
		router.buildRoutingTables();

		await router.routeMessage(msg('/ask what apps'));

		expect(chatbotModule.handleCommand).toHaveBeenCalledWith(
			'ask',
			['what', 'apps'],
			expect.objectContaining({ text: '/ask what apps' }),
		);
	});

	// ---------------------------------------------------------------------------
	// Toggle bypass: /ask works even when chatbot is toggled off
	// ---------------------------------------------------------------------------

	it('/ask bypasses chatbot toggle — still dispatches to ConversationService when chatbot is toggled off', async () => {
		const appToggle: AppToggleStore = {
			isEnabled: vi.fn().mockImplementation((userId: string, appId: string) =>
				appId !== 'chatbot', // chatbot is OFF
			),
		} as unknown as AppToggleStore;

		const { router } = buildRouter({ conversationService: conv, appToggle });
		await router.routeMessage(msg('/ask what apps'));

		// Built-in dispatch precedes toggle check — conv.handleAsk must be called
		expect(conv.handleAsk).toHaveBeenCalledOnce();
	});
});

describe('Router /help with conversation built-ins', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/help lists /ask, /edit, /notes exactly once when conversationService is wired', async () => {
		// Use chatbot manifest WITH commands — the filter should still produce only one each
		const { telegram, router } = buildRouter({ conversationService: conv, chatbotManifest: chatbotManifestWithCommands });
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		expect(helpText).toBeDefined();

		const askCount = (helpText.match(/\/ask/g) ?? []).length;
		const editCount = (helpText.match(/\/edit/g) ?? []).length;
		const notesCount = (helpText.match(/\/notes/g) ?? []).length;
		expect(askCount).toBe(1);
		expect(editCount).toBe(1);
		expect(notesCount).toBe(1);
	});

	it('/help lists conversation commands when chatbot manifest has no commands', async () => {
		const { telegram, router } = buildRouter({ conversationService: conv, chatbotManifest: chatbotManifestNoCommands });
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		expect(helpText).toContain('/ask');
		expect(helpText).toContain('/edit');
		expect(helpText).toContain('/notes');
	});

	it('/help does NOT list conversation commands when conversationService is absent', async () => {
		// No conversationService — legacy chatbot manifest with the commands
		const cache = new ManifestCache();
		cache.add(chatbotManifestWithCommands, '/apps/chatbot');
		const registry = {
			getApp: (id: string) =>
				id === 'chatbot'
					? ({ manifest: chatbotManifestWithCommands, module: { init: vi.fn(), handleMessage: vi.fn() } as any, appDir: '/apps/chatbot' } as RegisteredApp)
					: undefined,
			getManifestCache: () => cache,
			getLoadedAppIds: () => ['chatbot'],
		} as unknown as AppRegistry;
		const telegram = createMockTelegram();
		const router = new Router({
			registry,
			llm: createMockLLM(),
			telegram,
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config: createConfig(),
			logger: createMockLogger(),
			// no conversationService
		});
		router.buildRoutingTables();
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		// In legacy mode the chatbot manifest commands appear, so /ask is listed once via the app loop
		// But the "Conversation" section header should NOT appear
		expect(helpText).not.toContain('*Conversation*');
	});

	it('/help lists conversation commands for user with chatbot toggled OFF', async () => {
		const appToggle: AppToggleStore = {
			isEnabled: vi.fn().mockImplementation((userId: string, appId: string) =>
				appId !== 'chatbot',
			),
		} as unknown as AppToggleStore;

		const { telegram, router } = buildRouter({ conversationService: conv, appToggle });
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		expect(helpText).toContain('*Conversation*');
		expect(helpText).toContain('/ask');
		expect(helpText).toContain('/notes');
	});
});
