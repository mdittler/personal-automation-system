#!/usr/bin/env tsx
/**
 * Real-LLM iteration driver for the PAS food-app receipt/query flow.
 *
 * Spins up a full composeRuntime() against a seeded temp directory using a
 * real AnthropicProvider, runs 10 natural-language prompts, checks oracles,
 * and prints a pass/fail table.  Aborts early if cumulative estimated cost
 * exceeds $1.00.
 *
 * Usage:
 *   pnpm tsx scripts/iterate-prompts.ts --api-key=$ANTHROPIC_API_KEY
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { composeRuntime } from '../core/src/compose-runtime.js';
import type { RuntimeHandle } from '../core/src/compose-runtime.js';
import { requestContext } from '../core/src/services/context/request-context.js';
import { fakeTelegramService } from '../core/src/testing/fixtures/fake-telegram.js';
import type { FakeTelegramService } from '../core/src/testing/fixtures/fake-telegram.js';
import { seedUsers } from '../core/src/testing/fixtures/seed-users.js';
import type { SystemConfig } from '../core/src/types/config.js';
import type { MessageContext } from '../core/src/types/telegram.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OracleResult {
	pass: boolean;
	reason: string;
}

interface TestCase {
	prompt: string;
	oracle: (reply: string) => OracleResult;
}

interface CaseResult {
	index: number;
	prompt: string;
	reply: string;
	oracle: OracleResult;
}

// ---------------------------------------------------------------------------
// Seed data constants
// ---------------------------------------------------------------------------

const COSTCO_RECEIPT_YAML = `\
id: 2026-05-01-costco-test
store: Costco
date: 2026-05-01
capturedAt: 2026-05-01T18:00:00.000Z
lineItems:
  - { name: Spindrift, quantity: 1, unitPrice: 19.69, totalPrice: 19.69 }
  - { name: Q-Tips, quantity: 1, unitPrice: 9.99, totalPrice: 9.99 }
  - { name: Huggies Pull-Ups 3T-4T, quantity: 1, unitPrice: 39.99, totalPrice: 39.99 }
  - { name: KS Blueberry Muffins, quantity: 1, unitPrice: 9.29, totalPrice: 9.29 }
  - { name: Blueberries, quantity: 1, unitPrice: 7.69, totalPrice: 7.69 }
  - { name: Chicken Breast, quantity: 1, unitPrice: 28.99, totalPrice: 28.99 }
  - { name: Olive Oil, quantity: 1, unitPrice: 14.99, totalPrice: 14.99 }
  - { name: Kirkland Mixed Nuts, quantity: 1, unitPrice: 19.99, totalPrice: 19.99 }
  - { name: Parmesan Cheese, quantity: 1, unitPrice: 11.99, totalPrice: 11.99 }
  - { name: Greek Yogurt, quantity: 1, unitPrice: 8.99, totalPrice: 8.99 }
  - { name: Salmon Fillets, quantity: 1, unitPrice: 29.99, totalPrice: 29.99 }
  - { name: Baby Wipes, quantity: 1, unitPrice: 16.99, totalPrice: 16.99 }
  - { name: Laundry Detergent, quantity: 1, unitPrice: 19.99, totalPrice: 19.99 }
  - { name: Paper Towels, quantity: 1, unitPrice: 24.99, totalPrice: 24.99 }
  - { name: Strawberries, quantity: 1, unitPrice: 7.49, totalPrice: 7.49 }
  - { name: Avocados, quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }
  - { name: Ground Coffee, quantity: 1, unitPrice: 15.99, totalPrice: 15.99 }
  - { name: Tortilla Chips, quantity: 1, unitPrice: 8.49, totalPrice: 8.49 }
  - { name: Salsa, quantity: 1, unitPrice: 5.99, totalPrice: 5.99 }
  - { name: Orange Juice, quantity: 1, unitPrice: 8.99, totalPrice: 8.99 }
  - { name: Eggs, quantity: 1, unitPrice: 7.99, totalPrice: 7.99 }
subtotal: 272.93
tax: 33.84
total: 306.77
priceUpdates:
  - { receiptName: Spindrift, normalizedName: Spindrift Sparkling Water, price: 19.69, status: updated, department: Beverages, unit: '', updatedAt: '2026-05-01' }
  - { receiptName: Blueberries, normalizedName: Blueberries, price: 7.69, status: added, department: Produce, unit: '', updatedAt: '2026-05-01' }
`;

const TJ_RECEIPT_YAML = `\
id: 2026-04-29-tj-test
store: Trader Joes
date: 2026-04-29
capturedAt: 2026-04-29T18:00:00.000Z
lineItems:
  - { name: Ground Beef, quantity: 1, unitPrice: 8.99, totalPrice: 8.99 }
  - { name: Tomatoes, quantity: 1, unitPrice: 2.99, totalPrice: 2.99 }
  - { name: Blueberries, quantity: 1, unitPrice: 2.99, totalPrice: 2.99 }
subtotal: 14.97
tax: 0
total: 14.97
`;

const COSTCO_PRICES_MD = `\
---
store: Costco
slug: costco
last_updated: 2026-05-01
type: price-list
entity_keys:
  - costco
---

## Produce
- Blueberries: $7.69 <!-- updated: 2026-05-01 -->
- Strawberries: $7.49 <!-- updated: 2026-05-01 -->

## Beverages
- Spindrift Sparkling Water: $19.69 <!-- updated: 2026-05-01 -->
`;

const TJ_PRICES_MD = `\
---
store: Trader Joes
slug: trader-joes
last_updated: 2026-05-01
type: price-list
entity_keys:
  - trader joes
---

## Produce
- Blueberries: $6.49 <!-- updated: 2026-05-01 -->
`;

// ---------------------------------------------------------------------------
// Costco item names for oracle checks
// ---------------------------------------------------------------------------

const COSTCO_ITEMS = [
	'Spindrift',
	'Q-Tips',
	'Huggies',
	'Blueberry Muffins',
	'Blueberries',
	'Chicken',
	'Olive Oil',
	'Mixed Nuts',
	'Parmesan',
	'Greek Yogurt',
	'Salmon',
	'Baby Wipes',
	'Laundry',
	'Paper Towels',
	'Strawberries',
	'Avocados',
	'Coffee',
	'Tortilla',
	'Salsa',
	'Orange Juice',
	'Eggs',
];

function countCostcoItems(reply: string): number {
	const lower = reply.toLowerCase();
	return COSTCO_ITEMS.filter((item) => lower.includes(item.toLowerCase())).length;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

const TEST_CASES: TestCase[] = [
	{
		// Case 1 — break out all 21 item prices
		prompt:
			'Can you break out the price of each of the 21 items from my Costco receipt and indicate what is new?',
		oracle(reply) {
			const itemCount = countCostcoItems(reply);
			const hasTruncationHint = /first 10 items/i.test(reply);
			if (itemCount < 5) {
				return { pass: false, reason: `Only ${itemCount} seeded items found in reply` };
			}
			if (hasTruncationHint) {
				return { pass: false, reason: 'Reply truncated to first 10 items' };
			}
			return { pass: true, reason: `${itemCount} seeded items found` };
		},
	},
	{
		// Case 2 — last Costco trip date + total
		prompt: 'When was my last trip to Costco? How much did it cost?',
		oracle(reply) {
			const hasDate = /2026-05-01|May\s+1/i.test(reply);
			const hasCost = /\$?306/i.test(reply);
			if (!hasDate) return { pass: false, reason: 'Date 2026-05-01 / May 1 not found' };
			if (!hasCost) return { pass: false, reason: 'Total $306 not found' };
			return { pass: true, reason: 'Date and cost present' };
		},
	},
	{
		// Case 3 — receipt query should NOT claim there is no meal plan or ask to generate one
		prompt: 'Meal plan? I want to know about the receipt I just sent you.',
		oracle(reply) {
			const lower = reply.toLowerCase();
			if (/\bgenerate\b/.test(lower) && /meal plan/i.test(lower)) {
				return {
					pass: false,
					reason: 'Reply offered to generate a meal plan instead of showing receipt',
				};
			}
			if (/no meal plan/i.test(lower)) {
				return { pass: false, reason: 'Reply said "no meal plan" — receipt query misrouted' };
			}
			return { pass: true, reason: 'No meal-plan deflection detected' };
		},
	},
	{
		// Case 4 — items + total from Costco receipt
		prompt: 'Can you send me those items? How much was the total?',
		oracle(reply) {
			const itemCount = countCostcoItems(reply);
			const hasCost = /\$306|306\.77/i.test(reply);
			if (itemCount > 5 || hasCost) {
				return { pass: true, reason: `${itemCount} items found, cost present=${hasCost}` };
			}
			return { pass: false, reason: `Only ${itemCount} items; total $306 not found` };
		},
	},
	{
		// Case 5 — price comparison for blueberries
		prompt: 'Can you tell me the cheapest spot to buy blueberries?',
		oracle(reply) {
			const hasTJ = /trader\s*joe/i.test(reply);
			const hasPrice = /\$6\.49|6\.49/i.test(reply);
			if (!hasTJ) return { pass: false, reason: 'Trader Joes not mentioned' };
			if (!hasPrice) return { pass: false, reason: '$6.49 TJ blueberry price not mentioned' };
			return { pass: true, reason: 'Trader Joes and $6.49 both present' };
		},
	},
	{
		// Case 6 — spending by store
		prompt: 'How much do I typically spend at each grocery store?',
		oracle(reply) {
			const lower = reply.toLowerCase();
			const hasCostco = /costco/i.test(reply);
			const hasTrader = /trader/i.test(reply);
			const hasCostcoCost = /\$?306/i.test(reply);
			const hasBadPhrase = /no meal plan/i.test(lower);
			if (!hasCostco) return { pass: false, reason: 'Costco not mentioned' };
			if (!hasTrader) return { pass: false, reason: 'Trader Joes not mentioned' };
			if (!hasCostcoCost) return { pass: false, reason: 'Costco total $306 not mentioned' };
			if (hasBadPhrase) return { pass: false, reason: '"no meal plan" found — misrouted' };
			return { pass: true, reason: 'Both stores and Costco cost present' };
		},
	},
	{
		// Case 7 — grocery list query (regression guard — should not error)
		prompt: 'Is there anything on the grocery list?',
		oracle(reply) {
			if (/\berror\b/i.test(reply)) {
				return { pass: false, reason: 'Reply contains the word "error"' };
			}
			return { pass: true, reason: 'No error word in reply' };
		},
	},
	{
		// Case 8 — Costco blueberry price
		prompt: 'How much are blueberries at Costco?',
		oracle(reply) {
			const hasCostco = /costco/i.test(reply);
			const hasPrice = /\$7\.69|7\.69/i.test(reply);
			if (!hasCostco) return { pass: false, reason: 'Costco not mentioned' };
			if (!hasPrice) return { pass: false, reason: '$7.69 price not mentioned' };
			return { pass: true, reason: 'Costco and $7.69 both present' };
		},
	},
	{
		// Case 9 — what did I buy at Costco last time
		prompt: 'What did I buy at Costco last time?',
		oracle(reply) {
			const itemCount = countCostcoItems(reply);
			if (itemCount < 3) {
				return { pass: false, reason: `Only ${itemCount} seeded Costco items mentioned` };
			}
			return { pass: true, reason: `${itemCount} seeded items mentioned` };
		},
	},
	{
		// Case 10 — new items from last receipt
		prompt: 'What is new from my last receipt?',
		oracle(reply) {
			const lower = reply.toLowerCase();
			const hasNewOrAdded = /\bnew\b|\badded\b/i.test(lower);
			if (!hasNewOrAdded) {
				return { pass: false, reason: 'Neither "new" nor "added" found in reply' };
			}
			return { pass: true, reason: '"new" or "added" mentioned' };
		},
	},
];

// ---------------------------------------------------------------------------
// Cost estimation (very rough: $3/$15 per 1M in/out for claude-sonnet-4-6)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE_TOKENS = 2000;
const COST_PER_INPUT_TOKEN = 3 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;
const COST_CAP_USD = 1.0;

function estimateCost(inputTokens: number, outputTokens: number): number {
	return inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
}

// ---------------------------------------------------------------------------
// Truncate helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen - 3)}...`;
}

// ---------------------------------------------------------------------------
// Write seed data into the data directory
// ---------------------------------------------------------------------------

async function writeSeedData(dataDir: string): Promise<void> {
	const sharedFood = join(dataDir, 'users', 'shared', 'food');

	const receiptsDir = join(sharedFood, 'receipts');
	const pricesDir = join(sharedFood, 'prices');

	await mkdir(receiptsDir, { recursive: true });
	await mkdir(pricesDir, { recursive: true });

	await writeFile(join(receiptsDir, '2026-05-01-costco-test.yaml'), COSTCO_RECEIPT_YAML, 'utf8');
	await writeFile(join(receiptsDir, '2026-04-29-tj-test.yaml'), TJ_RECEIPT_YAML, 'utf8');
	await writeFile(join(pricesDir, 'costco.md'), COSTCO_PRICES_MD, 'utf8');
	await writeFile(join(pricesDir, 'trader-joes.md'), TJ_PRICES_MD, 'utf8');
}

// ---------------------------------------------------------------------------
// Build a MessageContext for the seeded user
// ---------------------------------------------------------------------------

function buildMessageContext(userId: string, prompt: string, index: number): MessageContext {
	return {
		userId,
		text: prompt,
		chatId: 10000 + index,
		messageId: index,
		timestamp: new Date(),
	};
}

// ---------------------------------------------------------------------------
// Run a single test case
// ---------------------------------------------------------------------------

async function runCase(
	testCase: TestCase,
	index: number,
	userId: string,
	householdId: string,
	runtime: RuntimeHandle,
	telegram: FakeTelegramService,
): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
	// Clear previously recorded messages
	telegram.sent.length = 0;

	const ctx = buildMessageContext(userId, testCase.prompt, index);

	await requestContext.run({ userId, householdId }, () =>
		runtime.services.router.routeMessage(ctx),
	);

	// Collect all sent messages for this user
	const reply = telegram.sent
		.filter((m) => m.userId === userId)
		.map((m) => m.text)
		.join('\n');

	// We cannot easily extract token counts from routeMessage; approximate from
	// reply length. The cost guard is best-effort for this harness.
	// Include system prompt base tokens (typically 2000-5000 chars) + user prompt.
	const approxInputTokens = SYSTEM_PROMPT_BASE_TOKENS + Math.ceil(testCase.prompt.length / 4);
	const approxOutputTokens = Math.ceil(reply.length / 4);

	return { reply, inputTokens: approxInputTokens, outputTokens: approxOutputTokens };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const { values: args } = parseArgs({
		options: {
			'api-key': { type: 'string' },
		},
		allowPositionals: false,
	});

	const apiKey = args['api-key'];
	if (!apiKey) {
		console.error('Error: --api-key is required');
		console.error('Usage: pnpm tsx scripts/iterate-prompts.ts --api-key=$ANTHROPIC_API_KEY');
		process.exit(1);
	}

	const stableTempDir = join(tmpdir(), `pas-iterate-${process.pid}`);
	await mkdir(stableTempDir, { recursive: true });

	let runtime: RuntimeHandle | undefined;

	try {
		const logger = pino({ level: 'warn' });

		// Seed minimal users + households
		const seed = await seedUsers({ dataDir: stableTempDir, users: 1, households: 1 });
		const user = seed.users[0];
		if (!user) throw new Error('seedUsers returned no users');

		const dataDir = join(stableTempDir, 'data');

		// Write food app seed data
		await writeSeedData(dataDir);

		// Patch config to use real Anthropic provider instead of stub
		const anthropicRef = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
		const config: SystemConfig = {
			...seed.config,
			dataDir,
			claude: {
				apiKey,
				model: 'claude-sonnet-4-6',
				fastModel: 'claude-haiku-4-5-20251001',
			},
			llm: {
				providers: {
					anthropic: {
						type: 'anthropic',
						name: 'Anthropic',
						apiKeyEnvVar: 'ANTHROPIC_API_KEY_ITERATE',
						defaultModel: 'claude-sonnet-4-6',
					},
				},
				tiers: {
					fast: anthropicRef,
					standard: anthropicRef,
					reasoning: anthropicRef,
				},
			},
		};

		// Inject the API key via environment so createProvider() can read it
		process.env.ANTHROPIC_API_KEY_ITERATE = apiKey;

		const telegram = fakeTelegramService();

		runtime = await composeRuntime({
			dataDir,
			configPath: seed.configPath,
			config,
			telegramService: telegram,
			logger,
		});

		console.log('Running 10 prompts against real LLM (claude-sonnet-4-6)...\n');

		const results: CaseResult[] = [];
		let cumulativeCostUsd = 0;

		for (let i = 0; i < TEST_CASES.length; i++) {
			const testCase = TEST_CASES[i];
			if (!testCase) continue;

			// Cost cap check before each call
			if (cumulativeCostUsd > COST_CAP_USD) {
				console.warn(
					`\nCost cap reached ($${cumulativeCostUsd.toFixed(4)} > $${COST_CAP_USD}). Aborting.`,
				);
				break;
			}

			let reply = '';
			let inputTokens = 0;
			let outputTokens = 0;

			try {
				({ reply, inputTokens, outputTokens } = await runCase(
					testCase,
					i,
					user.id,
					user.householdId,
					runtime,
					telegram,
				));
			} catch (err) {
				reply = `[ERROR: ${err instanceof Error ? err.message : String(err)}]`;
			}

			const approxCost = estimateCost(inputTokens, outputTokens);
			cumulativeCostUsd += approxCost;

			// Cost cap check after each call (post-check after accumulating usage)
			if (cumulativeCostUsd > COST_CAP_USD) {
				console.warn(
					`\nCost cap exceeded ($${cumulativeCostUsd.toFixed(4)} > $${COST_CAP_USD}). Aborting after this call.`,
				);
				const oracle = testCase.oracle(reply);
				results.push({ index: i + 1, prompt: testCase.prompt, reply, oracle });
				break;
			}

			const oracle = testCase.oracle(reply);
			results.push({ index: i + 1, prompt: testCase.prompt, reply, oracle });
		}

		// ---------------------------------------------------------------------------
		// Print results table
		// ---------------------------------------------------------------------------

		const header = '| # | Prompt (60 chars) | Reply (240 chars) | Oracle |';
		const sep = '|---|---|---|---|';
		const rows = results.map((r) => {
			const passStr = r.oracle.pass ? '✅ PASS' : '❌ FAIL';
			return `| ${r.index} | ${truncate(r.prompt, 60)} | ${truncate(r.reply, 240)} | ${passStr} |`;
		});

		console.log(header);
		console.log(sep);
		for (const row of rows) {
			console.log(row);
		}

		const passCount = results.filter((r) => r.oracle.pass).length;
		console.log(`\nSummary: ${passCount}/${results.length} PASS`);
		console.log(`Estimated cost: $${cumulativeCostUsd.toFixed(4)}`);

		const failed = results.filter((r) => !r.oracle.pass);
		if (failed.length > 0) {
			console.log('\nFAILED CASES:');
			for (const f of failed) {
				console.log(
					`\nCase ${f.index}: ${f.prompt}\nOracle reason: ${f.oracle.reason}\nFull reply:\n${f.reply}`,
				);
			}
		}

		process.exitCode = passCount === results.length ? 0 : 1;
	} finally {
		if (runtime) await runtime.dispose();
		await rm(stableTempDir, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
