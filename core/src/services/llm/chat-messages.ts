/**
 * Provider-neutral helpers for the chat-with-tools path.
 *
 * `validateChatMessages` enforces the shape every provider mapping relies on,
 * so a malformed history fails with one readable error before any network
 * call instead of as a vendor 400.
 */

import { randomBytes } from 'node:crypto';
import type { ChatMessage, ChatToolSpec, ThinkingLevel } from '../../types/llm.js';

export class ChatMessageShapeError extends Error {
	constructor(message: string) {
		super(`Invalid chat messages: ${message}`);
		this.name = 'ChatMessageShapeError';
	}
}

/** Shape of ids we synthesize when a provider (Ollama) returns tool calls without one. */
export const TOOL_CALL_ID_RE = /^call_[0-9a-f]{8}$/;

export function synthesizeToolCallId(): string {
	return `call_${randomBytes(4).toString('hex')}`;
}

/**
 * Rules (each is one provider's hard requirement, applied to all so histories
 * are portable between models):
 *  - at least one message, and at least one non-system message (Anthropic
 *    rejects `messages: []`);
 *  - system messages only at the start (Anthropic takes them as `system`),
 *    each with non-whitespace text (Anthropic rejects an empty text block);
 *  - images only on user messages — including the system prefix;
 *  - a user message carries text (non-whitespace) or images (Anthropic
 *    rejects an empty text block);
 *  - an assistant message carries text (non-whitespace) or tool calls
 *    (Anthropic rejects `content: []`; replaying a model's empty turn is
 *    meaningless on every provider);
 *  - a tool message needs `toolCallId`, must directly follow the assistant
 *    turn that requested it (or another tool result for the same turn), its
 *    id must be one that turn requested, and each requested id is answered
 *    exactly once (Anthropic/OpenAI reject orphans and duplicates);
 *  - every tool call is answered before the next non-tool message and before
 *    the history ends (Anthropic: "tool_use ids were found without tool_result
 *    blocks immediately after");
 *  - tool-call ids are unique within an assistant turn.
 */
export function validateChatMessages(messages: readonly ChatMessage[]): void {
	if (messages.length === 0) throw new ChatMessageShapeError('at least one message is required');

	/** Ids the current assistant turn requested that have not been answered yet. */
	let pending: Set<string> | null = null;
	/** Ids of the current assistant turn that were already answered (duplicate detection). */
	let answered = new Set<string>();
	let seenNonSystem = false;

	const assertNoPending = (i: number) => {
		if (pending && pending.size > 0) {
			const [first] = pending;
			throw new ChatMessageShapeError(
				`unanswered tool call '${first}' — every tool call needs a tool result before message ${i}`,
			);
		}
	};

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as ChatMessage;

		if (m.images?.length && m.role !== 'user') {
			throw new ChatMessageShapeError(`images are only allowed on user messages (message ${i})`);
		}

		if (m.role === 'system') {
			if (seenNonSystem) {
				throw new ChatMessageShapeError(`system messages must come first (message ${i})`);
			}
			if (m.content.trim().length === 0) {
				throw new ChatMessageShapeError(`system message ${i} has no text`);
			}
			continue;
		}
		seenNonSystem = true;

		if (m.role === 'tool') {
			if (!m.toolCallId) {
				throw new ChatMessageShapeError(`tool message ${i} is missing toolCallId`);
			}
			if (!pending && answered.size === 0) {
				throw new ChatMessageShapeError(
					`tool message ${i} must directly follow the assistant turn that requested it`,
				);
			}
			if (answered.has(m.toolCallId)) {
				throw new ChatMessageShapeError(
					`tool message ${i} toolCallId '${m.toolCallId}' was already answered`,
				);
			}
			if (!pending?.has(m.toolCallId)) {
				throw new ChatMessageShapeError(
					`tool message ${i} toolCallId '${m.toolCallId}' does not match a requested tool call`,
				);
			}
			pending.delete(m.toolCallId);
			answered.add(m.toolCallId);
			continue;
		}

		// assistant or user: the previous turn's tool calls must all be answered.
		assertNoPending(i);
		answered = new Set();
		pending = null;

		if (m.role === 'assistant') {
			const ids = new Set<string>();
			for (const call of m.toolCalls ?? []) {
				if (ids.has(call.id)) {
					throw new ChatMessageShapeError(`duplicate tool-call id '${call.id}' (message ${i})`);
				}
				ids.add(call.id);
			}
			if (ids.size === 0 && m.content.trim().length === 0) {
				throw new ChatMessageShapeError(`assistant message ${i} has neither text nor tool calls`);
			}
			pending = ids.size > 0 ? ids : null;
			continue;
		}

		// user
		if (m.content.trim().length === 0 && !m.images?.length) {
			throw new ChatMessageShapeError(`user message ${i} has neither text nor images`);
		}
	}

	if (!seenNonSystem) {
		throw new ChatMessageShapeError('at least one non-system message is required');
	}
	assertNoPending(messages.length);
}

/**
 * Settle `promise`, or reject with the signal's reason as soon as `signal`
 * fires. The underlying work is not cancelled (a shared capability probe must
 * finish and populate its cache for the next caller); only this caller's wait
 * ends. Used around the `/api/show` probe so an abort during a cold Ollama
 * chat returns at once instead of after the 120 s HTTP timeout (R1-6).
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

/** The signal's own reason, or an AbortError when the caller gave none. */
export function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Normalize a provider-reported cancellation (P2-4). The openai and
 * @anthropic-ai/sdk `APIUserAbortError` classes extend `APIError` and keep
 * `.name === 'Error'`, so nothing downstream could recognise them by name.
 * The providers catch them with `instanceof` and rethrow this instead: the
 * caller's own `signal.reason` when there is one (so a custom reason survives),
 * otherwise an `Error` named `AbortError` whose `cause` is the SDK error.
 */
export function toAbortError(signal: AbortSignal | undefined, cause: unknown): unknown {
	if (signal?.reason !== undefined) return signal.reason;
	const err = new Error('The operation was aborted', { cause });
	err.name = 'AbortError';
	return err;
}

/** Ollama `think`: `false` for off/undefined, `true` for the model default, or an explicit level. */
export function toOllamaThink(
	thinking: boolean | ThinkingLevel | undefined,
): boolean | 'low' | 'medium' | 'high' {
	if (thinking === undefined || thinking === false || thinking === 'off') return false;
	if (thinking === true) return true;
	return thinking;
}

/**
 * Text the guards estimate against: everything the provider mappings put on
 * the wire as text — each message's content, replayed assistant thinking, the
 * JSON of assistant tool calls (names + arguments; a raw-string argument is
 * included as is), and the tool list as JSON. Images are not in this string;
 * `countChatImages` feeds `estimateGuardCost`, which adds
 * `IMAGE_INPUT_TOKEN_ALLOWANCE` input tokens per image (code review R1-1).
 * R1-5: a 100k-character tool-call history used to estimate as 5 characters,
 * letting `HouseholdLLMLimiter.checkCost` admit a paid replay past the budget.
 */
export function serializeChatForEstimate(
	messages: readonly ChatMessage[],
	tools: readonly ChatToolSpec[] | undefined,
): string {
	const parts: string[] = [];
	for (const m of messages) {
		parts.push(m.content);
		if (m.thinking) parts.push(m.thinking);
		if (m.toolCalls?.length) parts.push(JSON.stringify(m.toolCalls));
	}
	if (tools?.length) parts.push(JSON.stringify(tools));
	return parts.join('\n');
}

/** Images on the chat, across every message. The guard estimate reserves each one. */
export function countChatImages(messages: readonly ChatMessage[]): number {
	let count = 0;
	for (const m of messages) count += m.images?.length ?? 0;
	return count;
}
