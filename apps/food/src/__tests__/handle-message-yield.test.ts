/**
 * TDD Batch 3 — Phase 2: food handleMessage HandlerResult contract.
 *
 * RED: handleMessage sends help text and returns void for unmatched messages.
 * GREEN: handleMessage returns {handled: false} for unmatched messages so the
 *        router can yield to the chatbot fallback instead of sending help text.
 */
import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage, init } from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';

function buildServices(overrides?: Partial<Parameters<typeof createMockCoreServices>[0]>): CoreServices {
	return createMockCoreServices({
		config: {
			get: vi.fn(async (key: string) => {
				if (key === 'shadow_sample_rate') return 0;
				if (key === 'routing_primary') return 'regex';
				return undefined;
			}),
		},
		...overrides,
	});
}

describe('food handleMessage HandlerResult', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = buildServices();
		await init(services);
		__clearShadowDepsForTests();
	});

	// ── RED tests ───────────────────────────────────────────────────────────────

	it('returns {handled: false} for free text that matches no regex or handler', async () => {
		const ctx = createTestMessageContext({ text: 'compare my Costco trips over the last month' });
		const result = await handleMessage(ctx);
		// RED: result is undefined (void); GREEN: result is {handled: false}
		expect(result).toEqual({ handled: false });
	});

	it('does NOT send the canned help message when returning {handled: false}', async () => {
		const ctx = createTestMessageContext({ text: 'compare my Costco trips over the last month' });
		await handleMessage(ctx);
		// RED: help text IS sent; GREEN: not sent (router forwards to chatbot instead)
		expect(services.telegram.send).not.toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining("I'm not sure what you'd like to do"),
		);
	});

	it('returns {handled: false} when dataQuery returns empty and nothing else matched', async () => {
		// DataQuery is enabled but returns empty — still should yield to chatbot.
		services = buildServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue({ files: [], empty: true }),
			},
			config: {
				get: vi.fn(async (key: string) => {
					if (key === 'shadow_sample_rate') return 0;
					if (key === 'routing_primary') return 'regex';
					return undefined;
				}),
			},
		});
		await init(services);
		__clearShadowDepsForTests();

		// "show" triggers the isDataQuestion gate inside the DataQuery branch
		const ctx = createTestMessageContext({ text: 'show me what I have in the fridge' });
		const result = await handleMessage(ctx);
		// RED: undefined (falls to help text); GREEN: {handled: false}
		expect(result).toEqual({ handled: false });
	});

	// ── Regression guards (should pass in both RED and GREEN) ────────────────────

	it('does NOT return {handled: false} for a receipt query (receipt handler runs)', async () => {
		// "show me my last receipt" matches EXPLICIT_RECEIPT_RE — handler sends "no receipts yet"
		// and returns true (handled). Food's handleMessage should NOT yield.
		const ctx = createTestMessageContext({ text: 'show me my last receipt' });
		const result = await handleMessage(ctx);
		// In both RED (undefined) and GREEN (undefined or {handled:true}), not {handled:false}
		expect(result).not.toEqual({ handled: false });
	});

	it('does NOT return {handled: false} when dataQuery provides a usable answer', async () => {
		// DataQuery returns a file; LLM produces an answer; food sends it and is "handled".
		services = buildServices({
			dataQuery: {
				query: vi.fn().mockResolvedValue({
					files: [
						{ appId: 'food', type: 'recipe', title: 'Pasta', content: 'Boil water, add pasta.' },
					],
					empty: false,
				}),
			},
			llm: {
				complete: vi.fn().mockResolvedValue('You have pasta in your recipes.'),
				classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0 }),
				extractStructured: vi.fn(),
			},
			config: {
				get: vi.fn(async (key: string) => {
					if (key === 'shadow_sample_rate') return 0;
					if (key === 'routing_primary') return 'regex';
					return undefined;
				}),
			},
		});
		await init(services);
		__clearShadowDepsForTests();

		// "show" triggers isDataQuestion, DataQuery returns pasta recipe, LLM answers it
		const ctx = createTestMessageContext({ text: 'show me what pasta I have' });
		const result = await handleMessage(ctx);
		// DataQuery answered it — food is handled, not yielded
		expect(result).not.toEqual({ handled: false });
		expect(services.telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			expect.stringContaining('pasta'),
		);
	});
});
