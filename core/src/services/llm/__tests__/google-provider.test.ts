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

describe('GoogleProvider — responseFormat plumbing (Batch 1)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGenerateContent.mockResolvedValue({
			text: '{"ok":true}',
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
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
