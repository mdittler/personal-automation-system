/**
 * Context-aware TelegramService wrapper.
 *
 * Wraps a real `TelegramService` so handler calls to `send(...)` (and other
 * non-edit methods) are routed through `requestContext.getStore()?.replyBuffer`
 * when one is active (i.e., during multi-intent dispatch). When no buffer is
 * in scope (the normal single-message path), every call delegates straight
 * to the inner real service unchanged — zero overhead in steady state.
 *
 * Codex Round 1 #3: the inner real transport is held as a separate handle so
 * that any code path that needs to bypass the buffer (in particular,
 * `BufferingTelegramProxy.inner` itself and `editMessage` regardless of
 * scope) can do so deterministically. A buffer that wrapped this wrapper
 * would loop infinitely on flush.
 *
 * Codex Round 1 #10: `editMessage` ALWAYS goes straight to the real transport
 *                    (REQ-ROUTE-019b).
 */

import type { InlineButton, SentMessage, TelegramService } from '../../types/telegram.js';
import { requestContext } from '../context/request-context.js';

export class ContextAwareTelegramService implements TelegramService {
	constructor(private readonly real: TelegramService) {}

	private get target(): TelegramService {
		return requestContext.getStore()?.replyBuffer ?? this.real;
	}

	send(userId: string, message: string): Promise<void> {
		return this.target.send(userId, message);
	}

	sendPhoto(userId: string, photo: Buffer, caption?: string): Promise<void> {
		return this.target.sendPhoto(userId, photo, caption);
	}

	sendOptions(userId: string, prompt: string, options: string[]): Promise<string> {
		return this.target.sendOptions(userId, prompt, options);
	}

	sendWithButtons(userId: string, text: string, buttons: InlineButton[][]): Promise<SentMessage> {
		return this.target.sendWithButtons(userId, text, buttons);
	}

	editMessage(
		chatId: number,
		messageId: number,
		text: string,
		buttons?: InlineButton[][],
	): Promise<void> {
		// REQ-ROUTE-019b: editMessage targets a prior message id and is
		// order-independent; bypass the buffer even when one is in scope.
		return this.real.editMessage(chatId, messageId, text, buttons);
	}
}
