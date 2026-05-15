/**
 * Google Gemini provider.
 *
 * Uses the official @google/genai SDK for completions and model listing.
 */

import { GoogleGenAI } from '@google/genai';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMFinishReason,
	ProviderModel,
} from '../../../types/llm.js';
import { getModelPricing } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

/**
 * Map Google Gemini `candidates[0].finishReason` to the unified LLMFinishReason.
 * Unknown / missing values → 'other'.
 */
function mapGoogleFinishReason(finishReason: unknown): LLMFinishReason {
	switch (finishReason) {
		case 'STOP':
			return 'stop';
		case 'MAX_TOKENS':
			return 'length';
		case 'SAFETY':
		case 'RECITATION':
			return 'error';
		default:
			return 'other';
	}
}

export class GoogleProvider extends BaseProvider {
	override readonly supportsVision = true;
	private readonly client: GoogleGenAI;

	constructor(options: Omit<BaseProviderOptions, 'providerType'>) {
		super({ ...options, providerType: 'google' });

		if (!options.apiKey) {
			throw new Error('Google AI API key is required but was empty');
		}

		this.client = new GoogleGenAI({
			apiKey: options.apiKey,
			httpOptions: { timeout: 120_000 }, // 2 minute timeout
		});
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		// Build multimodal content when images are provided
		let contents: string | Array<{ role: string; parts: Array<Record<string, unknown>> }> = prompt;
		if (options?.images?.length) {
			const parts: Array<Record<string, unknown>> = [];
			for (const img of options.images) {
				parts.push({
					inlineData: {
						data: img.data.toString('base64'),
						mimeType: img.mimeType,
					},
				});
			}
			parts.push({ text: prompt });
			contents = [{ role: 'user', parts }];
		}

		const response = await this.client.models.generateContent({
			model,
			contents,
			config: {
				temperature: options?.temperature,
				maxOutputTokens: options?.maxTokens ?? 1024,
				...(options?.systemPrompt ? { systemInstruction: options.systemPrompt } : {}),
				...(options?.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
			},
		});

		const text = response.text ?? '';
		const firstCandidate = Array.isArray(response.candidates) ? response.candidates[0] : undefined;
		const finishReason: LLMFinishReason = firstCandidate
			? mapGoogleFinishReason(firstCandidate.finishReason)
			: 'other';

		return {
			text,
			usage: response.usageMetadata
				? {
						inputTokens: response.usageMetadata.promptTokenCount ?? 0,
						outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
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
			const pager = await this.client.models.list();

			for await (const model of pager) {
				const id = model.name?.replace('models/', '') ?? '';
				if (!id) continue;

				const pricing = getModelPricing(id);
				models.push({
					id,
					displayName: model.displayName ?? id,
					provider: this.providerId,
					providerType: this.providerType,
					pricing: pricing ? { input: pricing.input, output: pricing.output } : null,
				});
			}

			return models;
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list Google models',
			);
			return [];
		}
	}

	protected override getRetryOptions() {
		return {
			maxRetries: 2,
			initialDelayMs: 1000,
			logger: this.logger,
		};
	}
}
