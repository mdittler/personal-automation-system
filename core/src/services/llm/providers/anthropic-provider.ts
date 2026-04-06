/**
 * Anthropic (Claude) provider.
 *
 * Refactored from claude-client.ts to implement the LLMProviderClient interface.
 * Uses the official @anthropic-ai/sdk for completions and model listing.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../../types/llm.js';
import { getModelPricing } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

export class AnthropicProvider extends BaseProvider {
	override readonly supportsVision = true;
	private readonly client: Anthropic;

	constructor(options: Omit<BaseProviderOptions, 'providerType'>) {
		super({ ...options, providerType: 'anthropic' });

		if (!options.apiKey) {
			throw new Error('Anthropic API key is required but was empty');
		}

		this.client = new Anthropic({
			apiKey: options.apiKey,
			timeout: 120_000, // 2 minute timeout
		});
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		// Build multimodal content when images are provided
		let content: string | Anthropic.MessageCreateParams['messages'][0]['content'] = prompt;
		if (options?.images?.length) {
			const blocks: Anthropic.ContentBlockParam[] = [];
			for (const img of options.images) {
				blocks.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
						data: img.data.toString('base64'),
					},
				});
			}
			blocks.push({ type: 'text', text: prompt });
			content = blocks;
		}

		const response = await this.client.messages.create({
			model,
			max_tokens: options?.maxTokens ?? 1024,
			messages: [{ role: 'user', content }],
			temperature: options?.temperature,
			...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
		});

		const text = response.content
			.filter((block): block is Anthropic.TextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('');

		return {
			text,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
			},
			model,
			provider: this.providerId,
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		try {
			const models: ProviderModel[] = [];
			const response = await this.client.models.list({ limit: 100 });

			for await (const model of response) {
				const pricing = getModelPricing(model.id);
				models.push({
					id: model.id,
					displayName: model.display_name ?? model.id,
					provider: this.providerId,
					providerType: this.providerType,
					pricing: pricing ? { input: pricing.input, output: pricing.output } : null,
				});
			}

			return models;
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list Anthropic models',
			);
			return [];
		}
	}
}
