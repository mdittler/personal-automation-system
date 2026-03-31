/**
 * LLM request context via AsyncLocalStorage.
 *
 * Transparently propagates userId through the call stack so that
 * cost tracking can attribute LLM calls to specific users without
 * requiring apps to pass userId explicitly.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LLMRequestContext {
	userId?: string;
}

export const llmContext = new AsyncLocalStorage<LLMRequestContext>();

/**
 * Get the current user ID from the LLM request context.
 * Returns undefined if not inside an llmContext.run() scope.
 */
export function getCurrentUserId(): string | undefined {
	return llmContext.getStore()?.userId;
}
