import type { ModelTier } from '../../types/llm.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../config/defaults.js';

export type GuardMethod = 'complete' | 'classify' | 'extractStructured';

export interface TierPrice {
    inputUsdPer1k: number;
    outputUsdPer1k: number;
}

export interface PriceLookup {
    /** Returns undefined if tier unknown; estimator falls back to defaultReservationUsd. */
    priceFor(tier: ModelTier): TierPrice | undefined;
}

export interface EstimateInput {
    method: GuardMethod;
    tier: ModelTier;
    prompt: string;
    maxOutputTokens?: number;
}

/** Upper-bound output token counts per method when maxOutputTokens is not provided. */
const METHOD_DEFAULT_OUTPUT_TOKENS: Record<GuardMethod, number> = {
    complete: 4096,
    classify: 32,
    extractStructured: 2048,
};

const VALID_METHODS = new Set<string>(['complete', 'classify', 'extractStructured']);

/** Approximate token count from text. 4 chars ≈ 1 token, ceiling, capped at 1M. */
export function approximateTokens(text: string): number {
    if (typeof text !== 'string') {
        throw new TypeError(`approximateTokens: expected string, got ${typeof text}`);
    }
    return Math.min(1_000_000, Math.ceil(text.length / 4));
}

/** Deterministic upper-bound $ estimate for a guard call. */
export function estimateGuardCost(
    input: EstimateInput,
    prices: PriceLookup,
    logger?: { warn: (...args: unknown[]) => void },
): number {
    if (typeof input.prompt !== 'string') {
        throw new TypeError('estimateGuardCost: prompt must be a string');
    }
    if (!VALID_METHODS.has(input.method)) {
        throw new TypeError(`estimateGuardCost: unknown method '${input.method}'`);
    }

    let outputTokens: number;
    if (input.maxOutputTokens !== undefined) {
        if (
            !Number.isFinite(input.maxOutputTokens) ||
            !Number.isInteger(input.maxOutputTokens) ||
            input.maxOutputTokens < 0
        ) {
            throw new TypeError(
                `estimateGuardCost: maxOutputTokens must be a non-negative integer, got ${input.maxOutputTokens}`,
            );
        }
        outputTokens = input.maxOutputTokens;
    } else {
        outputTokens = METHOD_DEFAULT_OUTPUT_TOKENS[input.method];
    }

    const inputTokens = approximateTokens(input.prompt);

    const price = prices.priceFor(input.tier);
    if (
        !price ||
        !Number.isFinite(price.inputUsdPer1k) ||
        price.inputUsdPer1k < 0 ||
        !Number.isFinite(price.outputUsdPer1k) ||
        price.outputUsdPer1k < 0
    ) {
        logger?.warn(
            { tier: input.tier, price },
            'estimateGuardCost: no valid price for tier, using defaultReservationUsd',
        );
        return DEFAULT_LLM_SAFEGUARDS.defaultReservationUsd;
    }

    const inputCost = (inputTokens / 1000) * price.inputUsdPer1k;
    const outputCost = (outputTokens / 1000) * price.outputUsdPer1k;
    return inputCost + outputCost;
}
