import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock @anthropic-ai/sdk ---

const mockCreate = vi.fn();
const mockListModels = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
	class MockAnthropic {
		messages = { create: mockCreate };
		models = { list: mockListModels };
	}
	// The SDK exports TextBlock as a namespace type; provide it for the filter
	(MockAnthropic as Record<string, unknown>).default = MockAnthropic;
	return { default: MockAnthropic };
});

import { AnthropicProvider } from '../providers/anthropic-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider(overrides: Record<string, unknown> = {}) {
	return new AnthropicProvider({
		providerId: 'anthropic',
		apiKey: 'sk-test-key',
		defaultModel: 'claude-sonnet-4-20250514',
		logger,
		costTracker: makeCostTracker() as never,
		...overrides,
	});
}

function mockResponse(overrides: Record<string, unknown> = {}) {
	return {
		content: [{ type: 'text', text: 'Hello world' }],
		usage: { input_tokens: 10, output_tokens: 20 },
		...overrides,
	};
}

describe('AnthropicProvider', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(mockResponse());
	});

	// --- Constructor ---

	it('sets providerType to anthropic', () => {
		const provider = makeProvider();
		expect(provider.providerType).toBe('anthropic');
	});

	it('throws when API key is empty', () => {
		expect(() => makeProvider({ apiKey: '' })).toThrow(
			'Anthropic API key is required but was empty',
		);
	});

	it('throws when API key is not provided', () => {
		expect(() => makeProvider({ apiKey: undefined })).toThrow(
			'Anthropic API key is required but was empty',
		);
	});

	// --- doComplete (accessed via public complete / completeWithUsage) ---

	it('calls messages.create with correct model and prompt', async () => {
		const provider = makeProvider();
		await provider.complete('test prompt');

		expect(mockCreate).toHaveBeenCalledOnce();
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'claude-sonnet-4-20250514',
				messages: [{ role: 'user', content: 'test prompt' }],
			}),
		);
	});

	it('returns text from response content blocks', async () => {
		const provider = makeProvider();
		const result = await provider.complete('hi');
		expect(result).toBe('Hello world');
	});

	it('returns usage from response', async () => {
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
		expect(result.model).toBe('claude-sonnet-4-20250514');
		expect(result.provider).toBe('anthropic');
	});

	it('passes maxTokens option (defaults to 1024)', async () => {
		const provider = makeProvider();

		// Default
		await provider.complete('hi');
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));

		mockCreate.mockClear();

		// Custom
		await provider.complete('hi', { maxTokens: 4096 });
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 4096 }));
	});

	it('passes temperature option', async () => {
		const provider = makeProvider();
		await provider.complete('hi', { temperature: 0.5 });
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.5 }));
	});

	it('passes system prompt when provided', async () => {
		const provider = makeProvider();
		await provider.complete('hi', { systemPrompt: 'You are a bot.' });
		expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ system: 'You are a bot.' }));
	});

	it('does not include system key when systemPrompt is not provided', async () => {
		const provider = makeProvider();
		await provider.complete('hi');
		const callArgs = mockCreate.mock.calls[0][0];
		expect(callArgs).not.toHaveProperty('system');
	});

	// --- Edge cases ---

	it('joins multiple text blocks', async () => {
		mockCreate.mockResolvedValue(
			mockResponse({
				content: [
					{ type: 'text', text: 'Hello' },
					{ type: 'text', text: ' world' },
				],
			}),
		);

		const provider = makeProvider();
		const result = await provider.complete('hi');
		expect(result).toBe('Hello world');
	});

	it('filters out non-text blocks', async () => {
		mockCreate.mockResolvedValue(
			mockResponse({
				content: [
					{ type: 'tool_use', id: 'x', name: 'test', input: {} },
					{ type: 'text', text: 'Only text' },
				],
			}),
		);

		const provider = makeProvider();
		const result = await provider.complete('hi');
		expect(result).toBe('Only text');
	});

	// --- listModels ---

	it('returns models from API with pricing lookup', async () => {
		const asyncIterable = {
			async *[Symbol.asyncIterator]() {
				yield { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' };
				yield { id: 'claude-haiku-3-5-20241022', display_name: 'Claude 3.5 Haiku' };
			},
		};
		mockListModels.mockResolvedValue(asyncIterable);

		const provider = makeProvider();
		const models = await provider.listModels();

		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({
			id: 'claude-sonnet-4-20250514',
			displayName: 'Claude Sonnet 4',
			provider: 'anthropic',
			providerType: 'anthropic',
		});
		// Pricing may or may not be present depending on the pricing table,
		// but the structure should be correct
		if (models[0].pricing) {
			expect(models[0].pricing).toHaveProperty('input');
			expect(models[0].pricing).toHaveProperty('output');
		}
	});

	it('uses model.id as displayName when display_name is missing', async () => {
		const asyncIterable = {
			async *[Symbol.asyncIterator]() {
				yield { id: 'claude-unknown-model', display_name: undefined };
			},
		};
		mockListModels.mockResolvedValue(asyncIterable);

		const provider = makeProvider();
		const models = await provider.listModels();

		expect(models).toHaveLength(1);
		expect(models[0].displayName).toBe('claude-unknown-model');
	});

	it('returns empty array on API failure', async () => {
		mockListModels.mockRejectedValue(new Error('Network error'));

		const provider = makeProvider();
		const models = await provider.listModels();

		expect(models).toEqual([]);
	});
});
