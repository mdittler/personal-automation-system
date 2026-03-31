/**
 * Built-in LLM provider definitions.
 *
 * Users only need to set the corresponding env var to enable a provider.
 * No YAML editing required for the common case. Custom OpenAI-compatible
 * endpoints can be added in pas.yaml under llm.providers.
 */

import type { LLMProviderConfig } from '../../types/config.js';

/**
 * Built-in provider definitions, keyed by provider ID.
 *
 * These are always available — the config loader checks which ones
 * have valid API keys set and only instantiates those.
 */
export const DEFAULT_PROVIDERS: Record<string, LLMProviderConfig> = {
	anthropic: {
		type: 'anthropic',
		name: 'Anthropic',
		apiKeyEnvVar: 'ANTHROPIC_API_KEY',
		defaultModel: 'claude-sonnet-4-20250514',
	},
	google: {
		type: 'google',
		name: 'Google AI',
		apiKeyEnvVar: 'GOOGLE_AI_API_KEY',
		defaultModel: 'gemini-2.0-flash',
	},
	openai: {
		type: 'openai-compatible',
		name: 'OpenAI',
		apiKeyEnvVar: 'OPENAI_API_KEY',
		defaultModel: 'gpt-4.1-mini',
	},
	ollama: {
		type: 'ollama',
		name: 'Ollama',
		apiKeyEnvVar: '',
		defaultModel: 'llama3.2:3b',
	},
};
