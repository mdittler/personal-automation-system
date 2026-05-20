import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { MemorySnapshot } from '../../types/conversation-session.js';
import type { MessageContext, TelegramService } from '../../types/telegram.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import type { ConversationRetrievalService } from '../conversation-retrieval/conversation-retrieval-service.js';
import type { ChatSessionStore } from '../conversation-session/chat-session-store.js';
import { NoActiveSessionError } from '../conversation-session/errors.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import { resolveUserBool } from './settings-resolver.js';

export interface HandleRefreshMemoryDeps {
	telegram: TelegramService;
	chatSessions: ChatSessionStore;
	conversationRetrieval?: ConversationRetrievalService;
	config?: AppConfigService;
	logger: AppLogger;
}

export async function handleRefreshMemory(
	_args: string,
	ctx: MessageContext,
	deps: HandleRefreshMemoryDeps,
): Promise<void> {
	const userId = ctx.userId;
	const sessionKey = resolveOrDefaultSessionKey(ctx);

	if (!deps.conversationRetrieval) {
		deps.logger.warn(`refresh-memory: conversationRetrieval not available userId=${userId}`);
		await deps.telegram.send(userId, 'Memory refresh deferred — try again later.');
		return;
	}
	const retrieval = deps.conversationRetrieval;

	const buildSnapshot = async (): Promise<MemorySnapshot> => {
		const flushEnabled = deps.config
			? await resolveUserBool(deps.config, userId, 'flush_memory_on_idle_reset', false, deps.logger)
			: false;
		return retrieval.buildMemorySnapshot(flushEnabled ? {} : { pinnedKeys: [] });
	};

	try {
		const snapshot = await deps.chatSessions.rebuildMemorySnapshot(
			{ userId, sessionKey },
			{ buildSnapshot, expectedSessionId: ctx.sessionId },
		);
		const text =
			snapshot.status === 'degraded'
				? 'Memory refreshed (degraded): some context unavailable.'
				: `Memory refreshed: ${snapshot.entryCount} entries (${snapshot.content.length} chars).`;
		await deps.telegram.send(userId, escapeMarkdown(text));
	} catch (err) {
		if (err instanceof NoActiveSessionError) {
			await deps.telegram.send(userId, 'No active session to refresh.');
			return;
		}
		deps.logger.warn(
			`refresh-memory failed userId=${userId} sessionId=${ctx.sessionId ?? 'none'}: ${String(err)}`,
		);
		await deps.telegram.send(userId, 'Memory refresh deferred — try again later.');
	}
}
