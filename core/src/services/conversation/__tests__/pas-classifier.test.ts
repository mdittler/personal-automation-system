import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import { classifyPASMessage, isPasRelevant } from '../pas-classifier.js';

describe('isPasRelevant', () => {
	it('returns true for PAS keyword messages (happy path)', () => {
		expect(isPasRelevant('what apps do I have?')).toBe(true);
		expect(isPasRelevant('how does scheduling work')).toBe(true);
	});

	it('returns false for off-topic messages', () => {
		expect(isPasRelevant("what's the weather like today?")).toBe(false);
	});

	it('returns false for empty/whitespace', () => {
		expect(isPasRelevant('')).toBe(false);
		expect(isPasRelevant('   ')).toBe(false);
	});

	it('detects installed app names via deps.appMetadata', () => {
		const services = createMockCoreServices();
		vi.mocked(services.appMetadata.getInstalledApps).mockReturnValue([
			{
				id: 'weather',
				name: 'Weather',
				description: 'Weather app',
				version: '1.0.0',
				commands: [{ name: '/weather', description: 'Get weather' }],
				intents: [],
				hasSchedules: false,
				hasEvents: false,
				acceptsPhotos: false,
			},
		]);
		expect(
			isPasRelevant('tell me about the Weather app', { appMetadata: services.appMetadata }),
		).toBe(true);
	});
});

describe('classifyPASMessage', () => {
	it('returns pasRelated=false without LLM call for empty text', async () => {
		const services = createMockCoreServices();
		const result = await classifyPASMessage('   ', {
			llm: services.llm,
			appMetadata: services.appMetadata,
			logger: services.logger,
		});
		expect(result.pasRelated).toBe(false);
		expect(services.llm.complete).not.toHaveBeenCalled();
	});

	it('returns pasRelated=true when LLM responds YES (PAS)', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockResolvedValue('YES');
		const result = await classifyPASMessage('what apps do I have', {
			llm: services.llm,
			appMetadata: services.appMetadata,
			logger: services.logger,
		});
		expect(result.pasRelated).toBe(true);
		expect(result.dataQueryCandidate).toBeFalsy();
	});

	it('returns pasRelated=true and dataQueryCandidate=true on YES_DATA', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockResolvedValue('YES_DATA');
		const result = await classifyPASMessage('what are my Costco prices', {
			llm: services.llm,
			appMetadata: services.appMetadata,
			logger: services.logger,
		});
		expect(result.pasRelated).toBe(true);
		expect(result.dataQueryCandidate).toBe(true);
	});

	it('returns pasRelated=false when LLM responds NO', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockResolvedValue('NO');
		const result = await classifyPASMessage('tell me a joke', {
			llm: services.llm,
			appMetadata: services.appMetadata,
			logger: services.logger,
		});
		expect(result.pasRelated).toBe(false);
	});

	it('fail-open: returns pasRelated=true when LLM throws', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockRejectedValue(new Error('LLM down'));
		const result = await classifyPASMessage('anything', {
			llm: services.llm,
			appMetadata: services.appMetadata,
			logger: services.logger,
		});
		expect(result.pasRelated).toBe(true);
	});

	it('passes recentContext into the classifier system prompt when provided', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.llm.complete).mockResolvedValue('YES');
		await classifyPASMessage(
			'what did that cost?',
			{ llm: services.llm, appMetadata: services.appMetadata, logger: services.logger },
			'receipt_captured (food, 2m ago)',
		);
		const call = vi.mocked(services.llm.complete).mock.calls[0];
		const sysPrompt = call?.[1]?.systemPrompt ?? '';
		expect(sysPrompt).toContain('Recent user actions');
		expect(sysPrompt).toContain('receipt_captured');
	});
});
