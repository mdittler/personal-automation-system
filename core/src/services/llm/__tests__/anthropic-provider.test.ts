import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock @anthropic-ai/sdk ---

const mockCreate = vi.fn();
const mockListModels = vi.fn();

const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>();
	class MockAnthropic {
		messages = { create: mockCreate };
		models = { list: mockListModels };
		constructor(opts: Record<string, unknown>) {
			constructorCalls.push(opts);
		}
	}
	(MockAnthropic as Record<string, unknown>).default = MockAnthropic;
	return { ...actual, default: MockAnthropic };
});

import { APIUserAbortError } from '@anthropic-ai/sdk';
import type { ChatMessage } from '../../../types/llm.js';
import { classifyLLMError } from '../../../utils/llm-errors.js';
import { ChatMessageShapeError } from '../chat-messages.js';
import { AnthropicProvider, toAnthropicMessages } from '../providers/anthropic-provider.js';

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
		stop_reason: 'end_turn',
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

	// --- finishReason mapping ---

	describe('finishReason mapping (REQ-FOOD-RECEIPT-INTEGRITY-003)', () => {
		it.each([
			['end_turn', 'stop'],
			['stop_sequence', 'stop'],
			['max_tokens', 'length'],
			['tool_use', 'other'],
		] as const)('maps stop_reason=%s → %s', async (stopReason, expected) => {
			mockCreate.mockResolvedValue(mockResponse({ stop_reason: stopReason }));
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi');
			expect(result.finishReason).toBe(expected);
		});

		it('maps unknown stop_reason → other (forward-compat with future SDK values)', async () => {
			mockCreate.mockResolvedValue(mockResponse({ stop_reason: 'some_future_value' }));
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi');
			expect(result.finishReason).toBe('other');
		});

		it('maps missing/undefined stop_reason → other', async () => {
			mockCreate.mockResolvedValue(mockResponse({ stop_reason: undefined }));
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi');
			expect(result.finishReason).toBe('other');
		});
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

	// --- temperature capability gate ---

	describe('temperature capability gate', () => {
		it('omits temperature entirely for a model that rejects it', async () => {
			const provider = makeProvider();
			await provider.complete('hi', {
				modelRef: { provider: 'anthropic', model: 'claude-opus-5' },
				temperature: 0,
			});

			const callArgs = mockCreate.mock.calls[0]?.[0];
			expect(callArgs).toMatchObject({ model: 'claude-opus-5' });
			expect(callArgs).not.toHaveProperty('temperature');
		});

		it('still sends temperature for a model that supports it', async () => {
			const provider = makeProvider();
			await provider.complete('hi', {
				modelRef: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
				temperature: 0,
			});

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ model: 'claude-sonnet-4-6', temperature: 0 }),
			);
		});

		it('still sends temperature for an unprobed model (default is supported)', async () => {
			const provider = makeProvider({ defaultModel: 'claude-some-future-model' });
			await provider.complete('hi', { temperature: 0.3 });

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.3 }));
		});
	});

	it("accepts responseFormat: 'json' without sending any extra SDK fields (Batch 1 — Claude reliably returns JSON when asked)", async () => {
		const provider = makeProvider();
		await provider.complete('return json', { responseFormat: 'json' });
		const callArgs = mockCreate.mock.calls[0]?.[0];
		expect(callArgs).not.toHaveProperty('response_format');
		expect(callArgs).not.toHaveProperty('responseFormat');
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

const LOOKUP_TOOL = {
	name: 'lookup_receipt_total',
	description: 'Total of the most recent receipt for a store.',
	inputSchema: { type: 'object', properties: { store: { type: 'string' } }, required: ['store'] },
};
const USER: ChatMessage[] = [{ role: 'user', content: 'Costco total?' }];

function chatResponse(overrides: Record<string, unknown> = {}) {
	return {
		content: [{ type: 'text', text: 'It was $113.42.' }],
		usage: {
			input_tokens: 40,
			output_tokens: 9,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		stop_reason: 'end_turn',
		...overrides,
	};
}

describe('AnthropicProvider — chat with tools (REQ-LLM-048)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(chatResponse());
	});

	it('supportsTools and supportsVisionModel are true for every model', async () => {
		await expect(makeProvider().supportsTools('claude-haiku-4-5')).resolves.toBe(true);
		await expect(makeProvider().supportsVisionModel('claude-haiku-4-5')).resolves.toBe(true);
	});

	it('sends tools with input_schema in the order given, tool_choice auto, the signal — and no cache_control anywhere (R1-1: caching is P2)', async () => {
		const controller = new AbortController();
		const second = { ...LOOKUP_TOOL, name: 'second_tool' };
		await makeProvider().chatWithUsage(USER, {
			tools: [LOOKUP_TOOL, second],
			signal: controller.signal,
			maxTokens: 64,
		});
		const [body, reqOpts] = mockCreate.mock.calls[0] as [
			Record<string, unknown>,
			{ signal?: AbortSignal },
		];
		expect(body.tools).toEqual([
			{
				name: LOOKUP_TOOL.name,
				description: LOOKUP_TOOL.description,
				input_schema: LOOKUP_TOOL.inputSchema,
			},
			{
				name: 'second_tool',
				description: LOOKUP_TOOL.description,
				input_schema: LOOKUP_TOOL.inputSchema,
			},
		]);
		expect(JSON.stringify(body)).not.toContain('cache_control');
		expect(body.tool_choice).toEqual({ type: 'auto' });
		expect(body.max_tokens).toBe(64);
		expect(reqOpts.signal).toBe(controller.signal);
	});

	it('sdkMaxRetries is forwarded to the Anthropic client as maxRetries; absent → not passed (SDK default stays)', () => {
		constructorCalls.length = 0;
		makeProvider({ sdkMaxRetries: 0 });
		expect(constructorCalls[0]).toMatchObject({ maxRetries: 0 });
		makeProvider();
		expect(constructorCalls[1]).not.toHaveProperty('maxRetries');
	});

	it('parallelToolCalls: false sets disable_parallel_tool_use; no tools → no tool_choice', async () => {
		await makeProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL], parallelToolCalls: false });
		expect((mockCreate.mock.calls[0]?.[0] as Record<string, unknown>).tool_choice).toEqual({
			type: 'auto',
			disable_parallel_tool_use: true,
		});
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(chatResponse());
		await makeProvider().chatWithUsage(USER);
		expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('tools');
		expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('tool_choice');
	});

	it('leading system messages become the system block array (plain text blocks, no cache_control)', async () => {
		await makeProvider().chatWithUsage([
			{ role: 'system', content: 'Identity.' },
			{ role: 'system', content: 'Catalog.' },
			...USER,
		]);
		const body = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(body.system).toEqual([
			{ type: 'text', text: 'Identity.' },
			{ type: 'text', text: 'Catalog.' },
		]);
		expect(body.messages).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'Costco total?' }] },
		]);
	});

	it('maps assistant tool calls to tool_use blocks and tool results to a user message whose first blocks are tool_result', async () => {
		const history: ChatMessage[] = [
			...USER,
			{
				role: 'assistant',
				content: 'Let me check.',
				toolCalls: [
					{ id: 'toolu_1', name: 'lookup_receipt_total', arguments: { store: 'Costco' } },
					{ id: 'toolu_2', name: 'lookup_receipt_total', arguments: { store: 'Wegmans' } },
				],
			},
			{
				role: 'tool',
				content: '{"total":113.42}',
				toolCallId: 'toolu_1',
				toolName: 'lookup_receipt_total',
			},
			{
				role: 'tool',
				content: 'store not found',
				toolCallId: 'toolu_2',
				toolName: 'lookup_receipt_total',
				isError: true,
			},
			{ role: 'user', content: 'and the date?' },
		];
		await makeProvider().chatWithUsage(history, { tools: [LOOKUP_TOOL] });
		const body = mockCreate.mock.calls[0]?.[0] as { messages: unknown[] };
		expect(body.messages).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'Costco total?' }] },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Let me check.' },
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'lookup_receipt_total',
						input: { store: 'Costco' },
					},
					{
						type: 'tool_use',
						id: 'toolu_2',
						name: 'lookup_receipt_total',
						input: { store: 'Wegmans' },
					},
				],
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"total":113.42}' },
					{
						type: 'tool_result',
						tool_use_id: 'toolu_2',
						content: 'store not found',
						is_error: true,
					},
					{ type: 'text', text: 'and the date?' },
				],
			},
		]);
	});

	it('an assistant turn with tool calls and empty text has no empty text block (the API rejects empty text)', async () => {
		await makeProvider().chatWithUsage(
			[
				...USER,
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'toolu_1', name: 'lookup_receipt_total', arguments: {} }],
				},
				{ role: 'tool', content: 'x', toolCallId: 'toolu_1' },
			],
			{ tools: [LOOKUP_TOOL] },
		);
		const body = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: unknown[] }> };
		expect(body.messages[1]?.content).toEqual([
			{ type: 'tool_use', id: 'toolu_1', name: 'lookup_receipt_total', input: {} },
		]);
	});

	it('non-object tool-call arguments are replayed as {} (the API requires an object)', async () => {
		await makeProvider().chatWithUsage(
			[
				...USER,
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'toolu_1', name: 'lookup_receipt_total', arguments: '{oops' }],
				},
				{ role: 'tool', content: 'bad args', toolCallId: 'toolu_1', isError: true },
			],
			{ tools: [LOOKUP_TOOL] },
		);
		const body = mockCreate.mock.calls[0]?.[0] as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		expect(body.messages[1]?.content[0]?.input).toEqual({});
	});

	it('user images become image blocks before the text block', async () => {
		const png = Buffer.from([1, 2, 3]);
		await makeProvider().chatWithUsage([
			{ role: 'user', content: 'receipt', images: [{ data: png, mimeType: 'image/png' }] },
		]);
		const body = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: unknown[] }> };
		expect(body.messages[0]?.content).toEqual([
			{
				type: 'image',
				source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
			},
			{ type: 'text', text: 'receipt' },
		]);
	});

	it('a captionless photo sends the image block only — no empty text block, which the API rejects with 400 (R1-3)', async () => {
		const png = Buffer.from([1, 2, 3]);
		await makeProvider().chatWithUsage([
			{ role: 'user', content: '', images: [{ data: png, mimeType: 'image/png' }] },
		]);
		const body = mockCreate.mock.calls[0]?.[0] as { messages: Array<{ content: unknown[] }> };
		expect(body.messages[0]?.content).toEqual([
			{
				type: 'image',
				source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
			},
		]);
	});

	it('a tool result with empty content omits the content field (the API accepts a bare tool_result)', async () => {
		await makeProvider().chatWithUsage(
			[
				...USER,
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'toolu_1', name: 'lookup_receipt_total', arguments: {} }],
				},
				{ role: 'tool', content: '', toolCallId: 'toolu_1' },
			],
			{ tools: [LOOKUP_TOOL] },
		);
		const body = mockCreate.mock.calls[0]?.[0] as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		expect(body.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1' });
	});

	it('returns tool_use blocks as toolCalls with finishReason tool_calls and the text alongside', async () => {
		mockCreate.mockResolvedValue(
			chatResponse({
				content: [
					{ type: 'text', text: 'Checking.' },
					{
						type: 'tool_use',
						id: 'toolu_9',
						name: 'lookup_receipt_total',
						input: { store: 'Costco' },
					},
				],
				stop_reason: 'tool_use',
			}),
		);
		const result = await makeProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.finishReason).toBe('tool_calls');
		expect(result.message.content).toBe('Checking.');
		expect(result.message.toolCalls).toEqual([
			{ id: 'toolu_9', name: 'lookup_receipt_total', arguments: { store: 'Costco' } },
		]);
	});

	it('usage: inputTokens is the uncached input_tokens; cache counts ride separately and are never folded into the billed count (R1-1)', async () => {
		mockCreate.mockResolvedValue(
			chatResponse({
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			}),
		);
		const result = await makeProvider().chatWithUsage(USER, { _appId: 'food' });
		expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
	});

	it('usage: if the API ever reports cache tokens (impossible without cache_control), they are carried on usage, warned about, and not billed at the input rate', async () => {
		const warn = vi.fn();
		const provider = makeProvider({
			logger: { ...logger, warn, child: () => ({ ...logger, warn }) } as never,
		});
		mockCreate.mockResolvedValue(
			chatResponse({
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 1500,
				},
			}),
		);
		const result = await provider.chatWithUsage(USER, { _appId: 'food' });
		expect(result.usage).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			cacheCreationTokens: 200,
			cacheReadTokens: 1500,
		});
		const record = (provider as never as { costTracker: { record: ReturnType<typeof vi.fn> } })
			.costTracker.record;
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ inputTokens: 10, outputTokens: 5, appId: 'food' }),
		);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ cacheCreationTokens: 200, cacheReadTokens: 1500 }),
			expect.stringMatching(/cache tokens .* not billed/i),
		);
	});

	it.each([
		['end_turn', 'stop'],
		['stop_sequence', 'stop'],
		['max_tokens', 'length'],
		['refusal', 'error'],
		['pause_turn', 'other'],
	] as const)('maps stop_reason %s → %s when no tool calls', async (stop, expected) => {
		mockCreate.mockResolvedValue(chatResponse({ stop_reason: stop }));
		const result = await makeProvider().chatWithUsage(USER);
		expect(result.finishReason).toBe(expected);
	});

	it('temperature is sent only when the model accepts it and the caller set it', async () => {
		await makeProvider({ defaultModel: 'claude-opus-5' }).chatWithUsage(USER, { temperature: 0.2 });
		expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
		vi.clearAllMocks();
		mockCreate.mockResolvedValue(chatResponse());
		await makeProvider({ defaultModel: 'claude-haiku-4-5' }).chatWithUsage(USER, {
			temperature: 0.2,
		});
		expect((mockCreate.mock.calls[0]?.[0] as Record<string, unknown>).temperature).toBe(0.2);
	});

	it('rejects a non-leading system message with ChatMessageShapeError before calling the SDK', async () => {
		await expect(
			makeProvider().chatWithUsage([...USER, { role: 'system', content: 'late' }]),
		).rejects.toBeInstanceOf(ChatMessageShapeError);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it.each([
		[
			'an empty system message',
			[{ role: 'system', content: ' ' }, ...USER],
			/system message 0 has no text/,
		],
		[
			'a system-only history',
			[{ role: 'system', content: 'Identity.' }],
			/at least one non-system message/,
		],
		[
			'an empty assistant turn',
			[...USER, { role: 'assistant', content: '' }, { role: 'user', content: 'hello?' }],
			/assistant message 1 has neither text nor tool calls/,
		],
	] as const)(
		'rejects %s before calling the SDK — no empty text block, empty messages, or content: [] is ever sent (P2-6)',
		async (_name, history, message) => {
			await expect(makeProvider().chatWithUsage(history as ChatMessage[])).rejects.toThrow(message);
			expect(mockCreate).not.toHaveBeenCalled();
		},
	);

	it('the real SDK APIUserAbortError (name "Error") is surfaced as the caller signal reason and never retried (P2-4)', async () => {
		const sdkError = new APIUserAbortError();
		expect(sdkError.name).toBe('Error');
		const controller = new AbortController();
		const reason = new Error('user cancelled');
		mockCreate.mockImplementation(async () => {
			controller.abort(reason);
			throw sdkError;
		});
		await expect(makeProvider().chatWithUsage(USER, { signal: controller.signal })).rejects.toBe(
			reason,
		);
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it('the real SDK APIUserAbortError without a caller signal becomes an AbortError (cause = the SDK error), classified aborted, not retried (P2-4)', async () => {
		const sdkError = new APIUserAbortError();
		mockCreate.mockRejectedValue(sdkError);
		const err = (await makeProvider()
			.chatWithUsage(USER)
			.catch((e: unknown) => e)) as Error & { cause?: unknown };
		expect(err.name).toBe('AbortError');
		expect(err.cause).toBe(sdkError);
		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(classifyLLMError(err).category).toBe('aborted');
	});
});

describe('toAnthropicMessages — defence in depth for direct callers (P2-6)', () => {
	// validateChatMessages rejects these first on the chatWithUsage path; the
	// mapper must still refuse them so no caller can emit an empty system text
	// block, `messages: []`, or an assistant `content: []` by skipping the validator.
	it('throws on an empty system message, a system-only history, and an empty assistant turn', () => {
		expect(() => toAnthropicMessages([{ role: 'system', content: '' }, ...USER])).toThrow(
			ChatMessageShapeError,
		);
		expect(() => toAnthropicMessages([{ role: 'system', content: 'x' }])).toThrow(
			ChatMessageShapeError,
		);
		expect(() => toAnthropicMessages([...USER, { role: 'assistant', content: '' }])).toThrow(
			ChatMessageShapeError,
		);
	});
});
