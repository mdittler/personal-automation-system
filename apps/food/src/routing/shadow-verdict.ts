import type { ShadowResult, ShadowVerdict } from './shadow-logger.js';
import type { FoodShadowLabel } from './shadow-taxonomy.js';

/**
 * Maps the shadow classifier result and the regex cascade winner onto a
 * ShadowVerdict for the log entry.  Pure function — no I/O, never throws.
 *
 * Short-circuit rule (from shadow-taxonomy.ts): legacy-skipped is returned
 * immediately when the Chunk A route-dispatch path wins; regexWinnerLabel is
 * never consulted in that case.
 */
export function computeVerdict(regexWinnerLabel: FoodShadowLabel, shadow: ShadowResult): ShadowVerdict {
    switch (shadow.kind) {
        case 'legacy-skipped':
            return 'legacy-skipped';
        case 'skipped-sample':
        case 'skipped-no-caption':
        case 'skipped-pending-flow':
        case 'skipped-cook-mode':
        case 'skipped-number-select':
            return 'skipped';
        case 'parse-failed':
        case 'llm-error':
            return 'error';
        case 'ok': {
            const shadowLabel = shadow.action as FoodShadowLabel;
            const regexIsNone = regexWinnerLabel === 'none';
            const shadowIsNone = shadowLabel === 'none';
            if (regexIsNone && shadowIsNone) return 'both-none';
            if (regexIsNone || shadowIsNone) return 'one-side-none';
            return regexWinnerLabel === shadowLabel ? 'agree' : 'disagree';
        }
    }
}
