import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock the `ollama` SDK ---

const mockGenerate = vi.fn();
const mockList = vi.fn();

vi.mock('ollama', () => {
	class MockOllama {
		generate = mockGenerate;
		list = mockList;
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
