import { describe, expect, it } from 'vitest';
import { MODEL_PRICING, estimateCallCost, getModelPricing } from '../model-pricing.js';

describe('model-pricing', () => {
	describe('getModelPricing', () => {
		it('returns pricing for a known Anthropic model', () => {
			const pricing = getModelPricing('claude-sonnet-4-6');
			expect(pricing).toEqual({ input: 3.0, output: 15.0 });
		});

		it('returns pricing for a known Google model', () => {
			const pricing = getModelPricing('gemini-2.5-pro');
			expect(pricing).toEqual({ input: 1.25, output: 10.0 });
		});

		it('returns pricing for a known OpenAI model', () => {
			const pricing = getModelPricing('gpt-4.1');
			expect(pricing).toEqual({ input: 2.0, output: 8.0 });
		});

		it('returns null for an unknown model', () => {
			expect(getModelPricing('totally-unknown-model')).toBeNull();
		});
	});

	describe('estimateCallCost', () => {
		it('calculates correctly for Sonnet', () => {
			// Sonnet: input=3.0, output=15.0 per million tokens
			// 1000 input tokens + 500 output tokens
			const cost = estimateCallCost('claude-sonnet-4-6', 1000, 500);
			const expected = (1000 * 3.0 + 500 * 15.0) / 1_000_000;
			expect(cost).toBeCloseTo(expected, 10);
		});

		it('calculates correctly for Haiku', () => {
			// Haiku: input=0.8, output=4.0 per million tokens
			const cost = estimateCallCost('claude-haiku-4-5-20251001', 2000, 1000);
			const expected = (2000 * 0.8 + 1000 * 4.0) / 1_000_000;
			expect(cost).toBeCloseTo(expected, 10);
		});

		it('returns 0 for an unknown model', () => {
			expect(estimateCallCost('nonexistent-model', 1000, 500)).toBe(0);
		});

		it('returns 0 when tokens are 0', () => {
			expect(estimateCallCost('claude-sonnet-4-6', 0, 0)).toBe(0);
		});

		it('produces negative cost for negative token counts', () => {
			const cost = estimateCallCost('claude-sonnet-4-6', -1000, 0);
			expect(cost).toBeLessThan(0);
		});

		it('produces NaN for NaN token counts', () => {
			const cost = estimateCallCost('claude-sonnet-4-6', Number.NaN, 100);
			expect(cost).toBeNaN();
		});

		it('rounds result to 6 decimal places (D5)', () => {
			// Use values that would produce floating-point imprecision
			// Haiku: input=0.8, output=4.0 per million tokens
			// 333 input + 777 output → (333*0.8 + 777*4.0) / 1_000_000
			const cost = estimateCallCost('claude-haiku-4-5-20251001', 333, 777);
			const str = cost.toString();
			const decimalPart = str.split('.')[1] ?? '';
			expect(decimalPart.length).toBeLessThanOrEqual(6);
		});
	});

	describe('MODEL_PRICING', () => {
		it('contains entries for Anthropic models', () => {
			const anthropicModels = Object.keys(MODEL_PRICING).filter((k) => k.startsWith('claude-'));
			expect(anthropicModels.length).toBeGreaterThan(0);
		});

		it('contains entries for Google models', () => {
			const googleModels = Object.keys(MODEL_PRICING).filter((k) => k.startsWith('gemini-'));
			expect(googleModels.length).toBeGreaterThan(0);
		});

		it('contains entries for OpenAI models', () => {
			const openaiModels = Object.keys(MODEL_PRICING).filter(
				(k) => k.startsWith('gpt-') || k.startsWith('o3') || k.startsWith('o4'),
			);
			expect(openaiModels.length).toBeGreaterThan(0);
		});
	});
});
