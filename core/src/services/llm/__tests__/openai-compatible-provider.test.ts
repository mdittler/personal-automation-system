import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the `openai` SDK ---

const mockChatCreate = vi.fn();
const mockModelsList = vi.fn();

vi.mock('openai', () => {
	class MockOpenAI {
		chat = { completions: { create: mockChatCreate } };
		models = { list: mockModelsList };
	}
	return { default: MockOpenAI };
});

import { OpenAICompatibleProvider } from '../providers/openai-compatible-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider() {
	return new OpenAICompatibleProvider({
		providerId: 'openai',
		apiKey: 'sk-test',
		defaultModel: 'gpt-4o-mini',
		logger,
		costTracker: makeCostTracker() as never,
	});
}

function makeChoicesResponse(finishReason: string | null | undefined) {
	return {
		choices: [{ message: { content: 'hi' }, finish_reason: finishReason }],
		usage: { prompt_tokens: 12, completion_tokens: 6 },
	};
}

describe('OpenAICompatibleProvider — responseFormat plumbing (Batch 1)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 6 },
		});
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
});

describe('OpenAICompatibleProvider — finishReason mapping (REQ-FOOD-RECEIPT-INTEGRITY-003)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		['stop', 'stop'],
		['length', 'length'],
		['content_filter', 'error'],
		['tool_calls', 'other'],
		['function_call', 'other'],
	] as const)('maps finish_reason=%s → %s', async (input, expected) => {
		mockChatCreate.mockResolvedValue(makeChoicesResponse(input));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe(expected);
	});

	it('maps null finish_reason → other (in-progress / streaming sentinel)', async () => {
		mockChatCreate.mockResolvedValue(makeChoicesResponse(null));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	it('maps undefined finish_reason → other', async () => {
		mockChatCreate.mockResolvedValue(makeChoicesResponse(undefined));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	it('maps unknown finish_reason → other (forward-compat)', async () => {
		mockChatCreate.mockResolvedValue(makeChoicesResponse('some_future_value'));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	it('maps missing choices array → other', async () => {
		mockChatCreate.mockResolvedValue({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } });
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});
});

describe('OpenAICompatibleProvider — providerType override + llama-cpp dummy key (REQ-LLM-LLAMA-CPP-002)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
	});

	it('defaults providerType to openai-compatible when override is not supplied', () => {
		const provider = new OpenAICompatibleProvider({
			providerId: 'openai',
			apiKey: 'sk-test',
			defaultModel: 'gpt-4o-mini',
			logger,
			costTracker: makeCostTracker() as never,
		});
		expect(provider.providerType).toBe('openai-compatible');
	});

	it('uses the supplied providerType when override is "llama-cpp"', () => {
		const provider = new OpenAICompatibleProvider({
			providerId: 'llama-cpp',
			apiKey: '',
			defaultModel: 'local-model',
			logger,
			costTracker: makeCostTracker() as never,
			providerType: 'llama-cpp',
		});
		expect(provider.providerType).toBe('llama-cpp');
	});

	it('accepts empty apiKey when providerType is "llama-cpp" (no throw)', () => {
		expect(
			() =>
				new OpenAICompatibleProvider({
					providerId: 'llama-cpp',
					apiKey: '',
					defaultModel: 'local-model',
					logger,
					costTracker: makeCostTracker() as never,
					providerType: 'llama-cpp',
				}),
		).not.toThrow();
	});

	it('still throws on empty apiKey when providerType is "openai-compatible" (default)', () => {
		expect(
			() =>
				new OpenAICompatibleProvider({
					providerId: 'openai',
					apiKey: '',
					defaultModel: 'gpt-4o-mini',
					logger,
					costTracker: makeCostTracker() as never,
				}),
		).toThrow(/API key is required/);
	});

	it('completes a chat call with empty apiKey when providerType is "llama-cpp"', async () => {
		const provider = new OpenAICompatibleProvider({
			providerId: 'llama-cpp',
			apiKey: '',
			defaultModel: 'local-model',
			logger,
			costTracker: makeCostTracker() as never,
			providerType: 'llama-cpp',
		});
		const result = await provider.completeWithUsage('hi');
		expect(result.text).toBe('ok');
		expect(result.provider).toBe('llama-cpp');
	});
});
