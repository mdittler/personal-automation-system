/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * Transparently propagates per-request metadata (userId, householdId) through
 * the async call stack so infrastructure consumers — LLM cost attribution,
 * `AppConfigService` per-user override lookups, household boundary enforcement,
 * and any future per-request infrastructure (audit logging, feature flags,
 * locale, …) — can read the current request's user/household without apps
 * having to pass it explicitly.
 *
 * Established at every dispatch entry point (Telegram message/photo/callback,
 * route-verification buttons, alert `dispatch_message` actions, the external
 * API `POST /api/messages` endpoint, and the scheduler for `user_scope:
 * per-user` jobs) via `requestContext.run({ userId, householdId }, fn)`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
	/**
	 * The user on whose behalf the current request is running.
	 * Undefined for system-level work (e.g. `user_scope: all` scheduled jobs).
	 */
	userId?: string;

	/**
	 * The household the current user belongs to.
	 * Undefined when userId is absent or when householdId derivation has not
	 * yet been wired (e.g. before Task J bootstrap wiring).
	 */
	householdId?: string;

	/**
	 * The chat session the current request belongs to.
	 *
	 * P0 adds the field; no production dispatch site populates it yet. P3 wires
	 * `ChatSessionStore` to set it on every conversation turn, and P5 reads it
	 * when indexing messages into the FTS5 transcript store.
	 *
	 * Undefined for non-conversation dispatch (scheduled jobs, alert actions,
	 * non-fallback router branches, admin/API writes). Validation is a
	 * consumer responsibility (the ALS stores the value verbatim).
	 */
	sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current user ID from the request context.
 * Returns undefined if called outside any `requestContext.run()` scope
 * or if the current context has no userId set.
 */
export function getCurrentUserId(): string | undefined {
	return requestContext.getStore()?.userId;
}

/**
 * Get the current household ID from the request context.
 * Returns undefined if called outside any `requestContext.run()` scope,
 * if the current context has no householdId set, or if householdId
 * derivation has not yet been wired at the relevant entry point.
 */
export function getCurrentHouseholdId(): string | undefined {
	return requestContext.getStore()?.householdId;
}

/**
 * Enter a request context synchronously, binding the provided store to the
 * current async execution context and all its descendants.
 *
 * Unlike `requestContext.run(store, fn)` (which creates a child scope),
 * `enterRequestContext` mutates the current context store so that code
 * running *after* this call in the same async continuation — but NOT inside
 * a callback — sees the new values. This is appropriate for Fastify onRequest
 * hooks that set the context once for the lifetime of a request handler.
 *
 * Used by the GUI auth guard (D5b-3) and the API auth hook (D5b-6).
 */
export function enterRequestContext(store: RequestContext): void {
	requestContext.enterWith(store);
}
