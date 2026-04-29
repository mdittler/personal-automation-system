/**
 * Regression: handleAsk / handleEdit live in core and don't take a command
 * name (the chatbot shim is the only place that branches on `'ask'` /
 * `'edit'`). This test is the core-side regression guard: it pins that the
 * core handlers don't accept a slashed command and that they're called
 * directly with their args/ctx — so even if the shim regresses, refactoring
 * core won't accidentally re-introduce a slashed-string contract.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ChatSessionStore } from '../../conversation-session/chat-session-store.js';
import { handleAsk } from '../handle-ask.js';
import { handleEdit } from '../handle-edit.js';
import { pendingEdits } from '../pending-edits.js';

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

describe('core conversation handlers — command contract', () => {
	it('handleAsk takes (args, ctx, deps) — no command name parameter', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.data.forUser).mockReturnValue(createMockScopedStore());
		vi.mocked(services.llm.complete).mockResolvedValue('answer');

		const ctx = createTestMessageContext({ text: '/ask what apps?' });
		await handleAsk(['what', 'apps?'], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions: makeChatSessions(),
			appMetadata: services.appMetadata,
			appKnowledge: services.appKnowledge,
			modelJournal: services.modelJournal,
			contextStore: services.contextStore,
			config: services.config,
			systemInfo: services.systemInfo,
		});

		// /ask with args calls LLM at standard tier
		expect(services.llm.complete).toHaveBeenCalled();
	});

	it('handleEdit takes (args, ctx, deps) — no command name parameter', async () => {
		const services = createMockCoreServices();
		const editService = {
			proposeEdit: vi
				.fn()
				.mockResolvedValue({ kind: 'error', action: 'no_match', message: 'no match' }),
			confirmEdit: vi.fn(),
		};

		const ctx = createTestMessageContext({ text: '/edit foo' });
		await handleEdit(['foo'], ctx, {
			editService,
			telegram: services.telegram,
			logger: services.logger,
			pendingEdits,
		});

		expect(editService.proposeEdit).toHaveBeenCalledWith('foo', expect.any(String));
	});

	it('handleAsk shows the static intro and skips LLM when args is empty', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.data.forUser).mockReturnValue(createMockScopedStore());

		const ctx = createTestMessageContext({ text: '/ask' });
		await handleAsk([], ctx, {
			llm: services.llm,
			telegram: services.telegram,
			data: services.data,
			logger: services.logger,
			timezone: 'UTC',
			chatSessions: makeChatSessions(),
		});

		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('PAS assistant'),
		);
	});
});
