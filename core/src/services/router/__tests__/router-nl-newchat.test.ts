/**
 * Tests for Router NL /newchat hook (Hermes P7 Task B3).
 *
 * Asserts:
 * 1. High-confidence result (confidence: 0.9) → handleNewChat called, not routed to app
 * 2. Prefilter match (source: 'prefilter', confidence: 1.0) → same as high-confidence
 * 3. Grey-zone result (confidence: 0.55) → pendingSessionControl.attach called + inline keyboard sent
 * 4. Low confidence (confidence: 0.2) → nothing intercepted, normal routing continues
 * 5. intent: 'continue' → nothing intercepted
 * 6. No sessionControlClassifier in options → hook skipped entirely (opt-in)
 * 7. High-confidence → confirmation message sent ("Starting a new chat")
 * 8. Grey-zone → telegram.sendWithButtons called with inline keyboard
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { ManifestCache, type AppRegistry, type RegisteredApp } from '../../app-registry/index.js';
import type { PendingSessionControlEntry, PendingSessionControlStore } from '../../conversation/pending-session-control-store.js';
import type { SessionControlResult } from '../../conversation/session-control-classifier.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
		sendOptions: vi.fn().mockResolvedValue(''),
		sendWithButtons: vi.fn().mockResolvedValue({ messageId: 99, chatId: 1 }),
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

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo', 'repeat'],
		},
	},
};

function createMockPendingSessionControl(): PendingSessionControlStore {
	return {
		attach: vi.fn(),
		get: vi.fn().mockReturnValue(undefined),
		has: vi.fn().mockReturnValue(false),
		remove: vi.fn(),
		resolveForUser: vi.fn().mockReturnValue(undefined),
	};
}

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
	sessionControlResult?: SessionControlResult;
	includeClassifier?: boolean;
	conversationService?: ReturnType<typeof makeConversationService>;
	pendingSessionControl?: PendingSessionControlStore;
}) {
	const cache = new ManifestCache();
	cache.add(echoManifest, '/apps/echo');

	const handleMessageSpy = vi.fn().mockResolvedValue(undefined);

	const registry = {
		getApp: (id: string) => {
			if (id !== 'echo') return undefined;
			return {
				manifest: echoManifest,
				module: { init: vi.fn(), handleMessage: handleMessageSpy } as any,
				appDir: '/apps/echo',
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getAll: () => [],
		getLoadedAppIds: () => ['echo'],
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();

	// Default result for classifier mock
	const defaultResult: SessionControlResult = options.sessionControlResult ?? {
		intent: 'continue',
		confidence: 0.1,
		reason: 'default',
		source: 'llm',
	};

	const classifierMock = vi.fn().mockResolvedValue(defaultResult);

	const conv = options.conversationService ?? makeConversationService();

	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: conv as any,
		sessionControlClassifier: options.includeClassifier !== false ? classifierMock : undefined,
		pendingSessionControl: options.pendingSessionControl ?? createMockPendingSessionControl(),
	});
	router.buildRoutingTables();

	return { router, telegram, classifierMock, handleMessageSpy, conv };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Router NL /newchat hook', () => {
	describe('Test 1 — High-confidence result (0.9) triggers handleNewChat', () => {
		it('handleNewChat is called and message is not routed to app handler', async () => {
			const conv = makeConversationService();
			const { router, handleMessageSpy } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 0.9,
					reason: 'wants fresh start',
					source: 'llm',
				},
				conversationService: conv,
			});

			await router.routeMessage(msg('I want to start over with something new'));

			expect(conv.handleNewChat).toHaveBeenCalledOnce();
			// App handler must NOT be called
			expect(handleMessageSpy).not.toHaveBeenCalled();
		});
	});

	describe('Test 2 — Prefilter match triggers handleNewChat', () => {
		it('prefilter source with confidence 1.0 triggers handleNewChat', async () => {
			const conv = makeConversationService();
			const { router, handleMessageSpy } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 1.0,
					reason: 'keyword match: new chat',
					source: 'prefilter',
				},
				conversationService: conv,
			});

			await router.routeMessage(msg('new chat'));

			expect(conv.handleNewChat).toHaveBeenCalledOnce();
			expect(handleMessageSpy).not.toHaveBeenCalled();
		});
	});

	describe('Test 3 — Grey-zone (0.55) stores pending entry + sends inline keyboard', () => {
		it('attach is called and sendWithButtons is called', async () => {
			const pendingStore = createMockPendingSessionControl();
			const { router } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 0.55,
					reason: 'maybe wants reset',
					source: 'llm',
				},
				pendingSessionControl: pendingStore,
			});

			await router.routeMessage(msg('maybe reset things?'));

			expect(pendingStore.attach).toHaveBeenCalledOnce();
			const [attachedUserId, attachedEntry] = (pendingStore.attach as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(attachedUserId).toBe('user1');
			const entry = attachedEntry as PendingSessionControlEntry;
			expect(entry.messageText).toBe('maybe reset things?');
		});
	});

	describe('Test 4 — Low confidence (0.2) lets message fall through', () => {
		it('nothing intercepted, message routed to fallback (conversationService)', async () => {
			const conv = makeConversationService();
			const { router } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 0.2,
					reason: 'low confidence',
					source: 'llm',
				},
				conversationService: conv,
			});

			// LLM classify returns 'unknown'/0.1, so no app match → falls to conversation fallback
			await router.routeMessage(msg('maybe do something'));

			// handleNewChat must NOT be called
			expect(conv.handleNewChat).not.toHaveBeenCalled();
			// handleMessage (as chatbot fallback) gets the message
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});
	});

	describe('Test 5 — intent: continue → nothing intercepted', () => {
		it('message falls through to normal routing', async () => {
			const conv = makeConversationService();
			const { router } = buildRouter({
				sessionControlResult: {
					intent: 'continue',
					confidence: 0.9,
					reason: 'continuing conversation',
					source: 'llm',
				},
				conversationService: conv,
			});

			await router.routeMessage(msg('what was my last grocery list?'));

			expect(conv.handleNewChat).not.toHaveBeenCalled();
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});
	});

	describe('Test 6 — No sessionControlClassifier → hook skipped (opt-in)', () => {
		it('when classifier not provided, hook is bypassed entirely', async () => {
			const conv = makeConversationService();
			const pendingStore = createMockPendingSessionControl();
			const { router } = buildRouter({
				includeClassifier: false,
				conversationService: conv,
				pendingSessionControl: pendingStore,
			});

			await router.routeMessage(msg('start fresh'));

			// Classifier never ran, so no new-chat dispatch
			expect(conv.handleNewChat).not.toHaveBeenCalled();
			// Pending store never touched
			expect(pendingStore.attach).not.toHaveBeenCalled();
			// Message goes through normal routing → chatbot fallback
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});
	});

	describe('Test 7 — High-confidence sends confirmation message', () => {
		it('sends "Starting a new chat" confirmation after handleNewChat', async () => {
			const conv = makeConversationService();
			const { router, telegram } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 0.85,
					reason: 'user wants fresh start',
					source: 'llm',
				},
				conversationService: conv,
			});

			await router.routeMessage(msg('lets start over completely'));

			expect(conv.handleNewChat).toHaveBeenCalledOnce();

			const sendMock = telegram.send as ReturnType<typeof vi.fn>;
			const sentTexts: string[] = sendMock.mock.calls.map((c: unknown[]) => c[1] as string);
			expect(sentTexts.some((t) => t.includes('Starting a new chat'))).toBe(true);
		});
	});

	describe('Test 8 — Grey-zone sends inline keyboard via sendWithButtons', () => {
		it('sendWithButtons called with yes/no buttons', async () => {
			const pendingStore = createMockPendingSessionControl();
			const { router, telegram } = buildRouter({
				sessionControlResult: {
					intent: 'new_session',
					confidence: 0.6,
					reason: 'grey zone',
					source: 'llm',
				},
				pendingSessionControl: pendingStore,
			});

			await router.routeMessage(msg('maybe we should reset this chat'));

			const sendWithButtonsMock = telegram.sendWithButtons as ReturnType<typeof vi.fn>;
			expect(sendWithButtonsMock).toHaveBeenCalledOnce();

			// Verify the button structure: should have sc:yes and sc:no
			const [, , buttons] = sendWithButtonsMock.mock.calls[0]!;
			const allButtons = (buttons as { text: string; callbackData: string }[][]).flat();
			const callbackDatas = allButtons.map((b) => b.callbackData);
			expect(callbackDatas).toContain('sc:yes');
			expect(callbackDatas).toContain('sc:no');
		});
	});
});
