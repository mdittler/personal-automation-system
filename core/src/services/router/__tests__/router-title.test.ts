/**
 * Tests for Router built-in /title command (Hermes P7 Task A8).
 *
 * Asserts:
 * - /title (no args) → conversationService.handleTitle([], ctx) called
 * - /title My Custom Title → conversationService.handleTitle(['My', 'Custom', 'Title'], ctx) called
 * - /title@PASBot Some title → @bot suffix stripped → conversationService.handleTitle(['Some', 'title'], ctx) called
 * - /title is treated as a built-in regardless of whether chatbot manifest declares it
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
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

/** Chatbot manifest with no /title in it (should still work as built-in). */
const chatbotManifestNoTitle: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: { messages: {} },
};

/** Chatbot manifest that declares /title as an app command (should be filtered in /help). */
const chatbotManifestWithTitle: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: {
		messages: {
			commands: [{ name: '/title', description: 'Set session title (manifest)' }],
		},
	},
};

function makeConversationService() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
	};
}

function buildRouter(options: {
	conversationService?: ReturnType<typeof makeConversationService>;
	chatbotManifest?: AppManifest;
}) {
	const cache = new ManifestCache();
	const manifest = options.chatbotManifest ?? chatbotManifestNoTitle;
	cache.add(manifest, '/apps/chatbot');

	const registry = {
		getApp: (id: string) => {
			if (id !== 'chatbot') return undefined;
			return {
				manifest,
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
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: options.conversationService as any,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

describe('Router built-in /title command', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/title (no args) dispatches to handleTitle with empty args and command route', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/title'));

		expect(conv.handleTitle).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleTitle.mock.calls[0]!;
		expect(args).toEqual([]);
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('title');
		expect(ctx.route?.appId).toBe('chatbot');
		expect(ctx.route?.confidence).toBe(1.0);
	});

	it('/title My Custom Title dispatches to handleTitle with parsed args', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/title My Custom Title'));

		expect(conv.handleTitle).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleTitle.mock.calls[0]!;
		expect(args).toEqual(['My', 'Custom', 'Title']);
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('title');
	});

	it('/title@PASBot Some title strips bot suffix and dispatches with args', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/title@PASBot Some title'));

		expect(conv.handleTitle).toHaveBeenCalledOnce();
		const [args, ctx] = conv.handleTitle.mock.calls[0]!;
		expect(args).toEqual(['Some', 'title']);
		expect(ctx.route?.intent).toBe('title');
	});

	it('/title is treated as a built-in even when chatbot manifest does not declare it', async () => {
		// chatbotManifestNoTitle has no /title — built-in dispatch must short-circuit
		const { router } = buildRouter({
			conversationService: conv,
			chatbotManifest: chatbotManifestNoTitle,
		});
		await router.routeMessage(msg('/title My Title'));

		expect(conv.handleTitle).toHaveBeenCalledOnce();
	});
});

describe('Router /help with /title built-in', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/help lists /title exactly once even when chatbot manifest also declares it', async () => {
		const { telegram, router } = buildRouter({
			conversationService: conv,
			chatbotManifest: chatbotManifestWithTitle,
		});
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		expect(helpText).toBeDefined();

		const titleCount = (helpText.match(/\/title/g) ?? []).length;
		expect(titleCount).toBe(1);
	});

	it('/help includes /title in the Conversation section', async () => {
		const { telegram, router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		const helpText = (telegram.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
		expect(helpText).toContain('*Conversation*');
		expect(helpText).toContain('/title');
	});
});
