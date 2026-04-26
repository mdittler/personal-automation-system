import type { MessageContext } from '../../types/telegram.js';
import { ConversationHistory } from '../conversation-history/index.js';
import { handleMessage as coreHandleMessage, type HandleMessageDeps } from './handle-message.js';

/**
 * DI bundle for ConversationService. Equivalent to HandleMessageDeps minus
 * `history` — the service owns the long-lived ConversationHistory instance.
 */
export type ConversationServiceDeps = Omit<HandleMessageDeps, 'history'>;

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
}
