import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type {
	ChatMessage,
	ChatOptions,
	ChatResult,
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../../types/llm.js';
import { LLMEmptyOutputError, LLMToolsUnsupportedError } from '../errors.js';
import { BaseProvider, type BaseProviderOptions } from '../providers/base-provider.js';

const logger = pino({ level: 'silent' });

/** Concrete test implementation of BaseProvider. */
class TestProvider extends BaseProvider {
	doCompleteResult: LLMCompletionResult = {
		text: 'test response',
		usage: { inputTokens: 10, outputTokens: 20 },
		model: 'test-model',
		provider: 'test',
		finishReason: 'stop',
	};
	doCompleteError?: Error;
	doCompleteCalls: Array<{ prompt: string; options?: LLMCompletionOptions }> = [];
	modelList: ProviderModel[] = [];
	doChatResult: ChatResult = {
		message: { role: 'assistant', content: 'chat response' },
		finishReason: 'stop',
		usage: { inputTokens: 7, outputTokens: 3 },
		model: 'test-model',
		provider: 'test',
	};
	doChatError?: Error;
	doChatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }> = [];
	/** A boolean, or a promise (to script a slow / never-settling probe). */
	toolsSupported: boolean | Promise<boolean> = true;
	/**
	 * `undefined` (the default) leaves the base `supportsVisionModel` in place —
	 * i.e. the provider-wide `supportsVision` flag, `false` on TestProvider — so
	 * the "default vision gate" test exercises the real base behaviour (P2-3).
	 * Set it to script a per-model answer.
	 */
	visionModelSupported: boolean | undefined = undefined;

	protected override async doChat(
		messages: ChatMessage[],
		options?: ChatOptions,
	): Promise<ChatResult> {
		this.doChatCalls.push({ messages, options });
		if (this.doChatError) throw this.doChatError;
		return this.doChatResult;
	}

	override supportsTools(): Promise<boolean> {
		return Promise.resolve(this.toolsSupported);
	}

	override supportsVisionModel(modelId: string): Promise<boolean> {
		return this.visionModelSupported === undefined
			? super.supportsVisionModel(modelId)
			: Promise.resolve(this.visionModelSupported);
	}

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

	describe('temperature strip-and-retry fallback', () => {
		/** Mimics the SDK error shape: a 400 whose message names the parameter. */
		function temperatureRejection(): Error {
			return Object.assign(new Error('`temperature` is deprecated for this model.'), {
				status: 400,
			});
		}

		it('retries once without temperature when the model rejects the parameter', async () => {
			const provider = createTestProvider({ defaultModel: 'model-that-rejects' });
			const seen: Array<number | undefined> = [];

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(
				async (_prompt: string, options?: LLMCompletionOptions) => {
					seen.push(options?.temperature);
					if (options?.temperature !== undefined) throw temperatureRejection();
					return provider.doCompleteResult;
				},
			);

			const result = await provider.completeWithUsage('hello', { temperature: 0 });

			expect(result.text).toBe('test response');
			// First attempt carries temperature; the strip-and-retry attempt does not.
			// No exponential backoff burn in between — the 400 is non-retryable.
			expect(seen).toEqual([0, undefined]);
		});

		it('does not swallow the error when the retry without temperature also fails', async () => {
			const provider = createTestProvider();

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				throw temperatureRejection();
			});

			await expect(provider.completeWithUsage('hello', { temperature: 0 })).rejects.toThrow(
				'`temperature` is deprecated for this model.',
			);
		});

		it('does not retry when no temperature was requested', async () => {
			const provider = createTestProvider();
			let calls = 0;

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				calls++;
				throw temperatureRejection();
			});

			await expect(provider.completeWithUsage('hello')).rejects.toThrow('is deprecated');
			expect(calls).toBe(1);
		});

		it('rethrows unrelated errors unchanged without stripping temperature', async () => {
			const provider = createTestProvider();
			let calls = 0;

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				calls++;
				throw Object.assign(new Error('Invalid request format'), { status: 400 });
			});

			await expect(provider.completeWithUsage('hello', { temperature: 0 })).rejects.toThrow(
				'Invalid request format',
			);
			// 1 initial + 2 retries from withRetry; no strip-and-retry pass on top.
			expect(calls).toBe(3);
		});

		it('does not strip temperature for a 400 naming a different parameter', async () => {
			const provider = createTestProvider();
			let calls = 0;

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				calls++;
				throw Object.assign(new Error('Unsupported parameter: `top_k` for this model.'), {
					status: 400,
				});
			});

			await expect(provider.completeWithUsage('hello', { temperature: 0 })).rejects.toThrow(
				'top_k',
			);
			expect(calls).toBe(1);
		});
	});

	describe('empty-output errors are not retried', () => {
		/** Mirrors LLMEmptyOutputError's shape without importing the provider layer. */
		function emptyOutput(): Error {
			return Object.assign(
				new Error(
					"Model 'qwen3.8:27b-mlx' returned empty output after exhausting its num_predict budget of 80 token(s).",
				),
				{ name: 'LLMEmptyOutputError' },
			);
		}

		it('is attempted exactly once — exhausting the same budget again cannot help', async () => {
			const provider = createTestProvider();
			let calls = 0;

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				calls++;
				throw emptyOutput();
			});

			await expect(provider.completeWithUsage('hello')).rejects.toThrow(/empty output/i);
			expect(calls).toBe(1);
		});

		it('is not retried even when a temperature was requested (no strip-and-retry pass)', async () => {
			const provider = createTestProvider();
			let calls = 0;

			vi.spyOn(provider as never, 'doComplete' as never).mockImplementation(async () => {
				calls++;
				throw emptyOutput();
			});

			await expect(provider.completeWithUsage('hello', { temperature: 0 })).rejects.toThrow(
				/empty output/i,
			);
			expect(calls).toBe(1);
		});
	});
});

const USER_HI: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const ONE_TOOL = [{ name: 'lookup', description: 'd', inputSchema: { type: 'object' } }];

describe('BaseProvider.chatWithUsage (REQ-LLM-045)', () => {
	it('returns the doChat result and records usage with provider type and app id', async () => {
		const provider = createTestProvider();
		const result = await provider.chatWithUsage(USER_HI, { _appId: 'food' });
		expect(result.message.content).toBe('chat response');
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'test-model',
				provider: 'test',
				providerType: 'anthropic',
				inputTokens: 7,
				outputTokens: 3,
				appId: 'food',
			}),
		);
	});

	it('does not record usage when the provider reported none', async () => {
		const provider = createTestProvider();
		provider.doChatResult = { ...provider.doChatResult, usage: undefined };
		await provider.chatWithUsage(USER_HI);
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).not.toHaveBeenCalled();
	});

	it('rejects a malformed history before calling doChat', async () => {
		const provider = createTestProvider();
		await expect(
			provider.chatWithUsage([{ role: 'tool', content: 'x', toolCallId: 'call_1' }]),
		).rejects.toThrow(/must directly follow/);
		expect(provider.doChatCalls).toHaveLength(0);
	});

	it('retries transient doChat failures with the provider retry options', async () => {
		const provider = createTestProvider();
		let calls = 0;
		provider.doChatError = Object.assign(new Error('503 upstream'), { status: 503 });
		const original = provider.doChatResult;
		// Fail once, then succeed.
		(provider as never as { doChat: unknown }).doChat = async (
			messages: ChatMessage[],
			options?: ChatOptions,
		) => {
			provider.doChatCalls.push({ messages, options });
			calls++;
			if (calls === 1) throw provider.doChatError;
			return original;
		};
		const result = await provider.chatWithUsage(USER_HI);
		expect(result.message.content).toBe('chat response');
		expect(calls).toBe(2);
	});
});

describe('BaseProvider.chatWithUsage — capability gates (REQ-LLM-049)', () => {
	it('throws LLMToolsUnsupportedError before doChat when tools are given and the model lacks them', async () => {
		const provider = createTestProvider();
		provider.toolsSupported = false;
		await expect(provider.chatWithUsage(USER_HI, { tools: ONE_TOOL })).rejects.toBeInstanceOf(
			LLMToolsUnsupportedError,
		);
		expect(provider.doChatCalls).toHaveLength(0);
	});

	it('does not consult supportsTools when no tools are passed (plain chat works on any model)', async () => {
		const provider = createTestProvider();
		provider.toolsSupported = false;
		await expect(provider.chatWithUsage(USER_HI)).resolves.toBeDefined();
	});

	it('an empty tools array is treated as no tools', async () => {
		const provider = createTestProvider();
		provider.toolsSupported = false;
		await expect(provider.chatWithUsage(USER_HI, { tools: [] })).resolves.toBeDefined();
	});

	it('the default supportsTools is false and the default doChat throws a clear not-implemented error', async () => {
		class BareProvider extends BaseProvider {
			protected async doComplete(): Promise<LLMCompletionResult> {
				return { text: '', model: 'm', provider: 'bare', finishReason: 'stop' };
			}
			async listModels(): Promise<ProviderModel[]> {
				return [];
			}
		}
		const bare = new BareProvider({
			providerId: 'bare',
			providerType: 'google',
			apiKey: 'k',
			defaultModel: 'm',
			logger,
			costTracker: { record: vi.fn() } as never,
		});
		await expect(bare.supportsTools('m')).resolves.toBe(false);
		await expect(bare.chatWithUsage(USER_HI)).rejects.toThrow(
			/Provider 'bare' \(google\) does not implement chat\(\)/,
		);
	});
});

describe('BaseProvider.chatWithUsage — vision gate (REQ-LLM-046)', () => {
	const IMAGE_MSG: ChatMessage[] = [
		{
			role: 'user',
			content: 'what is this?',
			images: [{ data: Buffer.from('x'), mimeType: 'image/png' }],
		},
	];

	it('rejects images when the provider does not support vision at all (default supportsVisionModel = provider flag)', async () => {
		const provider = createTestProvider(); // supportsVision = false on TestProvider; visionModelSupported stays undefined so the base default answers (P2-3)
		await expect(provider.chatWithUsage(IMAGE_MSG)).rejects.toThrow(
			/Model 'test-model' on provider test does not support vision/,
		);
		expect(provider.doChatCalls).toHaveLength(0);
	});

	it('the chat gate is per model only: complete() keeps the provider-wide gate and its message (R1-2)', async () => {
		const provider = createTestProvider();
		await expect(
			provider.completeWithUsage('x', {
				images: [{ data: Buffer.from('x'), mimeType: 'image/png' }],
			}),
		).rejects.toThrow(/Provider test does not support vision/);
	});

	it('rejects images when the provider supports vision but the model does not', async () => {
		class VisionTestProvider extends TestProvider {
			override readonly supportsVision = true;
		}
		const provider = new VisionTestProvider({
			providerId: 'test',
			providerType: 'ollama',
			apiKey: '',
			defaultModel: 'gemma4:e4b',
			logger,
			costTracker: { record: vi.fn() } as never,
		});
		provider.visionModelSupported = false;
		await expect(provider.chatWithUsage(IMAGE_MSG)).rejects.toThrow(
			/Model 'gemma4:e4b' on provider test does not support vision/,
		);
		expect(provider.doChatCalls).toHaveLength(0);
	});

	it('rejects an unsupported image MIME type', async () => {
		class VisionTestProvider extends TestProvider {
			override readonly supportsVision = true;
		}
		const provider = new VisionTestProvider({
			providerId: 'test',
			providerType: 'anthropic',
			apiKey: 'k',
			defaultModel: 'm',
			logger,
			costTracker: { record: vi.fn() } as never,
		});
		await expect(
			provider.chatWithUsage([
				{ role: 'user', content: 'x', images: [{ data: Buffer.from('x'), mimeType: 'image/bmp' }] },
			]),
		).rejects.toThrow(/Unsupported image MIME type: image\/bmp/);
	});
});

describe('BaseProvider.chatWithUsage — AbortSignal (REQ-LLM-050)', () => {
	it('throws the signal reason immediately when the signal is already aborted, without calling doChat', async () => {
		const provider = createTestProvider();
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.chatWithUsage(USER_HI, { signal: controller.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(provider.doChatCalls).toHaveLength(0);
	});

	it('never retries an aborted call', async () => {
		const provider = createTestProvider();
		provider.doChatError = new DOMException('The operation was aborted', 'AbortError');
		await expect(provider.chatWithUsage(USER_HI)).rejects.toMatchObject({ name: 'AbortError' });
		expect(provider.doChatCalls).toHaveLength(1);
	});

	it('an SDK-shaped abort (name "Error") thrown after the caller signal fired is not retried and surfaces as the signal reason (P2-4)', async () => {
		const provider = createTestProvider();
		const controller = new AbortController();
		const reason = new Error('user cancelled');
		// Mimic openai/@anthropic-ai/sdk APIUserAbortError: an Error whose name is just 'Error'.
		(provider as never as { doChat: unknown }).doChat = async (
			messages: ChatMessage[],
			options?: ChatOptions,
		) => {
			provider.doChatCalls.push({ messages, options });
			controller.abort(reason);
			throw new Error('Request was aborted.');
		};
		await expect(provider.chatWithUsage(USER_HI, { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(provider.doChatCalls).toHaveLength(1); // no retry: the predicate checks signal.aborted, not the name
	});

	it('a generic error thrown after the signal fired with no custom reason surfaces as an AbortError (P2-4)', async () => {
		const provider = createTestProvider();
		const controller = new AbortController();
		const original = new Error('fetch failed');
		(provider as never as { doChat: unknown }).doChat = async (
			messages: ChatMessage[],
			options?: ChatOptions,
		) => {
			provider.doChatCalls.push({ messages, options });
			controller.abort();
			throw original;
		};
		const err = (await provider
			.chatWithUsage(USER_HI, { signal: controller.signal })
			.catch((e: unknown) => e)) as Error & { cause?: unknown };
		expect(err.name).toBe('AbortError');
		expect(provider.doChatCalls).toHaveLength(1);
	});

	it('passes the signal through to doChat', async () => {
		const provider = createTestProvider();
		const controller = new AbortController();
		await provider.chatWithUsage(USER_HI, { signal: controller.signal });
		expect(provider.doChatCalls[0]?.options?.signal).toBe(controller.signal);
	});

	it('an abort while the capability probe is still pending rejects at once with AbortError and never reaches doChat (R1-6)', async () => {
		const provider = createTestProvider();
		provider.toolsSupported = new Promise<boolean>(() => {}); // a probe that never settles (cold Ollama, 120 s timeout)
		const controller = new AbortController();
		const call = provider.chatWithUsage(USER_HI, { tools: ONE_TOOL, signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		await expect(call).rejects.toMatchObject({ name: 'AbortError' });
		expect(provider.doChatCalls).toHaveLength(0);
	});
});

describe('BaseProvider records usage from a failed call (REQ-LLM-051)', () => {
	it('completeWithUsage: an LLMEmptyOutputError carrying usage is recorded, then rethrown', async () => {
		const provider = createTestProvider({ providerType: 'openai-compatible' });
		provider.doCompleteError = new LLMEmptyOutputError({
			provider: 'test',
			model: 'test-model',
			maxTokens: 64,
			usage: { inputTokens: 120, outputTokens: 64 },
		});
		await expect(provider.completeWithUsage('p', { _appId: 'food' })).rejects.toBeInstanceOf(
			LLMEmptyOutputError,
		);
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				inputTokens: 120,
				outputTokens: 64,
				appId: 'food',
				providerType: 'openai-compatible',
			}),
		);
	});

	it('chatWithUsage: same — usage on the error is charged exactly once', async () => {
		const provider = createTestProvider();
		provider.doChatError = new LLMEmptyOutputError({
			provider: 'test',
			model: 'test-model',
			usage: { inputTokens: 10, outputTokens: 5 },
		});
		await expect(provider.chatWithUsage(USER_HI)).rejects.toBeInstanceOf(LLMEmptyOutputError);
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ inputTokens: 10, outputTokens: 5 }),
		);
	});

	it('an LLMEmptyOutputError without usage records nothing (regression guard: no phantom zero rows)', async () => {
		const provider = createTestProvider();
		provider.doCompleteError = new LLMEmptyOutputError({ provider: 'test', model: 'test-model' });
		await expect(provider.completeWithUsage('p')).rejects.toBeInstanceOf(LLMEmptyOutputError);
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).not.toHaveBeenCalled();
	});

	it('a generic provider error records nothing (there is no usage to charge)', async () => {
		const provider = createTestProvider();
		provider.doCompleteError = Object.assign(new Error('400 bad'), { status: 400 });
		await expect(provider.completeWithUsage('p')).rejects.toThrow('400 bad');
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).not.toHaveBeenCalled();
	});
});
