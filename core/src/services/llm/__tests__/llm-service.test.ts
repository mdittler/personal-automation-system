import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LLMCompletionResult, LLMProviderClient, ModelRef } from '../../../types/llm.js';
import type { CostTracker } from '../cost-tracker.js';
import { LLMServiceImpl } from '../index.js';
import type { ModelSelector } from '../model-selector.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';

const logger = pino({ level: 'silent' });

/** Create a mock provider that returns a fixed response. */
function createMockProvider(providerId: string, response = 'provider response'): LLMProviderClient {
	return {
		providerId,
		providerType: 'anthropic',
		complete: vi.fn().mockResolvedValue(response),
		completeWithUsage: vi.fn().mockResolvedValue({
			text: response,
			usage: { inputTokens: 10, outputTokens: 20 },
			model: 'test-model',
			provider: providerId,
		} satisfies LLMCompletionResult),
		listModels: vi.fn().mockResolvedValue([]),
	};
}

/** Create a mock registry with given providers. */
function createMockRegistry(providers: Record<string, LLMProviderClient>): ProviderRegistry {
	return {
		get: vi.fn((id: string) => providers[id]),
		getAll: vi.fn(() => Object.values(providers)),
		getProviderIds: vi.fn(() => Object.keys(providers)),
		has: vi.fn((id: string) => id in providers),
		size: Object.keys(providers).length,
		register: vi.fn(),
		getAllModels: vi.fn().mockResolvedValue([]),
	} as unknown as ProviderRegistry;
}

/** Create a mock model selector. */
function createMockSelector(overrides?: {
	fast?: ModelRef;
	standard?: ModelRef;
	reasoning?: ModelRef;
}): ModelSelector {
	const fast = overrides?.fast ?? { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };
	const standard = overrides?.standard ?? {
		provider: 'anthropic',
		model: 'claude-sonnet-4-20250514',
	};
	const reasoning = overrides?.reasoning;

	return {
		getFastRef: vi.fn().mockReturnValue(fast),
		getStandardRef: vi.fn().mockReturnValue(standard),
		getReasoningRef: vi.fn().mockReturnValue(reasoning),
		getTierRef: vi.fn((tier: string) => {
			if (tier === 'fast') return fast;
			if (tier === 'standard') return standard;
			if (tier === 'reasoning') return reasoning;
			return undefined;
		}),
		// Deprecated string getters (still used internally)
		getFastModel: vi.fn().mockReturnValue(fast.model),
		getStandardModel: vi.fn().mockReturnValue(standard.model),
		// Other methods
		setStandardRef: vi.fn(),
		setFastRef: vi.fn(),
		setReasoningRef: vi.fn(),
		setStandardModel: vi.fn(),
		setFastModel: vi.fn(),
		load: vi.fn(),
	} as unknown as ModelSelector;
}

function createMockCostTracker(): CostTracker {
	return {
		record: vi.fn(),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	} as unknown as CostTracker;
}

describe('LLMServiceImpl (multi-provider)', () => {
	it('routes to fast tier by default', async () => {
		const provider = createMockProvider('anthropic', 'fast response');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test prompt');

		expect(result).toBe('fast response');
		expect(selector.getFastRef).toHaveBeenCalled();
		expect(provider.completeWithUsage).toHaveBeenCalledWith(
			'test prompt',
			expect.objectContaining({
				modelRef: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
			}),
		);
	});

	it('routes to standard tier when model is "claude" (backward compat)', async () => {
		const provider = createMockProvider('anthropic', 'standard response');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test', { model: 'claude' });

		expect(result).toBe('standard response');
		expect(selector.getStandardRef).toHaveBeenCalled();
	});

	it('routes to fast tier when model is "local" (backward compat)', async () => {
		const provider = createMockProvider('anthropic', 'fast response');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test', { model: 'local' });

		expect(result).toBe('fast response');
		expect(selector.getFastRef).toHaveBeenCalled();
	});

	it('routes via explicit tier option', async () => {
		const provider = createMockProvider('anthropic', 'standard response');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test', { tier: 'standard' });

		expect(result).toBe('standard response');
		expect(selector.getTierRef).toHaveBeenCalledWith('standard');
	});

	it('routes via explicit modelRef (highest priority)', async () => {
		const openai = createMockProvider('openai', 'openai response');
		const anthropic = createMockProvider('anthropic');
		const registry = createMockRegistry({ anthropic, openai });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test', {
			modelRef: { provider: 'openai', model: 'gpt-4o' },
		});

		expect(result).toBe('openai response');
		expect(openai.completeWithUsage).toHaveBeenCalledWith(
			'test',
			expect.objectContaining({
				modelRef: { provider: 'openai', model: 'gpt-4o' },
			}),
		);
	});

	it('supports claudeModel override with legacy model="claude"', async () => {
		const provider = createMockProvider('anthropic', 'opus response');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		await service.complete('test', { model: 'claude', claudeModel: 'claude-opus-4-6' });

		expect(provider.completeWithUsage).toHaveBeenCalledWith(
			'test',
			expect.objectContaining({
				modelRef: { provider: 'anthropic', model: 'claude-opus-4-6' },
			}),
		);
	});

	it('throws when provider is not registered', async () => {
		const registry = createMockRegistry({});
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		await expect(service.complete('test')).rejects.toThrow(/not registered/);
	});

	it('throws when tier has no model configured', async () => {
		const registry = createMockRegistry({});
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		await expect(service.complete('test', { tier: 'reasoning' })).rejects.toThrow(
			/No model configured for tier/,
		);
	});

	it('routes across multiple providers', async () => {
		const anthropic = createMockProvider('anthropic', 'anthropic response');
		const google = createMockProvider('google', 'google response');
		const registry = createMockRegistry({ anthropic, google });
		const selector = createMockSelector({
			fast: { provider: 'google', model: 'gemini-2.0-flash' },
			standard: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
		});

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		// Default (fast) → Google
		const fast = await service.complete('test');
		expect(fast).toBe('google response');
		expect(google.completeWithUsage).toHaveBeenCalled();

		// Standard tier → Anthropic
		const standard = await service.complete('test', { tier: 'standard' });
		expect(standard).toBe('anthropic response');
		expect(anthropic.completeWithUsage).toHaveBeenCalled();
	});

	it('classify() uses fast tier provider', async () => {
		const provider = createMockProvider('anthropic', 'grocery|0.9');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.classify('add milk', ['grocery', 'fitness']);

		expect(result).toBeDefined();
		expect(typeof result.category).toBe('string');
		expect(typeof result.confidence).toBe('number');
		// Verify it actually called the fast tier provider (not standard)
		expect(provider.complete).toHaveBeenCalled();
		expect(selector.getFastRef).toHaveBeenCalled();
	});

	it('modelRef takes priority over tier and legacy model', async () => {
		const openai = createMockProvider('openai', 'openai wins');
		const anthropic = createMockProvider('anthropic', 'anthropic loses');
		const registry = createMockRegistry({ anthropic, openai });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		// modelRef should win even when tier and model are also set
		const result = await service.complete('test', {
			modelRef: { provider: 'openai', model: 'gpt-4o' },
			tier: 'standard',
			model: 'claude',
		});

		expect(result).toBe('openai wins');
		expect(openai.completeWithUsage).toHaveBeenCalled();
		expect(anthropic.completeWithUsage).not.toHaveBeenCalled();
	});

	it('ignores partial modelRef (missing provider)', async () => {
		const provider = createMockProvider('anthropic', 'fast fallback');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		// modelRef with empty provider should fall through to default (fast tier)
		const result = await service.complete('test', {
			modelRef: { provider: '', model: 'gpt-4o' },
		});

		expect(result).toBe('fast fallback');
		expect(selector.getFastRef).toHaveBeenCalled();
	});

	it('ignores partial modelRef (missing model)', async () => {
		const provider = createMockProvider('anthropic', 'fast fallback');
		const registry = createMockRegistry({ anthropic: provider });
		const selector = createMockSelector();

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		const result = await service.complete('test', {
			modelRef: { provider: 'openai', model: '' },
		});

		expect(result).toBe('fast fallback');
		expect(selector.getFastRef).toHaveBeenCalled();
	});

	it('getFastClient throws when fast tier provider is not registered', async () => {
		const registry = createMockRegistry({});
		const selector = createMockSelector({
			fast: { provider: 'missing-provider', model: 'some-model' },
		});

		const service = new LLMServiceImpl({
			registry,
			modelSelector: selector,
			costTracker: createMockCostTracker(),
			logger,
		});

		await expect(service.classify('test', ['a', 'b'])).rejects.toThrow(/not registered/);
	});
});
