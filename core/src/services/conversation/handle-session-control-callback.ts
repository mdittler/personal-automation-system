/**
 * handleSessionControlCallback — extracted helper for sc:yes / sc:no button callbacks.
 *
 * Previously inline at compose-runtime.ts:1339-1361. Extracted for unit-testability
 * and to add confirmation telemetry (REQ-CONV-NEWCHAT-010).
 *
 * The CALLER is responsible for:
 *  - Nonce verification (peek + id check) before calling this function
 *  - Running inside the appropriate requestContext.run ALS scope
 *  - Sending the sc:no reply message (this helper handles only business logic)
 */

import type { AppLogger } from '../../types/app-module.js';
import type { MessageContext } from '../../types/telegram.js';
import type { PendingSessionControlStore } from './pending-session-control-store.js';
import type { SessionControlLogger } from './session-control-logger.js';

export interface HandleSessionControlCallbackDeps {
	pendingStore: PendingSessionControlStore;
	handleNewChat: (ctx: MessageContext) => Promise<void>;
	sessionControlLogger?: SessionControlLogger;
	logger: AppLogger;
	clock?: () => number;
}

/**
 * Handle the business logic for a sc:yes or sc:no callback.
 *
 * Callers have already verified the nonce. This function:
 *  - Consumes the pending entry (via `pendingStore.get`)
 *  - For sc:yes: calls `handleNewChat` (which sends its own confirmation)
 *  - For sc:no: entry is consumed to get `createdAtMs` for telemetry
 *  - Fires-and-forgets a confirmation telemetry event
 */
export async function handleSessionControlCallback(
	callbackData: 'sc:yes' | 'sc:no',
	entryId: string,
	ctx: MessageContext,
	deps: HandleSessionControlCallbackDeps,
): Promise<void> {
	const now = deps.clock?.() ?? Date.now();
	const entry = deps.pendingStore.get(ctx.userId); // consume-once (nonce pre-verified by caller)

	let outcome: 'confirmed' | 'declined' | 'expired-or-stale' | 'failed';
	let elapsedMs = 0;

	if (!entry || entry.id !== entryId) {
		// Race: expired between caller's peek and our get
		outcome = 'expired-or-stale';
	} else {
		elapsedMs = now - entry.createdAtMs;
		if (callbackData === 'sc:yes') {
			try {
				await deps.handleNewChat(ctx);
				outcome = 'confirmed';
			} catch (err) {
				deps.logger.warn(`session-control sc:yes handleNewChat failed: ${String(err)}`);
				outcome = 'failed';
			}
		} else {
			outcome = 'declined';
		}
	}

	deps.sessionControlLogger
		?.logConfirmation({
			timestamp: new Date(now),
			userId: ctx.userId,
			entryId,
			outcome,
			elapsedMs,
		})
		.catch(() => undefined);
}
