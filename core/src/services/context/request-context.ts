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
