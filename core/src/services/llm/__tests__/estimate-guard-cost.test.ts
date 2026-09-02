import { describe, expect, it, vi } from 'vitest';
import { type PriceLookup, approximateTokens, estimateGuardCost } from '../estimate-guard-cost.js';

const prices: PriceLookup = {
	priceFor: (tier) => {
		if (tier === 'fast') return { inputUsdPer1k: 0.001, outputUsdPer1k: 0.005 };
		if (tier === 'standard') return { inputUsdPer1k: 0.003, outputUsdPer1k: 0.015 };
		if (tier === 'reasoning') return { inputUsdPer1k: 0.015, outputUsdPer1k: 0.075 };
		return undefined;
	},
};

describe('estimateGuardCost', () => {
	it('classify upper bound is small (< 0.001 for fast tier, 500-char prompt)', () => {
		const cost = estimateGuardCost(
			{ method: 'classify', tier: 'fast', prompt: 'x'.repeat(500) },
			prices,
		);
		expect(cost).toBeLessThan(0.001);
		expect(cost).toBeGreaterThan(0);
	});

	it('complete uses provided maxOutputTokens as upper bound', () => {
		const lo = estimateGuardCost(
			{ method: 'complete', tier: 'fast', prompt: 'x'.repeat(400), maxOutputTokens: 100 },
			prices,
		);
		const hi = estimateGuardCost(
			{ method: 'complete', tier: 'fast', prompt: 'x'.repeat(400), maxOutputTokens: 1000 },
			prices,
		);
		expect(hi).toBeGreaterThan(lo);
	});

	it('complete with no maxOutputTokens uses 4096 default (empty prompt → output-only)', () => {
		const cost = estimateGuardCost({ method: 'complete', tier: 'fast', prompt: '' }, prices);
		// 4096 output tokens * 0.005/1k = 0.02048
		expect(cost).toBeCloseTo(0.02048, 4);
	});

	it('tier monotonicity: fast < standard < reasoning for same input', () => {
		const base = { method: 'complete' as const, prompt: 'x'.repeat(400), maxOutputTokens: 500 };
		const f = estimateGuardCost({ ...base, tier: 'fast' }, prices);
		const s = estimateGuardCost({ ...base, tier: 'standard' }, prices);
		const r = estimateGuardCost({ ...base, tier: 'reasoning' }, prices);
		expect(s).toBeGreaterThan(f);
		expect(r).toBeGreaterThan(s);
	});

	it('maxOutputTokens = 0 returns cost from input tokens only', () => {
		const cost = estimateGuardCost(
			{ method: 'complete', tier: 'fast', prompt: 'x'.repeat(400), maxOutputTokens: 0 },
			prices,
		);
		// 100 input tokens * 0.001/1k = 0.0001
		expect(cost).toBeCloseTo(0.0001, 5);
	});

	it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5])(
		'rejects invalid maxOutputTokens = %s',
		(v) => {
			expect(() =>
				estimateGuardCost(
					{ method: 'complete', tier: 'fast', prompt: 'hi', maxOutputTokens: v as number },
					prices,
				),
			).toThrow();
		},
	);

	it('rejects non-string prompt', () => {
		expect(() =>
			estimateGuardCost({ method: 'complete', tier: 'fast', prompt: 123 as any }, prices),
		).toThrow();
	});

	it('rejects unknown method', () => {
		expect(() =>
			estimateGuardCost({ method: 'bogus' as any, tier: 'fast', prompt: 'hi' }, prices),
		).toThrow();
	});

	describe('price fallback', () => {
		it('unknown tier → defaultReservationUsd with warn', () => {
			const empty: PriceLookup = { priceFor: () => undefined };
			const warn = vi.fn();
			const cost = estimateGuardCost({ method: 'complete', tier: 'fast', prompt: 'hi' }, empty, {
				warn,
			} as any);
			expect(cost).toBe(0.05);
			expect(warn).toHaveBeenCalled();
		});

		it('price with NaN field → fallback with warn', () => {
			const bad: PriceLookup = {
				priceFor: () => ({ inputUsdPer1k: Number.NaN, outputUsdPer1k: 0.005 }),
			};
			const warn = vi.fn();
			const cost = estimateGuardCost({ method: 'complete', tier: 'fast', prompt: 'hi' }, bad, {
				warn,
			} as any);
			expect(cost).toBe(0.05);
			expect(warn).toHaveBeenCalled();
		});

		it('price with negative field → fallback', () => {
			const bad: PriceLookup = {
				priceFor: () => ({ inputUsdPer1k: -0.001, outputUsdPer1k: 0.005 }),
			};
			const cost = estimateGuardCost({ method: 'complete', tier: 'fast', prompt: 'hi' }, bad);
			expect(cost).toBe(0.05);
		});
	});

	/**
	 * An all-local install (Ollama / llama.cpp only) never bills per token, so
	 * an unresolvable tier must not invent a `defaultReservationUsd` charge —
	 * that phantom reservation eats a household's cost cap for inference the
	 * operator is never billed for.
	 */
	describe('unresolvable tier on an all-local install', () => {
		const unresolvable: PriceLookup = { priceFor: () => undefined };

		it('estimates $0 when no configured provider bills per token', () => {
			const allLocal: PriceLookup = {
				...unresolvable,
				hasBillableProvider: () => false,
			};
			const warn = vi.fn();
			const cost = estimateGuardCost(
				{ method: 'complete', tier: 'reasoning', prompt: 'hi' },
				allLocal,
				{ warn },
			);
			expect(cost).toBe(0);
			// Reports why rather than silently returning 0.
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[1])).toMatch(/local/i);
		});

		it('keeps the default reservation when a remote provider IS configured', () => {
			const mixed: PriceLookup = {
				...unresolvable,
				hasBillableProvider: () => true,
			};
			const cost = estimateGuardCost(
				{ method: 'complete', tier: 'reasoning', prompt: 'hi' },
				mixed,
			);
			expect(cost).toBe(0.05);
		});

		it('keeps the default reservation when the lookup cannot answer', () => {
			// No `hasBillableProvider` at all → locality undeterminable →
			// conservative fallback, i.e. the legacy behaviour.
			const cost = estimateGuardCost(
				{ method: 'complete', tier: 'reasoning', prompt: 'hi' },
				unresolvable,
			);
			expect(cost).toBe(0.05);
		});

		it('a resolvable local tier still prices at $0 through priceFor', () => {
			// compose-runtime maps a local tier to {0,0} rather than undefined;
			// that path must not reach the reservation fallback at all.
			const localPriced: PriceLookup = {
				priceFor: () => ({ inputUsdPer1k: 0, outputUsdPer1k: 0 }),
			};
			expect(
				estimateGuardCost({ method: 'complete', tier: 'fast', prompt: 'hi' }, localPriced),
			).toBe(0);
		});
	});
});

describe('approximateTokens', () => {
	it('empty string → 0', () => {
		expect(approximateTokens('')).toBe(0);
	});

	it('4-char prompt → 1 token', () => {
		expect(approximateTokens('abcd')).toBe(1);
	});

	it('rounds up: 5-char prompt → 2 tokens (upper bound)', () => {
		expect(approximateTokens('abcde')).toBe(2);
	});

	it('caps at 1M tokens regardless of input length', () => {
		const huge = 'x'.repeat(10_000_000);
		expect(approximateTokens(huge)).toBe(1_000_000);
	});

	it('rejects non-string', () => {
		expect(() => approximateTokens(null as any)).toThrow();
		expect(() => approximateTokens(123 as any)).toThrow();
	});
});
