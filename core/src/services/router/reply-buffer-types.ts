/**
 * Shared types for the multi-intent reply collector ("Option B").
 *
 * This module exists separately from `reply-buffer.ts` to break a type-ordering
 * cycle: `core/src/services/context/request-context.ts` declares an optional
 * `replyBuffer?: FlushableTelegramProxy` field on `RequestContext`, and
 * `request-context.ts` is imported transitively from nearly everywhere — long
 * before the buffer's runtime implementation is available. By keeping only the
 * type declaration here, we avoid pulling `BufferingTelegramProxy` (and its
 * dependency on the full TelegramService implementation chain) into the
 * request-context module graph.
 *
 * Codex Round 1 finding #11: this file must land before any consumer can import
 * from it.
 *
 * Implementation: `core/src/services/router/reply-buffer.ts`
 * (`BufferingTelegramProxy`, Task 2.2).
 */

import type { TelegramService } from '../../types/telegram.js';

/**
 * `TelegramService` extended with an explicit `flushPending` operation.
 *
 * Lives in `requestContext.replyBuffer` during multi-intent dispatch so the
 * `ContextAwareTelegramService` wrapper can route plain `send(...)` calls
 * through the buffer. The Router calls `flushPending` at the end of
 * `tryMultiIntentSplit` to emit the combined reply.
 */
export interface FlushableTelegramProxy extends TelegramService {
	/**
	 * Emit all pending buffered text for `userId` as one or more Telegram
	 * messages.
	 *
	 * Splits at segment boundaries when total length exceeds the configured
	 * `maxLength`; hard-splits an individual segment that exceeds `maxLength`
	 * by itself. The buffer for `userId` is cleared regardless of whether the
	 * underlying transport resolves or rejects, so a second flush is a safe
	 * no-op.
	 */
	flushPending(userId: string): Promise<void>;
}
