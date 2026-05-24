/**
 * REQ-ROUTE-020 — the optional `replyBuffer` field on `RequestContext` is
 * scoped per-async-execution-context via AsyncLocalStorage. These tests pin:
 *
 * 1. Absence in default scope.
 * 2. Propagation through nested async work.
 * 3. Isolation between parallel `requestContext.run(...)` scopes.
 * 4. The Codex Round 1 #2 regression — a nested `requestContext.run` site
 *    inside Router that re-establishes the store MUST spread the outer store
 *    first, or the outer buffer is dropped before any handler observes it.
 */

import { describe, expect, it } from 'vitest';
import type { FlushableTelegramProxy } from '../../router/reply-buffer-types.js';
import { requestContext } from '../request-context.js';

describe('requestContext — replyBuffer scope', () => {
	it('returns undefined when no buffer is in scope', () => {
		const ctx = requestContext.getStore();
		expect(ctx?.replyBuffer).toBeUndefined();
	});

	it('propagates replyBuffer through nested async work', async () => {
		const stubBuffer = {} as FlushableTelegramProxy;
		const result = await requestContext.run({ userId: 'u1', replyBuffer: stubBuffer }, async () => {
			await Promise.resolve();
			return requestContext.getStore()?.replyBuffer;
		});
		expect(result).toBe(stubBuffer);
	});

	it('does not leak buffer to a parallel context (AsyncLocalStorage isolation)', async () => {
		const stubA = {} as FlushableTelegramProxy;
		const [a, b] = await Promise.all([
			requestContext.run({ userId: 'u1', replyBuffer: stubA }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return requestContext.getStore()?.replyBuffer;
			}),
			requestContext.run({ userId: 'u2' }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return requestContext.getStore()?.replyBuffer;
			}),
		]);
		expect(a).toBe(stubA);
		expect(b).toBeUndefined();
	});

	it('REQ-ROUTE-020 hardening — nested run() that re-establishes context must preserve outer replyBuffer (Codex Round 1 #2)', async () => {
		// Mirrors the production pattern in Router.dispatchMessage /
		// dispatchPhoto / dispatchConversation: they each call
		// `requestContext.run({ userId, householdId, [sessionId] }, ...)` —
		// which would DROP the outer replyBuffer unless the outer store is
		// spread first. Task 2.4 patches all 3 sites; this test pins the
		// contract that the spread is the load-bearing operation.
		const stub = {} as FlushableTelegramProxy;
		const inner = await requestContext.run({ userId: 'u1', replyBuffer: stub }, async () =>
			requestContext.run(
				{ ...requestContext.getStore(), userId: 'u1', householdId: 'h1' },
				async () => requestContext.getStore()?.replyBuffer,
			),
		);
		expect(inner).toBe(stub);
	});
});
