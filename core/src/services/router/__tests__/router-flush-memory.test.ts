/**
 * Tests for Router built-in /flushmemory command (Batch 3, Item 1).
 *
 * Asserts:
 * - /flushmemory → conversationService.handleFlushMemory([], ctx) called
 * - /flush-memory → dispatches (alias)
 * - /flushmemory@PASBot → @bot suffix stripped, dispatches
 * - /flush-memory@PASBot → dispatches
 * - /flushmemory (trailing space) → dispatches
 * - /flushmemory bypasses AppToggleStore (works even when chatbot app is disabled)
 * - /flushmemory appears in /help output
 * - /flushmemoryx, flushmemory, /flush, /flushmemo, NL variants, /refreshmemory, /recall, /newchat → do NOT dispatch
 * - missing conversationService → graceful fallback, no crash
 *
 * REQ-CONV-FLUSH-013
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
	};
}

function buildRouter(options: {
	conversationService?: ReturnType<typeof makeConversationService>;
}) {
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

// ---------------------------------------------------------------------------
// PF1 — /flushmemory dispatch
// ---------------------------------------------------------------------------

describe('Router built-in /flushmemory command — dispatch (PF1)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/flushmemory dispatches to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemory'));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});

	it('/flush-memory dispatches to handleFlushMemory (alias)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flush-memory'));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});

	it('/flushmemory with trailing space dispatches', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemory '));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});

	it('/flushmemory@PASBot strips @bot suffix and dispatches (REQ-CONV-FLUSH-013)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemory@PASBot'));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});

	it('/flush-memory@PASBot strips @bot suffix and dispatches (REQ-CONV-FLUSH-013)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flush-memory@PASBot'));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});

	it('/flushmemory dispatch does not call handleRefreshMemory or handleMessage', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemory'));

		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
		expect(conv.handleMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PF2 — Should NOT dispatch (negatives)
// ---------------------------------------------------------------------------

describe('Router built-in /flushmemory — should NOT dispatch (PF2)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/flushmemoryx (extra suffix) does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemoryx'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('flushmemory (no slash prefix) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('flushmemory'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/flushmemo (truncated) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flushmemo'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/FlushMemory (wrong case) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/FlushMemory'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/FLUSHMEMORY (all caps) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/FLUSHMEMORY'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('free text "flush my memory" does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('flush my memory'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('"please flush memory now" does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('please flush memory now'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('"lorem flushmemory ipsum" (mid-sentence) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('lorem flushmemory ipsum'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/flush does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/flush'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/refreshmemory does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemory'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/recall does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/recall'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/newchat does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/newchat'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});

	it('/help does NOT dispatch to handleFlushMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		expect(conv.handleFlushMemory).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PF9 — Help text appears exactly once
// ---------------------------------------------------------------------------

describe('PF9 — /flushmemory in /help (REQ-CONV-FLUSH-013)', () => {
	it('/help output contains /flushmemory exactly once', async () => {
		const conv = makeConversationService();
		const { router, telegram } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		const calls = (telegram.send as ReturnType<typeof vi.fn>).mock.calls;
		const helpText = calls.map(([, text]) => text as string).join('\n');
		const occurrences = (helpText.match(/\/flushmemory/g) ?? []).length;
		expect(occurrences).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// PF10 — App-toggle bypass: /flushmemory bypasses AppToggleStore
// ---------------------------------------------------------------------------

describe('PF10 — /flushmemory bypasses AppToggleStore', () => {
	it('/flushmemory dispatches even when user has no enabled apps', async () => {
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

		const config: SystemConfig = {
			...createConfig(),
			users: [{ id: 'user1', name: 'Test', isAdmin: false, enabledApps: [], sharedScopes: [] }],
		};

		const telegram = createMockTelegram();
		const router = new Router({
			registry,
			llm: createMockLLM(),
			telegram,
			fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
			config,
			logger: createMockLogger(),
			conversationService: conv as any,
		});
		router.buildRoutingTables();

		await router.routeMessage(msg('/flushmemory'));
		expect(conv.handleFlushMemory).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// PF11 — Missing conversationService → no crash
// ---------------------------------------------------------------------------

describe('PF11 — Missing conversationService → graceful fallback', () => {
	it('/flushmemory without conversationService does NOT crash', async () => {
		const { router } = buildRouter({ conversationService: undefined });
		await expect(router.routeMessage(msg('/flushmemory'))).resolves.toBeUndefined();
	});
});
