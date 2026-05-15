import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock @google/genai SDK ---

const mockGenerateContent = vi.fn();
const mockList = vi.fn();

vi.mock('@google/genai', () => {
	class MockGoogleGenAI {
		models = { generateContent: mockGenerateContent, list: mockList };
	}
	return { GoogleGenAI: MockGoogleGenAI };
});

import { GoogleProvider } from '../providers/google-provider.js';

const logger = pino({ level: 'silent' });

function makeCostTracker() {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	};
}

function makeProvider() {
	return new GoogleProvider({
		providerId: 'google',
		apiKey: 'sk-test-google',
		defaultModel: 'gemini-2.0-flash',
		logger,
		costTracker: makeCostTracker() as never,
	});
}

function makeGoogleResponse(finishReason: string | undefined) {
	return {
		text: 'hi',
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
		candidates: finishReason === undefined ? [{}] : [{ finishReason }],
	};
}

describe('GoogleProvider — responseFormat plumbing (Batch 1)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGenerateContent.mockResolvedValue({
			text: '{"ok":true}',
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
			candidates: [{ finishReason: 'STOP' }],
		});
	});

	it("sets responseMimeType: 'application/json' on the SDK request when responseFormat is 'json'", async () => {
		const provider = makeProvider();
		await provider.complete('classify', { responseFormat: 'json' });
		expect(mockGenerateContent).toHaveBeenCalledTimes(1);
		expect(mockGenerateContent.mock.calls[0]?.[0]?.config).toMatchObject({
			responseMimeType: 'application/json',
		});
	});

	it('does NOT set responseMimeType by default', async () => {
		const provider = makeProvider();
		await provider.complete('plain prompt');
		const config = mockGenerateContent.mock.calls[0]?.[0]?.config;
		expect(config).not.toHaveProperty('responseMimeType');
	});
});

describe('GoogleProvider — finishReason mapping (REQ-FOOD-RECEIPT-INTEGRITY-003)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		['STOP', 'stop'],
		['MAX_TOKENS', 'length'],
		['SAFETY', 'error'],
		['RECITATION', 'error'],
		['OTHER', 'other'],
	] as const)('maps candidates[0].finishReason=%s → %s', async (input, expected) => {
		mockGenerateContent.mockResolvedValue(makeGoogleResponse(input));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe(expected);
	});

	it('maps missing finishReason on candidate → other', async () => {
		mockGenerateContent.mockResolvedValue(makeGoogleResponse(undefined));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	it('maps missing candidates array → other', async () => {
		mockGenerateContent.mockResolvedValue({
			text: 'hi',
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
		});
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});

	it('maps unknown enum value → other (forward-compat)', async () => {
		mockGenerateContent.mockResolvedValue(makeGoogleResponse('LANGUAGE'));
		const provider = makeProvider();
		const result = await provider.completeWithUsage('hi');
		expect(result.finishReason).toBe('other');
	});
});
