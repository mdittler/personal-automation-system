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
