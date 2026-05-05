/**
 * Tests for the shared data-answer-formatter utility.
 */

import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataQueryResult } from '../../types/data-query.js';
import type { LLMService } from '../../types/llm.js';
import { formatDataAnswer } from '../data-answer-formatter.js';

function makeLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger;
}

function makeLLM(response: string | Error = 'Here is the answer'): LLMService {
	return {
		complete:
			response instanceof Error
				? vi.fn().mockRejectedValue(response)
				: vi.fn().mockResolvedValue(response),
		classify: vi.fn(),
		extractStructured: vi.fn(),
	} as unknown as LLMService;
}

const emptyResult: DataQueryResult = { files: [], empty: true };

const nonEmptyResult: DataQueryResult = {
	files: [
		{
			path: 'users/user1/food/recipes/tacos.yaml',
			appId: 'food',
			type: 'recipe',
			title: 'Tacos',
			content: 'ingredients: beef, tortillas\nservings: 4',
		},
	],
	empty: false,
};

describe('formatDataAnswer', () => {
	let logger: Logger;

	beforeEach(() => {
		logger = makeLogger();
	});

	it('returns null when dataResult.empty is true', async () => {
		const llm = makeLLM();
		const result = await formatDataAnswer('how many tacos?', emptyResult, llm, logger);
		expect(result).toBeNull();
		expect(llm.complete).not.toHaveBeenCalled();
	});

	it('calls LLM with standard tier and includes the question', async () => {
		const llm = makeLLM('You have a tacos recipe with beef and tortillas, serving 4.');
		const result = await formatDataAnswer(
			'what ingredients are in my tacos?',
			nonEmptyResult,
			llm,
			logger,
		);

		expect(llm.complete).toHaveBeenCalledOnce();
		const [prompt, opts] = vi.mocked(llm.complete).mock.calls[0] as [string, { tier?: string }];
		expect(opts?.tier).toBe('standard');
		expect(prompt).toContain('what ingredients are in my tacos?');
		expect(prompt).toContain('Tacos');
		expect(result).toBe('You have a tacos recipe with beef and tortillas, serving 4.');
	});

	it('returns LLM response on success', async () => {
		const llm = makeLLM('The answer is 42.');
		const result = await formatDataAnswer('some question', nonEmptyResult, llm, logger);
		expect(result).toBe('The answer is 42.');
	});

	it('returns null on LLM error and logs a warning', async () => {
		const llm = makeLLM(new Error('LLM unavailable'));
		const result = await formatDataAnswer('some question', nonEmptyResult, llm, logger);
		expect(result).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	/**
	 * TDD Batch 5 — Phase 4: prompt extensions for price/receipt file types.
	 *
	 * RED: the current prompt has no price or receipt formatting guidance.
	 * GREEN: guidance line added → tests pass.
	 */

	it('prompt includes price/receipt formatting guidance (RC7)', async () => {
		const pricesResult: DataQueryResult = {
			files: [
				{
					path: 'users/user1/food/prices/costco.md',
					appId: 'food',
					type: 'prices',
					title: 'Costco Prices',
					content: 'blueberries: $7.69\napples: $5.49',
				},
			],
			empty: false,
		};
		const llm = makeLLM('Blueberries at Costco are $7.69.');
		await formatDataAnswer('how much are blueberries at Costco?', pricesResult, llm, logger);
		const [prompt] = vi.mocked(llm.complete).mock.calls[0] as [string, ...unknown[]];
		// RED: prompt lacks this guidance. GREEN: guidance line added to prompt.
		expect(prompt).toContain('include specific amounts');
	});

	it('prompt includes receipt formatting guidance for receipt files (RC7)', async () => {
		const receiptResult: DataQueryResult = {
			files: [
				{
					path: 'users/user1/food/receipts/costco-2026-01-15.yaml',
					appId: 'food',
					type: 'receipt',
					title: 'Costco Jan 15',
					content:
						'store: Costco\ntotal: 306.77\nlineItems:\n  - name: Blueberries\n    price: 7.69',
				},
			],
			empty: false,
		};
		const llm = makeLLM('Your Costco receipt totaled $306.77.');
		await formatDataAnswer('what was my last Costco receipt?', receiptResult, llm, logger);
		const [prompt] = vi.mocked(llm.complete).mock.calls[0] as [string, ...unknown[]];
		// RED: prompt lacks this guidance. GREEN: guidance line added to prompt.
		expect(prompt).toContain('include the total');
	});
});
