/**
 * Integration test: handle-ask schedules auto-title hook after first exchange.
 *
 * Covers:
 *  - First exchange (sessionIsNew && turns.length === 0) → scheduleTitleAfterFirstExchange called
 *  - userContent is the question string (without /ask prefix)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../conversation-titling/auto-title-hook.js', () => ({
	scheduleTitleAfterFirstExchange: vi.fn(),
	runTitleAfterFirstExchange: vi.fn(),
}));

import { handleAsk } from '../handle-ask.js';
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

describe('handleAsk — auto-title hook wiring', () => {
	beforeEach(() => {
		vi.mocked(scheduleTitleAfterFirstExchange).mockClear();
	});

	it('schedules auto-title for /ask when session is new and there are no prior turns', async () => {
		const services = createMockCoreServices();
		const store = createMockScopedStore();
		vi.mocked(services.data.forUser).mockReturnValue(store);
		// classifier call (fast tier) returns NO, then main response (standard tier)
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO')
			.mockResolvedValueOnce('The ask response');

		const chatSessions = makeChatSessions({
			ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'ask-sess-1', isNew: true, snapshot: undefined }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
		});
		const titleService = makeTitleService();
		const ctx = createTestMessageContext({ text: '/ask what apps do I have?' });

		await handleAsk(['what', 'apps', 'do', 'I', 'have?'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions,
			titleService,
		});

		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledOnce();
		expect(scheduleTitleAfterFirstExchange).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: ctx.userId,
				sessionId: 'ask-sess-1',
				// userContent should be the question — NOT the raw /ask prefixed text
				userContent: 'what apps do I have?',
				assistantContent: 'The ask response',
			}),
			expect.objectContaining({ titleService }),
		);
	});
});
