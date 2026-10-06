import { describe, expect, it } from 'vitest';
// Deliberately the barrel, not `llm.js`: apps import chat types through
// `@pas/core/types`, so a missing re-export is a type error here (TS2305 under
// the Task 6 test-inclusive typecheck gate).
import type {
	ChatMessage,
	ChatOptions,
	ChatResult,
	ChatToolSpec,
	ThinkingLevel,
	ToolCallRequest,
} from '../../../types/index.js';
import {
	DEFAULT_AGENT_MODEL,
	DEFAULT_AGENT_THINKING,
	DEFAULT_CHAT_CONTEXT_WINDOW,
	DEFAULT_OLLAMA_KEEP_ALIVE,
	DEFAULT_OLLAMA_TIMEOUT_MS,
	IMAGE_INPUT_TOKEN_ALLOWANCE,
} from '../chat-defaults.js';
import {
	ChatMessageShapeError,
	TOOL_CALL_ID_RE,
	abortable,
	serializeChatForEstimate,
	synthesizeToolCallId,
	toAbortError,
	toOllamaThink,
	validateChatMessages,
} from '../chat-messages.js';

// Compile-time use of every barrel export (erased at runtime; checked by the Task 6 gate).
type _BarrelCheck = [ChatOptions, ChatResult, ChatToolSpec, ThinkingLevel, ToolCallRequest];

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistantCall = (id: string): ChatMessage => ({
	role: 'assistant',
	content: '',
	toolCalls: [{ id, name: 'lookup', arguments: { store: 'Costco' } }],
});
const toolResult = (toolCallId: string): ChatMessage => ({
	role: 'tool',
	content: '{"total":113.42}',
	toolCallId,
	toolName: 'lookup',
});

describe('validateChatMessages (REQ-LLM-045)', () => {
	it('accepts system → user → assistant(tool_calls) → tool → assistant', () => {
		expect(() =>
			validateChatMessages([
				{ role: 'system', content: 'be brief' },
				user('costco?'),
				assistantCall('call_1'),
				toolResult('call_1'),
				{ role: 'assistant', content: '$113.42' },
			]),
		).not.toThrow();
	});

	it('rejects an empty message list', () => {
		expect(() => validateChatMessages([])).toThrow(ChatMessageShapeError);
	});

	it('rejects a system message that is not at the start', () => {
		expect(() => validateChatMessages([user('hi'), { role: 'system', content: 'late' }])).toThrow(
			/system messages must come first/,
		);
	});

	it('rejects a tool message without toolCallId', () => {
		expect(() =>
			validateChatMessages([user('hi'), assistantCall('call_1'), { role: 'tool', content: 'x' }]),
		).toThrow(/toolCallId/);
	});

	it('rejects a tool message whose toolCallId was not requested by the preceding assistant turn', () => {
		expect(() =>
			validateChatMessages([user('hi'), assistantCall('call_1'), toolResult('call_other')]),
		).toThrow(/does not match/);
	});

	it('rejects a tool message that does not follow an assistant tool call (or another tool result)', () => {
		expect(() => validateChatMessages([user('hi'), toolResult('call_1')])).toThrow(
			/must directly follow/,
		);
	});

	it('rejects duplicate tool-call ids inside one assistant turn', () => {
		expect(() =>
			validateChatMessages([
				user('hi'),
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_1', name: 'a', arguments: {} },
						{ id: 'call_1', name: 'b', arguments: {} },
					],
				},
			]),
		).toThrow(/duplicate tool-call id/);
	});

	it('rejects images on a non-user message', () => {
		expect(() =>
			validateChatMessages([
				user('hi'),
				{
					role: 'assistant',
					content: 'x',
					images: [{ data: Buffer.alloc(1), mimeType: 'image/png' }],
				},
			]),
		).toThrow(/images are only allowed on user messages/);
	});

	it('rejects images on a leading system message too (R1-7: the system prefix was skipped unvalidated)', () => {
		expect(() =>
			validateChatMessages([
				{
					role: 'system',
					content: 'x',
					images: [{ data: Buffer.alloc(1), mimeType: 'image/png' }],
				},
				user('hi'),
			]),
		).toThrow(/images are only allowed on user messages \(message 0\)/);
	});

	it('rejects a second tool result for an id that was already answered (R1-7)', () => {
		expect(() =>
			validateChatMessages([
				user('hi'),
				assistantCall('call_1'),
				toolResult('call_1'),
				toolResult('call_1'),
			]),
		).toThrow(/already answered/);
	});

	it('rejects a user turn while an assistant tool call is still unanswered (R1-7)', () => {
		expect(() =>
			validateChatMessages([user('hi'), assistantCall('call_1'), user('and the date?')]),
		).toThrow(/unanswered tool call 'call_1'/);
	});

	it('rejects a history that ends with an unanswered assistant tool call (R1-7)', () => {
		expect(() => validateChatMessages([user('hi'), assistantCall('call_1')])).toThrow(
			/unanswered tool call 'call_1'/,
		);
	});

	it('accepts two tool calls answered in either order', () => {
		expect(() =>
			validateChatMessages([
				user('hi'),
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'call_1', name: 'a', arguments: {} },
						{ id: 'call_2', name: 'b', arguments: {} },
					],
				},
				toolResult('call_2'),
				toolResult('call_1'),
				{ role: 'assistant', content: 'done' },
			]),
		).not.toThrow();
	});

	it('rejects a user message with neither text nor images (Anthropic rejects an empty text block — R1-3)', () => {
		expect(() => validateChatMessages([user('   ')])).toThrow(
			/user message 0 has neither text nor images/,
		);
	});

	it('accepts a captionless photo (images, empty text)', () => {
		expect(() =>
			validateChatMessages([
				{ role: 'user', content: '', images: [{ data: Buffer.alloc(1), mimeType: 'image/png' }] },
			]),
		).not.toThrow();
	});

	it('rejects a system message with no text (Anthropic rejects an empty system text block — P2-6)', () => {
		expect(() => validateChatMessages([{ role: 'system', content: '  ' }, user('hi')])).toThrow(
			/system message 0 has no text/,
		);
	});

	it('rejects a system-only history (Anthropic rejects messages: [] — P2-6)', () => {
		expect(() => validateChatMessages([{ role: 'system', content: 'be brief' }])).toThrow(
			/at least one non-system message is required/,
		);
	});

	it('rejects an assistant turn with neither text nor tool calls (Anthropic rejects content: [] — P2-6)', () => {
		expect(() =>
			validateChatMessages([user('hi'), { role: 'assistant', content: '' }, user('still there?')]),
		).toThrow(/assistant message 1 has neither text nor tool calls/);
	});

	it('accepts an assistant turn with tool calls and empty text (the normal tool-call shape)', () => {
		expect(() =>
			validateChatMessages([
				user('hi'),
				assistantCall('call_1'),
				toolResult('call_1'),
				{ role: 'assistant', content: 'done' },
			]),
		).not.toThrow();
	});
});

describe('synthesizeToolCallId (REQ-LLM-046)', () => {
	it('matches call_<8 hex> and is unique across calls', () => {
		const ids = new Set(Array.from({ length: 50 }, () => synthesizeToolCallId()));
		for (const id of ids) expect(id).toMatch(TOOL_CALL_ID_RE);
		expect(ids.size).toBe(50);
	});
});

describe('toOllamaThink (REQ-LLM-046)', () => {
	it.each([
		[undefined, false],
		[false, false],
		['off', false],
		[true, true],
		['low', 'low'],
		['medium', 'medium'],
		['high', 'high'],
	] as const)('maps %s → %s', (input, expected) => {
		expect(toOllamaThink(input)).toBe(expected);
	});
});

describe('serializeChatForEstimate (REQ-LLM-045)', () => {
	it('joins message contents and the JSON of the tool list so the guard estimate scales with both', () => {
		const text = serializeChatForEstimate(
			[user('abc'), { role: 'assistant', content: 'def' }],
			[{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
		);
		expect(text).toContain('abc');
		expect(text).toContain('def');
		expect(text).toContain('"inputSchema"');
	});

	it('is just the message text when there are no tools', () => {
		expect(serializeChatForEstimate([user('abc')], undefined)).toBe('abc');
	});

	it('counts assistant tool-call arguments: a 100k-character tool-call history estimates ≥ 100k characters (R1-5)', () => {
		const bigArgs = { blob: 'x'.repeat(100_000) };
		const history: ChatMessage[] = [
			user('go'),
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 'lookup', arguments: bigArgs }],
			},
			{ role: 'tool', content: 'ok', toolCallId: 'call_1' },
		];
		const text = serializeChatForEstimate(history, undefined);
		expect(text.length).toBeGreaterThanOrEqual(100_000);
		expect(text).toContain('"blob"');
	});

	it('counts replayed assistant thinking and raw-string tool-call arguments', () => {
		const text = serializeChatForEstimate(
			[
				user('go'),
				{
					role: 'assistant',
					content: '',
					thinking: 'T'.repeat(500),
					toolCalls: [{ id: 'call_1', name: 'lookup', arguments: 'R'.repeat(300) }],
				},
				{ role: 'tool', content: 'ok', toolCallId: 'call_1' },
			],
			undefined,
		);
		expect(text).toContain('T'.repeat(500));
		expect(text).toContain('R'.repeat(300));
	});
});

describe('abortable (REQ-LLM-050, R1-6)', () => {
	it('returns the promise unchanged when no signal is given', async () => {
		await expect(abortable(Promise.resolve(1), undefined)).resolves.toBe(1);
	});

	it('rejects with the signal reason when the signal fires while the promise is pending', async () => {
		const controller = new AbortController();
		const pending = new Promise<number>(() => {});
		const result = abortable(pending, controller.signal);
		controller.abort();
		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort(new Error('custom reason'));
		await expect(abortable(new Promise<number>(() => {}), controller.signal)).rejects.toThrow(
			'custom reason',
		);
	});
});

describe('toAbortError (REQ-LLM-050, P2-4)', () => {
	it('returns the signal reason when the caller supplied one', () => {
		const controller = new AbortController();
		const reason = new Error('user cancelled');
		controller.abort(reason);
		expect(toAbortError(controller.signal, new Error('sdk said: Request was aborted.'))).toBe(
			reason,
		);
	});

	it('otherwise returns an Error named AbortError whose cause is the provider error', () => {
		const sdkError = new Error('Request was aborted.'); // the SDK classes have name 'Error'
		const err = toAbortError(undefined, sdkError) as Error & { cause?: unknown };
		expect(err.name).toBe('AbortError');
		expect(err.cause).toBe(sdkError);
		const controller = new AbortController();
		controller.abort(); // default reason is a DOMException AbortError → returned as is
		expect((toAbortError(controller.signal, sdkError) as Error).name).toBe('AbortError');
	});
});

describe('chat defaults are pinned (design §5.3, §18)', () => {
	it('context window 32768, keep-alive 30m, Ollama HTTP timeout 120 s, agent model qwen3.8:27b-mlx on ollama, thinking off', () => {
		expect(DEFAULT_CHAT_CONTEXT_WINDOW).toBe(32768);
		expect(DEFAULT_OLLAMA_KEEP_ALIVE).toBe('30m');
		expect(DEFAULT_OLLAMA_TIMEOUT_MS).toBe(120_000);
		expect(DEFAULT_AGENT_MODEL).toEqual({ provider: 'ollama', model: 'qwen3.8:27b-mlx' });
		expect(DEFAULT_AGENT_THINKING).toBe('off');
	});

	it('pins IMAGE_INPUT_TOKEN_ALLOWANCE at 1600 (Anthropic max-size image after resize, code review R1-1)', () => {
		expect(IMAGE_INPUT_TOKEN_ALLOWANCE).toBe(1600);
	});
});
