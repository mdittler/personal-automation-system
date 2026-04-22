/**
 * Table-driven tests for dispatchByRoute.
 *
 * RED phase — apps/food/src/routing/dispatch.ts does not exist yet.
 * All imports will fail, confirming RED state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RouteInfo } from '@core/types/telegram.js';
import { dispatchByRoute } from '../dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(overrides: Partial<RouteInfo> = {}): RouteInfo {
	return {
		appId: 'food',
		intent: 'K1',
		confidence: 0.92,
		source: 'intent',
		verifierStatus: 'agreed',
		...overrides,
	};
}

/** Minimal context — dispatchByRoute only inspects ctx.route */
function makeCtx(route?: RouteInfo): { route?: RouteInfo } {
	return { route };
}

// ---------------------------------------------------------------------------
// Shared setup — reset all mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Happy-path cases — all should return true and invoke the matched handler
// ---------------------------------------------------------------------------

describe('dispatchByRoute — happy path', () => {
	it('intent source, agreed verifier, above threshold → returns true, handler called once', async () => {
		const h1 = vi.fn(() => Promise.resolve());
		const h2 = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ appId: 'food', intent: 'K1', confidence: 0.92, source: 'intent', verifierStatus: 'agreed' }));
		const handlers = { K1: h1, K2: h2 };

		const result = await dispatchByRoute(ctx, handlers);

		expect(result).toBe(true);
		expect(h1).toHaveBeenCalledOnce();
		expect(h2).not.toHaveBeenCalled();
	});

	it('intent source, skipped verifier, high confidence → returns true', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'intent', verifierStatus: 'skipped', confidence: 0.88 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('IMPORTANT: degraded verifier treated as skipped — above threshold → returns true', async () => {
		// verifierStatus:'degraded' means verifier LLM failed; treated same as 'skipped'.
		// Confidence alone decides. 0.88 > MIN_INTENT_CONFIDENCE (0.75) → should dispatch.
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'intent', verifierStatus: 'degraded', confidence: 0.88 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('command source — confidence threshold skipped, not-run verifier → returns true', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'command', verifierStatus: 'not-run', confidence: 1.0 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('user-override source — returns true', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'user-override', verifierStatus: 'user-override', confidence: 1.0 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('context-promotion source, agreed verifier → returns true', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'context-promotion', verifierStatus: 'agreed', confidence: 0.8 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('handler throws — error propagates (message is CLAIMED; no false return / regex cascade)', async () => {
		const throwingHandler = vi.fn(() => Promise.reject(new Error('handler error')));
		const ctx = makeCtx(makeRoute({ source: 'intent', verifierStatus: 'agreed', confidence: 0.92 }));

		// If claimed, the promise should reject — not silently return false.
		await expect(dispatchByRoute(ctx, { K1: throwingHandler })).rejects.toThrow('handler error');
	});
});

// ---------------------------------------------------------------------------
// Edge cases — all should return false, no handler invoked
// ---------------------------------------------------------------------------

describe('dispatchByRoute — edge cases returning false', () => {
	it('route absent (ctx.route = undefined) → false, handler not called', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(undefined);

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('appId mismatch — route.appId is "shopping", not "food" → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ appId: 'shopping' }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('low confidence, intent source, below threshold → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'intent', confidence: 0.45, verifierStatus: 'agreed' }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('IMPORTANT: degraded verifier BELOW threshold → false (threshold alone decides, not verifierStatus)', async () => {
		// Confirms: degraded does NOT unlock routing. Confidence 0.50 < 0.75 → false.
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'intent', verifierStatus: 'degraded', confidence: 0.50 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('intent not in handlers map → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ intent: 'K-unknown' }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('fallback source (untrusted) → false even at high confidence', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'fallback', intent: 'K1', confidence: 0.99 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('photo-intent source (untrusted) → false even at high confidence', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ source: 'photo-intent', intent: 'K1', confidence: 0.99 }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Security cases — all should return false; intent is never used as regex/path/sink
// ---------------------------------------------------------------------------

describe('dispatchByRoute — security', () => {
	it('regex metacharacters in intent — Map lookup only, no regex evaluation → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ intent: '.*|$(rm -rf)' }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('prototype-pollution key "__proto__" — Object.hasOwn gate → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ intent: '__proto__' }));

		// Even if someone crafted a handlers object with __proto__ key,
		// Object.hasOwn must be used (not `in` operator or bracket access).
		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it('constructor key — Object.hasOwn gate → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ intent: 'constructor' }));

		const result = await dispatchByRoute(ctx, { K1: handler });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Custom appId argument
// ---------------------------------------------------------------------------

describe('dispatchByRoute — custom appId argument', () => {
	it('custom appId matches route.appId → returns true', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ appId: 'shopping', intent: 'K1', source: 'intent', confidence: 0.92, verifierStatus: 'agreed' }));

		const result = await dispatchByRoute(ctx, { K1: handler }, { appId: 'shopping' });

		expect(result).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('custom appId does NOT match route.appId → false', async () => {
		const handler = vi.fn(() => Promise.resolve());
		const ctx = makeCtx(makeRoute({ appId: 'food', intent: 'K1', source: 'intent', confidence: 0.92, verifierStatus: 'agreed' }));

		// Passing 'shopping' as appId, but route says 'food' → mismatch
		const result = await dispatchByRoute(ctx, { K1: handler }, { appId: 'shopping' });

		expect(result).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});
