import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderConfig } from '../../../types/config.js';
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
