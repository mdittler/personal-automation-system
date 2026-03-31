/**
 * Ollama (local LLM) provider.
 *
 * Refactored from ollama-client.ts to implement the LLMProviderClient interface.
 * Uses the official `ollama` npm package. Free local inference — no cost tracking.
 * Does NOT silently fall back to other providers on failure (URS-LLM-004).
 */

import { Ollama } from 'ollama';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../../types/llm.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

export class OllamaProvider extends BaseProvider {
	private readonly client: Ollama;

	constructor(options: Omit<BaseProviderOptions, 'providerType' | 'apiKey'>) {
		super({ ...options, providerType: 'ollama', apiKey: '' });

		this.client = new Ollama({
			host: options.baseUrl,
			fetch: createTimeoutFetch(120_000),
		});
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		const response = await this.client.generate({
			model,
			prompt,
			...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
			options: {
				temperature: options?.temperature ?? 0.1,
				num_predict: options?.maxTokens,
			},
		});

		return {
			text: response.response ?? '',
			usage: {
				inputTokens: response.prompt_eval_count ?? 0,
				outputTokens: response.eval_count ?? 0,
			},
			model,
			provider: this.providerId,
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		try {
			const response = await this.client.list();

			return response.models.map((model) => ({
				id: model.name,
				displayName: model.name,
				provider: this.providerId,
				providerType: this.providerType,
				pricing: null, // Ollama is free local inference
			}));
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list Ollama models',
			);
			return [];
		}
	}

	protected override getRetryOptions() {
		return {
			maxRetries: 2,
			initialDelayMs: 500,
			logger: this.logger,
		};
	}
}

/**
 * Create a fetch function with a timeout using AbortController.
 */
function createTimeoutFetch(timeoutMs: number): typeof globalThis.fetch {
	return (input, init) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		return globalThis
			.fetch(input, { ...init, signal: controller.signal })
			.finally(() => clearTimeout(timeout));
	};
}
