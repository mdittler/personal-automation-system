/**
 * Chatbot bucket cases — migrated from scripts/iterate-prompts.ts
 * TEST_CASES (v0 corpus). The v0 substring oracles inform the rubric
 * criteria; the rubric oracle (REQ-REG-005) replaces them with a
 * judge-LLM score-based pass/fail.
 *
 * Codex C3 — every prompt is SELF-CONTAINED. No pronouns referring to
 * prior turns ("those items", "I just sent you"). Cases reference the
 * seeded fixtures by store name and date so cache-skip ordering cannot
 * change context. The chatbot-runner additionally calls
 * `env.endActiveSession()` between inputs.
 *
 * Codex I6 (deferred) — `expectedHandler` was originally declared on every
 * fixture to assert routing correctness alongside reply quality. Removed
 * pending Router instrumentation — see the `ChatbotFixture` JSDoc below.
 *
 * v0 source: scripts/iterate-prompts.ts:182-420
 */

import { fileURLToPath } from 'node:url';
import type { LoadedCase, PersonaCase } from '@core/types/regression.js';

const COVERAGE_BASE = [
	'apps/food/src/index.ts',
	'apps/food/src/services/receipt-query.ts',
	'core/src/services/conversation/handle-message.ts',
	'core/src/services/conversation/handle-ask.ts',
	'core/src/services/conversation-retrieval/conversation-retrieval-service.ts',
];

interface ChatbotFixture {
	id: string;
	description: string;
	prompt: string;
	rubric: string;
	/**
	 * Codex correction: `expectedHandler` is REMOVED from chatbot fixtures.
	 * The current chatbot env factory (`build-deps.ts:131`) ships a placeholder
	 * `captureHandler` that always returns null because the Router does not
	 * yet emit a per-dispatch handler-id event surface-able through
	 * `RuntimeServices`. With `expectedHandler` declared, every chatbot case
	 * would trip the runner's "diagnostic captured no handler" branch and
	 * emit `verdict: 'error'` regardless of reply quality. Until Router
	 * instrumentation lands, chatbot cases grade reply quality via the
	 * rubric oracle alone. Re-introduce `expectedHandler` per fixture once
	 * the instrumentation is wired AND fixture IDs are aligned with the
	 * food app's actual `regexWinner` taxonomy (`receipt_query`,
	 * `price_lookup`, `store_spending`, `grocery_view`, etc. — see
	 * `apps/food/src/index.ts` line ~1000).
	 */
	budgetUsd?: number;
}

const FIXTURES: ChatbotFixture[] = [
	{
		id: 'chatbot-costco-21-items',
		description: 'Break out 21 Costco items + flag what is new',
		prompt:
			'List the items on my Costco receipt from May 1 2026, with each price, and call out which are new entries.',
		rubric:
			'1. Reply MUST mention at least 5 of these Costco items: Spindrift, Blueberries, Chicken, Eggs, Strawberries, Avocados, Coffee, Salmon, Yogurt, Olive Oil.\n2. Reply MUST NOT say "first 10 items" or otherwise truncate.\n3. Reply MUST be readable in a Telegram message (no raw JSON dumps).',
	},
	{
		id: 'chatbot-last-costco-trip',
		description: 'Last Costco trip date + total',
		prompt: 'When was my most recent Costco trip and how much did it cost?',
		rubric:
			'1. Reply MUST mention the date 2026-05-01 or "May 1".\n2. Reply MUST mention $306 (the total).\n3. Reply MUST be relevant to a Costco trip.',
	},
	{
		id: 'chatbot-receipt-vs-meal-plan',
		description: 'Routing guard — receipt query phrased confusingly, must NOT deflect to meal plan',
		prompt: 'Show me the items and total from my most recent Costco receipt — not a meal plan.',
		rubric:
			'1. Reply MUST address the Costco receipt items and total.\n2. Reply MUST NOT offer to generate a meal plan.\n3. Reply MUST NOT say "no meal plan".',
	},
	{
		id: 'chatbot-receipt-items-and-total',
		description: 'Items + total from Costco receipt (self-contained)',
		prompt: 'List the items and total from my most recent Costco receipt.',
		rubric:
			'1. Reply MUST mention more than 5 Costco items OR mention the $306.77 total.\n2. Reply MUST reference Costco.\n3. Reply MUST NOT be empty or "I do not know".',
	},
	{
		id: 'chatbot-cheapest-blueberries',
		description:
			'Price comparison for blueberries — both stores show $6.49 for blueberries; TJ is cheapest baseline',
		prompt: 'Where can I get the cheapest blueberries among the stores I have saved prices for?',
		rubric:
			'1. Reply MUST mention Trader Joes (or "Trader Joe").\n2. Reply MUST mention the $6.49 price (or "6.49").\n3. Reply MUST be a price-comparison answer, not a refusal.\n4. Reply MUST NOT claim a price the seed does not contain.',
	},
	{
		id: 'chatbot-store-spending',
		description: 'Spending breakdown by store',
		prompt: 'How much have I spent at Costco and Trader Joes based on my saved receipts?',
		rubric:
			'1. Reply MUST mention Costco.\n2. Reply MUST mention Trader Joes (or "Trader Joe").\n3. Reply MUST mention the Costco total ($306 or close).\n4. Reply MUST NOT say "no meal plan".',
		budgetUsd: 0.25,
	},
	{
		id: 'chatbot-grocery-list-empty',
		description: 'Routing guard — empty grocery list query must not error',
		prompt: 'What is on my grocery list right now?',
		rubric:
			'1. Reply MUST address the grocery list question (empty list is fine).\n2. Reply MUST NOT contain the word "error".\n3. Reply MUST be a coherent sentence in English.',
	},
	{
		id: 'chatbot-blueberries-at-costco',
		description: 'Costco blueberry price',
		prompt: 'What is the saved price for blueberries at Costco?',
		rubric:
			'1. Reply MUST mention Costco.\n2. Reply MUST mention $7.69 (or "7.69").\n3. Reply MUST NOT suggest a different store as the answer.',
	},
	{
		id: 'chatbot-costco-last-items',
		description: 'Items from the most recent Costco trip',
		prompt: 'What items did I buy on my most recent Costco trip?',
		rubric:
			'1. Reply MUST mention at least 3 of these seeded items: Spindrift, Blueberries, Chicken, Olive Oil, Eggs, Strawberries, Salmon, Coffee.\n2. Reply MUST be specific to the most recent Costco trip.\n3. Reply MUST NOT be a generic refusal.',
	},
	{
		id: 'chatbot-new-receipt-items',
		description: 'New / added items on the most recent Costco receipt',
		prompt: 'Which items on my most recent Costco receipt are new additions to the price list?',
		rubric:
			'1. Reply MUST mention "new" or "added" items.\n2. Reply MUST reference at least one Costco item from the seeded receipt.\n3. Reply MUST NOT say "no new items" given the seeded receipt has priceUpdates with status=added.',
	},
];

export function buildCases(): LoadedCase[] {
	const filePath = fileURLToPath(import.meta.url);
	return FIXTURES.map((fx): LoadedCase => {
		const c: PersonaCase = {
			id: fx.id,
			description: fx.description,
			bucket: 'chatbot',
			coverage: COVERAGE_BASE,
			inputs: [
				{
					payload: fx.prompt,
					expected: {},
				},
			],
			oracle: 'rubric',
			rubric: fx.rubric,
			budgetUsd: fx.budgetUsd ?? 0.15,
		};
		return { case: c, filePath };
	});
}
