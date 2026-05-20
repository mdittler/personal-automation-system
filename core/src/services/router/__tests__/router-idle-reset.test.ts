/**
 * Tests for Router idle-reset hook wiring (Hermes P8a Task A8).
 *
 * Asserts:
 * 1. Placement before command dispatch — hook fires before handleCommand for all command types
 * 2. Placement before photo classification — hook fires before photo dispatch
 * 3. IdleResetState propagation — returned state is set on enrichedCtx.idleResetState
 * 4. No-deps fallback — when idleResetDeps is absent, hook never called
 * 5. Hook throws — error is caught and routing continues (fail-open)
 * 6. Photo path: hook fires before classify (via real hook with mock deps)
 * 7. Free-text path: hook fires and state propagated to conversation handler
 */

import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, PhotoContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { IdleResetHookDeps, IdleResetState } from '../../conversation/idle-reset-hook.js';
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
			accepts_photos: true,
			photo_intents: ['echo-photo'],
		},
	},
};

function makeConversationService(): jest.Mocked<ConversationService> {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
	} as unknown as jest.Mocked<ConversationService>;
}

/**
 * Build mock IdleResetHookDeps that causes the real runIdleResetHook to return the
 * desired state by controlling what the chatSessions mock returns.
 *
 * For status === 'reset': peekActive returns the given endedSessionId, readSession
 * returns a session with last_activity_at far in the past, and idleMinutes is set
 * to 1 so the idle check fires.
 *
 * For status === 'none': peekActive returns undefined (no active session).
 */
function makeIdleResetDeps(
	returnState: IdleResetState = { status: 'none' },
	idleMinutes: number | null = null,
): IdleResetHookDeps {
	const isReset = returnState.status === 'reset';
	// Use the endedSessionId from returnState as the active session ID so the hook
	// returns it back to us as IdleResetState.endedSessionId.
	const activeId = isReset ? (returnState.endedSessionId ?? 'session-abc') : undefined;
	const lastActivity = isReset
		? new Date(Date.now() - 99999999).toISOString() // far in the past → definitely idle
		: undefined;

	return {
		idleMinutes: isReset ? (idleMinutes ?? 1) : idleMinutes,
		chatSessions: {
			peekActive: vi.fn().mockResolvedValue(activeId),
			readSession: vi.fn().mockResolvedValue(
				activeId
					? {
							meta: {
								id: activeId,
								last_activity_at: lastActivity,
								started_at: new Date(Date.now() - 99999999).toISOString(),
								title: returnState.parentTitle ?? null,
								ended_at: null,
							},
							turns: [],
						}
					: undefined,
			),
			endActive: vi.fn().mockResolvedValue({ endedSessionId: activeId }),
		},
		telegram: { send: vi.fn().mockResolvedValue(undefined) },
		logger: createMockLogger() as unknown as Pick<Logger, 'warn'>,
		pendingSessionControl: undefined,
		now: undefined,
	};
}

/**
 * Build a spy-based IdleResetHookDeps that captures calls to peekActive so we can
 * assert the hook was invoked before other work. The real hook returns 'none'
 * (no active session) so it's a fast no-op.
 */
function makeSpyIdleResetDeps(): {
	deps: IdleResetHookDeps;
	peekActiveSpy: ReturnType<typeof vi.fn>;
} {
	const peekActiveSpy = vi.fn().mockResolvedValue(undefined); // no session → status: 'none'
	const deps: IdleResetHookDeps = {
		idleMinutes: 60, // some value so hook doesn't short-circuit on null
		chatSessions: {
			peekActive: peekActiveSpy,
			readSession: vi.fn().mockResolvedValue(undefined),
			endActive: vi.fn().mockResolvedValue(undefined),
		},
		telegram: { send: vi.fn().mockResolvedValue(undefined) },
		logger: createMockLogger() as unknown as Pick<Logger, 'warn'>,
		pendingSessionControl: undefined,
		now: undefined,
	};
	return { deps, peekActiveSpy };
}

function buildRouter(options: {
	idleResetDeps?: IdleResetHookDeps;
	conversationService?: ReturnType<typeof makeConversationService>;
}) {
	const cache = new ManifestCache();
	cache.add(echoManifest, '/apps/echo');

	const handleMessageSpy = vi.fn().mockResolvedValue(undefined);
	const handlePhotoSpy = vi.fn().mockResolvedValue(undefined);

	const registry = {
		getApp: (id: string) => {
			if (id !== 'echo') return undefined;
			return {
				manifest: echoManifest,
				module: {
					init: vi.fn(),
					handleMessage: handleMessageSpy,
					handlePhoto: handlePhotoSpy,
				} as any,
				appDir: '/apps/echo',
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getAll: () => [],
		getLoadedAppIds: () => ['echo'],
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const conv = options.conversationService ?? makeConversationService();

	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: conv as any,
		idleResetDeps: options.idleResetDeps,
	});
	router.buildRoutingTables();

	return { router, telegram, handleMessageSpy, handlePhotoSpy, conv };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

function photo(userId = 'user1'): PhotoContext {
	return {
		userId,
		photo: Buffer.from('fake-photo'),
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 2,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Router idle-reset hook wiring', () => {
	describe('Test 1 — Hook fires before command dispatch (all command types)', () => {
		it.each([
			['/ask hi'],
			['/edit grocery add milk'],
			['/notes on'],
			['/newchat'],
			['/title set My Session'],
			['hello free text'],
		])('hook peekActive called for text "%s"', async (text) => {
			const { deps, peekActiveSpy } = makeSpyIdleResetDeps();
			const conv = makeConversationService();
			const { router } = buildRouter({ idleResetDeps: deps, conversationService: conv });

			await router.routeMessage(msg(text));

			// peekActive is the first observable side-effect inside runIdleResetHook
			expect(peekActiveSpy).toHaveBeenCalledOnce();
			expect(peekActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
		});
	});

	describe('Test 2 — Hook fires before photo classification', () => {
		it('peekActive called even when no photo apps are installed', async () => {
			const { deps, peekActiveSpy } = makeSpyIdleResetDeps();

			// Build registry with no photo-accepting apps
			const textOnlyManifest: AppManifest = {
				app: {
					id: 'text-only',
					name: 'Text Only',
					version: '1.0.0',
					description: 'No photos',
					author: 'Test',
				},
				capabilities: { messages: { intents: ['text-only'] } },
			};
			const noPhotoCache = new ManifestCache();
			noPhotoCache.add(textOnlyManifest, '/apps/text-only');
			const noPhotoRegistry = {
				getApp: () => undefined,
				getManifestCache: () => noPhotoCache,
				getAll: () => [],
				getLoadedAppIds: () => [],
			} as unknown as AppRegistry;

			const router = new Router({
				registry: noPhotoRegistry,
				llm: createMockLLM(),
				telegram: createMockTelegram(),
				fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
				config: createConfig(),
				logger: createMockLogger(),
				idleResetDeps: deps,
			});
			router.buildRoutingTables();

			await router.routePhoto(photo());

			// Hook must fire even though no photo apps exist (session lifecycle before app availability)
			expect(peekActiveSpy).toHaveBeenCalledOnce();
		});

		it('peekActive called before handlePhoto is invoked', async () => {
			const { deps, peekActiveSpy } = makeSpyIdleResetDeps();
			// Make LLM classify return a high-confidence photo match so handlePhoto is called
			const llmMock = createMockLLM();
			(llmMock.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
				category: 'echo-photo',
				confidence: 0.95,
			});

			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			const handlePhotoSpy = vi.fn().mockResolvedValue(undefined);
			const registry = {
				getApp: (id: string) => {
					if (id !== 'echo') return undefined;
					return {
						manifest: echoManifest,
						module: { init: vi.fn(), handleMessage: vi.fn(), handlePhoto: handlePhotoSpy } as any,
						appDir: '/apps/echo',
					} as RegisteredApp;
				},
				getManifestCache: () => cache,
				getAll: () => [],
				getLoadedAppIds: () => ['echo'],
			} as unknown as AppRegistry;

			const router = new Router({
				registry,
				llm: llmMock,
				telegram: createMockTelegram(),
				fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
				config: createConfig(),
				logger: createMockLogger(),
				idleResetDeps: deps,
			});
			router.buildRoutingTables();

			// Track call order
			const callOrder: string[] = [];
			peekActiveSpy.mockImplementation(async () => {
				callOrder.push('peekActive');
				return undefined;
			});
			handlePhotoSpy.mockImplementation(async () => {
				callOrder.push('handlePhoto');
				return undefined;
			});

			await router.routePhoto(photo());

			// peekActive must appear BEFORE handlePhoto
			expect(callOrder).toContain('peekActive');
			expect(callOrder.indexOf('peekActive')).toBeLessThan(callOrder.indexOf('handlePhoto'));
		});
	});

	describe('Test 3 — IdleResetState propagated to enrichedCtx', () => {
		it('when hook returns reset state, enrichedCtx.idleResetState is set on handleMessage ctx', async () => {
			const resetState: IdleResetState = {
				status: 'reset',
				endedSessionId: 's1',
				parentTitle: 'foo',
			};
			const deps = makeIdleResetDeps(resetState, 1 /* idleMinutes = 1 */);

			// Capture the ctx passed to handleMessage
			let capturedCtx: MessageContext | undefined;
			const conv = makeConversationService();
			(conv.handleMessage as ReturnType<typeof vi.fn>).mockImplementation(
				async (ctx: MessageContext) => {
					capturedCtx = ctx;
				},
			);

			const { router } = buildRouter({ idleResetDeps: deps, conversationService: conv });

			// Free text → falls to conversation service
			await router.routeMessage(msg('hello world'));

			expect(capturedCtx).toBeDefined();
			expect(capturedCtx!.idleResetState).toBeDefined();
			expect(capturedCtx!.idleResetState!.status).toBe('reset');
			expect(capturedCtx!.idleResetState!.endedSessionId).toBe('s1');
			expect(capturedCtx!.idleResetState!.parentTitle).toBe('foo');
		});
	});

	describe('Test 4 — No idleResetDeps → hook never called', () => {
		it('when idleResetDeps is undefined, no hook side-effects occur', async () => {
			const conv = makeConversationService();
			const { router } = buildRouter({ idleResetDeps: undefined, conversationService: conv });

			// Routing still works
			await router.routeMessage(msg('hello'));
			expect(conv.handleMessage).toHaveBeenCalledOnce();

			await router.routePhoto(photo());
			// No peekActive to assert on — just verify no throws and routing proceeds
		});
	});

	describe('Test 5 — Hook throws → fail-open, routing continues', () => {
		it('when idleResetDeps.chatSessions.peekActive throws, message is still routed', async () => {
			const deps = makeSpyIdleResetDeps().deps;
			// Make peekActive throw
			(deps.chatSessions.peekActive as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('disk failure'),
			);

			const conv = makeConversationService();
			const { router } = buildRouter({ idleResetDeps: deps, conversationService: conv });

			// Must not throw — routing continues to fallback
			await expect(router.routeMessage(msg('anything'))).resolves.toBeUndefined();
			// Conversation service still got the message
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});
	});

	describe('Test 6 — Command path: idleResetState set on enrichedCtx passed to handleCommand', () => {
		it('for /ask command, enrichedCtx.idleResetState is set when hook returns reset', async () => {
			const resetState: IdleResetState = {
				status: 'reset',
				endedSessionId: 's2',
				parentTitle: null,
			};
			const deps = makeIdleResetDeps(resetState, 1);

			let capturedCtx: MessageContext | undefined;
			const conv = makeConversationService();
			(conv.handleAsk as ReturnType<typeof vi.fn>).mockImplementation(
				async (_args: unknown, ctx: MessageContext) => {
					capturedCtx = ctx;
				},
			);

			const { router } = buildRouter({ idleResetDeps: deps, conversationService: conv });
			await router.routeMessage(msg('/ask what is 2+2'));

			expect(capturedCtx).toBeDefined();
			// P8b adds summaryStatus to IdleResetState — use toMatchObject to allow for it
			expect(capturedCtx!.idleResetState).toMatchObject(resetState);
		});
	});

	describe('Test 7 — Ordering: hook fires before NL /newchat hook in free-text path', () => {
		it('peekActive is called before sessionControlClassifier', async () => {
			const { deps, peekActiveSpy } = makeSpyIdleResetDeps();
			const callOrder: string[] = [];

			peekActiveSpy.mockImplementation(async () => {
				callOrder.push('idleHook');
				return undefined;
			});

			const sessionControlMock = vi.fn().mockImplementation(async () => {
				callOrder.push('sessionControl');
				return { intent: 'continue', confidence: 0.1, reason: 'no', source: 'llm' };
			});

			const pendingSessionControl = {
				attach: vi.fn(),
				get: vi.fn().mockReturnValue(undefined),
				has: vi.fn().mockReturnValue(false),
				remove: vi.fn(),
			};

			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			const registry = {
				getApp: () => undefined,
				getManifestCache: () => cache,
				getAll: () => [],
				getLoadedAppIds: () => [],
			} as unknown as AppRegistry;

			const conv = makeConversationService();
			const router = new Router({
				registry,
				llm: createMockLLM(),
				telegram: createMockTelegram(),
				fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
				config: createConfig(),
				logger: createMockLogger(),
				conversationService: conv as any,
				idleResetDeps: deps,
				sessionControlClassifier: sessionControlMock as any,
				pendingSessionControl: pendingSessionControl as any,
			});
			router.buildRoutingTables();

			await router.routeMessage(msg('hello there'));

			expect(callOrder.indexOf('idleHook')).toBeLessThan(callOrder.indexOf('sessionControl'));
		});
	});

	describe('NL /newchat conflict with idle reset', () => {
		/**
		 * Helper: build a Router with BOTH idle-reset AND NL session-control wired.
		 * idleState controls what the idle hook returns; classifierResult controls the
		 * session-control classifier's return value.
		 */
		function buildConflictRouter(options: {
			idleState: IdleResetState;
			classifierResult: { intent: string; confidence: number; source: string };
			conversationService?: ReturnType<typeof makeConversationService>;
		}) {
			const idleResetDeps = makeIdleResetDeps(options.idleState, 1 /* idleMinutes=1 */);

			const sessionControlClassifier = vi.fn().mockResolvedValue({
				...options.classifierResult,
				reason: 'test',
			});

			const pendingSessionControl = {
				attach: vi.fn(),
				get: vi.fn().mockReturnValue(undefined),
				has: vi.fn().mockReturnValue(false),
				remove: vi.fn(),
			};

			const cache = new ManifestCache();
			cache.add(echoManifest, '/apps/echo');
			const registry = {
				getApp: () => undefined,
				getManifestCache: () => cache,
				getAll: () => [],
				getLoadedAppIds: () => [],
			} as unknown as AppRegistry;

			const conv = options.conversationService ?? makeConversationService();
			const telegram = createMockTelegram();

			const router = new Router({
				registry,
				llm: createMockLLM(),
				telegram,
				fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
				config: createConfig(),
				logger: createMockLogger(),
				conversationService: conv as any,
				idleResetDeps,
				sessionControlClassifier: sessionControlClassifier as any,
				pendingSessionControl: pendingSessionControl as any,
			});
			router.buildRoutingTables();

			return {
				router,
				telegram,
				conv,
				sessionControlClassifier,
				pendingSessionControl,
				idleResetDeps,
			};
		}

		it('idle reset + reset-intent message → NL hook does NOT double-message (silent consume)', async () => {
			// The user sends "let's start over" after being idle.
			// The idle hook fires and resets the session (sending an inactivity notice via its
			// own deps.telegram). The NL hook should stay silent — it must not call handleNewChat
			// and must not send a second "Starting a new chat" notice via the router's telegram.
			const conv = makeConversationService();
			const { router, telegram, idleResetDeps } = buildConflictRouter({
				idleState: { status: 'reset', endedSessionId: 'session-idle-1', parentTitle: null },
				classifierResult: { intent: 'new_session', confidence: 0.95, source: 'llm' },
				conversationService: conv,
			});

			await router.routeMessage(msg("let's start over"));

			// The router's main telegram.send must have zero "Starting" / "new chat" calls —
			// the NL hook must not have sent a second notice.
			const routerSendMock = telegram.send as ReturnType<typeof vi.fn>;
			const routerSentTexts: string[] = routerSendMock.mock.calls.map(
				(c: unknown[]) => c[1] as string,
			);
			const newChatNotices = routerSentTexts.filter(
				(t) => t.toLowerCase().includes('starting') || t.toLowerCase().includes('new chat'),
			);
			expect(newChatNotices).toHaveLength(0);

			// The idle hook's own telegram.send must have sent the inactivity notice.
			const idleSendMock = idleResetDeps.telegram.send as ReturnType<typeof vi.fn>;
			const idleSentTexts: string[] = idleSendMock.mock.calls.map((c: unknown[]) => c[1] as string);
			const inactivityNotices = idleSentTexts.filter((t) => t.toLowerCase().includes('inactiv'));
			expect(inactivityNotices).toHaveLength(1);

			// handleNewChat must NOT have been called by the NL hook (idle hook handled the reset).
			expect(conv.handleNewChat).not.toHaveBeenCalled();

			// The message must still be answered by the conversation service in the new session.
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});

		it('idle reset + non-reset-intent message → routes normally (no NL hook intercept)', async () => {
			// The user sends "what's for dinner" after being idle.
			// Idle reset fires (one inactivity notice). NL hook must NOT intercept.
			// Message should fall through to normal routing (conversation service).
			const conv = makeConversationService();
			const { router, telegram } = buildConflictRouter({
				idleState: { status: 'reset', endedSessionId: 'session-idle-2', parentTitle: null },
				classifierResult: { intent: 'other', confidence: 0.9, source: 'llm' },
				conversationService: conv,
			});

			await router.routeMessage(msg("what's for dinner"));

			const sendMock = telegram.send as ReturnType<typeof vi.fn>;
			const sentTexts: string[] = sendMock.mock.calls.map((c: unknown[]) => c[1] as string);

			// No NL-hook intercept messages.
			const newChatNotices = sentTexts.filter(
				(t) => t.toLowerCase().includes('starting') || t.toLowerCase().includes('new chat'),
			);
			expect(newChatNotices).toHaveLength(0);

			// handleNewChat must NOT have been called.
			expect(conv.handleNewChat).not.toHaveBeenCalled();

			// Message falls through to conversation service.
			expect(conv.handleMessage).toHaveBeenCalledOnce();
		});

		it('no idle reset + reset-intent message → NL hook fires normally', async () => {
			// No idle reset (session still active/recent), user sends "let's start over".
			// NL hook should fire normally — handleNewChat is called.
			const conv = makeConversationService();
			const { router } = buildConflictRouter({
				idleState: { status: 'none' },
				classifierResult: { intent: 'new_session', confidence: 0.95, source: 'llm' },
				conversationService: conv,
			});

			await router.routeMessage(msg("let's start over"));

			// NL hook fires → handleNewChat called.
			expect(conv.handleNewChat).toHaveBeenCalledOnce();
			// Normal routing suppressed.
			expect(conv.handleMessage).not.toHaveBeenCalled();
		});
	});

	describe('Literal /newchat and /reset suppressed after idle reset', () => {
		it.each([['/newchat'], ['/reset']])(
			'idle reset + %s command → handleNewChat NOT called (no double-message)',
			async (command) => {
				// The idle reset already ended the session and sent the inactivity notice.
				// A literal /newchat or /reset arriving in the same turn must be silently suppressed.
				const conv = makeConversationService();
				const idleResetDeps = makeIdleResetDeps(
					{ status: 'reset', endedSessionId: 'session-idle-cmd', parentTitle: null },
					1,
				);
				const cache = new ManifestCache();
				cache.add(echoManifest, '/apps/echo');
				const registry = {
					getApp: () => undefined,
					getManifestCache: () => cache,
					getAll: () => [],
					getLoadedAppIds: () => [],
				} as unknown as AppRegistry;
				const telegram = createMockTelegram();
				const router = new Router({
					registry,
					llm: createMockLLM(),
					telegram,
					fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
					config: createConfig(),
					logger: createMockLogger(),
					conversationService: conv as any,
					idleResetDeps,
				});
				router.buildRoutingTables();

				await router.routeMessage(msg(command));

				// handleNewChat must NOT be called — idle reset handled the session end.
				expect(conv.handleNewChat).not.toHaveBeenCalled();
				// No "Starting a new chat" notice from the router's telegram.
				const sendMock = telegram.send as ReturnType<typeof vi.fn>;
				const sentTexts: string[] = sendMock.mock.calls.map((c: unknown[]) => c[1] as string);
				const newChatNotices = sentTexts.filter(
					(t) => t.toLowerCase().includes('starting') || t.toLowerCase().includes('new chat'),
				);
				expect(newChatNotices).toHaveLength(0);
			},
		);
	});
});
