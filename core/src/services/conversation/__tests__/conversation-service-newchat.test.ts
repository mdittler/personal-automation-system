import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ConversationServiceDeps } from '../conversation-service.js';
import { ConversationService } from '../conversation-service.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { buildSessionKey } from '../../conversation-session/session-key.js';

const SESSION_KEY = buildSessionKey({
	agent: 'main',
	channel: 'telegram',
	scope: 'dm',
	chatId: 'user-0',
});

function makeChatSessions(opts: {
	endActiveResult?: { endedSessionId: string | null };
	loadRecentTurnsResult?: { role: 'user' | 'assistant'; content: string; timestamp: string }[];
	appendExchangeResult?: { sessionId: string };
} = {}): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi
			.fn()
			.mockResolvedValue(opts.appendExchangeResult ?? { sessionId: 'new-session-id' }),
		loadRecentTurns: vi.fn().mockResolvedValue(opts.loadRecentTurnsResult ?? []),
		endActive: vi.fn().mockResolvedValue(opts.endActiveResult ?? { endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: opts.appendExchangeResult?.sessionId ?? 'new-session-id', isNew: true, snapshot: undefined }),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
	};
}

function mockDeps(chatSessions: ChatSessionStore): ConversationServiceDeps {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue('hi back'),
			classify: vi.fn(),
			extractStructured: vi.fn(),
			getModelForTier: vi.fn().mockReturnValue('claude-sonnet-4-6'),
		} as any,
		telegram: {
			send: vi.fn(),
			sendPhoto: vi.fn(),
			sendOptions: vi.fn(),
			sendWithButtons: vi.fn(),
			editMessage: vi.fn(),
		} as any,
		data: {
			forUser: vi.fn().mockReturnValue({
				read: vi.fn().mockResolvedValue(''),
				write: vi.fn().mockResolvedValue(undefined),
				append: vi.fn().mockResolvedValue(undefined),
				exists: vi.fn().mockResolvedValue(false),
				list: vi.fn().mockResolvedValue([]),
				delete: vi.fn().mockResolvedValue(undefined),
			}),
			forShared: vi.fn(),
			forSpace: vi.fn(),
		} as any,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
		timezone: 'UTC',
		config: {
			get: vi.fn(),
			getAll: vi.fn(),
			getOverrides: vi.fn().mockResolvedValue(null),
			setAll: vi.fn(),
			updateOverrides: vi.fn(),
		} as any,
		chatSessions,
	};
}

// ---------------------------------------------------------------------------
// handleNewChat
// ---------------------------------------------------------------------------

describe('ConversationService.handleNewChat', () => {
	it('calls endActive with newchat reason and sends "Started a new conversation" when session was active', async () => {
		const chatSessions = makeChatSessions({ endActiveResult: { endedSessionId: 'old-session' } });
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = { ...createTestMessageContext({ userId: 'user-0', text: '/newchat' }), sessionKey: SESSION_KEY };

		await requestContext.run({ userId: 'user-0', householdId: null }, async () => {
			await svc.handleNewChat([], ctx);
		});

		expect(chatSessions.endActive).toHaveBeenCalledWith(
			{ userId: 'user-0', sessionKey: SESSION_KEY },
			'newchat',
		);
		expect((deps.telegram as any).send).toHaveBeenCalledWith(
			'user-0',
			expect.stringContaining('Started a new conversation'),
		);
	});

	it('sends "No active conversation to reset." when no session was active', async () => {
		const chatSessions = makeChatSessions({ endActiveResult: { endedSessionId: null } });
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = { ...createTestMessageContext({ userId: 'user-0', text: '/newchat' }), sessionKey: SESSION_KEY };

		await requestContext.run({ userId: 'user-0', householdId: null }, async () => {
			await svc.handleNewChat([], ctx);
		});

		expect((deps.telegram as any).send).toHaveBeenCalledWith(
			'user-0',
			expect.stringContaining('No active conversation'),
		);
	});

	it('falls back to buildSessionKey when ctx.sessionKey is absent', async () => {
		const chatSessions = makeChatSessions({ endActiveResult: { endedSessionId: null } });
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		// No sessionKey set on ctx
		const ctx = createTestMessageContext({ userId: 'user-0', text: '/newchat' });

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleNewChat([], ctx);
		});

		// endActive is still called (with derived session key)
		expect(chatSessions.endActive).toHaveBeenCalledWith(
			{ userId: 'user-0', sessionKey: expect.stringContaining('user-0') },
			'newchat',
		);
	});
});

// ---------------------------------------------------------------------------
// handleMessage — chatSessions wiring
// ---------------------------------------------------------------------------

describe('ConversationService.handleMessage — chatSessions wiring', () => {
	it('calls loadRecentTurns with sessionKey from ctx', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = { ...createTestMessageContext({ userId: 'user-0', text: 'hello' }), sessionKey: SESSION_KEY };

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect(chatSessions.loadRecentTurns).toHaveBeenCalledWith(
			{ userId: 'user-0', sessionKey: SESSION_KEY },
			{ maxTurns: 20 },
		);
	});

	it('calls appendExchange with both turns after a successful LLM response', async () => {
		const chatSessions = makeChatSessions({ appendExchangeResult: { sessionId: 'ensure-session-id' } });
		const deps = mockDeps(chatSessions);
		(deps.llm as any).complete = vi.fn().mockResolvedValue('hi there');
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: 'hello' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-0',
				sessionKey: SESSION_KEY,
				expectedSessionId: 'ensure-session-id',
			}),
			expect.objectContaining({ role: 'user', content: 'hello' }),
			expect.objectContaining({ role: 'assistant', content: 'hi there' }),
		);
	});

	it('does NOT call appendExchange when the LLM call fails', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		(deps.llm as any).complete = vi.fn().mockRejectedValue(new Error('LLM failure'));
		const svc = new ConversationService(deps);
		const ctx = { ...createTestMessageContext({ userId: 'user-0', text: 'hello' }), sessionKey: SESSION_KEY };

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect(chatSessions.appendExchange).not.toHaveBeenCalled();
	});

	it('passes ensuredSessionId from ensureActiveSession as expectedSessionId into appendExchange', async () => {
		const chatSessions = makeChatSessions({ appendExchangeResult: { sessionId: 'ensure-abc' } });
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: 'hello' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.objectContaining({ expectedSessionId: 'ensure-abc' }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it('appendExchange receives the ensuredSessionId even when ctx.sessionId is absent', async () => {
		const chatSessions = makeChatSessions({ appendExchangeResult: { sessionId: 'ensure-xyz' } });
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: 'hello' }),
			sessionKey: SESSION_KEY,
			};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.objectContaining({ expectedSessionId: 'ensure-xyz' }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it('still sends response and logs warn when appendExchange fails', async () => {
		const chatSessions = makeChatSessions();
		(chatSessions.appendExchange as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('disk full'),
		);
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = { ...createTestMessageContext({ userId: 'user-0', text: 'hello' }), sessionKey: SESSION_KEY };

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleMessage(ctx);
		});

		expect((deps.telegram as any).send).toHaveBeenCalled();
		expect((deps.logger as any).warn).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// handleAsk — chatSessions wiring
// ---------------------------------------------------------------------------

describe('ConversationService.handleAsk — chatSessions wiring', () => {
	it('calls loadRecentTurns with sessionKey from ctx', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: '/ask what apps?' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleAsk(['what apps?'], ctx);
		});

		expect(chatSessions.loadRecentTurns).toHaveBeenCalledWith(
			{ userId: 'user-0', sessionKey: SESSION_KEY },
			{ maxTurns: 20 },
		);
	});

	it('calls appendExchange after a successful /ask response', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		(deps.llm as any).complete = vi.fn().mockResolvedValue('Here are the apps...');
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: '/ask what apps?' }),
			sessionKey: SESSION_KEY,
			sessionId: 'ask-session-id',
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleAsk(['what apps?'], ctx);
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.objectContaining({ userId: 'user-0', sessionKey: SESSION_KEY }),
			expect.objectContaining({ role: 'user' }),
			expect.objectContaining({ role: 'assistant' }),
		);
	});

	it('does NOT call appendExchange when /ask has no args (static intro path)', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: '/ask' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleAsk([], ctx);
		});

		expect(chatSessions.appendExchange).not.toHaveBeenCalled();
		expect(chatSessions.loadRecentTurns).not.toHaveBeenCalled();
	});

	it('does NOT call appendExchange when LLM fails in /ask', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		(deps.llm as any).complete = vi.fn().mockRejectedValue(new Error('LLM failure'));
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: '/ask what?' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleAsk(['what?'], ctx);
		});

		expect(chatSessions.appendExchange).not.toHaveBeenCalled();
	});

	it('stores /ask prefix in the user turn content', async () => {
		const chatSessions = makeChatSessions();
		const deps = mockDeps(chatSessions);
		(deps.llm as any).complete = vi.fn().mockResolvedValue('answer');
		const svc = new ConversationService(deps);
		const ctx = {
			...createTestMessageContext({ userId: 'user-0', text: '/ask what is the status?' }),
			sessionKey: SESSION_KEY,
		};

		await requestContext.run({ userId: 'user-0' }, async () => {
			await svc.handleAsk(['what', 'is', 'the', 'status?'], ctx);
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ content: '/ask what is the status?' }),
			expect.objectContaining({ role: 'assistant' }),
		);
	});
});
