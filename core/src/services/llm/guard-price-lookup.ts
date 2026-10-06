/**
 * The guards' price lookup: resolves a tier or an explicit ModelRef to a
 * per-1k price using the same provider registry and model selector
 * `LLMServiceImpl` routes with, so the guard reserves against the model that
 * will actually serve the request (P2-1). Local provider types are $0;
 * priced remote models use MODEL_PRICING; unknown remote models take the
 * conservative DEFAULT_REMOTE_PRICING; an unregistered provider is unpriceable.
 */

import type { ModelRef, ModelTier } from '../../types/llm.js';
import type { PriceLookup, TierPrice } from './estimate-guard-cost.js';
import { DEFAULT_REMOTE_PRICING, getModelPricing, isLocalProvider } from './model-pricing.js';
import type { ModelSelector } from './model-selector.js';
import type { ProviderRegistry } from './providers/provider-registry.js';

export function createGuardPriceLookup(deps: {
	registry: Pick<ProviderRegistry, 'get' | 'getAll'>;
	modelSelector: Pick<ModelSelector, 'getTierRef'>;
}): PriceLookup {
	const priceForRef = (ref: ModelRef): TierPrice | undefined => {
		const providerType = deps.registry.get(ref.provider)?.providerType;
		if (!providerType) return undefined;
		if (isLocalProvider(providerType)) return { inputUsdPer1k: 0, outputUsdPer1k: 0 };
		const pricing = getModelPricing(ref.model) ?? DEFAULT_REMOTE_PRICING;
		return { inputUsdPer1k: pricing.input / 1000, outputUsdPer1k: pricing.output / 1000 };
	};
	return {
		priceForRef,
		priceFor: (tier: ModelTier) => {
			const ref = deps.modelSelector.getTierRef(tier);
			return ref ? priceForRef(ref) : undefined;
		},
		// An all-local install never bills per token, so an unresolvable tier or
		// ref must estimate $0 instead of `defaultReservationUsd`. With zero
		// providers registered locality is undeterminable — report `true` so the
		// conservative reservation stands.
		hasBillableProvider: () => {
			const all = deps.registry.getAll();
			if (all.length === 0) return true;
			return all.some((p) => !isLocalProvider(p.providerType));
		},
	};
}
