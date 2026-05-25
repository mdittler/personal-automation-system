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
import type { FlushableTelegramProxy } from '../router/reply-buffer-types.js';

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
	 * Undefined for non-conversation dispatch (scheduled jobs, alert actions,
	 * non-fallback router branches, admin/API writes). Validation is a
	 * consumer responsibility (the ALS stores the value verbatim).
	 */
	sessionId?: string;

	/**
	 * Optional multi-intent reply buffer. Present only inside
	 * `Router.tryMultiIntentSplit`. When present, the
	 * `ContextAwareTelegramService` wrapper routes plain `send(...)` through
	 * the buffer instead of the underlying transport; rich sends
	 * (`sendPhoto`/`sendWithButtons`/`sendOptions`) flush the buffer first
	 * and pass through; `editMessage` bypasses the buffer entirely (REQ-ROUTE-019b).
	 *
	 * See `core/src/services/router/reply-buffer.ts`.
	 *
	 * Codex Round 1 #2: every nested `requestContext.run(...)` site in Router
	 * must spread the outer store first or this field is dropped before any
	 * handler observes it. The `request-context-reply-buffer.test.ts` regression
	 * test pins that contract.
	 */
	replyBuffer?: FlushableTelegramProxy;
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
 * Get the current chat session ID from the request context.
 * Returns undefined if called outside any `requestContext.run()` scope,
 * if the current context has no sessionId set, or if the dispatch path
 * is non-conversational (scheduled jobs, alert actions, API writes).
 */
export function getCurrentSessionId(): string | undefined {
	return requestContext.getStore()?.sessionId;
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
 *
 * IMPORTANT: In Fastify auth hooks, calling `enterRequestContext` AFTER an
 * `await` does NOT reliably bind the eventual route handler to the new ALS
 * frame, because the handler runs in an async continuation forked from the
 * hook's pre-await state. For Fastify hooks that perform awaited auth work
 * before knowing the userId/householdId, use `enterMutableRequestContext`
 * instead — it seeds the ALS frame synchronously before the first await and
 * exposes mutators that update the same object reference once auth resolves.
 */
export function enterRequestContext(store: RequestContext): void {
	requestContext.enterWith(store);
}

/**
 * Mutator interface for a request context seeded synchronously at hook entry.
 *
 * Returned by `enterMutableRequestContext`. The underlying store object is
 * shared with the ALS frame — calling these setters updates the values that
 * `getCurrentUserId()` / `getCurrentHouseholdId()` / `getCurrentSessionId()`
 * return for the rest of the request, including from the route handler that
 * runs after the hook resolves.
 */
export interface MutableRequestContextHandle {
	setUserId(id?: string): void;
	setHouseholdId(id?: string): void;
	setSessionId(id?: string): void;
}

/**
 * Seed a mutable request context synchronously and return mutators for it.
 *
 * Calls `requestContext.enterWith({})` immediately, before any `await`, so
 * the empty store is bound to the current async resource and propagates to
 * the eventual Fastify route handler. The returned handle exposes setters
 * that mutate the SAME object reference, so awaited auth work can populate
 * userId/householdId after the fact and the handler will observe the
 * updated values via `getCurrentUserId()` etc.
 *
 * Use this in Fastify auth hooks; use `requestContext.run()` everywhere else.
 */
export function enterMutableRequestContext(): MutableRequestContextHandle {
	const store: RequestContext = {};
	requestContext.enterWith(store);
	return {
		setUserId(id?: string) {
			store.userId = id;
		},
		setHouseholdId(id?: string) {
			store.householdId = id;
		},
		setSessionId(id?: string) {
			store.sessionId = id;
		},
	};
}
