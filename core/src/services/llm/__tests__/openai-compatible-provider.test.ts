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
		mockChatCreate.mockResolvedValue({
			choices: [],
			usage: { prompt_tokens: 0, completion_tokens: 0 },
		});
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

describe('OpenAICompatibleProvider — empty output after budget exhaustion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	/**
	 * The reasoning-model failure shape: LM Studio / vLLM / SGLang / llama-server
	 * put the chain of thought in the non-standard `reasoning_content` field and
	 * leave `content` empty once the cap is hit.
	 */
	function budgetBurnedInReasoning() {
		return {
			choices: [
				{
					message: { content: '', reasoning_content: 'x'.repeat(762) },
					finish_reason: 'length',
				},
			],
			usage: { prompt_tokens: 210, completion_tokens: 176 },
		};
	}

	it('throws a diagnostic naming the model, the budget and the reasoning length', async () => {
		mockChatCreate.mockResolvedValue(budgetBurnedInReasoning());
		const provider = makeProvider();

		const err = await provider
			.complete('classify this', { responseFormat: 'json', maxTokens: 176 })
			.then(
				() => null,
				(e: unknown) => e as Error,
			);

		expect(err).toBeInstanceOf(Error);
		expect(err?.name).toBe('LLMEmptyOutputError');
		expect(err?.message).toContain('gpt-4o-mini'); // the model
		expect(err?.message).toContain('openai'); // the provider
		expect(err?.message).toContain('176'); // the token cap
		expect(err?.message).toContain('762'); // the reasoning block length
	});

	it('names the provider default cap when the caller supplied none', async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '' }, finish_reason: 'length' }],
			usage: { prompt_tokens: 10, completion_tokens: 1024 },
		});
		const provider = makeProvider();
		await expect(provider.complete('hi')).rejects.toThrow(/1024/);
	});

	it('throws even when the model reports no reasoning block (empty + length is enough)', async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '   ' }, finish_reason: 'length' }],
			usage: { prompt_tokens: 10, completion_tokens: 80 },
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).rejects.toThrow(
			/returned empty output/i,
		);
	});

	it('still resolves to "" for empty content + finish_reason stop (callers retry that themselves)', async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 1 },
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).resolves.toBe('');
	});

	it('still resolves to "" for empty content + reasoning_content + finish_reason stop', async () => {
		// Reasoning text is NOT substituted for the answer: it is prose, and a
		// responseFormat:'json' caller would choke on it. Empty-on-stop stays ''.
		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: { content: '', reasoning_content: 'Let me think about this...' },
					finish_reason: 'stop',
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 40 },
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).resolves.toBe('');
	});

	it('ignores reasoning_content entirely when content is present', async () => {
		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: { content: '{"a":1}', reasoning_content: 'lots of deliberation here' },
					finish_reason: 'stop',
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 8 },
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi', { maxTokens: 80 });
		expect(result.text).toBe('{"a":1}');
		expect(result.finishReason).toBe('stop');
	});

	it('resolves normally for truncated-but-non-empty output (the oracle judges that)', async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: '{"a":1' }, finish_reason: 'length' }],
			usage: { prompt_tokens: 10, completion_tokens: 80 },
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi', { maxTokens: 80 });
		expect(result.text).toBe('{"a":1');
		expect(result.finishReason).toBe('length');
	});

	it('is attempted exactly once — the failure is deterministic, not transient', async () => {
		mockChatCreate.mockResolvedValue(budgetBurnedInReasoning());
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 176 })).rejects.toThrow(/empty output/i);
		expect(mockChatCreate).toHaveBeenCalledTimes(1);
	});
});

describe('OpenAICompatibleProvider — temperature capability gate', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue(makeChoicesResponse('stop'));
	});

	// MODEL_CAPABILITIES is keyed by model id, not by provider — OpenAI-compatible
	// gateways (OpenRouter, LiteLLM) proxy Anthropic model ids verbatim, so the
	// same gate has to apply on this transport.
	it('omits temperature entirely for a model that rejects it', async () => {
		const provider = makeProvider();
		await provider.complete('hi', {
			modelRef: { provider: 'openai', model: 'claude-opus-5' },
			temperature: 0,
		});

		const callArgs = mockChatCreate.mock.calls[0]?.[0];
		expect(callArgs).toMatchObject({ model: 'claude-opus-5' });
		expect(callArgs).not.toHaveProperty('temperature');
	});

	it('still sends temperature for a model that supports it', async () => {
		const provider = makeProvider();
		await provider.complete('hi', {
			modelRef: { provider: 'openai', model: 'claude-sonnet-4-6' },
			temperature: 0,
		});

		expect(mockChatCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'claude-sonnet-4-6', temperature: 0 }),
		);
	});

	it('still sends temperature for an unprobed model (default is supported)', async () => {
		const provider = makeProvider();
		await provider.complete('hi', { temperature: 0.7 });

		expect(mockChatCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'gpt-4o-mini', temperature: 0.7 }),
		);
	});
});
