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
