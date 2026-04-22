import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { CostTracker } from '../../../services/llm/cost-tracker.js';
import { StubProvider, createStubProviderRegistry } from '../stub-llm-provider.js';

const logger = pino({ level: 'silent' });

let dataDir: string;
let costTracker: CostTracker;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'stub-provider-test-'));
	costTracker = new CostTracker(dataDir, logger);
});

describe('StubProvider', () => {
	it('returns { category, confidence } shape for classification prompts', async () => {
		const provider = new StubProvider(costTracker, logger, {
			classificationCategory: 'food',
		});
		const result = await provider.completeWithUsage(
			'Classify this message. Return JSON with category and confidence.',
		);
		const parsed = JSON.parse(result.text) as unknown;
		expect(parsed).toEqual({ category: 'food', confidence: 0.9 });
	});

	it('returns { category, confidence } when prompt contains "classify"', async () => {
		const provider = new StubProvider(costTracker, logger);
		const result = await provider.completeWithUsage('classify this text for me');
		const parsed = JSON.parse(result.text) as unknown;
		expect(parsed).toMatchObject({ category: expect.any(String), confidence: 0.9 });
	});

	it('returns { category, confidence } when prompt contains "category"', async () => {
		const provider = new StubProvider(costTracker, logger);
		const result = await provider.completeWithUsage(
			'What category does this message belong to?',
		);
		const parsed = JSON.parse(result.text) as unknown;
		expect(parsed).toMatchObject({ category: expect.any(String), confidence: 0.9 });
	});

	it('defaults classification category to chatbot', async () => {
		const provider = new StubProvider(costTracker, logger);
		const result = await provider.completeWithUsage('Return JSON with category field');
		const parsed = JSON.parse(result.text) as { category: string; confidence: number };
		expect(parsed.category).toBe('chatbot');
	});

	it('returns plain text for non-classification prompts', async () => {
		const provider = new StubProvider(costTracker, logger, {
			completionText: 'hello world',
		});
		const result = await provider.completeWithUsage('tell me something');
		expect(result.text).toBe('hello world');
	});

	it('classification has no delay (< 10ms)', async () => {
		const provider = new StubProvider(costTracker, logger);
		const start = Date.now();
		await provider.completeWithUsage('Return JSON with category and confidence');
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(10);
	});

	it('returns usage tokens based on prompt and text length', async () => {
		const provider = new StubProvider(costTracker, logger);
		const prompt = 'Return JSON with category field';
		const result = await provider.completeWithUsage(prompt);
		expect(result.usage).toBeDefined();
		expect(result.usage!.inputTokens).toBeGreaterThan(0);
		expect(result.usage!.outputTokens).toBeGreaterThan(0);
	});

	it('returns model and provider fields', async () => {
		const provider = new StubProvider(costTracker, logger);
		const result = await provider.completeWithUsage('Return JSON with category field');
		expect(result.model).toBe('stub-model');
		expect(result.provider).toBe('stub');
	});

	it('listModels returns stub-model entry', async () => {
		const provider = new StubProvider(costTracker, logger);
		const models = await provider.listModels();
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe('stub-model');
		expect(models[0].provider).toBe('stub');
	});
});

describe('createStubProviderRegistry', () => {
	it('registers a stub provider under id "stub"', () => {
		const registry = createStubProviderRegistry(costTracker, logger);
		expect(registry.has('stub')).toBe(true);
		expect(registry.size).toBe(1);
	});
});
