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
} from '../../../types/llm.js';
import { LLMEmptyOutputError } from '../errors.js';
import { supportsTemperature } from '../model-capabilities.js';
import { getModelPricing, isLocalProvider } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

/**
 * Provider types that may reuse OpenAICompatibleProvider's transport. Narrower
 * than the full ProviderType union so subclasses can't accidentally inherit
 * the OpenAI chat-completions path under a foreign type tag.
 */
type CompatibleProviderType = 'openai-compatible' | 'llama-cpp';

/**
 * Sentinel API key used by providers that don't authenticate (llama.cpp's
 * `llama-server`). The `openai` SDK requires a non-empty `apiKey` to construct,
 * but the server ignores the value.
 */
const LOCAL_NO_AUTH_API_KEY = 'sk-no-auth-required';

/** Output cap applied when the caller doesn't specify one. */
const DEFAULT_MAX_TOKENS = 1024;

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
	override readonly supportsVision: boolean = true;
	private readonly client: OpenAI;

	constructor(
		options: Omit<BaseProviderOptions, 'providerType'> & {
			/**
			 * Override the providerType. Defaults to 'openai-compatible'.
			 * Subclasses that reuse this transport (e.g. LlamaCppProvider) pass
			 * their own type so cost-tracking and routing logic can distinguish them.
			 */
			providerType?: CompatibleProviderType;
		},
	) {
		const providerType: CompatibleProviderType = options.providerType ?? 'openai-compatible';
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

		// Hoisted so the diagnostic below can name the cap that actually went on
		// the wire, not just the caller-supplied (possibly undefined) value.
		const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;

		const response = await this.client.chat.completions.create({
			model,
			messages,
			max_tokens: maxTokens,
			...(supportsTemperature(model) ? { temperature: options?.temperature } : {}),
			...(options?.responseFormat === 'json'
				? { response_format: { type: 'json_object' as const } }
				: {}),
		});

		const choice = response.choices[0];
		const text = choice?.message?.content ?? '';
		const finishReason: LLMFinishReason = choice
			? mapOpenAIFinishReason(choice.finish_reason)
			: 'other';

		// Reasoning models served over an OpenAI-compatible API (LM Studio, vLLM,
		// SGLang, llama-server) emit their chain of thought in the NON-STANDARD
		// `message.reasoning_content` field and leave `content` empty. The `openai`
		// SDK types don't declare it, so read it through a narrow cast — the same
		// shape OllamaProvider uses for `done_reason`/`thinking`.
		//
		// We deliberately do NOT substitute reasoning text for the answer. It is
		// unstructured prose, so handing it back would feed narration to every
		// `responseFormat: 'json'` caller (classifiers, receipt parsing, the
		// regression judge) and let a non-answer masquerade as a real one — a
		// quieter failure than the empty string it replaced. It is used only as
		// evidence in the diagnostic below, mirroring how OllamaProvider reports
		// `thinking` length without ever returning it.
		const reasoning = (choice?.message as { reasoning_content?: unknown } | undefined)
			?.reasoning_content;
		const reasoningChars = typeof reasoning === 'string' ? reasoning.length : undefined;

		if (text.trim() === '') {
			// Empty output + budget exhausted is unambiguously a failure: there is
			// nothing to return and no budget left to produce it with. Gated on the
			// finish reason rather than on a reasoning block being present, so a
			// model that burns its budget without reporting one is caught too.
			//
			// Empty output + `stop` deliberately still returns '': some local models
			// legitimately answer ambiguous prompts with an empty string, and the
			// shadow/recall classifiers already retry that case themselves.
			if (finishReason === 'length') {
				throw new LLMEmptyOutputError({
					provider: this.providerId,
					model,
					maxTokens,
					...(reasoningChars !== undefined ? { thinkingChars: reasoningChars } : {}),
				});
			}

			if (reasoningChars) {
				// Not fatal (see above) but never silent: an operator seeing this
				// knows the model reasoned and then declined to answer, rather than
				// guessing why a caller got ''.
				this.logger.warn(
					{ provider: this.providerId, model, finishReason, reasoningChars },
					'Model returned empty content alongside a reasoning block; returning "" unchanged',
				);
			}
		}

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

			// Local providers (llama.cpp) always report null pricing regardless of
			// the model id — a GGUF served as 'gpt-4.1' is still free inference.
			const localProvider = isLocalProvider(this.providerType);

			for await (const model of response) {
				const pricing = localProvider ? null : getModelPricing(model.id);
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
