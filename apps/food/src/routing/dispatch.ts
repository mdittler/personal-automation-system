import type { RouteInfo, RouteSource } from '@pas/core/types';

const MIN_INTENT_CONFIDENCE = 0.75;

const TRUSTED_SOURCES = new Set<RouteSource>([
    'command',
    'intent',
    'user-override',
    'context-promotion',
]);

/**
 * Route-first dispatcher for Food messages.
 *
 * Returns `true` iff the route claimed the message — the caller MUST NOT
 * continue to its regex/fallback cascade. Returns `false` only when the
 * pre-checks failed (route absent, untrusted source, below threshold,
 * intent not in map, appId mismatch). Handler outcomes (success, user
 * error message, clarification prompt) all count as "claimed" — a claimed
 * route owns the message.
 *
 * `verifierStatus: 'degraded'` is treated the same as `'skipped'` per the
 * RouteInfo contract (core/src/types/telegram.ts:65-69) — the confidence
 * threshold alone decides.
 */
export async function dispatchByRoute<C extends { route?: RouteInfo }>(
    ctx: C,
    handlers: Record<string, (ctx: C) => Promise<void>>,
    appId = 'food',
): Promise<boolean> {
    const r = ctx.route;
    if (!r) return false;
    if (r.appId !== appId) return false;
    if (!TRUSTED_SOURCES.has(r.source)) return false;
    if (r.source === 'intent' && r.confidence < MIN_INTENT_CONFIDENCE) return false;
    if (!Object.hasOwn(handlers, r.intent)) return false;
    await handlers[r.intent]!(ctx);
    return true;
}
