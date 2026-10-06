import { APIUserAbortError } from 'openai';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the `openai` SDK ---

const mockChatCreate = vi.fn();
const mockModelsList = vi.fn();

const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('openai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('openai')>();
	class MockOpenAI {
		chat = { completions: { create: mockChatCreate } };
		models = { list: mockModelsList };
		constructor(opts: Record<string, unknown>) {
			constructorCalls.push(opts);
		}
	}
	return { ...actual, default: MockOpenAI };
});

import type { ChatMessage } from '../../../types/llm.js';
import { classifyLLMError } from '../../../utils/llm-errors.js';
import { LLMEmptyOutputError, LLMToolsUnsupportedError } from '../errors.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider(overrides: { supportsTools?: boolean; defaultModel?: string } = {}) {
	return new OpenAICompatibleProvider({
		providerId: 'openai',
		apiKey: 'sk-test',
		defaultModel: overrides.defaultModel ?? 'gpt-4o-mini',
		logger,
		costTracker: makeCostTracker() as never,
		...(overrides.supportsTools !== undefined ? { supportsTools: overrides.supportsTools } : {}),
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

const LOOKUP_TOOL = {
	name: 'lookup_receipt_total',
	description: 'Total of the most recent receipt for a store.',
	inputSchema: { type: 'object', properties: { store: { type: 'string' } }, required: ['store'] },
};
const USER: ChatMessage[] = [{ role: 'user', content: 'Costco total?' }];

function chatCompletion(overrides: Record<string, unknown> = {}) {
	return {
		choices: [
			{ message: { role: 'assistant', content: 'It was $113.42.' }, finish_reason: 'stop' },
		],
		usage: { prompt_tokens: 40, completion_tokens: 9 },
		...overrides,
	};
}

describe('OpenAICompatibleProvider — chat with tools (REQ-LLM-047)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue(chatCompletion());
	});

	it('supportsTools defaults to true for openai-compatible', async () => {
		await expect(makeProvider().supportsTools('gpt-4.1')).resolves.toBe(true);
	});

	it('supportsTools follows the config flag when set', async () => {
		await expect(makeProvider({ supportsTools: false }).supportsTools('gpt-4.1')).resolves.toBe(
			false,
		);
		await expect(
			makeProvider({ supportsTools: false }).chatWithUsage(USER, { tools: [LOOKUP_TOOL] }),
		).rejects.toBeInstanceOf(LLMToolsUnsupportedError);
		expect(mockChatCreate).not.toHaveBeenCalled();
	});

	it('sends tools as function tools, parallel_tool_calls default true, and the signal as request option', async () => {
		const controller = new AbortController();
		await makeProvider().chatWithUsage(USER, {
			tools: [LOOKUP_TOOL],
			signal: controller.signal,
			maxTokens: 200,
		});
		const [body, reqOpts] = mockChatCreate.mock.calls[0] as [
			Record<string, unknown>,
			{ signal?: AbortSignal },
		];
		expect(body.tools).toEqual([
			{
				type: 'function',
				function: {
					name: LOOKUP_TOOL.name,
					description: LOOKUP_TOOL.description,
					parameters: LOOKUP_TOOL.inputSchema,
				},
			},
		]);
		expect(body.parallel_tool_calls).toBe(true);
		expect(body.max_tokens).toBe(200);
		expect(reqOpts.signal).toBe(controller.signal);
	});

	it('parallelToolCalls: false is forwarded; without tools parallel_tool_calls is omitted (the API rejects it)', async () => {
		await makeProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL], parallelToolCalls: false });
		expect((mockChatCreate.mock.calls[0]?.[0] as Record<string, unknown>).parallel_tool_calls).toBe(
			false,
		);
		vi.clearAllMocks();
		mockChatCreate.mockResolvedValue(chatCompletion());
		await makeProvider().chatWithUsage(USER);
		expect(mockChatCreate.mock.calls[0]?.[0]).not.toHaveProperty('parallel_tool_calls');
		expect(mockChatCreate.mock.calls[0]?.[0]).not.toHaveProperty('tools');
	});

	it('maps system/user/assistant(tool_calls)/tool messages to chat-completions shapes', async () => {
		const history: ChatMessage[] = [
			{ role: 'system', content: 'Use tools.' },
			...USER,
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 'lookup_receipt_total', arguments: { store: 'Costco' } }],
			},
			{
				role: 'tool',
				content: '{"total":113.42}',
				toolCallId: 'call_1',
				toolName: 'lookup_receipt_total',
			},
		];
		await makeProvider().chatWithUsage(history, { tools: [LOOKUP_TOOL] });
		expect((mockChatCreate.mock.calls[0]?.[0] as Record<string, unknown>).messages).toEqual([
			{ role: 'system', content: 'Use tools.' },
			{ role: 'user', content: 'Costco total?' },
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'lookup_receipt_total', arguments: '{"store":"Costco"}' },
					},
				],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: '{"total":113.42}' },
		]);
	});

	it('sends user images as data URLs in content parts', async () => {
		const png = Buffer.from([1, 2, 3]);
		await makeProvider().chatWithUsage([
			{ role: 'user', content: 'receipt', images: [{ data: png, mimeType: 'image/png' }] },
		]);
		const messages = (
			mockChatCreate.mock.calls[0]?.[0] as { messages: Array<{ content: unknown }> }
		).messages;
		expect(messages[0]?.content).toEqual([
			{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
			{ type: 'text', text: 'receipt' },
		]);
	});

	it('returns tool calls with parsed JSON arguments and finishReason tool_calls', async () => {
		mockChatCreate.mockResolvedValue(
			chatCompletion({
				choices: [
					{
						message: {
							role: 'assistant',
							content: null,
							tool_calls: [
								{
									id: 'call_x',
									type: 'function',
									function: { name: 'lookup_receipt_total', arguments: '{"store":"Costco"}' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		const result = await makeProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.finishReason).toBe('tool_calls');
		expect(result.message.content).toBe('');
		expect(result.message.toolCalls).toEqual([
			{ id: 'call_x', name: 'lookup_receipt_total', arguments: { store: 'Costco' } },
		]);
		expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
	});

	it('keeps unparseable argument strings raw (P2 validates)', async () => {
		mockChatCreate.mockResolvedValue(
			chatCompletion({
				choices: [
					{
						message: {
							role: 'assistant',
							content: null,
							tool_calls: [
								{
									id: 'c',
									type: 'function',
									function: { name: 'lookup_receipt_total', arguments: '{oops' },
								},
							],
						},
						finish_reason: 'tool_calls',
					},
				],
			}),
		);
		const result = await makeProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.message.toolCalls?.[0]?.arguments).toBe('{oops');
	});

	it('maps finish_reason length/content_filter/unknown and keeps reasoning_content out of the answer', async () => {
		mockChatCreate.mockResolvedValue(
			chatCompletion({
				choices: [
					{
						message: { role: 'assistant', content: 'x', reasoning_content: 'thinking…' },
						finish_reason: 'content_filter',
					},
				],
			}),
		);
		const result = await makeProvider().chatWithUsage(USER);
		expect(result.finishReason).toBe('error');
		expect(result.message.content).toBe('x');
		expect(result.message.thinking).toBeUndefined();
	});

	it('empty content + no tool calls + length throws LLMEmptyOutputError carrying usage', async () => {
		mockChatCreate.mockResolvedValue(
			chatCompletion({
				choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
				usage: { prompt_tokens: 100, completion_tokens: 64 },
			}),
		);
		const err = await makeProvider()
			.chatWithUsage(USER, { maxTokens: 64 })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LLMEmptyOutputError);
		expect((err as LLMEmptyOutputError).usage).toEqual({ inputTokens: 100, outputTokens: 64 });
	});

	it('completeWithUsage: the existing empty-output throw now carries usage too (REQ-LLM-051)', async () => {
		mockChatCreate.mockResolvedValue(
			chatCompletion({
				choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
				usage: { prompt_tokens: 11, completion_tokens: 22 },
			}),
		);
		const err = await makeProvider()
			.completeWithUsage('p', { maxTokens: 22 })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LLMEmptyOutputError);
		expect((err as LLMEmptyOutputError).usage).toEqual({ inputTokens: 11, outputTokens: 22 });
	});

	it('o-series models get max_completion_tokens and no max_tokens on chat (R1-4; SDK 6.27 marks max_tokens incompatible with o-series)', async () => {
		await makeProvider().chatWithUsage(USER, {
			modelRef: { provider: 'openai', model: 'o4-mini' },
			maxTokens: 200,
		});
		const body = mockChatCreate.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(body.max_completion_tokens).toBe(200);
		expect(body).not.toHaveProperty('max_tokens');
	});

	it('non-o-series models keep max_tokens (OpenAI-compatible servers such as Groq/vLLM/llama-server accept only that field)', async () => {
		await makeProvider().chatWithUsage(USER, { maxTokens: 200 });
		const body = mockChatCreate.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(body.max_tokens).toBe(200);
		expect(body).not.toHaveProperty('max_completion_tokens');
	});

	it('complete() uses the same model-aware output-limit field (o3 → max_completion_tokens)', async () => {
		await makeProvider().completeWithUsage('p', {
			modelRef: { provider: 'openai', model: 'o3' },
			maxTokens: 50,
		});
		const body = mockChatCreate.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(body.max_completion_tokens).toBe(50);
		expect(body).not.toHaveProperty('max_tokens');
	});

	it('sdkMaxRetries is forwarded to the OpenAI client as maxRetries; absent → not passed (SDK default stays)', () => {
		constructorCalls.length = 0;
		new OpenAICompatibleProvider({
			providerId: 'openai',
			apiKey: 'sk-test',
			defaultModel: 'gpt-4o-mini',
			logger,
			costTracker: makeCostTracker() as never,
			sdkMaxRetries: 0,
		});
		expect(constructorCalls[0]).toMatchObject({ maxRetries: 0 });
		makeProvider();
		expect(constructorCalls[1]).not.toHaveProperty('maxRetries');
	});

	it('the real SDK APIUserAbortError (name "Error") is surfaced as the caller signal reason and never retried (P2-4)', async () => {
		const sdkError = new APIUserAbortError();
		expect(sdkError.name).toBe('Error'); // the claim this test exists for: the SDK does not name its abort error
		const controller = new AbortController();
		const reason = new Error('user cancelled');
		mockChatCreate.mockImplementation(async () => {
			controller.abort(reason);
			throw sdkError;
		});
		await expect(makeProvider().chatWithUsage(USER, { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(mockChatCreate).toHaveBeenCalledTimes(1);
	});

	it('the real SDK APIUserAbortError without a caller signal still becomes an AbortError (cause = the SDK error), not an "unknown" retried failure (P2-4)', async () => {
		const sdkError = new APIUserAbortError();
		mockChatCreate.mockRejectedValue(sdkError);
		const err = (await makeProvider()
			.chatWithUsage(USER)
			.catch((e: unknown) => e)) as Error & { cause?: unknown };
		expect(err.name).toBe('AbortError');
		expect(err.cause).toBe(sdkError);
		expect(mockChatCreate).toHaveBeenCalledTimes(1);
		expect(classifyLLMError(err).category).toBe('aborted');
	});
});
