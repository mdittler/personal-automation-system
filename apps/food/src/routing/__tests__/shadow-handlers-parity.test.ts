import { describe, it, expect } from 'vitest';
import {
    FOOD_SHADOW_LABELS,
    INTENTIONALLY_UNMAPPED_LABELS,
    SHADOW_LABELS_WITHOUT_TEXT_HANDLER,
} from '../shadow-taxonomy.js';
import { SHADOW_HANDLERS } from '../../index.js';

describe('SHADOW_HANDLERS parity', () => {
    it('every shadow label is exactly one of {SHADOW_HANDLERS key, blocklist entry, "none"}', () => {
        const handlerKeys = new Set(Object.keys(SHADOW_HANDLERS));
        const blocklist = new Set<string>(SHADOW_LABELS_WITHOUT_TEXT_HANDLER);

        const uncategorized: string[] = [];
        const double: string[] = [];
        for (const label of FOOD_SHADOW_LABELS) {
            if (label === 'none') continue;
            const inHandlers = handlerKeys.has(label);
            const inBlock = blocklist.has(label);
            const hits = [inHandlers, inBlock].filter(Boolean).length;
            if (hits === 0) uncategorized.push(label);
            if (hits > 1) double.push(label);
        }
        expect(uncategorized, `labels missing from both SHADOW_HANDLERS and blocklist: ${uncategorized.join(' | ')}`).toEqual([]);
        expect(double, `labels in both SHADOW_HANDLERS and blocklist: ${double.join(' | ')}`).toEqual([]);
    });

    it('INTENTIONALLY_UNMAPPED_LABELS route to SHADOW_HANDLERS (nearest-handler decision)', () => {
        for (const label of INTENTIONALLY_UNMAPPED_LABELS) {
            expect(Object.hasOwn(SHADOW_HANDLERS, label), `unmapped label "${label}" should have a nearest-handler entry`).toBe(true);
        }
    });

    it('SHADOW_HANDLERS never routes to keys outside FOOD_SHADOW_LABELS', () => {
        const valid = new Set<string>(FOOD_SHADOW_LABELS);
        for (const key of Object.keys(SHADOW_HANDLERS)) {
            expect(valid.has(key), `unknown handler key "${key}"`).toBe(true);
        }
    });

    it('SHADOW_HANDLERS has a handler for every value — no undefined entries', () => {
        for (const [key, fn] of Object.entries(SHADOW_HANDLERS)) {
            expect(typeof fn, `handler for "${key}" must be a function`).toBe('function');
        }
    });
});
