/**
 * Model pricing lookup table.
 *
 * Shared source of truth for per-model cost estimation.
 * Used by both the CostTracker and the ModelCatalog.
 * Prices are in USD per million tokens.
 */

import type { ProviderType } from '../../types/llm.js';

export interface ModelPricing {
	/** Cost per million input tokens (USD). */
	input: number;
	/** Cost per million output tokens (USD). */
	output: number;
}

/** Approximate cost per million tokens (as of 2026). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
	// Anthropic
	'claude-opus-4-6': { input: 15.0, output: 75.0 },
	'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
	'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
	'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },

	// Google Gemini
	'gemini-2.5-pro': { input: 1.25, output: 10.0 },
	'gemini-2.5-flash': { input: 0.15, output: 0.6 },
	'gemini-2.0-flash': { input: 0.1, output: 0.4 },
	'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },

	// OpenAI
	'gpt-4.1': { input: 2.0, output: 8.0 },
	'gpt-4.1-mini': { input: 0.4, output: 1.6 },
	'gpt-4.1-nano': { input: 0.1, output: 0.4 },
	'gpt-4o': { input: 2.5, output: 10.0 },
	'gpt-4o-mini': { input: 0.15, output: 0.6 },
	o3: { input: 2.0, output: 8.0 },
	'o3-mini': { input: 1.1, output: 4.4 },
	'o4-mini': { input: 1.1, output: 4.4 },
};

/**
 * Conservative fallback pricing for unrecognized remote models (USD per million tokens).
 * Applied when a non-Ollama model has no entry in MODEL_PRICING, so cost caps still trip.
 */
export const DEFAULT_REMOTE_PRICING: ModelPricing = { input: 3.0, output: 15.0 };

/**
 * Get pricing for a model. Returns null for unknown models.
 */
export function getModelPricing(modelId: string): ModelPricing | null {
	return MODEL_PRICING[modelId] ?? null;
}

/**
 * Returns true when the model has a known price entry, or is a local Ollama model.
 * Returns false when cost-tracking will fall back to DEFAULT_REMOTE_PRICING.
 */
export function hasPricing(modelId: string, providerType?: ProviderType): boolean {
	if (providerType === 'ollama') return true; // Ollama is always free
	return MODEL_PRICING[modelId] !== undefined;
}

/**
 * Estimate cost for a single API call.
 *
 * - Ollama models (providerType === 'ollama') are always $0 — locally hosted.
 * - Known models use the MODEL_PRICING table.
 * - Unknown remote models use DEFAULT_REMOTE_PRICING as a conservative estimate
 *   so that cost caps remain effective.
 */
export function estimateCallCost(
	modelId: string,
	inputTokens: number,
	outputTokens: number,
	providerType?: ProviderType,
): number {
	// Ollama is locally hosted — always free regardless of model name
	if (providerType === 'ollama') return 0;

	const pricing = getModelPricing(modelId) ?? DEFAULT_REMOTE_PRICING;
	const raw = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
	return Math.round(raw * 1e6) / 1e6;
}
