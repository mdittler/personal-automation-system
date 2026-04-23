import type { ShadowResult } from './shadow-logger.js';
import { SHADOW_DECLINE_LABEL } from './shadow-taxonomy.js';
import type { FoodShadowLabel } from './shadow-taxonomy.js';

export interface DispatchShadowResult {
    dispatched: boolean;
    /** True when shadow returned ok but confidence was below threshold and we fell through. Telemetry only. */
    suppressedByThreshold: boolean;
}

/**
 * Pure shadow dispatcher: given a shadow result and a handler table, attempts to
 * dispatch to the appropriate handler.  No I/O, never throws.
 *
 * Falls through (dispatched=false) when:
 * - shadow.kind is not 'ok'
 * - action is 'none'
 * - confidence is below minConfidence (sets suppressedByThreshold=true)
 * - action is in the blocklist
 * - action has no entry in handlers
 */
export async function dispatchShadow<Ctx>(
    ctx: Ctx,
    shadow: ShadowResult,
    minConfidence: number,
    handlers: Partial<Record<FoodShadowLabel, (ctx: Ctx) => Promise<void>>>,
    blocklist: ReadonlySet<string>,
): Promise<DispatchShadowResult> {
    if (shadow.kind !== 'ok') {
        return { dispatched: false, suppressedByThreshold: false };
    }
    if (shadow.action === SHADOW_DECLINE_LABEL) {
        return { dispatched: false, suppressedByThreshold: false };
    }
    if (shadow.confidence < minConfidence) {
        return { dispatched: false, suppressedByThreshold: true };
    }
    if (blocklist.has(shadow.action)) {
        return { dispatched: false, suppressedByThreshold: false };
    }
    const handler = handlers[shadow.action as FoodShadowLabel];
    if (!handler) {
        return { dispatched: false, suppressedByThreshold: false };
    }
    await handler(ctx);
    return { dispatched: true, suppressedByThreshold: false };
}
