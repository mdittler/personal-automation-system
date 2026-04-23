import { describe, it, expect, vi } from 'vitest';
import { dispatchShadow } from '../shadow-dispatch.js';
import type { ShadowResult } from '../shadow-logger.js';

const LABEL = 'user wants to add items to the grocery list' as const;
const OTHER_LABEL = 'user wants to save a recipe' as const;
const BLOCKED = 'user wants to see receipt details or look up items from a receipt' as const;

const FAKE_CTX = { userId: 'u1', text: 'test' } as any;

describe('dispatchShadow', () => {
    it('dispatches when kind=ok, confidence≥threshold, action in handlers', async () => {
        const handler = vi.fn(async () => {});
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: LABEL, confidence: 0.8 },
            0.7,
            { [LABEL]: handler },
            new Set(),
        );
        expect(result).toEqual({ dispatched: true, suppressedByThreshold: false });
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(FAKE_CTX);
    });

    it('marks suppressedByThreshold=true when confidence<threshold, does not dispatch', async () => {
        const handler = vi.fn(async () => {});
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: LABEL, confidence: 0.6 },
            0.7,
            { [LABEL]: handler },
            new Set(),
        );
        expect(result).toEqual({ dispatched: false, suppressedByThreshold: true });
        expect(handler).not.toHaveBeenCalled();
    });

    it('falls through when action is "none"', async () => {
        const handler = vi.fn();
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: 'none', confidence: 0.99 },
            0.7,
            { [LABEL]: handler },
            new Set(),
        );
        expect(result).toEqual({ dispatched: false, suppressedByThreshold: false });
        expect(handler).not.toHaveBeenCalled();
    });

    it('falls through when action is in blocklist', async () => {
        const handler = vi.fn();
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: BLOCKED, confidence: 0.99 },
            0.7,
            { [BLOCKED]: handler } as any,
            new Set([BLOCKED]),
        );
        expect(result).toEqual({ dispatched: false, suppressedByThreshold: false });
        expect(handler).not.toHaveBeenCalled();
    });

    it('falls through when action has no handler', async () => {
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: OTHER_LABEL, confidence: 0.99 },
            0.7,
            {},
            new Set(),
        );
        expect(result).toEqual({ dispatched: false, suppressedByThreshold: false });
    });

    it.each([
        ['parse-failed', { kind: 'parse-failed' as const, raw: 'junk' }],
        ['llm-error', { kind: 'llm-error' as const, category: 'rate-limit' as const }],
        ['skipped-sample', { kind: 'skipped-sample' as const }],
        ['skipped-no-caption', { kind: 'skipped-no-caption' as const }],
        ['skipped-pending-flow', { kind: 'skipped-pending-flow' as const, flow: 'cook' }],
        ['skipped-cook-mode', { kind: 'skipped-cook-mode' as const }],
        ['legacy-skipped', { kind: 'legacy-skipped' as const }],
    ])('falls through when shadow.kind is %s', async (_label, shadow) => {
        const handler = vi.fn();
        const result = await dispatchShadow(
            FAKE_CTX,
            shadow as ShadowResult,
            0.7,
            { [LABEL]: handler },
            new Set(),
        );
        expect(result).toEqual({ dispatched: false, suppressedByThreshold: false });
        expect(handler).not.toHaveBeenCalled();
    });

    it('calls handler when confidence exactly equals threshold', async () => {
        const handler = vi.fn(async () => {});
        const result = await dispatchShadow(
            FAKE_CTX,
            { kind: 'ok', action: LABEL, confidence: 0.7 },
            0.7,
            { [LABEL]: handler },
            new Set(),
        );
        expect(result).toEqual({ dispatched: true, suppressedByThreshold: false });
        expect(handler).toHaveBeenCalledOnce();
    });
});
