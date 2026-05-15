/**
 * llama.cpp provider — talks to a `llama-server` instance over its
 * OpenAI-compatible `/v1/chat/completions` endpoint.
 *
 * `llama-server` doesn't authenticate, so the parent constructor receives a
 * sentinel API key that the server ignores. Free local inference — pricing is
 * hardcoded to zero in compose-runtime alongside Ollama.
 *
 * Reuses OpenAICompatibleProvider's chat-completions and listModels logic via
 * inheritance — finish_reason mapping, JSON mode, and `/v1/models` listing all
 * work as-is. No code duplication beyond the constructor.
 */

import type { BaseProviderOptions } from './base-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';

export class LlamaCppProvider extends OpenAICompatibleProvider {
	constructor(options: Omit<BaseProviderOptions, 'providerType' | 'apiKey'>) {
		super({
			...options,
			apiKey: '',
			providerType: 'llama-cpp',
		});
	}
}
