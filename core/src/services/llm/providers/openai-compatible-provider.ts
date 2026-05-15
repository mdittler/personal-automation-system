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
	LLMFinishReason,
	ProviderModel,
	ProviderType,
} from '../../../types/llm.js';
import { getModelPricing } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

/**
 * Sentinel API key used by providers that don't authenticate (llama.cpp's
 * `llama-server`). The `openai` SDK requires a non-empty `apiKey` to construct,
 * but the server ignores the value.
 */
const LOCAL_NO_AUTH_API_KEY = 'sk-no-auth-required';

/**
 * Map OpenAI-compatible `finish_reason` to the unified LLMFinishReason.
 * Unknown / null / undefined values → 'other'.
 */
function mapOpenAIFinishReason(finishReason: unknown): LLMFinishReason {
	switch (finishReason) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'content_filter':
			return 'error';
		case 'tool_calls':
		case 'function_call':
			return 'other';
		default:
			return 'other';
	}
}

export class OpenAICompatibleProvider extends BaseProvider {
	override readonly supportsVision = true;
	private readonly client: OpenAI;

	constructor(
		options: Omit<BaseProviderOptions, 'providerType'> & {
			/**
			 * Override the providerType. Defaults to 'openai-compatible'.
			 * Subclasses that reuse this transport (e.g. LlamaCppProvider) pass
			 * their own type so cost-tracking and routing logic can distinguish them.
			 */
			providerType?: ProviderType;
		},
	) {
		const providerType: ProviderType = options.providerType ?? 'openai-compatible';
		const noAuthRequired = providerType === 'llama-cpp';
		const apiKey = options.apiKey || (noAuthRequired ? LOCAL_NO_AUTH_API_KEY : '');

		super({ ...options, providerType, apiKey });

		if (!apiKey) {
			throw new Error(`API key is required for provider "${options.providerId}" but was empty`);
		}

		this.client = new OpenAI({
			apiKey,
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
			...(options?.responseFormat === 'json'
				? { response_format: { type: 'json_object' as const } }
				: {}),
		});

		const text = response.choices[0]?.message?.content ?? '';
		const finishReason: LLMFinishReason = response.choices[0]
			? mapOpenAIFinishReason(response.choices[0].finish_reason)
			: 'other';

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
			finishReason,
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
