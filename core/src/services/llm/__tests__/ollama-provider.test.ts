import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the `ollama` SDK ---

const mockGenerate = vi.fn();
const mockList = vi.fn();
const mockChat = vi.fn();
const mockShow = vi.fn();
const constructorCalls: Array<Record<string, unknown>> = [];

vi.mock('ollama', () => {
	class MockOllama {
		generate = mockGenerate;
		list = mockList;
		chat = mockChat;
		show = mockShow;
		constructor(opts: Record<string, unknown>) {
			constructorCalls.push(opts);
		}
	}
	return { Ollama: MockOllama };
});

import { OllamaProvider } from '../providers/ollama-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider() {
	return new OllamaProvider({
		providerId: 'ollama',
		baseUrl: 'http://localhost:11434',
		defaultModel: 'gemma4:e4b',
		logger,
		costTracker: makeCostTracker() as never,
	});
}

describe('OllamaProvider — responseFormat plumbing (Batch 1)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGenerate.mockResolvedValue({
			response: '{"action":"price-lookup","confidence":0.9}',
			prompt_eval_count: 12,
			eval_count: 8,
			done_reason: 'stop',
		});
	});

	it("passes format: 'json' to the SDK when responseFormat is 'json'", async () => {
		const provider = makeProvider();
		await provider.complete('classify this prompt', { responseFormat: 'json' });
		expect(mockGenerate).toHaveBeenCalledTimes(1);
		expect(mockGenerate.mock.calls[0]?.[0]).toMatchObject({ format: 'json' });
	});

	it('does NOT pass format field when responseFormat is unset (default behavior preserved)', async () => {
		const provider = makeProvider();
		await provider.complete('plain prompt');
		expect(mockGenerate).toHaveBeenCalledTimes(1);
		expect(mockGenerate.mock.calls[0]?.[0]).not.toHaveProperty('format');
	});

	it('does NOT pass format field when responseFormat is some other value (only json supported)', async () => {
		const provider = makeProvider();
		// @ts-expect-error — exercising defensive runtime behavior
		await provider.complete('plain prompt', { responseFormat: 'xml' });
		expect(mockGenerate.mock.calls[0]?.[0]).not.toHaveProperty('format');
	});
});

describe('OllamaProvider — finishReason mapping (REQ-FOOD-RECEIPT-INTEGRITY-003)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		['stop', 'stop'],
		['length', 'length'],
		['load', 'other'],
	] as const)('maps done_reason=%s → %s (newer Ollama)', async (input, expected) => {
		mockGenerate.mockResolvedValue({
			response: 'hi',
			prompt_eval_count: 1,
			eval_count: 1,
			done_reason: input,
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe(expected);
	});

	it('maps unknown done_reason → other', async () => {
		mockGenerate.mockResolvedValue({
			response: 'hi',
			prompt_eval_count: 1,
			eval_count: 1,
			done_reason: 'something_new',
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	describe('older Ollama fallback (no done_reason)', () => {
		it('eval_count >= maxTokens → length', async () => {
			mockGenerate.mockResolvedValue({
				response: 'hi',
				prompt_eval_count: 1,
				eval_count: 100, // reached cap
			});
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi', { maxTokens: 100 });
			expect(result.finishReason).toBe('length');
		});

		it('eval_count < maxTokens → stop', async () => {
			mockGenerate.mockResolvedValue({
				response: 'hi',
				prompt_eval_count: 1,
				eval_count: 50,
			});
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi', { maxTokens: 100 });
			expect(result.finishReason).toBe('stop');
		});

		it('no maxTokens provided AND no done_reason → other (cannot infer)', async () => {
			mockGenerate.mockResolvedValue({
				response: 'hi',
				prompt_eval_count: 1,
				eval_count: 999,
			});
			const provider = makeProvider();
			const result = await provider.completeWithUsage('hi');
			expect(result.finishReason).toBe('other');
		});
	});
});

describe('OllamaProvider — thinking flag (defaults OFF)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGenerate.mockResolvedValue({
			response: '{"action":"none","confidence":0.5}',
			prompt_eval_count: 12,
			eval_count: 8,
			done_reason: 'stop',
		});
	});

	it('sends think: false by default — an omitted field would leave thinking ON', async () => {
		const provider = makeProvider();
		await provider.complete('classify this', { responseFormat: 'json', maxTokens: 80 });
		expect(mockGenerate).toHaveBeenCalledTimes(1);
		const payload = mockGenerate.mock.calls[0]?.[0];
		expect(payload).toHaveProperty('think', false);
	});

	it('sends think: true when options.thinking === true', async () => {
		const provider = makeProvider();
		await provider.complete('reason about this', { thinking: true, maxTokens: 2000 });
		expect(mockGenerate.mock.calls[0]?.[0]).toHaveProperty('think', true);
	});

	it('sends think even when responseFormat is unset — the flag is NOT gated on JSON mode', async () => {
		// Guards against a future "only disable thinking for JSON prompts" regression:
		// the worst case in the repo (pas-classifier, maxTokens: 10) sets no
		// responseFormat at all.
		const provider = makeProvider();
		await provider.complete('yes or no?', { maxTokens: 10 });
		const payload = mockGenerate.mock.calls[0]?.[0];
		expect(payload).not.toHaveProperty('format');
		expect(payload).toHaveProperty('think', false);
	});

	it('treats thinking: false the same as omitted', async () => {
		const provider = makeProvider();
		await provider.complete('hi', { thinking: false });
		expect(mockGenerate.mock.calls[0]?.[0]).toHaveProperty('think', false);
	});
});

describe('OllamaProvider — empty output after budget exhaustion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	/** The observed live failure: whole num_predict budget spent inside `thinking`. */
	function budgetBurnedInThinking() {
		return {
			response: '',
			thinking: 'x'.repeat(762),
			prompt_eval_count: 210,
			eval_count: 176,
			done_reason: 'length',
		};
	}

	it('throws a diagnostic naming the model, the budget and the thinking length', async () => {
		mockGenerate.mockResolvedValue(budgetBurnedInThinking());
		const provider = makeProvider();

		await expect(
			provider.complete('classify this', { responseFormat: 'json', maxTokens: 176 }),
		).rejects.toThrow(/gemma4:e4b/);

		mockGenerate.mockResolvedValue(budgetBurnedInThinking());
		const err = await provider
			.complete('classify this', { responseFormat: 'json', maxTokens: 176 })
			.then(
				() => null,
				(e: unknown) => e as Error,
			);

		expect(err).toBeInstanceOf(Error);
		expect(err?.name).toBe('LLMEmptyOutputError');
		expect(err?.message).toContain('176'); // the num_predict budget
		expect(err?.message).toContain('762'); // the thinking block length
		expect(err?.message).toMatch(/maxTokens|thinking/);
	});

	it('throws even when the model reports no thinking block (empty + length is enough)', async () => {
		mockGenerate.mockResolvedValue({
			response: '   ',
			prompt_eval_count: 10,
			eval_count: 80,
			done_reason: 'length',
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).rejects.toThrow(
			/returned empty output/i,
		);
	});

	it('still resolves to "" for empty + done_reason stop (Gemma ambiguity, handled upstream)', async () => {
		mockGenerate.mockResolvedValue({
			response: '',
			prompt_eval_count: 10,
			eval_count: 1,
			done_reason: 'stop',
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).resolves.toBe('');
	});

	it('resolves normally for truncated-but-non-empty output (the oracle judges that)', async () => {
		mockGenerate.mockResolvedValue({
			response: '{"a":1}',
			prompt_eval_count: 10,
			eval_count: 80,
			done_reason: 'length',
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi', { maxTokens: 80 });
		expect(result.text).toBe('{"a":1}');
		expect(result.finishReason).toBe('length');
	});

	it('also fires on the older-Ollama path where length is inferred from eval_count', async () => {
		mockGenerate.mockResolvedValue({
			response: '',
			thinking: 'y'.repeat(400),
			prompt_eval_count: 10,
			eval_count: 80, // >= maxTokens, no done_reason field
		});
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 80 })).rejects.toThrow(/empty output/i);
	});

	it('is attempted exactly once — the failure is deterministic, not transient', async () => {
		mockGenerate.mockResolvedValue(budgetBurnedInThinking());
		const provider = makeProvider();
		await expect(provider.complete('hi', { maxTokens: 176 })).rejects.toThrow(/empty output/i);
		expect(mockGenerate).toHaveBeenCalledTimes(1);
	});
});

import type { ChatMessage } from '../../../types/llm.js';
import { DEFAULT_OLLAMA_TIMEOUT_MS } from '../chat-defaults.js';
import { TOOL_CALL_ID_RE } from '../chat-messages.js';
import { LLMEmptyOutputError, LLMToolsUnsupportedError } from '../errors.js';

const QWEN = 'qwen3.8:27b-mlx';
const toolShow = { capabilities: ['completion', 'vision', 'tools', 'thinking'] };
const noToolShow = { capabilities: ['completion'] };
const LOOKUP_TOOL = {
	name: 'lookup_receipt_total',
	description: 'Total of the most recent receipt for a store.',
	inputSchema: { type: 'object', properties: { store: { type: 'string' } }, required: ['store'] },
};
const USER: ChatMessage[] = [{ role: 'user', content: 'How much was my last Costco trip?' }];

function makeQwenProvider() {
	return new OllamaProvider({
		providerId: 'ollama',
		baseUrl: 'http://localhost:11434',
		defaultModel: QWEN,
		logger,
		costTracker: makeCostTracker() as never,
	});
}

function chatReply(overrides: Record<string, unknown> = {}) {
	return {
		message: { role: 'assistant', content: 'It was $113.42.' },
		done: true,
		done_reason: 'stop',
		prompt_eval_count: 40,
		eval_count: 9,
		...overrides,
	};
}

describe('OllamaProvider — capability detection via /api/show (REQ-LLM-049)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		constructorCalls.length = 0;
	});

	it('supportsTools is true when capabilities include "tools"', async () => {
		mockShow.mockResolvedValue(toolShow);
		await expect(makeQwenProvider().supportsTools(QWEN)).resolves.toBe(true);
		expect(mockShow).toHaveBeenCalledWith({ model: QWEN });
	});

	it('supportsTools is false when capabilities lack "tools"', async () => {
		mockShow.mockResolvedValue(noToolShow);
		await expect(makeQwenProvider().supportsTools('gemma4:e4b')).resolves.toBe(false);
	});

	it('supportsVisionModel reads the "vision" capability', async () => {
		mockShow.mockResolvedValueOnce(toolShow).mockResolvedValueOnce(noToolShow);
		const provider = makeQwenProvider();
		await expect(provider.supportsVisionModel(QWEN)).resolves.toBe(true);
		await expect(provider.supportsVisionModel('gemma4:e4b')).resolves.toBe(false);
	});

	it('probes each model once and caches the answer for the provider lifetime', async () => {
		mockShow.mockResolvedValue(toolShow);
		const provider = makeQwenProvider();
		await provider.supportsTools(QWEN);
		await provider.supportsVisionModel(QWEN);
		await provider.supportsTools(QWEN);
		expect(mockShow).toHaveBeenCalledTimes(1);
	});

	it('concurrent probes of the same model share one /api/show request', async () => {
		mockShow.mockResolvedValue(toolShow);
		const provider = makeQwenProvider();
		await Promise.all([provider.supportsTools(QWEN), provider.supportsTools(QWEN)]);
		expect(mockShow).toHaveBeenCalledTimes(1);
	});

	it('a failed probe rejects with the provider error and is not cached (server down ≠ no tools)', async () => {
		mockShow.mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValueOnce(toolShow);
		const provider = makeQwenProvider();
		await expect(provider.supportsTools(QWEN)).rejects.toThrow('fetch failed');
		await expect(provider.supportsTools(QWEN)).resolves.toBe(true);
		expect(mockShow).toHaveBeenCalledTimes(2);
	});

	it('an older server without a capabilities field is treated as capable, with one warning', async () => {
		mockShow.mockResolvedValue({});
		await expect(makeQwenProvider().supportsTools(QWEN)).resolves.toBe(true);
	});

	it('supportsVision (provider-wide, the complete() gate) stays false: complete() with images is still rejected and generate is never called (R1-2)', async () => {
		const provider = makeQwenProvider();
		expect(provider.supportsVision).toBe(false);
		await expect(
			provider.completeWithUsage('what is this?', {
				images: [{ data: Buffer.from('x'), mimeType: 'image/png' }],
			}),
		).rejects.toThrow(/Provider ollama does not support vision/);
		expect(mockGenerate).not.toHaveBeenCalled();
		expect(mockShow).not.toHaveBeenCalled();
	});

	it('an abort while /api/show is still pending rejects at once; the probe result is still cached when it lands (R1-6)', async () => {
		let resolveShow: (v: unknown) => void = () => {};
		mockShow.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveShow = resolve;
			}),
		);
		const provider = makeQwenProvider();
		const controller = new AbortController();
		const call = provider.chatWithUsage(USER, { tools: [LOOKUP_TOOL], signal: controller.signal });
		setTimeout(() => controller.abort(), 10);
		await expect(call).rejects.toMatchObject({ name: 'AbortError' });
		expect(mockChat).not.toHaveBeenCalled();
		resolveShow(toolShow);
		await expect(provider.supportsTools(QWEN)).resolves.toBe(true);
		expect(mockShow).toHaveBeenCalledTimes(1); // the aborted caller's probe was reused, not re-issued
	});
});

describe('OllamaProvider — chat request mapping (REQ-LLM-046)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		constructorCalls.length = 0;
		mockShow.mockResolvedValue(toolShow);
		mockChat.mockResolvedValue(chatReply());
	});

	it('calls client.chat (not generate) with tools in the function wrapper', async () => {
		await makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(mockGenerate).not.toHaveBeenCalled();
		const req = mockChat.mock.calls[0]?.[0];
		expect(req.model).toBe(QWEN);
		expect(req.tools).toEqual([
			{
				type: 'function',
				function: {
					name: LOOKUP_TOOL.name,
					description: LOOKUP_TOOL.description,
					parameters: LOOKUP_TOOL.inputSchema,
				},
			},
		]);
		expect(req.stream).toBe(false);
	});

	it('always sends num_ctx (default 32768) and keep_alive (default 30m), and think: false by default', async () => {
		await makeQwenProvider().chatWithUsage(USER);
		const req = mockChat.mock.calls[0]?.[0];
		expect(req.options.num_ctx).toBe(32768);
		expect(req.keep_alive).toBe('30m');
		expect(req.think).toBe(false);
	});

	it('honours contextWindow, keepAlive, maxTokens and temperature when given', async () => {
		await makeQwenProvider().chatWithUsage(USER, {
			contextWindow: 8192,
			keepAlive: '5m',
			maxTokens: 300,
			temperature: 0.7,
		});
		const req = mockChat.mock.calls[0]?.[0];
		expect(req.options).toEqual({ num_ctx: 8192, num_predict: 300, temperature: 0.7 });
		expect(req.keep_alive).toBe('5m');
	});

	it('sends no temperature unless the caller sets one (model-card defaults apply; unlike complete())', async () => {
		await makeQwenProvider().chatWithUsage(USER);
		expect(mockChat.mock.calls[0]?.[0].options).not.toHaveProperty('temperature');
	});

	it.each([
		[true, true],
		['low', 'low'],
		['high', 'high'],
		['off', false],
	] as const)('maps thinking %s → think %s', async (thinking, expected) => {
		await makeQwenProvider().chatWithUsage(USER, { thinking });
		expect(mockChat.mock.calls[0]?.[0].think).toBe(expected);
	});

	it('maps system/user/assistant(tool_calls, thinking)/tool messages to the Ollama shapes', async () => {
		const history: ChatMessage[] = [
			{ role: 'system', content: 'Use tools.' },
			...USER,
			{
				role: 'assistant',
				content: '',
				thinking: 'The user wants the Costco total.',
				toolCalls: [
					{ id: 'call_ab12cd34', name: 'lookup_receipt_total', arguments: { store: 'Costco' } },
				],
			},
			{
				role: 'tool',
				content: '{"total":113.42}',
				toolCallId: 'call_ab12cd34',
				toolName: 'lookup_receipt_total',
			},
		];
		await makeQwenProvider().chatWithUsage(history, { tools: [LOOKUP_TOOL] });
		const req = mockChat.mock.calls[0]?.[0];
		expect(req.messages).toEqual([
			{ role: 'system', content: 'Use tools.' },
			{ role: 'user', content: USER[0]?.content },
			{
				role: 'assistant',
				content: '',
				thinking: 'The user wants the Costco total.',
				tool_calls: [
					{ function: { name: 'lookup_receipt_total', arguments: { store: 'Costco' } } },
				],
			},
			{ role: 'tool', content: '{"total":113.42}', tool_name: 'lookup_receipt_total' },
		]);
	});

	it('sends user images as base64 strings', async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		await makeQwenProvider().chatWithUsage([
			{ role: 'user', content: 'receipt', images: [{ data: png, mimeType: 'image/png' }] },
		]);
		expect(mockChat.mock.calls[0]?.[0].messages[0].images).toEqual([png.toString('base64')]);
	});

	it('refuses images for a model whose /api/show lacks vision, before calling chat', async () => {
		mockShow.mockResolvedValue(noToolShow);
		await expect(
			makeQwenProvider().chatWithUsage(
				[
					{
						role: 'user',
						content: 'x',
						images: [{ data: Buffer.from('x'), mimeType: 'image/png' }],
					},
				],
				{ modelRef: { provider: 'ollama', model: 'gemma4:e4b' } },
			),
		).rejects.toThrow(/Model 'gemma4:e4b' on provider ollama does not support vision/);
		expect(mockChat).not.toHaveBeenCalled();
	});

	it('refuses tools for a model whose /api/show lacks tools, before calling chat', async () => {
		mockShow.mockResolvedValue(noToolShow);
		await expect(
			makeQwenProvider().chatWithUsage(USER, {
				tools: [LOOKUP_TOOL],
				modelRef: { provider: 'ollama', model: 'gemma4:e4b' },
			}),
		).rejects.toBeInstanceOf(LLMToolsUnsupportedError);
		expect(mockChat).not.toHaveBeenCalled();
	});
});

describe('OllamaProvider — chat response mapping (REQ-LLM-046)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		constructorCalls.length = 0;
		mockShow.mockResolvedValue(toolShow);
	});

	it('returns tool calls with synthesized ids when Ollama provides none, finishReason tool_calls', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [
						{ function: { name: 'lookup_receipt_total', arguments: { store: 'Costco' } } },
					],
				},
				done_reason: 'stop',
			}),
		);
		const result = await makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.finishReason).toBe('tool_calls');
		expect(result.message.toolCalls).toHaveLength(1);
		expect(result.message.toolCalls?.[0]?.id).toMatch(TOOL_CALL_ID_RE);
		expect(result.message.toolCalls?.[0]).toMatchObject({
			name: 'lookup_receipt_total',
			arguments: { store: 'Costco' },
		});
		expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 9 });
		expect(result.model).toBe(QWEN);
		expect(result.provider).toBe('ollama');
	});

	it('uses the id Ollama provides when present', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [
						{ id: 'ollama-id-1', function: { name: 'lookup_receipt_total', arguments: {} } },
					],
				},
			}),
		);
		const result = await makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.message.toolCalls?.[0]?.id).toBe('ollama-id-1');
	});

	it('keeps string arguments that are not JSON as the raw string (P2 validates)', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'lookup_receipt_total', arguments: 'not json' } }],
				},
			}),
		);
		const result = await makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.message.toolCalls?.[0]?.arguments).toBe('not json');
	});

	it('parses string arguments that are JSON', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [
						{ function: { name: 'lookup_receipt_total', arguments: '{"store":"Costco"}' } },
					],
				},
			}),
		);
		const result = await makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] });
		expect(result.message.toolCalls?.[0]?.arguments).toEqual({ store: 'Costco' });
	});

	it('returns thinking on the assistant message when the model emitted it', async () => {
		mockChat.mockResolvedValue(
			chatReply({ message: { role: 'assistant', content: 'ok', thinking: 'short thought' } }),
		);
		const result = await makeQwenProvider().chatWithUsage(USER, { thinking: 'low' });
		expect(result.message.thinking).toBe('short thought');
	});

	it('does not set toolCalls when none were made and maps done_reason stop/length', async () => {
		mockChat.mockResolvedValue(chatReply({ done_reason: 'length' }));
		const result = await makeQwenProvider().chatWithUsage(USER);
		expect(result.message.toolCalls).toBeUndefined();
		expect(result.finishReason).toBe('length');
	});

	it('empty content + no tool calls + length throws LLMEmptyOutputError carrying usage', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: { role: 'assistant', content: '', thinking: 'x'.repeat(300) },
				done_reason: 'length',
				eval_count: 64,
			}),
		);
		const provider = makeQwenProvider();
		const err = await provider.chatWithUsage(USER, { maxTokens: 64 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(LLMEmptyOutputError);
		expect((err as LLMEmptyOutputError).usage).toEqual({ inputTokens: 40, outputTokens: 64 });
		expect((err as LLMEmptyOutputError).thinkingChars).toBe(300);
	});

	it('empty content + tool calls is not an empty-output failure', async () => {
		mockChat.mockResolvedValue(
			chatReply({
				message: {
					role: 'assistant',
					content: '',
					tool_calls: [{ function: { name: 'lookup_receipt_total', arguments: {} } }],
				},
				done_reason: 'length',
			}),
		);
		await expect(
			makeQwenProvider().chatWithUsage(USER, { tools: [LOOKUP_TOOL] }),
		).resolves.toMatchObject({
			finishReason: 'tool_calls',
		});
	});
});

describe('OllamaProvider — AbortSignal on chat (REQ-LLM-050)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		constructorCalls.length = 0;
		mockShow.mockResolvedValue(toolShow);
		mockChat.mockResolvedValue(chatReply());
	});

	it('uses a per-call client whose fetch carries a signal that follows the caller signal', async () => {
		const provider = makeQwenProvider();
		const constructedAtStart = constructorCalls.length;
		const controller = new AbortController();
		await provider.chatWithUsage(USER, { signal: controller.signal });
		expect(constructorCalls.length).toBe(constructedAtStart + 1);
		const perCall = constructorCalls[constructorCalls.length - 1] as {
			fetch: typeof fetch;
			host: string;
		};
		expect(perCall.host).toBe('http://localhost:11434');

		const seen: RequestInit[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response('{}');
		}) as typeof fetch;
		try {
			await perCall.fetch('http://localhost:11434/api/chat', { method: 'POST' });
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(seen[0]?.signal?.aborted).toBe(false);
		controller.abort();
		expect(seen[0]?.signal?.aborted).toBe(true);
	});

	it('reuses the shared client when no signal is given', async () => {
		const provider = makeQwenProvider();
		const constructedAtStart = constructorCalls.length;
		await provider.chatWithUsage(USER);
		expect(constructorCalls.length).toBe(constructedAtStart);
	});

	it('the per-call fetch still enforces the 120 s HTTP timeout alongside the caller signal (R1-14 pin)', async () => {
		vi.useFakeTimers();
		try {
			const provider = makeQwenProvider();
			const controller = new AbortController();
			await provider.chatWithUsage(USER, { signal: controller.signal });
			const perCall = constructorCalls[constructorCalls.length - 1] as { fetch: typeof fetch };
			const seen: RequestInit[] = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
				seen.push(init ?? {});
				return new Promise<Response>(() => {}); // never settles: only the timeout can end it
			}) as typeof fetch;
			try {
				void perCall.fetch('http://localhost:11434/api/chat', { method: 'POST' });
				vi.advanceTimersByTime(DEFAULT_OLLAMA_TIMEOUT_MS - 1);
				expect(seen[0]?.signal?.aborted).toBe(false);
				vi.advanceTimersByTime(1);
				expect(seen[0]?.signal?.aborted).toBe(true);
			} finally {
				globalThis.fetch = realFetch;
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
