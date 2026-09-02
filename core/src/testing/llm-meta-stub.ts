/**
 * Test helper: give a `complete`-only LLM stub a matching `completeWithMeta`.
 *
 * Several services now call `completeWithMeta` so they can tell a reply cut off
 * at their `maxTokens` budget from a genuinely malformed one (see
 * `classifyStructuredOutput` in `utils/json-strip-fences.ts`). Their test stubs
 * predate that and only define `complete`; many are handed over with
 * `as unknown as`, so the omission surfaces at RUNTIME as
 * `completeWithMeta is not a function` rather than at compile time.
 *
 * The fix used everywhere is to DELEGATE to the same `complete` mock rather
 * than add a second independent one, so existing call-count, prompt and option
 * assertions on `complete` stay meaningful.
 *
 * No vitest import on purpose — this file is compiled into `dist` alongside the
 * rest of `src/testing`, and the delegation needs nothing from the test runner.
 */

import type { LLMCompletionMeta, LLMFinishReason } from '../types/llm.js';

/**
 * Return `llm` with a `completeWithMeta` that forwards to its own `complete`.
 *
 * Mutates and returns the same object so callers can keep a reference to the
 * underlying mocks (`h.llm.complete`).
 *
 * @param finishReason reported by every `completeWithMeta` call. Pass `'length'`
 *   to simulate a reply cut off at the caller's token budget.
 */
export function withCompleteWithMeta<T extends object>(
	llm: T,
	finishReason: LLMFinishReason = 'stop',
): T & { completeWithMeta(prompt: string, options?: unknown): Promise<LLMCompletionMeta> } {
	const target = llm as T & {
		complete(prompt: string, options?: unknown): Promise<string>;
		completeWithMeta?: (prompt: string, options?: unknown) => Promise<LLMCompletionMeta>;
	};
	target.completeWithMeta = async (prompt: string, options?: unknown) => ({
		text: await target.complete(prompt, options),
		finishReason,
	});
	return target as T & {
		completeWithMeta(prompt: string, options?: unknown): Promise<LLMCompletionMeta>;
	};
}
