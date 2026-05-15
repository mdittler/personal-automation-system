/**
 * Provider factory.
 *
 * Creates LLMProviderClient instances from configuration.
 * Adding a new OpenAI-compatible endpoint is config-driven (no code changes).
 */

import type { Logger } from 'pino';
import type { LLMProviderConfig } from '../../../types/config.js';
import type { LLMProviderClient } from '../../../types/llm.js';
import type { CostTracker } from '../cost-tracker.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { GoogleProvider } from './google-provider.js';
import { LlamaCppProvider } from './llama-cpp-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';

/**
 * Create a provider client from configuration.
 *
 * Returns null if the provider's API key is not set in the environment
 * (meaning the provider is not configured / not available).
 */
export function createProvider(
	providerId: string,
	config: LLMProviderConfig,
	logger: Logger,
	costTracker: CostTracker,
): LLMProviderClient | null {
	// Check if the API key env var is set (Ollama and llama.cpp don't need one)
	const apiKey = config.apiKeyEnvVar ? process.env[config.apiKeyEnvVar] : '';
	const noAuthRequired = config.type === 'ollama' || config.type === 'llama-cpp';
	if (!noAuthRequired && !apiKey) {
		logger.debug({ providerId, envVar: config.apiKeyEnvVar }, 'Provider skipped — API key not set');
		return null;
	}

	const defaultModel = config.defaultModel ?? '';

	// Local providers (Ollama, llama.cpp) have their own fallback model defaults
	if (!defaultModel && !noAuthRequired) {
		logger.warn({ providerId }, 'Provider skipped — no default model configured');
		return null;
	}

	const baseOptions = {
		providerId,
		apiKey: apiKey ?? '',
		defaultModel,
		logger,
		costTracker,
		baseUrl: config.baseUrl,
	};

	switch (config.type) {
		case 'anthropic':
			return new AnthropicProvider(baseOptions);

		case 'google':
			return new GoogleProvider(baseOptions);

		case 'openai-compatible':
			return new OpenAICompatibleProvider(baseOptions);

		case 'ollama': {
			// Ollama needs a base URL to be useful
			if (!config.baseUrl) {
				logger.debug({ providerId }, 'Ollama provider skipped — no base URL');
				return null;
			}
			return new OllamaProvider({
				providerId,
				defaultModel: config.defaultModel ?? 'llama3.2:3b',
				logger,
				costTracker,
				baseUrl: config.baseUrl,
			});
		}

		case 'llama-cpp': {
			// llama-server needs a base URL to be useful
			if (!config.baseUrl) {
				logger.debug({ providerId }, 'llama-cpp provider skipped — no base URL');
				return null;
			}
			return new LlamaCppProvider({
				providerId,
				defaultModel: config.defaultModel || 'local-model',
				logger,
				costTracker,
				baseUrl: config.baseUrl,
			});
		}

		default:
			logger.warn({ providerId, type: config.type }, 'Unknown provider type — skipped');
			return null;
	}
}
