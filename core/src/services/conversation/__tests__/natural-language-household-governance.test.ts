/**
 * Chatbot — Household Governance Persona Tests
 *
 * Tests the user-visible behavior when household LLM rate/cost caps are hit.
 * Exercises the classifyLLMError scope-aware translation through handleMessage.
 *
 * Harness: mock CoreServices with services.llm configured to throw specific
 * household-scoped errors. Asserts on the Telegram reply the user sees, not
 * the internal guard machinery (which is covered in llm-household-governance
 * integration tests).
 *
 * Personas: Matt (user-1) and Nina (user-2) share household hA;
 *           Alice (user-3) is in a separate household hB.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockCoreServices,
} from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { requestContext } from '../../context/request-context.js';
import { LLMCostCapError, LLMRateLimitError } from '../../llm/errors.js';
import { ConversationService } from '../conversation-service.js';
import type { CoreServices } from '@pas/core/types';

// ---------------------------------------------------------------------------
// makeService helper
// ---------------------------------------------------------------------------

function makeService(services: CoreServices): ConversationService {
	return new ConversationService({
		llm: services.llm,
		telegram: services.telegram,
		data: services.data,
		logger: services.logger,
		timezone: 'UTC',
		systemInfo: services.systemInfo,
		appMetadata: services.appMetadata,
		appKnowledge: services.appKnowledge,
		modelJournal: services.modelJournal,
		contextStore: services.contextStore,
		config: services.config,
		dataQuery: services.dataQuery ?? undefined,
		interactionContext: services.interactionContext ?? undefined,
	});
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const MATT = { userId: 'user-1', householdId: 'hA' };
const NINA = { userId: 'user-2', householdId: 'hA' };
const ALICE = { userId: 'user-3', householdId: 'hB' };

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

function makeHouseholdRateLimitError(householdId: string): LLMRateLimitError {
	return new LLMRateLimitError({
		scope: 'household',
		householdId,
		maxRequests: 3,
		windowSeconds: 3600,
	});
}

function makeHouseholdCostCapError(householdId: string): LLMCostCapError {
	return new LLMCostCapError({
		scope: 'household',
		householdId,
		currentCost: 0.5,
		cap: 0.5,
	});
}

function makeReservationExceededError(): LLMCostCapError {
	return new LLMCostCapError({
		scope: 'reservation-exceeded',
		currentCost: 0,
		cap: 0,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendMessage(
	services: ReturnType<typeof createMockCoreServices>,
	userId: string,
	householdId: string,
	text: string,
) {
	const ctx = createTestMessageContext({ userId, text });
	await requestContext.run({ userId, householdId }, () => makeService(services).handleMessage(ctx));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Chatbot — Household Governance Persona Tests', () => {
	let services: ReturnType<typeof createMockCoreServices>;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	// ====================================================================
	// 1. Household rate cap
	// ====================================================================

	describe('Persona: Matt hits household rate cap', () => {
		it('casual chat messages succeed when under the cap', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				'Sure, happy to help with your grocery list!',
			);

			await sendMessage(services, MATT.userId, MATT.householdId, 'hey can you help me with my grocery list?');

			expect(services.telegram.send).toHaveBeenCalledWith(
				MATT.userId,
				expect.stringContaining('grocery list'),
			);
		});

		it('another casual message also succeeds', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue('The weather looks nice today!');

			await sendMessage(services, MATT.userId, MATT.householdId, "what's the weather like today?");

			expect(services.telegram.send).toHaveBeenCalled();
			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).not.toContain('household');
		});

		it('message that triggers household rate cap → reply names the household limit (not generic app limit)', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(
				makeHouseholdRateLimitError(MATT.householdId),
			);

			await sendMessage(services, MATT.userId, MATT.householdId, 'ugh what was I gonna ask again?');

			expect(services.telegram.send).toHaveBeenCalled();
			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toContain('household');
			expect(sentText).not.toContain('next month');
		});

		it('household rate cap reply is marked retryable (says "try again later", not "service unavailable")', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(
				makeHouseholdRateLimitError(MATT.householdId),
			);

			await sendMessage(services, MATT.userId, MATT.householdId, 'remind me what we were talking about');

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).not.toMatch(/service will resume next month/i);
		});
	});

	// ====================================================================
	// 2. Household cost cap (shared between Matt and Nina in hA)
	// ====================================================================

	describe('Persona: household shares a cost cap (Matt + Nina in hA)', () => {
		it('Matt hits household monthly cost cap → reply mentions household budget, not app budget', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(
				makeHouseholdCostCapError(MATT.householdId),
			);

			await sendMessage(services, MATT.userId, MATT.householdId, "i wanna know what's in our pantry");

			expect(services.telegram.send).toHaveBeenCalled();
			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toContain('household');
		});

		it("household cost cap mentions the monthly limit so Matt knows it's not a transient error", async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(
				makeHouseholdCostCapError(MATT.householdId),
			);

			await sendMessage(services, MATT.userId, MATT.householdId, 'can you write a shopping list for dinner tonight?');

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toMatch(/month|budget|limit/i);
		});

		it('Nina in the same household sees the household cap reply (not a generic error)', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(
				makeHouseholdCostCapError(NINA.householdId),
			);

			await sendMessage(services, NINA.userId, NINA.householdId, 'honey what were we supposed to pick up from the store?');

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toContain('household');
		});

		it('Alice in hB is unaffected — her messages get normal chatbot responses', async () => {
			vi.mocked(services.llm.complete).mockResolvedValue(
				'Here is a great pasta recipe for tonight!',
			);

			await sendMessage(services, ALICE.userId, ALICE.householdId, "what's a good recipe for pasta tonight?");

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toContain('pasta');
			expect(sentText).not.toContain('household');
			expect(sentText).not.toMatch(/limit|cap|budget/i);
		});
	});

	// ====================================================================
	// 3. Reservation-exceeded: retry-later semantics
	// ====================================================================

	describe('Persona: reservation-exceeded surfaces as retry-later', () => {
		it('reservation-exceeded → "try again" copy (not "monthly limit reached")', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(makeReservationExceededError());

			await sendMessage(services, MATT.userId, MATT.householdId, 'what should we have for dinner tonight?');

			expect(services.telegram.send).toHaveBeenCalled();
			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toMatch(/try again/i);
			expect(sentText).not.toMatch(/service will resume next month/i);
		});

		it('reservation-exceeded does NOT mention household — it is a transient retry signal', async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(makeReservationExceededError());

			await sendMessage(services, MATT.userId, MATT.householdId, 'can you remind me to call the dentist?');

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).not.toMatch(/household|budget|monthly/i);
		});

		it("Nina's reservation-exceeded also gets the retry-later copy", async () => {
			vi.mocked(services.llm.complete).mockRejectedValue(makeReservationExceededError());

			await sendMessage(services, NINA.userId, NINA.householdId, 'is there anything left in the fridge?');

			const sentText = vi.mocked(services.telegram.send).mock.calls[0]?.[1] as string;
			expect(sentText).toMatch(/try again/i);
		});
	});

	// ====================================================================
	// 4. Error scope distinctness — all three scope messages differ
	// ====================================================================

	describe('error scope messages are distinct from each other', () => {
		it('household-rate-limit, household-cost-cap, and reservation-exceeded produce different Telegram replies', async () => {
			const messages: string[] = [];

			vi.mocked(services.llm.complete).mockRejectedValue(makeHouseholdRateLimitError('hA'));
			await sendMessage(services, MATT.userId, MATT.householdId, 'first message');
			messages.push(vi.mocked(services.telegram.send).mock.calls.at(-1)?.[1] as string);

			vi.mocked(services.llm.complete).mockRejectedValue(makeHouseholdCostCapError('hA'));
			await sendMessage(services, MATT.userId, MATT.householdId, 'second message');
			messages.push(vi.mocked(services.telegram.send).mock.calls.at(-1)?.[1] as string);

			vi.mocked(services.llm.complete).mockRejectedValue(makeReservationExceededError());
			await sendMessage(services, MATT.userId, MATT.householdId, 'third message');
			messages.push(vi.mocked(services.telegram.send).mock.calls.at(-1)?.[1] as string);

			// All three must be distinct
			expect(messages[0]).not.toBe(messages[1]);
			expect(messages[1]).not.toBe(messages[2]);
			expect(messages[0]).not.toBe(messages[2]);
		});
	});
});
