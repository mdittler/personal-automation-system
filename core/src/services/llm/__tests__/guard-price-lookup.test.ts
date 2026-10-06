import { describe, expect, it } from 'vitest';
import type { ModelRef, ModelTier, ProviderType } from '../../../types/llm.js';
import { createGuardPriceLookup } from '../guard-price-lookup.js';
import { DEFAULT_REMOTE_PRICING, MODEL_PRICING } from '../model-pricing.js';

function fakeRegistry(types: Record<string, ProviderType>) {
	return {
		get: (id: string) => (types[id] ? { providerType: types[id] } : undefined),
		getAll: () => Object.values(types).map((providerType) => ({ providerType })),
	};
}
function fakeSelector(tiers: Partial<Record<ModelTier, ModelRef>>) {
	return { getTierRef: (tier: ModelTier) => tiers[tier] };
}

describe('createGuardPriceLookup (P2-1)', () => {
	const registry = fakeRegistry({ ollama: 'ollama', anthropic: 'anthropic' });
	const selector = fakeSelector({
		fast: { provider: 'ollama', model: 'qwen3.8:27b-mlx' },
		standard: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
	});
	const lookup = createGuardPriceLookup({
		registry: registry as never,
		modelSelector: selector as never,
	});

	it('priceForRef: local provider → $0/$0', () => {
		expect(lookup.priceForRef?.({ provider: 'ollama', model: 'anything' })).toEqual({
			inputUsdPer1k: 0,
			outputUsdPer1k: 0,
		});
	});

	it('priceForRef: priced remote model → MODEL_PRICING per 1k', () => {
		const haiku = MODEL_PRICING['claude-haiku-4-5-20251001'] as { input: number; output: number };
		expect(
			lookup.priceForRef?.({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
		).toEqual({
			inputUsdPer1k: haiku.input / 1000,
			outputUsdPer1k: haiku.output / 1000,
		});
	});

	it('priceForRef: unknown model on a registered remote provider → conservative DEFAULT_REMOTE_PRICING', () => {
		expect(lookup.priceForRef?.({ provider: 'anthropic', model: 'claude-nonexistent' })).toEqual({
			inputUsdPer1k: DEFAULT_REMOTE_PRICING.input / 1000,
			outputUsdPer1k: DEFAULT_REMOTE_PRICING.output / 1000,
		});
	});

	it('priceForRef: unregistered provider → undefined (the estimator then reserves the default)', () => {
		expect(lookup.priceForRef?.({ provider: 'ghost', model: 'm' })).toBeUndefined();
	});

	it('priceFor(tier) resolves the tier to its ref and prices that ref; an unassigned tier → undefined', () => {
		expect(lookup.priceFor('fast')).toEqual({ inputUsdPer1k: 0, outputUsdPer1k: 0 });
		expect(lookup.priceFor('standard')).toEqual(
			lookup.priceForRef?.({ provider: 'anthropic', model: 'claude-sonnet-5-5' }),
		);
		expect(lookup.priceFor('reasoning')).toBeUndefined();
	});

	it('hasBillableProvider: true with no providers (unknown), false when all are local, true when any is remote', () => {
		expect(
			createGuardPriceLookup({
				registry: fakeRegistry({}) as never,
				modelSelector: selector as never,
			}).hasBillableProvider?.(),
		).toBe(true);
		expect(
			createGuardPriceLookup({
				registry: fakeRegistry({ ollama: 'ollama', llama: 'llama-cpp' }) as never,
				modelSelector: selector as never,
			}).hasBillableProvider?.(),
		).toBe(false);
		expect(lookup.hasBillableProvider?.()).toBe(true);
	});
});
