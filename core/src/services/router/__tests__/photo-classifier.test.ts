import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LLMService } from '../../../types/llm.js';
import type { IntentTableEntry } from '../../app-registry/manifest-cache.js';
import { PhotoClassifier } from '../photo-classifier.js';

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

const singleAppTable: IntentTableEntry[] = [
	{ category: 'receipt', appId: 'grocery' },
	{ category: 'grocery photo', appId: 'grocery' },
];

const multiAppTable: IntentTableEntry[] = [
	{ category: 'receipt', appId: 'grocery' },
	{ category: 'landscape', appId: 'photos' },
	{ category: 'document', appId: 'photos' },
];

describe('PhotoClassifier', () => {
	it('should route directly when only one app and no caption', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify(undefined, singleAppTable, 0.4);

		expect(result).toEqual({
			appId: 'grocery',
			photoType: 'receipt',
			confidence: 1.0,
		});
		// Should NOT call LLM
		expect(llm.classify).not.toHaveBeenCalled();
	});

	it('should route directly when only one app WITH caption (skip LLM)', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		// Simulate real-world caption variations that would previously fail LLM classification
		for (const caption of ['grocery receipt_1', 'grocery receipt 2', 'my receipt', 'recipe']) {
			const result = await classifier.classify(caption, singleAppTable, 0.4);

			expect(result).toEqual({
				appId: 'grocery',
				photoType: 'receipt',
				confidence: 1.0,
			});
		}
		// Should NOT call LLM — no routing ambiguity when only one app
		expect(llm.classify).not.toHaveBeenCalled();
	});

	it('should return null when multiple apps and no caption', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify(undefined, multiAppTable, 0.4);

		expect(result).toBeNull();
		expect(llm.classify).not.toHaveBeenCalled();
	});

	it('should classify caption when available', async () => {
		const llm = createMockLLM({ category: 'receipt', confidence: 0.9 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('grocery receipt from today', multiAppTable, 0.4);

		expect(result).toEqual({
			appId: 'grocery',
			photoType: 'receipt',
			confidence: 0.9,
		});
		expect(llm.classify).toHaveBeenCalledWith('grocery receipt from today', [
			'receipt',
			'landscape',
			'document',
		]);
	});

	it('should return null when classification below threshold', async () => {
		const llm = createMockLLM({ category: 'receipt', confidence: 0.2 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('some caption', multiAppTable, 0.4);

		expect(result).toBeNull();
	});

	it('should return null when no photo intents registered', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		const classifier = new PhotoClassifier({ llm, logger: createMockLogger() });

		const result = await classifier.classify('a caption', [], 0.4);

		expect(result).toBeNull();
		expect(llm.classify).not.toHaveBeenCalled();
	});

	it('should return null when LLM throws', async () => {
		const llm = createMockLLM({ category: '', confidence: 0 });
		vi.mocked(llm.classify).mockRejectedValue(new Error('LLM error'));
		const logger = createMockLogger();
		const classifier = new PhotoClassifier({ llm, logger });

		const result = await classifier.classify('test caption', multiAppTable, 0.4);

		expect(result).toBeNull();
		expect(logger.error).toHaveBeenCalled();
	});
});
