import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LLMService } from '../../../types/llm.js';
import type { IntentTableEntry } from '../../app-registry/manifest-cache.js';
import { IntentClassifier } from '../intent-classifier.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockLLM(classifyResult: { category: string; confidence: number }): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue(classifyResult),
		extractStructured: vi.fn(),
	};
}

const intentTable: IntentTableEntry[] = [
	{ category: 'echo', appId: 'echo' },
	{ category: 'repeat', appId: 'echo' },
	{ category: 'add grocery', appId: 'grocery' },
	{ category: 'grocery list', appId: 'grocery' },
	{ category: 'shopping', appId: 'grocery' },
];

describe('IntentClassifier', () => {
	it('should classify text and return the matching app', async () => {
		const llm = createMockLLM({ category: 'add grocery', confidence: 0.85 });
		const classifier = new IntentClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('add milk to the list', intentTable, 0.4);

		expect(result).toEqual({
			appId: 'grocery',
			intent: 'add grocery',
			confidence: 0.85,
		});
		expect(llm.classify).toHaveBeenCalledWith('add milk to the list', [
			'echo',
			'repeat',
			'add grocery',
			'grocery list',
			'shopping',
		]);
	});

	it('should return null when confidence is below threshold', async () => {
		const llm = createMockLLM({ category: 'echo', confidence: 0.2 });
		const classifier = new IntentClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('something random', intentTable, 0.4);

		expect(result).toBeNull();
	});

	it('should return null when intent table is empty', async () => {
		const llm = createMockLLM({ category: 'anything', confidence: 1.0 });
		const classifier = new IntentClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('hello', [], 0.4);

		expect(result).toBeNull();
		expect(llm.classify).not.toHaveBeenCalled();
	});

	it('should return null when LLM throws an error', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		vi.mocked(llm.classify).mockRejectedValue(new Error('LLM unavailable'));
		const logger = createMockLogger();
		const classifier = new IntentClassifier({ llm, logger });

		const result = await classifier.classify('test', intentTable, 0.4);

		expect(result).toBeNull();
		expect(logger.error).toHaveBeenCalled();
	});

	it('should return null when classified category is not in table', async () => {
		const llm = createMockLLM({ category: 'nonexistent', confidence: 0.9 });
		const logger = createMockLogger();
		const classifier = new IntentClassifier({ llm, logger });

		const result = await classifier.classify('test', intentTable, 0.4);

		expect(result).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	it('should use exact threshold boundary (equal = pass)', async () => {
		const llm = createMockLLM({ category: 'echo', confidence: 0.4 });
		const classifier = new IntentClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('repeat this', intentTable, 0.4);

		expect(result).toEqual({
			appId: 'echo',
			intent: 'echo',
			confidence: 0.4,
		});
	});
});
