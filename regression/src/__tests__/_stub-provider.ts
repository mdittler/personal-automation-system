/**
 * Local stub LLM provider for regression-suite unit tests.
 *
 * Why local: `RecordingStubProvider` in
 * `core/src/services/conversation/__tests__/memory-snapshot-freeze.integration.test.ts`
 * is intentionally not exported. Duplicating its tiny surface here keeps the
 * regression workspace free of test-file imports from `core/`.
 *
 * Usage:
 *   const stub = new StubLLMService();
 *   stub.queue('first response');
 *   stub.queue('second response');
 *   // pass `stub` wherever `LLMService` is expected
 *   await stub.complete('hi');           // → 'first response'
 *   await stub.complete('hi again');     // → 'second response'
 *   stub.calls;                          // → 2
 *   stub.lastPrompt;                     // → 'hi again'
 *
 * `queue()` takes an optional finishReason (default 'stop') so callers that go
 * through `completeWithMeta` can be exercised against a cap-truncated reply:
 *   stub.queue('{"score": 2, "explanation": "The reply g', 'length');
 */

import type { LLMCompletionMeta, LLMFinishReason, LLMService } from '@core/types/llm.js';

export class StubLLMService
	implements Pick<LLMService, 'complete' | 'completeWithMeta' | 'classify'>
{
	private responses: Array<{ text: string; finishReason: LLMFinishReason }> = [];
	/** finishReason of the most recently shifted response; read by completeWithMeta. */
	private lastFinishReason: LLMFinishReason = 'stop';
	public calls = 0;
	public lastPrompt = '';
	public lastOptions: unknown = undefined;

	queue(response: string, finishReason: LLMFinishReason = 'stop'): this {
		this.responses.push({ text: response, finishReason });
		return this;
	}

	async complete(prompt: string, options?: unknown): Promise<string> {
		this.calls++;
		this.lastPrompt = prompt;
		this.lastOptions = options;
		const r = this.responses.shift();
		if (r === undefined) {
			throw new Error('StubLLMService: response queue empty (test did not queue enough responses)');
		}
		this.lastFinishReason = r.finishReason;
		return r.text;
	}

	/**
	 * Delegates to `this.complete` on purpose: tests that wrap `stub.complete`
	 * (to simulate a CostTracker advancing during the call) keep working when a
	 * caller switches from `complete` to `completeWithMeta`.
	 */
	async completeWithMeta(prompt: string, options?: unknown): Promise<LLMCompletionMeta> {
		const text = await this.complete(prompt, options);
		return { text, finishReason: this.lastFinishReason };
	}

	async classify(
		_text: string,
		_categories: string[],
	): Promise<{ category: string; confidence: number }> {
		this.calls++;
		const r = this.responses.shift();
		if (r === undefined) {
			throw new Error('StubLLMService.classify: response queue empty');
		}
		const parsed = JSON.parse(r.text) as { category: string; confidence: number };
		return parsed;
	}
}
