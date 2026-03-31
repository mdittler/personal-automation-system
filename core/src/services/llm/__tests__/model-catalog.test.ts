import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderModel } from '../../../types/llm.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

// Mock the Anthropic SDK to prevent real API calls
vi.mock('@anthropic-ai/sdk', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			models: {
				list: vi.fn(),
			},
		})),
	};
});

// Import after mock is set up
const { ModelCatalog } = await import('../model-catalog.js');

const logger = pino({ level: 'silent' });

function createMockRegistry(models: ProviderModel[] = []): ProviderRegistry {
	return {
		getAllModels: vi.fn().mockResolvedValue(models),
	} as unknown as ProviderRegistry;
}

const sampleModels: ProviderModel[] = [
	{
		id: 'claude-sonnet-4-20250514',
		displayName: 'Claude Sonnet 4',
		provider: 'anthropic',
		providerType: 'anthropic',
		pricing: { input: 3.0, output: 15.0 },
	},
	{
		id: 'gpt-4o',
		displayName: 'GPT-4o',
		provider: 'openai',
		providerType: 'openai-compatible',
		pricing: { input: 2.5, output: 10.0 },
	},
	{
		id: 'unknown-model',
		displayName: 'Unknown Model',
		provider: 'custom',
		providerType: 'openai-compatible',
		pricing: null,
	},
];

describe('ModelCatalog', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('fetches models from provider registry', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		const models = await catalog.getModels();

		expect(registry.getAllModels).toHaveBeenCalledOnce();
		expect(models).toHaveLength(3);
	});

	it('returns cached models on subsequent calls', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		await catalog.getModels();
		await catalog.getModels();
		await catalog.getModels();

		expect(registry.getAllModels).toHaveBeenCalledOnce();
	});

	it('sorts models with pricing before those without', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		const models = await catalog.getModels();

		// Models with pricing should come first
		const pricingBoundary = models.findIndex((m) => m.pricing === null);
		for (let i = 0; i < pricingBoundary; i++) {
			expect(models[i].pricing).not.toBeNull();
		}
		for (let i = pricingBoundary; i < models.length; i++) {
			expect(models[i].pricing).toBeNull();
		}
	});

	it('refresh clears cache and re-fetches', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		await catalog.getModels();
		expect(registry.getAllModels).toHaveBeenCalledOnce();

		await catalog.refresh();
		expect(registry.getAllModels).toHaveBeenCalledTimes(2);
	});

	it('maps ProviderModel fields to CatalogModel correctly', async () => {
		const registry = createMockRegistry([sampleModels[0]]);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		const models = await catalog.getModels();

		expect(models[0]).toEqual({
			id: 'claude-sonnet-4-20250514',
			displayName: 'Claude Sonnet 4',
			createdAt: '',
			pricing: { input: 3.0, output: 15.0 },
			provider: 'anthropic',
			providerType: 'anthropic',
		});
	});

	it('returns empty array when fetch fails', async () => {
		const registry = createMockRegistry([]);
		(registry.getAllModels as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Network error'),
		);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		const models = await catalog.getModels();

		expect(models).toEqual([]);
	});

	it('returns stale cache when fetch fails after initial load', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		// First call succeeds and caches
		const initial = await catalog.getModels();
		expect(initial).toHaveLength(3);

		// Simulate cache expiry by manipulating time
		vi.useFakeTimers();
		vi.advanceTimersByTime(61 * 60 * 1000); // past TTL

		// Make registry fail
		(registry.getAllModels as ReturnType<typeof vi.fn>).mockRejectedValue(
			new Error('Provider down'),
		);

		const stale = await catalog.getModels();
		expect(stale).toHaveLength(3);
		expect(stale).toEqual(initial);

		vi.useRealTimers();
	});

	it('cache expires after TTL', async () => {
		const registry = createMockRegistry(sampleModels);
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			providerRegistry: registry,
		});

		vi.useFakeTimers();

		await catalog.getModels();
		expect(registry.getAllModels).toHaveBeenCalledOnce();

		// Advance past the 1-hour TTL
		vi.advanceTimersByTime(61 * 60 * 1000);

		await catalog.getModels();
		expect(registry.getAllModels).toHaveBeenCalledTimes(2);

		vi.useRealTimers();
	});

	it('returns empty array with no registry and no client', async () => {
		// When providerRegistry is not provided, a real Anthropic client
		// would be created. We mock it above so it won't make real calls.
		// But here we test the edge: construct WITHOUT registry,
		// the fetchFromAnthropic path would be used.
		// Since our mock doesn't set up async iteration, this tests graceful handling.
		const catalog = new ModelCatalog({
			apiKey: 'test-key',
			logger,
			// No providerRegistry — uses Anthropic fallback
		});

		// The mocked Anthropic client's models.list() returns undefined (not async iterable),
		// which will throw, and the error handler returns cache ?? []
		const models = await catalog.getModels();
		expect(models).toEqual([]);
	});
});
