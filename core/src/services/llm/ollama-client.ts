/**
 * Ollama (local LLM) client.
 *
 * Uses the official `ollama` npm package to communicate with
 * the Ollama server for fast, free local inference.
 */

import { Ollama } from 'ollama';
import type { Logger } from 'pino';
import type { LLMCompletionOptions } from '../../types/llm.js';
import { withRetry } from './retry.js';

export interface OllamaClientOptions {
	/** Ollama server URL. Default: http://ollama:11434. */
	url: string;
	/** Default model. Default: llama3.2:3b. */
	model: string;
	/** Logger instance. */
	logger: Logger;
}

export class OllamaClient {
	private readonly client: Ollama;
	private readonly defaultModel: string;
	private readonly logger: Logger;

	constructor(options: OllamaClientOptions) {
		this.client = new Ollama({
			host: options.url,
			fetch: createTimeoutFetch(120_000),
		});
		this.defaultModel = options.model;
		this.logger = options.logger;
	}

	/**
	 * Generate a text completion using the local Ollama model.
	 *
	 * Does NOT silently fall back to Claude on failure (URS-LLM-004).
	 * Throws with a clear error message on connection failure.
	 */
	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		const model = this.defaultModel;

		return withRetry(
			async () => {
				const response = await this.client.generate({
					model,
					prompt,
					options: {
						temperature: options?.temperature ?? 0.1,
						num_predict: options?.maxTokens,
					},
				});

				return response.response;
			},
			{
				maxRetries: 2,
				initialDelayMs: 500,
				logger: this.logger,
			},
		);
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
