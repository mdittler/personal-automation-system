/**
 * User persona tests for D1 chatbot (Phase 2 review).
 *
 * Tests use natural language a real user would actually type in Telegram.
 * These cover:
 *   1. Classifier gets the right topic hints for the message domain
 *   2. App-aware vs basic prompt is chosen correctly per message type
 *   3. Full handleMessage flow produces the right kind of output
 *   4. Message splitting works on realistic long responses
 *   5. Household context appears in prompt when user is in a space
 *
 * The LLM is mocked — the "YES/NO" the mock returns represents what a real
 * LLM classifier would answer given those messages and the classifier prompt.
 */

import type { CoreServices } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockCoreServices,
	createMockScopedStore,
} from '../../../../core/src/testing/mock-services.js';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';
import { expectBasicPrompt, expectPasAwarePrompt } from './helpers/prompt-assertions.js';
import * as chatbot from '../index.js';
import { classifyPASMessage } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up services with auto_detect_pas ON (the new default). */
function withAutoDetect(services: CoreServices) {
	vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });
	vi.mocked(services.appMetadata.getEnabledApps).mockResolvedValue([
		{
			id: 'food',
			name: 'Food',
			description: 'Food tracker and grocery manager',
			version: '1.0.0',
			commands: [{ name: '/food', description: 'Food commands' }],
			intents: [],
			schedules: [],
		},
		{
			id: 'notes',
			name: 'Notes',
			description: 'Daily notes',
			version: '1.0.0',
			commands: [{ name: '/notes', description: 'Notes commands' }],
			intents: [],
			schedules: [],
		},
	]);
}

// ---------------------------------------------------------------------------
// 1. Classifier prompt content — verifying the classifier gets useful hints
// ---------------------------------------------------------------------------

describe('classifier prompt content', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		await chatbot.init(services);
		vi.mocked(services.llm.complete).mockResolvedValue('YES');
	});

	it('classifier prompt describes PAS domains so real LLM can classify food questions', async () => {
		await classifyPASMessage("what did I have for dinner last Tuesday?", services);

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0][1]?.systemPrompt ?? '';
		// Prompt must describe the food/grocery/health domain
		expect(systemPrompt).toContain('food');
		// Must give answer instruction (now YES_DATA/YES/NO)
		expect(systemPrompt).toContain('YES');
	});

	it('classifier prompt describes scheduling so it can classify reminder questions', async () => {
		await classifyPASMessage("can you remind me to take my medication at 8pm?", services);

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0][1]?.systemPrompt ?? '';
		expect(systemPrompt).toContain('scheduling');
	});

	it('classifier prompt describes system status so it can classify cost/model questions', async () => {
		await classifyPASMessage("how much am I spending on AI this month?", services);

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0][1]?.systemPrompt ?? '';
		expect(systemPrompt).toContain('model');
		expect(systemPrompt).toContain('cost');
	});

	it('classifier receives installed app names to help classify app-specific questions', async () => {
		vi.mocked(services.appMetadata.getInstalledApps).mockReturnValue([
			{
				id: 'food',
				name: 'Food',
				description: 'Food tracker',
				version: '1.0.0',
				commands: [],
				intents: [],
				hasSchedules: false,
				hasEvents: false,
				acceptsPhotos: false,
			},
		]);

		await classifyPASMessage("how do I add a recipe?", services);

		const systemPrompt = vi.mocked(services.llm.complete).mock.calls[0][1]?.systemPrompt ?? '';
		expect(systemPrompt).toContain('Food');
	});

	it('classifier receives the actual user text so a real LLM can evaluate it', async () => {
		const userMessage = "I'm going to Costco later, what should I grab?";
		await classifyPASMessage(userMessage, services);

		const textSentToLLM = vi.mocked(services.llm.complete).mock.calls[0][0] as string;
		// Text should be present (sanitized, but content preserved for normal input)
		expect(textSentToLLM).toContain('Costco');
	});
});

// ---------------------------------------------------------------------------
// 2. PAS-related messages → app-aware prompt
// These are messages a real LLM classifier would return YES for.
// ---------------------------------------------------------------------------

describe('PAS-related user messages route to app-aware prompt', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		withAutoDetect(services);
		await chatbot.init(services);
	});

	it('user asks what apps they have installed', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier
			.mockResolvedValueOnce('You have Food and Notes installed.');
		const ctx = createTestMessageContext({ text: 'what apps do I have?' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
		expect(services.telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			'You have Food and Notes installed.',
		);
	});

	it('user asks to see their grocery list', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — grocery = food app = PAS
			.mockResolvedValueOnce("Here's your current grocery list: milk, eggs, bread.");
		const ctx = createTestMessageContext({ text: "what's on my grocery list?" });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
	});

	it('user asks what they ate last week', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — food log query = PAS
			.mockResolvedValueOnce('Last Tuesday you had pasta for dinner.');
		const ctx = createTestMessageContext({ text: 'what did I eat last week?' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
	});

	it('user asks how much they are spending on AI', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — cost query = PAS
			.mockResolvedValueOnce("You've spent $2.34 this month.");
		const ctx = createTestMessageContext({ text: 'how much am I spending on AI this month?' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
	});

	it('user wants to switch to a smarter AI model', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — model switching = PAS
			.mockResolvedValueOnce('Switched to claude-opus.');
		const ctx = createTestMessageContext({ text: 'can you switch to a smarter model?' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
	});

	it('user asks about their notes from yesterday', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — notes data query = PAS
			.mockResolvedValueOnce('Here are your notes from yesterday...');
		const ctx = createTestMessageContext({ text: 'show me my notes from yesterday' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectPasAwarePrompt(mainPrompt);
	});
});

// ---------------------------------------------------------------------------
// 3. Non-PAS messages → basic (friendly) prompt
// These are messages a real LLM classifier would return NO for.
// ---------------------------------------------------------------------------

describe('casual / general messages route to basic prompt', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		withAutoDetect(services);
		await chatbot.init(services);
	});

	it('user asks for a joke', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO') // classifier — jokes are not PAS
			.mockResolvedValueOnce('Why did the robot go on a diet? Too many bytes!');
		const ctx = createTestMessageContext({ text: 'tell me a joke' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectBasicPrompt(mainPrompt);
	});

	it('user asks what the weather is like', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO') // classifier — weather is not PAS
			.mockResolvedValueOnce("I don't have live weather data, but you could check a weather app!");
		const ctx = createTestMessageContext({ text: "what's the weather like today?" });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectBasicPrompt(mainPrompt);
	});

	it('user asks a math question', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO') // classifier — math is not PAS
			.mockResolvedValueOnce('15% of 340 is 51.');
		const ctx = createTestMessageContext({ text: "what's 15% of 340?" });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectBasicPrompt(mainPrompt);
	});

	it('user sends a casual greeting', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO') // classifier — greeting is not PAS
			.mockResolvedValueOnce('Hey! How can I help you today?');
		const ctx = createTestMessageContext({ text: 'hey how are you doing?' });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectBasicPrompt(mainPrompt);
	});

	it('user asks for a translation', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO') // classifier — translation is not PAS
			.mockResolvedValueOnce("'Hello' in Spanish is 'Hola'.");
		const ctx = createTestMessageContext({ text: "how do you say 'hello' in Spanish?" });

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expectBasicPrompt(mainPrompt);
	});
});

// ---------------------------------------------------------------------------
// 4. Household context in responses
// ---------------------------------------------------------------------------

describe('household context in chatbot responses', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		withAutoDetect(services);
		await chatbot.init(services);
	});

	it('user in a named household sees their household name in the prompt context', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce('You have Food and Notes installed for the Smith household.');
		const ctx = createTestMessageContext({
			text: 'what apps do we have?',
			spaceName: 'Smith Household',
		});

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		// The LLM should know which household it's talking to
		expect(mainPrompt).toContain('Smith Household');
	});

	it('user asking a casual question still gets their household in context', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO')
			.mockResolvedValueOnce('Here is a joke for you!');
		const ctx = createTestMessageContext({
			text: 'tell me something funny',
			spaceName: 'Johnson Home',
		});

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		// Even casual prompts get household context
		expect(mainPrompt).toContain('Johnson Home');
	});

	it('user with no household set does not see household line in prompt', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO')
			.mockResolvedValueOnce('Here is a joke!');
		const ctx = createTestMessageContext({
			text: 'tell me a joke',
			spaceName: undefined,
		});

		await chatbot.handleMessage(ctx);

		const mainPrompt = vi.mocked(services.llm.complete).mock.calls[1][1]?.systemPrompt ?? '';
		expect(mainPrompt).not.toContain('household');
	});
});

// ---------------------------------------------------------------------------
// 5. Long responses are split into multiple Telegram messages
// ---------------------------------------------------------------------------

describe('long chatbot responses are split for Telegram', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		withAutoDetect(services);
		vi.mocked(services.data.forUser).mockReturnValue(createMockScopedStore());
		await chatbot.init(services);
	});

	it('a detailed multi-section response is delivered as multiple messages', async () => {
		// Simulate a long response a user might get when asking about all their apps
		const foodSection = `## Food App\n${'The Food app tracks your meals, grocery lists, and recipes. '.repeat(30)}`;
		const notesSection = `## Notes App\n${'The Notes app stores your daily thoughts and reminders. '.repeat(30)}`;
		const systemSection = `## System Status\n${'Everything is running smoothly. Your current model is claude-sonnet. '.repeat(20)}`;
		const longResponse = `Here is a summary of everything in your system:\n\n${foodSection}\n\n${notesSection}\n\n${systemSection}`;

		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES')
			.mockResolvedValueOnce(longResponse);
		const ctx = createTestMessageContext({ text: 'give me a full summary of my system' });

		await chatbot.handleMessage(ctx);

		// Should have been sent in multiple parts (long response > 3800 chars)
		const sendCalls = vi.mocked(services.telegram.send).mock.calls;
		expect(sendCalls.length).toBeGreaterThan(1);
		// Each part must be safe for Telegram
		for (const [, message] of sendCalls) {
			expect((message as string).length).toBeLessThanOrEqual(4096);
		}
		// All content must be delivered
		const allDelivered = sendCalls.map(([, m]) => m as string).join('\n\n');
		expect(allDelivered).toContain('Food App');
		expect(allDelivered).toContain('Notes App');
		expect(allDelivered).toContain('System Status');
	});

	it('a short response (typical answer) is delivered as a single message', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('NO')
			.mockResolvedValueOnce('Sure! Here is a quick joke for you.');
		const ctx = createTestMessageContext({ text: 'tell me a quick joke' });

		await chatbot.handleMessage(ctx);

		const sendCalls = vi.mocked(services.telegram.send).mock.calls;
		expect(sendCalls.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 6. /ask command with natural language questions
// ---------------------------------------------------------------------------

describe('/ask command with natural language questions', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		vi.mocked(services.appMetadata.getEnabledApps).mockResolvedValue([]);
		await chatbot.init(services);
	});

	it('/ask with no question shows friendly examples a real user can follow', async () => {
		const ctx = createTestMessageContext({ text: '/ask' });

		await chatbot.handleCommand?.('ask', [], ctx);

		const [, message] = vi.mocked(services.telegram.send).mock.calls[0];
		// Should be user-friendly (not just a bare API error)
		expect(message as string).toContain('what apps do I have');
		expect(message as string).toContain('how does');
		// No LLM call needed for the intro
		expect(services.llm.complete).not.toHaveBeenCalled();
	});

	it('/ask about installed apps always uses app-aware prompt (no classifier needed)', async () => {
		vi.mocked(services.llm.complete).mockResolvedValueOnce('You have Food and Notes installed.');
		const ctx = createTestMessageContext({
			text: '/ask what apps do I have?',
			spaceName: 'My Household',
		});

		await chatbot.handleCommand?.('ask', ['what', 'apps', 'do', 'I', 'have?'], ctx);

		// /ask now runs classifier first (fast tier), then main response (standard tier)
		expect(services.llm.complete).toHaveBeenCalledTimes(2);
		const standardCall = vi.mocked(services.llm.complete).mock.calls.find((c) => c[1]?.tier === 'standard');
		const prompt = standardCall?.[1]?.systemPrompt ?? '';
		expectPasAwarePrompt(prompt);
		// And household context is included
		expect(prompt).toContain('My Household');
	});

	it('/ask about costs gives a helpful answer with correct prompt context', async () => {
		vi.mocked(services.llm.complete)
			.mockResolvedValueOnce('YES') // classifier — PAS spending question but not a data file query
			.mockResolvedValueOnce("You've spent $1.20 this month."); // main LLM
		const ctx = createTestMessageContext({ text: '/ask how much have I spent this month?' });

		await chatbot.handleCommand?.('ask', ['how', 'much', 'have', 'I', 'spent', 'this', 'month?'], ctx);

		// /ask now runs classifier (fast tier) then main response (standard tier)
		const standardCall = vi.mocked(services.llm.complete).mock.calls.find((c) => c[1]?.tier === 'standard');
		const prompt = standardCall?.[1]?.systemPrompt ?? '';
		expectPasAwarePrompt(prompt);
		expect(services.telegram.send).toHaveBeenCalledWith(
			expect.any(String),
			"You've spent $1.20 this month.",
		);
	});
});
