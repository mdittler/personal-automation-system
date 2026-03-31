import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS } from '../default-providers.js';

describe('DEFAULT_PROVIDERS', () => {
	it('includes anthropic provider', () => {
		expect(DEFAULT_PROVIDERS.anthropic).toBeDefined();
		expect(DEFAULT_PROVIDERS.anthropic.type).toBe('anthropic');
		expect(DEFAULT_PROVIDERS.anthropic.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
	});

	it('includes google provider', () => {
		expect(DEFAULT_PROVIDERS.google).toBeDefined();
		expect(DEFAULT_PROVIDERS.google.type).toBe('google');
		expect(DEFAULT_PROVIDERS.google.apiKeyEnvVar).toBe('GOOGLE_AI_API_KEY');
	});

	it('includes openai provider', () => {
		expect(DEFAULT_PROVIDERS.openai).toBeDefined();
		expect(DEFAULT_PROVIDERS.openai.type).toBe('openai-compatible');
		expect(DEFAULT_PROVIDERS.openai.apiKeyEnvVar).toBe('OPENAI_API_KEY');
	});

	it('includes ollama provider', () => {
		expect(DEFAULT_PROVIDERS.ollama).toBeDefined();
		expect(DEFAULT_PROVIDERS.ollama.type).toBe('ollama');
		expect(DEFAULT_PROVIDERS.ollama.apiKeyEnvVar).toBe('');
	});

	it('all providers have a default model', () => {
		for (const [id, config] of Object.entries(DEFAULT_PROVIDERS)) {
			expect(config.defaultModel, `${id} should have a default model`).toBeTruthy();
		}
	});

	it('all provider IDs are unique', () => {
		const ids = Object.keys(DEFAULT_PROVIDERS);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it('all providers have a type field', () => {
		for (const [id, config] of Object.entries(DEFAULT_PROVIDERS)) {
			expect(config.type, `${id} should have a type`).toBeTruthy();
		}
	});

	it('all providers have an apiKeyEnvVar field defined', () => {
		for (const [id, config] of Object.entries(DEFAULT_PROVIDERS)) {
			expect(typeof config.apiKeyEnvVar, `${id} should have apiKeyEnvVar as string`).toBe('string');
		}
	});
});
