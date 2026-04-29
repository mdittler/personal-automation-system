/**
 * Integration test: handle-message schedules auto-title hook after first exchange.
 *
 * Covers:
 *  - First exchange (sessionIsNew && turns.length === 0) → scheduleTitleAfterFirstExchange called
 *  - Subsequent exchanges (sessionIsNew but turns.length > 0) → not called
 *  - Session not new (isNew: false) → not called
 *  - When titleService is undefined → not called (and no error)
 *  - Hook is scheduled AFTER appendExchange resolves
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../conversation-titling/auto-title-hook.js', () => ({
	scheduleTitleAfterFirstExchange: vi.fn(),
	runTitleAfterFirstExchange: vi.fn(),
}));

import { handleMessage } from '../handle-message.js';
import { scheduleTitleAfterFirstExchange } from '../../conversation-titling/auto-title-hook.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { TitleService } from '../../conversation-titling/title-service.js';

function makeChatSessions(overrides?: Partial<ChatSessionStore>): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'session-1', isNew: true, snapshot: undefined }),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
		...overrides,
	};
}

function makeTitleService(): TitleService {
	return {
		applyTitle: vi.fn().mockResolvedValue({ updated: true, title: 'Generated Title' }),
	} as unknown as TitleService;
}

function makeDeps(chatSessions: ChatSessionStore) {
	const services = createMockCoreServices();
	const store = createMockScopedStore();
	vi.mocked(services.data.forUser).mockReturnValue(store);
	vi.mocked(services.llm.complete).mockResolvedValue('The assistant response');
	return {
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		chatSessions,
	};
}

describe('handleMessage — auto-title hook wiring', () => {
	beforeEach(() => {
		vi.mocked(scheduleTitleAfterFirstExchange).mockClear();
	});

	it('schedules auto-title when session is new and there are no prior turns', async () => {
		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', isNew: true, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
		});
		const titleService = makeTitleService();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			...makeDeps(chatSessions),
			chatSessions,
			titleService,
		});

		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledOnce();
		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: ctx.userId,
				sessionId: 'sess-1',
				userContent: ctx.text,
				assistantContent: 'The assistant response',
			}),
			expect.objectContaining({ titleService }),
		);
	});

	it('does NOT schedule auto-title when session is not new', async () => {
		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'existing-sess', isNew: false, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
		});
		const titleService = makeTitleService();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			...makeDeps(chatSessions),
			chatSessions,
			titleService,
		});

		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('does NOT schedule auto-title when there are prior turns (not first exchange)', async () => {
		const priorTurns = [
			{ role: 'user' as const, content: 'previous message', timestamp: '2026-01-01T00:00:00Z' },
			{ role: 'assistant' as const, content: 'previous response', timestamp: '2026-01-01T00:00:01Z' },
		];
		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', isNew: true, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue(priorTurns),
		});
		const titleService = makeTitleService();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			...makeDeps(chatSessions),
			chatSessions,
			titleService,
		});

		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('does NOT schedule auto-title when titleService is undefined', async () => {
		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', isNew: true, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
		});
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		// No titleService provided — should not throw and should not call hook
		await expect(
			handleMessage(ctx, {
				...makeDeps(chatSessions),
				chatSessions,
				// titleService intentionally omitted
			}),
		).resolves.toBeUndefined();

		expect(scheduleTitleAfterFirstExchange).not.toHaveBeenCalled();
	});

	it('schedules auto-title AFTER appendExchange resolves', async () => {
		const callOrder: string[] = [];

		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', isNew: true, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
			appendExchange: vi.fn().mockImplementation(async () => {
				callOrder.push('appendExchange');
				return { sessionId: 'sess-1' };
			}),
		});
		vi.mocked(scheduleTitleAfterFirstExchange).mockImplementation(() => {
			callOrder.push('scheduleTitle');
		});

		const titleService = makeTitleService();
		const ctx = createTestMessageContext({ text: 'Hello bot' });

		await handleMessage(ctx, {
			...makeDeps(chatSessions),
			chatSessions,
			titleService,
		});

		const appendIdx = callOrder.indexOf('appendExchange');
		const scheduleIdx = callOrder.indexOf('scheduleTitle');
		expect(appendIdx).toBeGreaterThan(-1);
		expect(scheduleIdx).toBeGreaterThan(appendIdx);
	});
});
