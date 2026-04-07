/**
 * Tests for LLM vision (image input) support across the provider stack.
 */

import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMImage,
	LLMService,
	ProviderModel,
} from '../../../types/llm.js';
import type { CostTracker } from '../cost-tracker.js';
import { LLMGuard, type LLMGuardConfig } from '../llm-guard.js';
import { BaseProvider, type BaseProviderOptions } from '../providers/base-provider.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
		getMonthlyAppCost: vi.fn().mockReturnValue(0),
		getMonthlyTotalCost: vi.fn().mockReturnValue(0),
		loadMonthlyCache: vi.fn().mockResolvedValue(undefined),
		flush: vi.fn().mockResolvedValue(undefined),
	} as unknown as CostTracker;
}

function baseOpts(overrides?: Partial<BaseProviderOptions>): BaseProviderOptions {
	return {
		providerId: 'test',
		providerType: 'anthropic',
		apiKey: 'test-key',
		defaultModel: 'test-model',
		logger,
		costTracker: createMockCostTracker(),
		...overrides,
	};
}

/** A vision-capable test provider. */
class VisionProvider extends BaseProvider {
	override readonly supportsVision = true;
	lastPrompt = '';
	lastOptions?: LLMCompletionOptions;

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		this.lastPrompt = prompt;
		this.lastOptions = options;
		return {
			text: 'vision response',
			usage: { inputTokens: 100, outputTokens: 50 },
			model: 'test-model',
			provider: 'test',
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		return [];
	}
}

/** A non-vision test provider. */
class TextOnlyProvider extends BaseProvider {
	// supportsVision defaults to false

	protected async doComplete(
		prompt: string,
		_options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		return {
			text: 'text response',
			usage: { inputTokens: 10, outputTokens: 20 },
			model: 'test-model',
			provider: 'test',
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testImage = {
	data: Buffer.from('fake-jpeg-data'),
	mimeType: 'image/jpeg',
};

describe('LLM Vision Support', () => {
	describe('LLMImage type', () => {
		it('accepts Buffer data with mimeType', () => {
			const image: LLMImage = {
				data: Buffer.from('test'),
				mimeType: 'image/jpeg',
			};
			expect(image.data).toBeInstanceOf(Buffer);
			expect(image.mimeType).toBe('image/jpeg');
		});
	});

	describe('BaseProvider — supportsVision guard', () => {
		it('throws when images passed to a non-vision provider', async () => {
			const provider = new TextOnlyProvider(baseOpts());

			await expect(
				provider.complete('describe this', { images: [testImage] }),
			).rejects.toThrow(/does not support vision/i);
		});

		it('allows images on a vision-capable provider', async () => {
			const provider = new VisionProvider(baseOpts());

			const result = await provider.complete('describe this', {
				images: [testImage],
			});

			expect(result).toBe('vision response');
		});

		it('passes images through to doComplete()', async () => {
			const provider = new VisionProvider(baseOpts());

			await provider.complete('describe this', {
				images: [testImage],
				tier: 'standard',
			});

			expect(provider.lastOptions?.images).toHaveLength(1);
			expect(provider.lastOptions?.images?.[0]?.data).toBeInstanceOf(Buffer);
			expect(provider.lastOptions?.images?.[0]?.mimeType).toBe('image/jpeg');
		});

		it('allows text-only calls on vision providers', async () => {
			const provider = new VisionProvider(baseOpts());

			const result = await provider.complete('hello');

			expect(result).toBe('vision response');
		});

		it('allows text-only calls on non-vision providers', async () => {
			const provider = new TextOnlyProvider(baseOpts());

			const result = await provider.complete('hello');

			expect(result).toBe('text response');
		});

		it('defaults supportsVision to false', () => {
			const provider = new TextOnlyProvider(baseOpts());
			expect(provider.supportsVision).toBe(false);
		});

		it('throws on invalid MIME type', async () => {
			const provider = new VisionProvider(baseOpts());
			const badImage = { data: Buffer.from('data'), mimeType: 'text/html' };

			await expect(
				provider.complete('describe this', { images: [badImage] }),
			).rejects.toThrow(/unsupported image mime type/i);
		});

		it('throws on empty MIME type', async () => {
			const provider = new VisionProvider(baseOpts());
			const badImage = { data: Buffer.from('data'), mimeType: '' };

			await expect(
				provider.complete('describe this', { images: [badImage] }),
			).rejects.toThrow(/unsupported image mime type/i);
		});

		it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])(
			'accepts valid MIME type %s',
			async (mimeType) => {
				const provider = new VisionProvider(baseOpts());
				const image = { data: Buffer.from('data'), mimeType };

				const result = await provider.complete('describe this', { images: [image] });
				expect(result).toBe('vision response');
			},
		);
	});

	describe('LLMGuard — vision pass-through', () => {
		it('passes images option through to inner service', async () => {
			const inner: LLMService = {
				complete: vi.fn().mockResolvedValue('result'),
				classify: vi.fn().mockResolvedValue({ category: 'test', confidence: 0.9 }),
				extractStructured: vi.fn().mockResolvedValue({}),
			};

			const guard = new LLMGuard({
				inner,
				appId: 'test-app',
				costTracker: createMockCostTracker(),
				config: {
					maxRequests: 100,
					windowSeconds: 60,
					monthlyCostCap: 50,
					globalMonthlyCostCap: 100,
				},
				logger,
			});

			await guard.complete('describe this', {
				tier: 'standard',
				images: [testImage],
			});

			expect(inner.complete).toHaveBeenCalledWith(
				'describe this',
				expect.objectContaining({
					images: [testImage],
				}),
			);
		});
	});
});
