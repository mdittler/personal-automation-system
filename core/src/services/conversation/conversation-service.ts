import type { MessageContext } from '../../types/telegram.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import { resolveOrDefaultSessionKey } from '../conversation-session/session-key.js';
import type { EditService } from '../edit/index.js';
import { type HandleAskDeps, handleAsk as coreHandleAsk } from './handle-ask.js';
import { handleEdit as coreHandleEdit } from './handle-edit.js';
import { type HandleMessageDeps, handleMessage as coreHandleMessage } from './handle-message.js';
import { handleNotes as coreHandleNotes } from './handle-notes.js';
import { pendingEdits } from './pending-edits.js';

/**
 * DI bundle for ConversationService. Equivalent to HandleMessageDeps plus
 * `editService` for /edit dispatch.
 *
 * Note: `titleService` from HandleMessageDeps flows through here unchanged —
 * it is used both by auto-title (handle-message.ts) and by the explicit
 * `handleTitle` command method.
 */
export type ConversationServiceDeps = HandleMessageDeps & {
	editService?: EditService;
};

/**
 * Core conversation orchestrator. Replaces the chatbot app's free-text dispatch
 * path. The Router establishes the `requestContext.run({ userId, householdId })`
 * boundary; this class is the inner call (mirrors how dispatchMessage wraps
 * `app.module.handleMessage`).
 *
 * Session persistence is handled by the injected ChatSessionStore (REQ-CONV-SESSION-*).
 * Concurrent handleMessage calls are serialized by the store's per-session file mutex.
 */
export class ConversationService {
	constructor(private readonly deps: ConversationServiceDeps) {}

	async handleMessage(ctx: MessageContext): Promise<void> {
		return coreHandleMessage(ctx, this.deps);
	}

	async handleAsk(args: string[], ctx: MessageContext): Promise<void> {
		const askDeps: HandleAskDeps = {
			llm: this.deps.llm,
			telegram: this.deps.telegram,
			data: this.deps.data,
			logger: this.deps.logger,
			timezone: this.deps.timezone,
			chatSessions: this.deps.chatSessions,
			...(this.deps.systemInfo !== undefined ? { systemInfo: this.deps.systemInfo } : {}),
			...(this.deps.appMetadata !== undefined ? { appMetadata: this.deps.appMetadata } : {}),
			...(this.deps.appKnowledge !== undefined ? { appKnowledge: this.deps.appKnowledge } : {}),
			...(this.deps.modelJournal !== undefined ? { modelJournal: this.deps.modelJournal } : {}),
			...(this.deps.contextStore !== undefined ? { contextStore: this.deps.contextStore } : {}),
			...(this.deps.config !== undefined ? { config: this.deps.config } : {}),
			...(this.deps.dataQuery !== undefined ? { dataQuery: this.deps.dataQuery } : {}),
			...(this.deps.interactionContext !== undefined
				? { interactionContext: this.deps.interactionContext }
				: {}),
			...(this.deps.conversationRetrieval !== undefined
				? { conversationRetrieval: this.deps.conversationRetrieval }
				: {}),
			...(this.deps.titleService !== undefined ? { titleService: this.deps.titleService } : {}),
			chatLogToNotesDefault: this.deps.chatLogToNotesDefault ?? false,
		};
		return coreHandleAsk(args, ctx, askDeps);
	}

	async handleNewChat(_args: string[], ctx: MessageContext): Promise<void> {
		const sessionKey = resolveOrDefaultSessionKey(ctx);
		const { endedSessionId } = await this.deps.chatSessions.endActive(
			{ userId: ctx.userId, sessionKey },
			'newchat',
		);
		if (endedSessionId) {
			await this.deps.telegram.send(
				ctx.userId,
				'Started a new conversation. Previous session saved.',
			);
		} else {
			await this.deps.telegram.send(ctx.userId, 'No active conversation to reset.');
		}
	}

	async handleTitle(args: string[], ctx: MessageContext): Promise<void> {
		const sessionKey = resolveOrDefaultSessionKey(ctx);
		const sessionId = await this.deps.chatSessions.peekActive({ userId: ctx.userId, sessionKey });
		if (!sessionId) {
			await this.deps.telegram.send(ctx.userId, 'No active conversation yet.');
			return;
		}

		if (args.length === 0) {
			// Read title from session frontmatter via readSession (NOT peekSnapshot, which
			// returns a MemorySnapshot and does not contain the `title` field).
			const session = await this.deps.chatSessions.readSession(ctx.userId, sessionId);
			const title = session?.meta.title ?? null;
			const display = title ? escapeMarkdown(title) : '(none)';
			await this.deps.telegram.send(ctx.userId, `Current title: ${display}`);
			return;
		}

		if (!this.deps.titleService) {
			await this.deps.telegram.send(ctx.userId, 'Title updates are not configured.');
			return;
		}

		const newTitle = args.join(' ');
		const result = await this.deps.titleService.applyTitle(ctx.userId, sessionId, newTitle, {
			skipIfTitled: false,
		});
		if (!result.updated) {
			await this.deps.telegram.send(
				ctx.userId,
				"Couldn't set that title — try a short plain-text phrase.",
			);
			return;
		}
		const written = result.title ?? newTitle;
		await this.deps.telegram.send(ctx.userId, `Title updated to: ${escapeMarkdown(written)}`);
	}

	async handleEdit(args: string[], ctx: MessageContext): Promise<void> {
		return coreHandleEdit(args, ctx, {
			editService: this.deps.editService,
			telegram: this.deps.telegram,
			logger: this.deps.logger,
			pendingEdits,
		});
	}

	async handleNotes(args: string[], ctx: MessageContext): Promise<void> {
		if (!this.deps.config) {
			await this.deps.telegram.send(ctx.userId, 'Config service is not available.');
			return;
		}
		return coreHandleNotes(args, ctx, {
			telegram: this.deps.telegram,
			config: this.deps.config,
			logger: this.deps.logger,
			systemDefault: this.deps.chatLogToNotesDefault ?? false,
		});
	}
}
