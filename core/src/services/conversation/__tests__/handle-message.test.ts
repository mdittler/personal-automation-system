import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemorySnapshot } from '../../../types/conversation-session.js';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { handleMessage } from '../handle-message.js';

function makeChatSessions(): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'session-1', isNew: true, snapshot: undefined }),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
	};
}

function makeDeps() {
	const services = createMockCoreServices();
	const store = createMockScopedStore();
	vi.mocked(services.data.forUser).mockReturnValue(store);
	vi.mocked(services.llm.complete).mockResolvedValue('The assistant response');
	return {
		services,
		store,
		chatSessions: makeChatSessions(),
	};
}

describe('handleMessage', () => {
	it('sends the LLM response to the user', async () => {
		const { services, chatSessions } = makeDeps();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(services.telegram.send).toHaveBeenCalledWith('test-user', 'The assistant response');
	});

	it('saves history after sending the response', async () => {
		const { services, chatSessions } = makeDeps();
		const ctx = createTestMessageContext({ text: 'Remember this' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(chatSessions.appendExchange).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ role: 'user', content: 'Remember this' }),
			expect.objectContaining({ role: 'assistant', content: 'The assistant response' }),
		);
	});

	it('sends a friendly error message when LLM call fails', async () => {
		const { services, chatSessions } = makeDeps();
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('rate limit'));
		const ctx = createTestMessageContext({ text: 'hello' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(services.telegram.send).toHaveBeenCalled();
		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		// Should be a user-friendly error message, not a raw stack trace
		expect(sentText).not.toContain('Error:');
		expect(sentText.length).toBeGreaterThan(0);
	});

	it('strips switch-model tags without executing them', async () => {
		const { services, chatSessions } = makeDeps();
		vi.mocked(services.llm.complete).mockResolvedValue(
			'Here is my answer <switch-model tier="fast" provider="anthropic" model="claude-haiku-4-5-20251001"/> done.',
		);
		const ctx = createTestMessageContext({ text: 'What model?' });

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		const sentText = vi.mocked(services.telegram.send).mock.calls[0][1] as string;
		expect(sentText).not.toContain('<switch-model');
		// setTierModel should NOT be called — tags are stripped without executing
		expect(services.systemInfo?.setTierModel).not.toHaveBeenCalled();
	});

	it('logs a warning and continues when appendExchange fails', async () => {
		const { services, chatSessions } = makeDeps();
		(chatSessions.appendExchange as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('disk full'),
		);
		const ctx = createTestMessageContext({ text: 'hello' });

		// Should not throw
		await expect(
			handleMessage(ctx, {
				llm: services.llm,
				telegram: services.telegram,
				data: services.data,
				logger: services.logger,
				timezone: 'UTC',
				chatSessions,
			}),
		).resolves.toBeUndefined();

		expect(services.logger.warn).toHaveBeenCalled();
		// Response was still sent before the history failure
		expect(services.telegram.send).toHaveBeenCalled();
	});
});

describe('handleMessage — ensureActiveSession wiring', () => {
	let services: ReturnType<typeof createMockCoreServices>;
	let chatSessions: ChatSessionStore;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockResolvedValue('OK');
		chatSessions = makeChatSessions();
	});

	it('calls ensureActiveSession before LLM call', async () => {
		const ctx = createTestMessageContext({ text: 'test' });
		const llmCallOrder: string[] = [];
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
			llmCallOrder.push('ensure');
			return Promise.resolve({ sessionId: 'sess', isNew: true, snapshot: undefined });
		});
		vi.mocked(services.llm.complete).mockImplementation(() => {
			llmCallOrder.push('llm');
			return Promise.resolve('OK');
		});

		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		const ensureIdx = llmCallOrder.indexOf('ensure');
		const llmIdx = llmCallOrder.indexOf('llm');
		expect(ensureIdx).toBeGreaterThan(-1);
		expect(llmIdx).toBeGreaterThan(ensureIdx);
	});

	it('passes snapshot to system prompt when conversationRetrieval is wired', async () => {
		const okSnapshot: MemorySnapshot = {
			content: 'User prefers Celsius.',
			status: 'ok',
			builtAt: '2026-01-01T00:00:00Z',
			entryCount: 1,
		};
		const buildMemorySnapshot = vi.fn().mockResolvedValue(okSnapshot);
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: 'sess',
			isNew: true,
			snapshot: okSnapshot,
		});
		const retrieval = {
			buildContextSnapshot: vi.fn().mockResolvedValue(null),
			buildMemorySnapshot,
			searchSessions: vi.fn(),
			hasSessionSearch: vi.fn().mockReturnValue(false),
		};

		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
			conversationRetrieval: retrieval as never,
		});

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(systemPrompt).toContain('<memory-context label="durable-memory">');
		expect(systemPrompt).toContain('User prefers Celsius.');
	});

	it('no durable-memory block when conversationRetrieval is absent', async () => {
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: 'sess',
			isNew: true,
			snapshot: undefined,
		});

		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(systemPrompt).not.toContain('<memory-context label="durable-memory">');
	});

	it('no durable-memory block when buildMemorySnapshot returns degraded status', async () => {
		const degradedSnapshot: MemorySnapshot = {
			content: '',
			status: 'degraded',
			builtAt: '2026-01-01T00:00:00Z',
			entryCount: 0,
		};
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: 'sess',
			isNew: true,
			snapshot: degradedSnapshot,
		});

		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0]?.[1]?.systemPrompt ?? '';
		expect(systemPrompt).not.toContain('<memory-context label="durable-memory">');
	});

	it('ensureActiveSession is called with buildSnapshot only when conversationRetrieval is wired', async () => {
		const retrieval = {
			buildContextSnapshot: vi.fn().mockResolvedValue(null),
			buildMemorySnapshot: vi.fn().mockResolvedValue({
				content: 'x',
				status: 'ok',
				builtAt: '',
				entryCount: 0,
			}),
			searchSessions: vi.fn(),
			hasSessionSearch: vi.fn().mockReturnValue(false),
		};

		const ctx = createTestMessageContext({ text: 'test' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
			conversationRetrieval: retrieval as never,
		});

		const call = (chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.[1]?.buildSnapshot).toBeTypeOf('function');
	});

	it('ensureActiveSession is called without buildSnapshot when conversationRetrieval is absent', async () => {
		const ctx = createTestMessageContext({ text: 'test' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		const call = (chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call?.[1]?.buildSnapshot).toBeUndefined();
	});

	it('still replies when ensureActiveSession throws (fail-open)', async () => {
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('session store unavailable'),
		);
		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(services.telegram.send).toHaveBeenCalled();
		expect(services.logger.warn).toHaveBeenCalled();
	});

	it('ends the session when LLM fails on a newly minted session', async () => {
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: 'new-sess',
			isNew: true,
			snapshot: undefined,
		});
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM failure'));

		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(chatSessions.endActive).toHaveBeenCalledWith(
			expect.objectContaining({ userId: ctx.userId }),
			'system',
		);
	});

	it('does not call endActive on LLM failure when session was not newly minted', async () => {
		(chatSessions.ensureActiveSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			sessionId: 'existing-sess',
			isNew: false,
			snapshot: undefined,
		});
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM failure'));

		const ctx = createTestMessageContext({ text: 'hello' });
		await handleMessage(ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
		});

		expect(chatSessions.endActive).not.toHaveBeenCalled();
	});
});
