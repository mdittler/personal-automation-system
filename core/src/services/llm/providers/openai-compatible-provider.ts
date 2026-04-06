/**
 * OpenAI-compatible provider.
 *
 * Uses the official `openai` npm package with a configurable baseURL.
 * Works with OpenAI, Groq, Together, Mistral, vLLM, and any other
 * provider that exposes an OpenAI-compatible API.
 */

import OpenAI from 'openai';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../../types/llm.js';
import { getModelPricing } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

export class OpenAICompatibleProvider extends BaseProvider {
	override readonly supportsVision = true;
	private readonly client: OpenAI;

	constructor(options: Omit<BaseProviderOptions, 'providerType'>) {
		super({ ...options, providerType: 'openai-compatible' });

		if (!options.apiKey) {
			throw new Error(`API key is required for provider "${options.providerId}" but was empty`);
		}

		this.client = new OpenAI({
			apiKey: options.apiKey,
			baseURL: options.baseUrl,
			timeout: 120_000, // 2 minute timeout
		});
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		const messages: OpenAI.ChatCompletionMessageParam[] = [];
		if (options?.systemPrompt) {
			messages.push({ role: 'system', content: options.systemPrompt });
		}

		// Build multimodal content when images are provided
		if (options?.images?.length) {
			const contentParts: OpenAI.ChatCompletionContentPart[] = [];
			for (const img of options.images) {
				contentParts.push({
					type: 'image_url',
					image_url: {
						url: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
					},
				});
			}
			contentParts.push({ type: 'text', text: prompt });
			messages.push({ role: 'user', content: contentParts });
		} else {
			messages.push({ role: 'user', content: prompt });
		}

		const response = await this.client.chat.completions.create({
			model,
			messages,
			max_tokens: options?.maxTokens ?? 1024,
			temperature: options?.temperature,
		});

		const text = response.choices[0]?.message?.content ?? '';

		return {
			text,
			usage: response.usage
				? {
						inputTokens: response.usage.prompt_tokens ?? 0,
						outputTokens: response.usage.completion_tokens ?? 0,
					}
				: undefined,
			model,
			provider: this.providerId,
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		try {
			const models: ProviderModel[] = [];
			const response = await this.client.models.list();

			for await (const model of response) {
				const pricing = getModelPricing(model.id);
				models.push({
					id: model.id,
					displayName: model.id,
					provider: this.providerId,
					providerType: this.providerType,
					pricing: pricing ? { input: pricing.input, output: pricing.output } : null,
				});
			}

			return models;
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list models from %s',
				this.providerId,
			);
			return [];
		}
	}
}
