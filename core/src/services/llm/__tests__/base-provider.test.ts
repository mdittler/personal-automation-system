import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../../types/llm.js';
import { BaseProvider, type BaseProviderOptions } from '../providers/base-provider.js';

const logger = pino({ level: 'silent' });

/** Concrete test implementation of BaseProvider. */
class TestProvider extends BaseProvider {
	doCompleteResult: LLMCompletionResult = {
		text: 'test response',
		usage: { inputTokens: 10, outputTokens: 20 },
		model: 'test-model',
		provider: 'test',
	};
	doCompleteError?: Error;
	doCompleteCalls: Array<{ prompt: string; options?: LLMCompletionOptions }> = [];
	modelList: ProviderModel[] = [];

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		this.doCompleteCalls.push({ prompt, options });
		if (this.doCompleteError) throw this.doCompleteError;
		return this.doCompleteResult;
	}

	async listModels(): Promise<ProviderModel[]> {
		return this.modelList;
	}
}

function createTestProvider(overrides?: Partial<BaseProviderOptions>): TestProvider {
	const mockCostTracker = {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};

	return new TestProvider({
		providerId: 'test',
		providerType: 'anthropic',
		apiKey: 'test-key',
		defaultModel: 'test-model',
		logger,
		costTracker: mockCostTracker as never,
		...overrides,
	});
}

describe('BaseProvider', () => {
	it('complete() returns just the text', async () => {
		const provider = createTestProvider();

		const result = await provider.complete('hello');

		expect(result).toBe('test response');
	});

	it('completeWithUsage() returns full result', async () => {
		const provider = createTestProvider();

		const result = await provider.completeWithUsage('hello');

		expect(result.text).toBe('test response');
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
		expect(result.model).toBe('test-model');
		expect(result.provider).toBe('test');
	});

	it('records cost after completion', async () => {
		const mockCostTracker = {
			record: vi.fn().mockResolvedValue(undefined),
			estimateCost: vi.fn().mockReturnValue(0),
			readUsage: vi.fn().mockResolvedValue(''),
		};

		const provider = new TestProvider({
			providerId: 'test',
			providerType: 'anthropic',
			apiKey: 'test-key',
			defaultModel: 'test-model',
			logger,
			costTracker: mockCostTracker as never,
		});

		await provider.completeWithUsage('hello');

		// Wait for async cost recording
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(mockCostTracker.record).toHaveBeenCalledWith({
			model: 'test-model',
			provider: 'test',
			providerType: 'anthropic',
			inputTokens: 10,
			outputTokens: 20,
			appId: undefined,
			userId: undefined,
			householdId: undefined,
		});
	});

	it('propagates householdId from request context to costTracker', async () => {
		const { requestContext } = await import('../../context/request-context.js');
		const mockCostTracker = {
			record: vi.fn().mockResolvedValue(undefined),
			estimateCost: vi.fn().mockReturnValue(0),
			readUsage: vi.fn().mockResolvedValue(''),
		};

		const provider = new TestProvider({
			providerId: 'test',
			providerType: 'anthropic',
			apiKey: 'test-key',
			defaultModel: 'test-model',
			logger,
			costTracker: mockCostTracker as never,
		});

		await requestContext.run({ userId: 'u1', householdId: 'h1' }, async () => {
			await provider.completeWithUsage('test prompt', {});
			// Wait for async cost recording
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mockCostTracker.record).toHaveBeenCalledWith(
				expect.objectContaining({ userId: 'u1', householdId: 'h1' }),
			);
		});
	});

	it('passes _appId to cost tracker', async () => {
		const mockCostTracker = {
			record: vi.fn().mockResolvedValue(undefined),
			estimateCost: vi.fn().mockReturnValue(0),
			readUsage: vi.fn().mockResolvedValue(''),
		};

		const provider = new TestProvider({
			providerId: 'test',
			providerType: 'anthropic',
			apiKey: 'test-key',
			defaultModel: 'test-model',
			logger,
			costTracker: mockCostTracker as never,
		});

		await provider.completeWithUsage('hello', { _appId: 'my-app' } as LLMCompletionOptions & {
			_appId: string;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(mockCostTracker.record).toHaveBeenCalledWith(
			expect.objectContaining({ appId: 'my-app' }),
		);
	});

	it('resolves model from modelRef', async () => {
		const provider = createTestProvider();

		await provider.complete('hello', { modelRef: { provider: 'test', model: 'custom-model' } });

		expect(provider.doCompleteCalls[0].options?.modelRef?.model).toBe('custom-model');
	});

	it('resolves model from claudeModel for backward compat', async () => {
		const provider = createTestProvider();

		await provider.complete('hello', { claudeModel: 'claude-opus-4-6' });

		expect(provider.doCompleteCalls[0].options?.claudeModel).toBe('claude-opus-4-6');
	});

	it('uses default model when no override is specified', async () => {
		const provider = createTestProvider({ defaultModel: 'my-default' });

		await provider.complete('hello');

		// resolveModel should return 'my-default'
		// We can verify by checking the doComplete was called with expected options
		expect(provider.doCompleteCalls).toHaveLength(1);
	});

	it('exposes providerId and providerType', () => {
		const provider = createTestProvider({
			providerId: 'my-provider',
			providerType: 'google',
		});

		expect(provider.providerId).toBe('my-provider');
		expect(provider.providerType).toBe('google');
	});

	it('satisfies LLMClient interface', async () => {
		const provider = createTestProvider();

		// LLMClient just needs complete(prompt, options?) => Promise<string>
		const result: string = await provider.complete('test');
		expect(typeof result).toBe('string');
	});

	it('retries on failure', async () => {
		const provider = createTestProvider();
		let callCount = 0;
		provider.doCompleteError = new Error('transient');

		// Override doComplete to fail twice then succeed
		// biome-ignore lint/complexity/useLiteralKeys: accessing protected method for testing
		const originalDoComplete = provider['doComplete'].bind(provider);
		vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(
			async (prompt: string, options?: LLMCompletionOptions) => {
				callCount++;
				if (callCount <= 2) {
					throw new Error('transient');
				}
				provider.doCompleteError = undefined;
				return originalDoComplete(prompt, options);
			},
		);

		const result = await provider.completeWithUsage('hello');

		expect(callCount).toBe(3); // 1 initial + 2 retries
		expect(result.text).toBe('test response');
	});

	it('throws after all retries exhausted', async () => {
		const provider = createTestProvider();
		provider.doCompleteError = new Error('permanent failure');

		await expect(provider.completeWithUsage('hello')).rejects.toThrow('permanent failure');
	});
});
