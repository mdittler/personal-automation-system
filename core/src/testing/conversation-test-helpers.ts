import { vi } from 'vitest';
import { ConversationService } from '../services/conversation/conversation-service.js';
import type { ChatSessionStore } from '../services/conversation-session/chat-session-store.js';
import type { EditService } from '../services/edit/index.js';
import type { CoreServices } from '../types/app-module.js';

function makeNullChatSessions(): ChatSessionStore {
	return {
		peekActive: vi.fn().mockResolvedValue(undefined),
		appendExchange: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
		loadRecentTurns: vi.fn().mockResolvedValue([]),
		endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
		readSession: vi.fn().mockResolvedValue(undefined),
		ensureActiveSession: vi.fn().mockResolvedValue({ sessionId: 'test-session', isNew: false, snapshot: undefined }),
		peekSnapshot: vi.fn().mockResolvedValue(undefined),
		setTitle: vi.fn().mockResolvedValue({ updated: false }),
	};
}

export function makeConversationService(
	services: CoreServices & { editService?: EditService; chatSessions?: ChatSessionStore },
): ConversationService {
	return new ConversationService({
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		chatSessions: services.chatSessions ?? makeNullChatSessions(),
		systemInfo: services.systemInfo,
		appMetadata: services.appMetadata,
		appKnowledge: services.appKnowledge,
		modelJournal: services.modelJournal,
		contextStore: services.contextStore,
		config: services.config,
		dataQuery: services.dataQuery ?? undefined,
		interactionContext: services.interactionContext ?? undefined,
		editService: services.editService,
	});
}
