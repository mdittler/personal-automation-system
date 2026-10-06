import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderConfig } from '../../../types/config.js';
import { LlamaCppProvider } from '../providers/llama-cpp-provider.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible-provider.js';
import { createProvider } from '../providers/provider-factory.js';

// Mock all provider constructors to avoid real SDK initialization
vi.mock('../providers/anthropic-provider.js', () => ({
	AnthropicProvider: vi.fn().mockImplementation((opts) => ({
		providerId: opts.providerId,
		providerType: 'anthropic',
		complete: vi.fn(),
		completeWithUsage: vi.fn(),
		listModels: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock('../providers/google-provider.js', () => ({
	GoogleProvider: vi.fn().mockImplementation((opts) => ({
		providerId: opts.providerId,
		providerType: 'google',
		complete: vi.fn(),
		completeWithUsage: vi.fn(),
		listModels: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock('../providers/openai-compatible-provider.js', () => ({
	OpenAICompatibleProvider: vi.fn().mockImplementation((opts) => ({
		providerId: opts.providerId,
		providerType: 'openai-compatible',
		complete: vi.fn(),
		completeWithUsage: vi.fn(),
		listModels: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock('../providers/ollama-provider.js', () => ({
	OllamaProvider: vi.fn().mockImplementation((opts) => ({
		providerId: opts.providerId,
		providerType: 'ollama',
		complete: vi.fn(),
		completeWithUsage: vi.fn(),
		listModels: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock('../providers/llama-cpp-provider.js', () => ({
	LlamaCppProvider: vi.fn().mockImplementation((opts) => ({
		providerId: opts.providerId,
		providerType: 'llama-cpp',
		complete: vi.fn(),
		completeWithUsage: vi.fn(),
		listModels: vi.fn().mockResolvedValue([]),
	})),
}));

const mockCostTracker = {
	record: vi.fn(),
	estimateCost: vi.fn().mockReturnValue(0),
	readUsage: vi.fn().mockResolvedValue(''),
} as never;

const logger = pino({ level: 'silent' });

describe('createProvider', () => {
	afterEach(() => {
		// Clean up env vars
		process.env.TEST_API_KEY = undefined;
		process.env.TEST_GOOGLE_KEY = undefined;
	});

	it('creates an Anthropic provider when API key is set', () => {
		process.env.TEST_API_KEY = 'sk-test-key';

		const config: LLMProviderConfig = {
			type: 'anthropic',
			name: 'Anthropic',
			apiKeyEnvVar: 'TEST_API_KEY',
			defaultModel: 'claude-sonnet-4-20250514',
		};

		const provider = createProvider('anthropic', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerId).toBe('anthropic');
		expect(provider?.providerType).toBe('anthropic');
	});

	it('creates a Google provider when API key is set', () => {
		process.env.TEST_GOOGLE_KEY = 'AIza-test';

		const config: LLMProviderConfig = {
			type: 'google',
			name: 'Google',
			apiKeyEnvVar: 'TEST_GOOGLE_KEY',
			defaultModel: 'gemini-2.0-flash',
		};

		const provider = createProvider('google', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('google');
	});

	it('creates an OpenAI-compatible provider with baseUrl', () => {
		process.env.TEST_API_KEY = 'sk-test';

		const config: LLMProviderConfig = {
			type: 'openai-compatible',
			name: 'Groq',
			apiKeyEnvVar: 'TEST_API_KEY',
			baseUrl: 'https://api.groq.com/openai/v1',
			defaultModel: 'llama-3.3-70b',
		};

		const provider = createProvider('groq', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('openai-compatible');
	});

	it('creates an Ollama provider with baseUrl', () => {
		const config: LLMProviderConfig = {
			type: 'ollama',
			name: 'Ollama',
			apiKeyEnvVar: '',
			baseUrl: 'http://localhost:11434',
			defaultModel: 'llama3.2:3b',
		};

		const provider = createProvider('ollama', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('ollama');
	});

	it('returns null when API key is not set', () => {
		const config: LLMProviderConfig = {
			type: 'anthropic',
			name: 'Anthropic',
			apiKeyEnvVar: 'MISSING_KEY',
			defaultModel: 'claude-sonnet-4-20250514',
		};

		const provider = createProvider('anthropic', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});

	it('returns null for Ollama without baseUrl', () => {
		const config: LLMProviderConfig = {
			type: 'ollama',
			name: 'Ollama',
			apiKeyEnvVar: '',
		};

		const provider = createProvider('ollama', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});

	it('returns null when defaultModel is empty string (non-Ollama)', () => {
		process.env.TEST_API_KEY = 'sk-test-key';

		const config: LLMProviderConfig = {
			type: 'anthropic',
			name: 'Anthropic',
			apiKeyEnvVar: 'TEST_API_KEY',
			defaultModel: '',
		};

		const provider = createProvider('anthropic', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});

	it('returns null when defaultModel is undefined (non-Ollama)', () => {
		process.env.TEST_API_KEY = 'sk-test-key';

		const config: LLMProviderConfig = {
			type: 'google',
			name: 'Google',
			apiKeyEnvVar: 'TEST_API_KEY',
		};

		const provider = createProvider('google', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});

	it('Ollama creates with fallback model when defaultModel is empty', () => {
		const config: LLMProviderConfig = {
			type: 'ollama',
			name: 'Ollama',
			apiKeyEnvVar: '',
			baseUrl: 'http://localhost:11434',
			defaultModel: '',
		};

		const provider = createProvider('ollama', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('ollama');
	});

	it('creates a llama-cpp provider with baseUrl and no API key', () => {
		const config: LLMProviderConfig = {
			type: 'llama-cpp',
			name: 'llama.cpp',
			apiKeyEnvVar: '',
			baseUrl: 'http://localhost:8080',
			defaultModel: 'local-model',
		};

		const provider = createProvider('llama-cpp', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('llama-cpp');
	});

	it('returns null for llama-cpp without baseUrl', () => {
		const config: LLMProviderConfig = {
			type: 'llama-cpp',
			name: 'llama.cpp',
			apiKeyEnvVar: '',
			defaultModel: 'local-model',
		};

		const provider = createProvider('llama-cpp', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});

	it('llama-cpp creates with fallback model when defaultModel is empty', () => {
		const config: LLMProviderConfig = {
			type: 'llama-cpp',
			name: 'llama.cpp',
			apiKeyEnvVar: '',
			baseUrl: 'http://localhost:8080',
			defaultModel: '',
		};

		const provider = createProvider('llama-cpp', config, logger, mockCostTracker);

		expect(provider).not.toBeNull();
		expect(provider?.providerType).toBe('llama-cpp');
	});

	it('returns null for unknown provider type', () => {
		process.env.TEST_API_KEY = 'sk-test';

		const config = {
			type: 'unknown-type',
			name: 'Unknown',
			apiKeyEnvVar: 'TEST_API_KEY',
		} as LLMProviderConfig;

		const provider = createProvider('unknown', config, logger, mockCostTracker);

		expect(provider).toBeNull();
	});
});

describe('createProvider — supports_tools flag (REQ-LLM-047)', () => {
	// This file replaces every provider class with a vi.mock factory, so the
	// objects it hands back have no real `supportsTools`. What the factory is
	// responsible for — and all it can be tested for here — is forwarding the
	// flag into the constructor options (P2-3). The real defaults are covered in
	// openai-compatible-provider.test.ts and llama-cpp-provider.test.ts.
	it('forwards supportsTools from config into the openai-compatible and llama-cpp constructor options', () => {
		process.env.TEST_API_KEY = 'sk-test-key';
		vi.mocked(OpenAICompatibleProvider).mockClear();
		vi.mocked(LlamaCppProvider).mockClear();
		expect(
			createProvider(
				'groq',
				{
					type: 'openai-compatible',
					name: 'Groq',
					apiKeyEnvVar: 'TEST_API_KEY',
					baseUrl: 'http://x',
					defaultModel: 'm',
					supportsTools: false,
				},
				logger,
				mockCostTracker as never,
			),
		).not.toBeNull();
		expect(vi.mocked(OpenAICompatibleProvider)).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: 'groq', supportsTools: false }),
		);
		expect(
			createProvider(
				'llama-cpp',
				{
					type: 'llama-cpp',
					name: 'llama',
					apiKeyEnvVar: '',
					baseUrl: 'http://localhost:8080',
					defaultModel: 'local-model',
					supportsTools: true,
				},
				logger,
				mockCostTracker as never,
			),
		).not.toBeNull();
		expect(vi.mocked(LlamaCppProvider)).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: 'llama-cpp', supportsTools: true }),
		);
	});

	it('leaves supportsTools undefined when the config omits it (the provider default then applies)', () => {
		process.env.TEST_API_KEY = 'sk-test-key';
		vi.mocked(OpenAICompatibleProvider).mockClear();
		createProvider(
			'groq',
			{
				type: 'openai-compatible',
				name: 'Groq',
				apiKeyEnvVar: 'TEST_API_KEY',
				baseUrl: 'http://x',
				defaultModel: 'm',
			},
			logger,
			mockCostTracker as never,
		);
		expect(vi.mocked(OpenAICompatibleProvider).mock.calls[0]?.[0]).toMatchObject({
			supportsTools: undefined,
		});
	});
});
