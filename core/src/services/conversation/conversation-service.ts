import type { MessageContext } from '../../types/telegram.js';
import { ConversationHistory } from '../conversation-history/index.js';
import type { EditService } from '../edit/index.js';
import { type HandleAskDeps, handleAsk as coreHandleAsk } from './handle-ask.js';
import { handleEdit as coreHandleEdit } from './handle-edit.js';
import { type HandleMessageDeps, handleMessage as coreHandleMessage } from './handle-message.js';
import { handleNotes as coreHandleNotes } from './handle-notes.js';
import { pendingEdits } from './pending-edits.js';

/**
 * DI bundle for ConversationService. Equivalent to HandleMessageDeps minus
 * `history` — the service owns the long-lived ConversationHistory instance.
 * `editService` is added here (not present on HandleMessageDeps) for /edit dispatch.
 */
export type ConversationServiceDeps = Omit<HandleMessageDeps, 'history'> & {
	editService?: EditService;
};

/**
 * Core conversation orchestrator. Replaces the chatbot app's free-text dispatch
 * path. The Router establishes the `requestContext.run({ userId, householdId })`
 * boundary; this class is the inner call (mirrors how dispatchMessage wraps
 * `app.module.handleMessage`).
 *
 * Holds one ConversationHistory({ maxTurns: 20 }) for the lifetime of the
 * process. Per-user serialized writes happen via ConversationHistory.writeQueue
 * (REQ-CHATBOT-018), so concurrent handleMessage calls do not corrupt history.
 */
export class ConversationService {
	private readonly history: ConversationHistory;

	constructor(private readonly deps: ConversationServiceDeps) {
		this.history = new ConversationHistory({ maxTurns: 20 });
	}

	async handleMessage(ctx: MessageContext): Promise<void> {
		return coreHandleMessage(ctx, { ...this.deps, history: this.history });
	}

	async handleAsk(args: string[], ctx: MessageContext): Promise<void> {
		const askDeps: HandleAskDeps = {
			llm: this.deps.llm,
			telegram: this.deps.telegram,
			data: this.deps.data,
			logger: this.deps.logger,
			timezone: this.deps.timezone,
			history: this.history,
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
			chatLogToNotesDefault: this.deps.chatLogToNotesDefault ?? false,
		};
		return coreHandleAsk(args, ctx, askDeps);
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
