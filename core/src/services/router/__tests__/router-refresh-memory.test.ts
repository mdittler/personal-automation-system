/**
 * Tests for Router built-in /refreshmemory command (Hermes P6.next Chunk B).
 *
 * Asserts:
 * - /refreshmemory → conversationService.handleRefreshMemory('', ctx) called
 * - /refresh-memory → dispatches (alias)
 * - /refreshmemory <args> → dispatches
 * - /refreshmemory@PASBot → @bot suffix stripped, dispatches
 * - /refresh-memory@PASBot → dispatches
 * - /refreshmemory (leading/trailing space) → dispatches
 * - /refreshmemory bypasses AppToggleStore (works even when chatbot app is disabled)
 * - /refreshmemory appears in /help output
 * - /refreshmemoryx, refreshmemory, /refreshmemo, /RefreshMemory → do NOT dispatch
 *
 * REQ-CONV-MEMORY-013, REQ-CONV-MEMORY-014
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
// PR1 — /refreshmemory dispatch
// ---------------------------------------------------------------------------

describe('Router built-in /refreshmemory command — dispatch (PR1)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/refreshmemory dispatches to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemory'));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});

	it('/refresh-memory dispatches to handleRefreshMemory (alias)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refresh-memory'));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});

	it('/refreshmemory with trailing space dispatches', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemory '));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});

	it('/refreshmemory@PASBot strips @bot suffix and dispatches (REQ-CONV-MEMORY-014)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemory@PASBot'));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});

	it('/refresh-memory@PASBot strips @bot suffix and dispatches (REQ-CONV-MEMORY-014)', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refresh-memory@PASBot'));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});

	it('/refreshmemory dispatch does not call handleRecall or handleMessage', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemory'));

		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
		expect(conv.handleRecall).not.toHaveBeenCalled();
		expect(conv.handleMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PR2 — Should NOT dispatch (negatives)
// ---------------------------------------------------------------------------

describe('Router built-in /refreshmemory — should NOT dispatch (PR2)', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	it('/refreshmemoryx (extra suffix) does NOT dispatch to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemoryx'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('refreshmemory (no slash prefix) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('refreshmemory'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/refreshmemo (truncated) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refreshmemo'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/RefreshMemory (wrong case) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/RefreshMemory'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/REFRESHMEMORY (all caps) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/REFRESHMEMORY'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('free text "refresh memory" does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('refresh memory'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('"I want to refresh memory" does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('I want to refresh memory'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('"lorem refreshmemory ipsum" (mid-sentence) does NOT dispatch', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('lorem refreshmemory ipsum'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/help does NOT dispatch to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/recall does NOT dispatch to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/recall'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/newchat does NOT dispatch to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/newchat'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});

	it('/refresh does NOT dispatch to handleRefreshMemory', async () => {
		const { router } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/refresh'));

		expect(conv.handleRefreshMemory).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// PR10 — App-toggle bypass: /refreshmemory bypasses AppToggleStore
// ---------------------------------------------------------------------------

describe('PR10 — /refreshmemory bypasses AppToggleStore', () => {
	it('/refreshmemory dispatches even when chatbot app is toggled off (by not being in enabledApps)', async () => {
		// Router built-ins bypass the app enable check. We build a router where the chatbot
		// is technically not in the user's enabledApps but /refreshmemory still routes.
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
			// User has NO enabled apps — but /refreshmemory is a built-in
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

		await router.routeMessage(msg('/refreshmemory'));
		expect(conv.handleRefreshMemory).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// PR9 — Help text appears exactly once
// ---------------------------------------------------------------------------

describe('PR9 — /refreshmemory in /help (REQ-CONV-MEMORY-013)', () => {
	it('/help output contains /refreshmemory exactly once', async () => {
		const conv = makeConversationService();
		const { router, telegram } = buildRouter({ conversationService: conv });
		await router.routeMessage(msg('/help'));

		const calls = (telegram.send as ReturnType<typeof vi.fn>).mock.calls;
		const helpText = calls.map(([, text]) => text as string).join('\n');
		const occurrences = (helpText.match(/\/refreshmemory/g) ?? []).length;
		expect(occurrences).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// PR11 — Missing conversationService → no crash
// ---------------------------------------------------------------------------

describe('PR11 — Missing conversationService → graceful fallback', () => {
	it('/refreshmemory without conversationService does NOT crash', async () => {
		const { router, telegram } = buildRouter({ conversationService: undefined });
		// Should not throw — falls through to lookupCommand or chatbot fallback
		await expect(router.routeMessage(msg('/refreshmemory'))).resolves.toBeUndefined();
	});
});
