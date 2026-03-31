import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderClient, ProviderModel } from '../../../types/llm.js';
import { ProviderRegistry } from '../providers/provider-registry.js';

const logger = pino({ level: 'silent' });

function createMockProvider(providerId: string, models: ProviderModel[] = []): LLMProviderClient {
	return {
		providerId,
		providerType: 'anthropic',
		complete: vi.fn().mockResolvedValue('response'),
		completeWithUsage: vi.fn().mockResolvedValue({
			text: 'response',
			usage: { inputTokens: 10, outputTokens: 20 },
			model: 'test-model',
			provider: providerId,
		}),
		listModels: vi.fn().mockResolvedValue(models),
	};
}

describe('ProviderRegistry', () => {
	it('registers and retrieves a provider', () => {
		const registry = new ProviderRegistry(logger);
		const provider = createMockProvider('test');

		registry.register(provider);

		expect(registry.get('test')).toBe(provider);
		expect(registry.has('test')).toBe(true);
		expect(registry.size).toBe(1);
	});

	it('returns undefined for unregistered provider', () => {
		const registry = new ProviderRegistry(logger);

		expect(registry.get('nonexistent')).toBeUndefined();
		expect(registry.has('nonexistent')).toBe(false);
	});

	it('overwrites existing provider with same ID', () => {
		const registry = new ProviderRegistry(logger);
		const provider1 = createMockProvider('test');
		const provider2 = createMockProvider('test');

		registry.register(provider1);
		registry.register(provider2);

		expect(registry.get('test')).toBe(provider2);
		expect(registry.size).toBe(1);
	});

	it('returns all providers', () => {
		const registry = new ProviderRegistry(logger);
		registry.register(createMockProvider('a'));
		registry.register(createMockProvider('b'));

		const all = registry.getAll();

		expect(all).toHaveLength(2);
	});

	it('returns all provider IDs', () => {
		const registry = new ProviderRegistry(logger);
		registry.register(createMockProvider('a'));
		registry.register(createMockProvider('b'));

		const ids = registry.getProviderIds();

		expect(ids).toEqual(['a', 'b']);
	});

	it('aggregates models from all providers', async () => {
		const registry = new ProviderRegistry(logger);

		const modelsA: ProviderModel[] = [
			{
				id: 'model-a',
				displayName: 'Model A',
				provider: 'a',
				providerType: 'anthropic',
				pricing: null,
			},
		];
		const modelsB: ProviderModel[] = [
			{
				id: 'model-b',
				displayName: 'Model B',
				provider: 'b',
				providerType: 'openai-compatible',
				pricing: { input: 1.0, output: 2.0 },
			},
		];

		registry.register(createMockProvider('a', modelsA));
		registry.register(createMockProvider('b', modelsB));

		const allModels = await registry.getAllModels();

		expect(allModels).toHaveLength(2);
		expect(allModels[0].id).toBe('model-a');
		expect(allModels[1].id).toBe('model-b');
	});

	it('skips providers that fail to list models', async () => {
		const registry = new ProviderRegistry(logger);

		const goodProvider = createMockProvider('good', [
			{
				id: 'model-good',
				displayName: 'Good',
				provider: 'good',
				providerType: 'anthropic',
				pricing: null,
			},
		]);

		const badProvider = createMockProvider('bad');
		vi.mocked(badProvider.listModels).mockRejectedValue(new Error('API error'));

		registry.register(goodProvider);
		registry.register(badProvider);

		const allModels = await registry.getAllModels();

		expect(allModels).toHaveLength(1);
		expect(allModels[0].id).toBe('model-good');
	});
});
