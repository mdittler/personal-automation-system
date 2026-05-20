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
 */

import type { LLMService } from '@core/types/llm.js';

export class StubLLMService implements Pick<LLMService, 'complete' | 'classify'> {
	private responses: string[] = [];
	public calls = 0;
	public lastPrompt = '';
	public lastOptions: unknown = undefined;

	queue(response: string): this {
		this.responses.push(response);
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
		return r;
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
		const parsed = JSON.parse(r) as { category: string; confidence: number };
		return parsed;
	}
}
