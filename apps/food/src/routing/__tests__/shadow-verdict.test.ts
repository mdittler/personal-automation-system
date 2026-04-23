import { describe, expect, it } from 'vitest';
import type { ShadowResult } from '../shadow-logger.js';
import type { FoodShadowLabel } from '../shadow-taxonomy.js';
import { computeVerdict } from '../shadow-verdict.js';

const GROCERY_ADD: FoodShadowLabel = 'user wants to add items to the grocery list';
const PANTRY: FoodShadowLabel = 'user wants to check or update the pantry';
const COOK: FoodShadowLabel = 'user wants to start cooking a recipe';
const NONE: FoodShadowLabel = 'none';

function ok(action: FoodShadowLabel, confidence = 0.9): ShadowResult {
    return { kind: 'ok', action, confidence };
}

describe('computeVerdict', () => {
    it('agree — both labels same non-none', () => {
        expect(computeVerdict(GROCERY_ADD, ok(GROCERY_ADD))).toBe('agree');
    });

    it('disagree — different non-none labels', () => {
        expect(computeVerdict(GROCERY_ADD, ok(PANTRY))).toBe('disagree');
    });

    it('one-side-none — regex none, shadow real', () => {
        expect(computeVerdict(NONE, ok(COOK))).toBe('one-side-none');
    });

    it('one-side-none — regex real, shadow none', () => {
        expect(computeVerdict(COOK, ok(NONE))).toBe('one-side-none');
    });

    it('both-none — both labels are none', () => {
        expect(computeVerdict(NONE, ok(NONE))).toBe('both-none');
    });

    it('skipped — skipped-sample', () => {
        expect(computeVerdict(NONE, { kind: 'skipped-sample' })).toBe('skipped');
    });

    it('skipped — skipped-no-caption', () => {
        expect(computeVerdict(NONE, { kind: 'skipped-no-caption' })).toBe('skipped');
    });

    it('error — parse-failed', () => {
        expect(computeVerdict(NONE, { kind: 'parse-failed', raw: 'bad json' })).toBe('error');
    });

    it('error — llm-error', () => {
        expect(computeVerdict(NONE, { kind: 'llm-error', category: 'network' })).toBe('error');
    });

    it('legacy-skipped — short-circuits regardless of regexWinnerLabel', () => {
        expect(computeVerdict(NONE, { kind: 'legacy-skipped' })).toBe('legacy-skipped');
        expect(computeVerdict(GROCERY_ADD, { kind: 'legacy-skipped' })).toBe('legacy-skipped');
    });
});

describe('shadow-dispatched short-circuit (Chunk D)', () => {
    it('returns "shadow-dispatched" when rawRegexWinner is the shadow-dispatched sentinel', () => {
        const verdict = computeVerdict(
            NONE,
            { kind: 'ok', action: GROCERY_ADD, confidence: 0.95 },
            '(shadow-dispatched)',
        );
        expect(verdict).toBe('shadow-dispatched');
    });

    it('short-circuits before consulting shadow — works even if shadow is parse-failed', () => {
        const verdict = computeVerdict(NONE, { kind: 'parse-failed', raw: 'junk' }, '(shadow-dispatched)');
        expect(verdict).toBe('shadow-dispatched');
    });

    it('without the sentinel, existing verdict semantics are preserved', () => {
        const verdict = computeVerdict(GROCERY_ADD, { kind: 'ok', action: GROCERY_ADD, confidence: 0.95 });
        expect(verdict).toBe('agree');
    });

    it('computeVerdict stays pure — no threshold-awareness, no side effects', () => {
        // Calling it multiple times with same args returns same result
        const r1 = computeVerdict(GROCERY_ADD, ok(GROCERY_ADD));
        const r2 = computeVerdict(GROCERY_ADD, ok(GROCERY_ADD));
        expect(r1).toBe('agree');
        expect(r2).toBe('agree');
    });
});
