import type { AppLogger, MessageContext } from '@pas/core/types';
import type { ShadowLogEntry, ShadowResult } from './shadow-logger.js';
import { computeVerdict } from './shadow-verdict.js';
import { normalizeRegexLabel } from './shadow-taxonomy.js';

export interface ShadowClassifierInterface {
    classify(text: string, sampleRate: number): Promise<ShadowResult>;
}

export interface ShadowLoggerInterface {
    log(entry: ShadowLogEntry): Promise<void>;
}

let shadowClassifier: ShadowClassifierInterface | null = null;
let shadowLogger: ShadowLoggerInterface | null = null;

/** Called from init() with the production instances. */
export function initShadowDeps(
    classifier: ShadowClassifierInterface,
    logger: ShadowLoggerInterface,
): void {
    shadowClassifier = classifier;
    shadowLogger = logger;
}

/** Test seam — replaces both deps for the current test. */
export function __setShadowDepsForTests(
    classifier: ShadowClassifierInterface,
    logger: ShadowLoggerInterface,
): void {
    shadowClassifier = classifier;
    shadowLogger = logger;
}

/** Clears both deps (call in afterEach to avoid cross-test pollution). */
export function __clearShadowDepsForTests(): void {
    shadowClassifier = null;
    shadowLogger = null;
}

// Tracks the latest finalize invocation so __flushShadowForTests() can drain it.
let shadowChain: Promise<void> = Promise.resolve();

/**
 * Awaits all pending finalizeShadow work.  Call in tests before asserting log
 * entries or warn-call counts, since finalizeShadow is fire-and-forget.
 */
export function __flushShadowForTests(): Promise<void> {
    return shadowChain;
}

/**
 * Kicks off a shadow classify call.  Only call this on the regex-cascade path
 * (after dispatchByRoute returns false).  All other paths supply a synthetic
 * Promise.resolve({kind:…}) directly to finalizeShadow instead of calling this.
 */
export function startShadow(text: string, sampleRate: number): Promise<ShadowResult> {
    if (!shadowClassifier) return Promise.resolve({ kind: 'skipped-sample' });
    return shadowClassifier.classify(text, sampleRate);
}

/**
 * Awaits the shadow promise, computes the verdict, and writes the log entry.
 * Fire-and-forget from the caller (prefix with `void`).
 * Errors from both the classifier and the logger are swallowed here and
 * surfaced only as a warn on appLogger — never propagated to the user path.
 */
export function finalizeShadow(
    shadowPromise: Promise<ShadowResult>,
    ctx: MessageContext,
    regexWinner: string,
    pendingFlow: string | undefined,
    appLogger: AppLogger,
    extra?: { shadowSuppressedByThreshold?: boolean },
): void {
    if (!shadowLogger) return;  // deps not initialised — no-op (e.g. most existing tests)
    const p = doFinalize(shadowPromise, ctx, regexWinner, pendingFlow, appLogger, extra);
    // Chain so __flushShadowForTests() covers all concurrent calls.
    shadowChain = shadowChain.then(() => p).catch(() => undefined);
}

async function doFinalize(
    shadowPromise: Promise<ShadowResult>,
    ctx: MessageContext,
    regexWinner: string,
    pendingFlow: string | undefined,
    appLogger: AppLogger,
    extra?: { shadowSuppressedByThreshold?: boolean },
): Promise<void> {
    let shadow: ShadowResult;
    try {
        shadow = await shadowPromise;
    } catch (err) {
        appLogger.warn('food shadow classifier unexpected rejection: %s', String(err));
        shadow = { kind: 'llm-error', category: 'unexpected' };
    }

    const regexWinnerLabel = normalizeRegexLabel(regexWinner);
    const verdict = computeVerdict(regexWinnerLabel, shadow, regexWinner);

    const entry: ShadowLogEntry = {
        timestamp: new Date(),
        userId: ctx.userId,
        messageText: ctx.text,
        messageKind: 'text',
        pendingFlow,
        coreRoute: ctx.route
            ? {
                  intent: ctx.route.intent,
                  confidence: ctx.route.confidence,
                  source: ctx.route.source,
                  verifierStatus: ctx.route.verifierStatus,
              }
            : undefined,
        regexWinner,
        regexWinnerLabel,
        shadow,
        verdict,
        ...(extra?.shadowSuppressedByThreshold ? { shadowSuppressedByThreshold: true } : {}),
    };

    try {
        await shadowLogger!.log(entry);
    } catch (err) {
        appLogger.warn('food shadow logger write failed: %s', String(err));
    }
}
