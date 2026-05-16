import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the `openai` SDK (LlamaCppProvider reuses it via inheritance) ---

const mockChatCreate = vi.fn();
const mockModelsList = vi.fn();
const mockOpenAIConstructor = vi.fn();

vi.mock('openai', () => {
	class MockOpenAI {
		chat = { completions: { create: mockChatCreate } };
		models = { list: mockModelsList };
		constructor(options: unknown) {
			mockOpenAIConstructor(options);
		}
	}
	return { default: MockOpenAI };
});

import { LlamaCppProvider } from '../providers/llama-cpp-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider(overrides: Partial<{ defaultModel: string; baseUrl: string }> = {}) {
	return new LlamaCppProvider({
		providerId: 'llama-cpp',
		defaultModel: overrides.defaultModel ?? 'local-model',
		logger,
		costTracker: makeCostTracker() as never,
		baseUrl: overrides.baseUrl ?? 'http://localhost:8080',
	});
}

describe('LlamaCppProvider — construction (REQ-LLM-LLAMA-CPP-001)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('constructs without an API key', () => {
		expect(() => makeProvider()).not.toThrow();
	});

	it('reports providerType = "llama-cpp"', () => {
		const provider = makeProvider();
		expect(provider.providerType).toBe('llama-cpp');
	});

	it('reports the configured providerId', () => {
		const provider = makeProvider();
		expect(provider.providerId).toBe('llama-cpp');
	});

	it('passes baseURL and a non-empty sentinel key to the OpenAI SDK (REQ-LLM-LLAMA-CPP-002)', () => {
		makeProvider({ baseUrl: 'http://localhost:8080' });
		expect(mockOpenAIConstructor).toHaveBeenCalledTimes(1);
		const opts = mockOpenAIConstructor.mock.calls[0]?.[0] as { apiKey: string; baseURL: string };
		expect(opts.baseURL).toBe('http://localhost:8080');
		expect(opts.apiKey).toBeTruthy();
		expect(opts.apiKey.length).toBeGreaterThan(0);
	});
});

describe('LlamaCppProvider — chat completions (REQ-LLM-LLAMA-CPP-003, REQ-LLM-LLAMA-CPP-004)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 6 },
		});
	});

	it('returns response text and provider id', async () => {
		const provider = makeProvider();
		const result = await provider.completeWithUsage('classify this');
		expect(result.text).toBe('{"ok":true}');
		expect(result.provider).toBe('llama-cpp');
	});

	it("sets response_format: {type:'json_object'} when responseFormat is 'json'", async () => {
		const provider = makeProvider();
		await provider.complete('classify', { responseFormat: 'json' });
		expect(mockChatCreate).toHaveBeenCalledTimes(1);
		expect(mockChatCreate.mock.calls[0]?.[0]).toMatchObject({
			response_format: { type: 'json_object' },
		});
	});

	it('does NOT set response_format by default', async () => {
		const provider = makeProvider();
		await provider.complete('plain');
		const call = mockChatCreate.mock.calls[0]?.[0];
		expect(call).not.toHaveProperty('response_format');
	});

	it.each([
		['stop', 'stop'],
		['length', 'length'],
		['content_filter', 'error'],
	] as const)('maps finish_reason=%s → %s', async (input, expected) => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: 'hi' }, finish_reason: input }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe(expected);
	});
});

describe('LlamaCppProvider — listModels (REQ-LLM-LLAMA-CPP-005)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns the loaded model with no pricing', async () => {
		async function* iter() {
			yield { id: 'local-model' };
		}
		mockModelsList.mockResolvedValue(iter());

		const provider = makeProvider();
		const models = await provider.listModels();
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: 'local-model',
			displayName: 'local-model',
			provider: 'llama-cpp',
			providerType: 'llama-cpp',
			pricing: null,
		});
	});

	it('returns [] when the server is unreachable', async () => {
		mockModelsList.mockRejectedValue(new Error('ECONNREFUSED'));
		const provider = makeProvider();
		const models = await provider.listModels();
		expect(models).toEqual([]);
	});

	it('forces pricing=null even when the model name collides with a priced remote model', async () => {
		// A local GGUF served by llama-server as 'gpt-4.1' (or any other remote
		// model name) MUST NOT report paid pricing — llama.cpp is free local inference.
		async function* iter() {
			yield { id: 'gpt-4.1' };
			yield { id: 'claude-sonnet-4-6' };
			yield { id: 'gemini-2.5-pro' };
		}
		mockModelsList.mockResolvedValue(iter());

		const provider = makeProvider();
		const models = await provider.listModels();
		expect(models).toHaveLength(3);
		for (const model of models) {
			expect(model.pricing).toBeNull();
			expect(model.providerType).toBe('llama-cpp');
		}
	});
});
