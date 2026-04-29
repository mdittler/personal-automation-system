/**
 * Photo Memory Bridge Persona Tests
 * ====================================
 *
 * Verifies end-to-end that photo-summary data written to the ChatSessionStore
 * survives into the LLM system prompt — so the chatbot can answer follow-up
 * questions about receipts, recipes, pantry scans, and grocery photos.
 *
 * Key principle (feedback_persona_test_scoping.md):
 *   These tests assert PROMPT CONTENT (deterministic, verifiable), NOT LLM
 *   output. We capture what gets sent to the LLM and assert the photo summary
 *   is there.
 *
 * Why /ask for negatives: free-text messages route through the classifier
 * first; using the prompt-builder path directly (via sendAskAndCaptureLLMPrompt)
 * tests the chatbot prompt path, not classifier routing.
 *
 * Coverage:
 *   1. Receipt → ask about specific items (15 messages, 1 truncation test)
 *   2. Recipe photo → ask about it (5 messages)
 *   3. Pantry photo → ask about it (5 messages)
 *   4. /newchat clears active session (multi-step, 3 assertions)
 *   5. /ask without prior photo — receipt content NOT in prompt (15 negatives)
 *   6. Grocery list photo → ask about it (5 messages)
 */

import { describe, expect, it } from 'vitest';
import { createPersonaEnv } from './helpers/persona-env.js';

// ─── Scenario 1: Receipt → ask about specific items ─────────────────────────

describe('Scenario 1: receipt → ask about specific item present', () => {
	const messages = [
		'how much was the goldfish crackers',
		'what was the price on the salmon',
		'did i get bananas',
		'the eggs were how much',
		'show me everything I bought',
		'price of the asparagus',
		'how much did the cheese cost',
		'what about the green beans',
		'how much for the dates',
		'did i buy any blueberries',
		'can you tell me how much I paid for the salmon',
		'the bananas, what did those run me',
		'whats the cost on the cheddar',
		'what was the most expensive thing',
		'how many items total',
		'tell me the total',
	];

	const lineItems = [
		{ name: 'Asparagus', quantity: 1, unitPrice: 7.29, totalPrice: 7.29 },
		{ name: 'Salmon', quantity: 1, unitPrice: 30.11, totalPrice: 30.11 },
		{ name: 'Goldfish Crackers (45ct)', quantity: 1, unitPrice: 12.99, totalPrice: 12.99 },
		{ name: 'Pasture Eggs', quantity: 1, unitPrice: 7.99, totalPrice: 7.99 },
		{ name: 'Sharp Cheddar', quantity: 1, unitPrice: 13.99, totalPrice: 13.99 },
		{ name: 'Green Beans', quantity: 1, unitPrice: 6.49, totalPrice: 6.49 },
		{ name: 'Bananas', quantity: 1, unitPrice: 2.19, totalPrice: 2.19 },
		{ name: 'Blueberries', quantity: 1, unitPrice: 6.89, totalPrice: 6.89 },
		{ name: 'Mozzarella', quantity: 1, unitPrice: 9.99, totalPrice: 9.99 },
		{ name: 'Organic Dates', quantity: 1, unitPrice: 9.89, totalPrice: 9.89 },
	];

	it.each(messages)(
		'after receipt upload, "%s" prompt contains receipt items+prices',
		async (msg) => {
			const env = await createPersonaEnv();
			try {
				await env.uploadReceipt({
					store: 'Costco',
					date: '2026-04-29',
					total: 306.77,
					lineItems,
				});
				const prompt = await env.sendAskAndCaptureLLMPrompt(msg);
				expect(prompt).toContain('Costco');
				expect(prompt).toContain('306.77');
				expect(prompt).toContain('Salmon');
				expect(prompt).toContain('30.11');
				expect(prompt).toContain('Bananas');
				// PHOTO_SUMMARY_GUIDANCE is always injected
				expect(prompt).toContain('captured photo summary');
			} finally {
				await env.teardown();
			}
		},
	);

	it('long receipt (21 items): 10th item still in rendered prompt (truncation exemption)', async () => {
		const env = await createPersonaEnv();
		try {
			const items = Array.from({ length: 21 }, (_, i) => ({
				name: `Distinctive Item Name ${i}`,
				quantity: 1,
				unitPrice: 1.0,
				totalPrice: 1.0,
			}));
			await env.uploadReceipt({
				store: 'Costco',
				date: '2026-04-29',
				total: 21,
				lineItems: items,
			});
			const prompt = await env.sendAskAndCaptureLLMPrompt('whats on the receipt');
			// buildReceiptSummary slices the first 10 items (MAX_TOP_ITEMS = 10)
			// so index 9 = "Distinctive Item Name 9" must appear
			expect(prompt).toContain('Distinctive Item Name 9');
		} finally {
			await env.teardown();
		}
	});
});

// ─── Scenario 2: Recipe photo → ask about it ────────────────────────────────

describe('Scenario 2: recipe photo → ask about it', () => {
	const messages = [
		'what recipe did I save',
		'how many steps',
		'how many ingredients',
		'what is it called',
		'is it saved',
	];

	it.each(messages)(
		'after recipe upload, "%s" prompt contains recipe info',
		async (msg) => {
			const env = await createPersonaEnv();
			try {
				await env.uploadRecipe({ title: 'Lemon Pasta', ingredientCount: 6, stepCount: 4 });
				const prompt = await env.sendAskAndCaptureLLMPrompt(msg);
				expect(prompt).toContain('Lemon Pasta');
				expect(prompt).toContain('[Photo: recipe]');
				expect(prompt).toContain('captured photo summary');
			} finally {
				await env.teardown();
			}
		},
	);
});

// ─── Scenario 3: Pantry photo → ask about it ────────────────────────────────

describe('Scenario 3: pantry photo → ask about it', () => {
	const messages = [
		'what did I scan into my pantry',
		'what items were added',
		'what did the fridge photo show',
		'what was in my freezer',
		'did you capture my pantry items',
	];

	it.each(messages)(
		'after pantry upload, "%s" prompt contains pantry info',
		async (msg) => {
			const env = await createPersonaEnv();
			try {
				await env.uploadPantry([
					{ name: 'Milk', quantity: '1 gal' },
					{ name: 'Eggs', quantity: '12' },
				]);
				const prompt = await env.sendAskAndCaptureLLMPrompt(msg);
				expect(prompt).toContain('[Photo: pantry]');
				expect(prompt).toContain('Milk');
				expect(prompt).toContain('captured photo summary');
			} finally {
				await env.teardown();
			}
		},
	);
});

// ─── Scenario 4: /newchat clears active session (multi-step) ─────────────────

describe('Scenario 4: /newchat clears active session (multi-step)', () => {
	it('after /newchat, prior receipt is NOT in active session turns', async () => {
		const env = await createPersonaEnv();
		try {
			await env.uploadReceipt({
				store: 'Costco',
				date: '2026-04-29',
				total: 306.77,
				lineItems: [{ name: 'Salmon', quantity: 1, unitPrice: 30.11, totalPrice: 30.11 }],
			});

			// Start a new chat session — ends the current one
			await env.startNewSession();

			// After /newchat the active session is cleared; loadRecentTurns returns []
			const turns = await env.chatSessions.loadRecentTurns(
				{
					userId: env.userId,
					sessionKey: `agent:main:telegram:dm:${env.userId}`,
				},
				{ maxTurns: 10 },
			);
			for (const t of turns) {
				expect(t.content).not.toContain('Salmon');
			}
		} finally {
			await env.teardown();
		}
	});

	it('after /newchat, prompt built from new (empty) session has no prior receipt', async () => {
		const env = await createPersonaEnv();
		try {
			await env.uploadReceipt({
				store: 'Costco',
				date: '2026-04-29',
				total: 100,
				lineItems: [{ name: 'OldItem', quantity: 1, unitPrice: 10, totalPrice: 10 }],
			});

			await env.startNewSession();

			// Build a prompt for the new (empty) session
			const prompt = await env.sendAskAndCaptureLLMPrompt('what was on the receipt');
			// New session has no turns yet, so history section is absent → no OldItem
			expect(prompt).not.toContain('OldItem');
		} finally {
			await env.teardown();
		}
	});

	it('after receipt → /newchat → new receipt, only new receipt in prompt', async () => {
		const env = await createPersonaEnv();
		try {
			await env.uploadReceipt({
				store: 'Costco',
				date: '2026-04-29',
				total: 100,
				lineItems: [{ name: 'OldItem', quantity: 1, unitPrice: 10, totalPrice: 10 }],
			});
			await env.startNewSession();
			await env.uploadReceipt({
				store: 'Safeway',
				date: '2026-04-29',
				total: 50,
				lineItems: [{ name: 'NewItem', quantity: 1, unitPrice: 5, totalPrice: 5 }],
			});

			const prompt = await env.sendAskAndCaptureLLMPrompt('what was on the receipt');
			expect(prompt).toContain('NewItem');
			expect(prompt).toContain('Safeway');
			// OldItem is in a now-ended prior session — not in the current session's turns
			expect(prompt).not.toContain('OldItem');
		} finally {
			await env.teardown();
		}
	});
});

// ─── Scenario 5: /ask without prior photo — receipt content NOT in prompt ────

describe('Scenario 5: /ask without prior photo — receipt content NOT in prompt', () => {
	const messages = [
		'whats 2 plus 2',
		'what time is it',
		'tell me a joke',
		'who won the world cup in 2022',
		'just saying hi',
		'good morning',
		'thanks',
		'wait',
		'ok',
		'how are you',
		'what model are you',
		'help',
		'what apps do I have',
		'any news today',
		'tell me about the weather in Vancouver',
	];

	it.each(messages)(
		'without receipt upload, "%s" prompt has no receipt content',
		async (msg) => {
			const env = await createPersonaEnv();
			try {
				const prompt = await env.sendAskAndCaptureLLMPrompt(msg);
				expect(prompt).not.toContain('🧾 Receipt captured');
				expect(prompt).not.toContain('Costco');
			} finally {
				await env.teardown();
			}
		},
	);
});

// ─── Scenario 6: Grocery list photo → ask about it ──────────────────────────

describe('Scenario 6: grocery list photo → ask about it', () => {
	const messages = [
		'what items did you scan from the photo',
		'what grocery items were added',
		'what was on the shopping list in the photo',
		'did you capture the grocery list',
		'what did the photo show',
	];

	it.each(messages)(
		'after grocery upload, "%s" prompt contains grocery info',
		async (msg) => {
			const env = await createPersonaEnv();
			try {
				await env.uploadGrocery([
					{ name: 'Milk', quantity: 2, unit: 'gal' },
					{ name: 'Bread', quantity: 1, unit: 'loaf' },
				]);
				const prompt = await env.sendAskAndCaptureLLMPrompt(msg);
				expect(prompt).toContain('[Photo: grocery list]');
				expect(prompt).toContain('Milk');
				expect(prompt).toContain('captured photo summary');
			} finally {
				await env.teardown();
			}
		},
	);
});
