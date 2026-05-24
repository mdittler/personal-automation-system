/**
 * REQ-ROUTE-022 — natural-language multi-intent persona scenarios. Each
 * case is a realistic Telegram message a user would actually type that
 * triggers the multi-intent splitter; expected outcome is one combined
 * Telegram message (or as few as possible given the 4000-char cap).
 *
 * The harness mocks the segmenter so the corpus is deterministic. Real
 * LLM segmenter behavior is covered by the regression suite, not here.
 * The fake app handler calls `services.telegram.send(ctx.userId, 'reply: ' + ctx.text)`
 * so the combined output deterministically contains a reply-prefix marker per
 * segment that assertions can pattern-match.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppModule, CoreServices } from '../../../types/app-module.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { ContextAwareTelegramService } from '../../telegram/context-aware.js';
import { buildRouter, createTextCtx, echoManifest } from './test-helpers.js';

interface Recorded {
	method: string;
	userId: string;
	text?: string;
}

function makeRealTelegram(): { real: TelegramService; sends: Recorded[] } {
	const sends: Recorded[] = [];
	const real = {
		send: vi.fn(async (userId: string, text: string) => {
			sends.push({ method: 'send', userId, text });
		}),
		sendPhoto: vi.fn(async () => {}),
		sendOptions: vi.fn(async () => ''),
		sendWithButtons: vi.fn(async () => ({ chatId: 1, messageId: 1 })),
		editMessage: vi.fn(async () => {}),
	} as unknown as TelegramService;
	return { real, sends };
}

async function runPersonaCase(
	input: string,
	segments: string[],
	preFilterReturns = true,
): Promise<Recorded[]> {
	const { real, sends } = makeRealTelegram();
	const services = {
		telegram: new ContextAwareTelegramService(real),
	} as unknown as CoreServices;
	const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
		manifest: echoManifest,
		module: {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn(async (ctx: MessageContext) => {
				await services.telegram.send(ctx.userId, `reply: ${ctx.text}`);
			}),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		},
	};
	// classifyResults needs one entry per dispatched segment. When preFilter
	// returns false the splitter declines; the message goes through the
	// single-message path which classifies once. When preFilter returns true,
	// each segment is classified once. Provide a generous list either way.
	const classifyResults = new Array(Math.max(segments.length, 1))
		.fill(null)
		.map(() => ({ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 }));
	const { router } = buildRouter({
		telegram: real,
		apps: [fakeApp],
		preFilter: vi.fn(() => preFilterReturns),
		segment: vi.fn(async () => segments),
		classifyResults,
	});
	await router.routeMessage(createTextCtx(input));
	return sends;
}

const NATURAL_MULTI_INTENT_CASES = [
	{
		input: "What's for dinner tonight and how much did I spend at Costco?",
		segments: ["What's for dinner tonight", 'How much did I spend at Costco?'],
		expectCombinedContains: ['dinner', 'Costco'],
	},
	{
		input: "add milk to the grocery list and what's in my pantry",
		segments: ['add milk to the grocery list', "what's in my pantry"],
		expectCombinedContains: ['milk', 'pantry'],
	},
	{
		input: 'show me my recipes and tell me my health stats',
		segments: ['show me my recipes', 'tell me my health stats'],
		expectCombinedContains: ['recipes', 'health'],
	},
	{
		input: 'whats for dinner, add eggs to groceries, and how many calories did i eat today',
		segments: ['whats for dinner', 'add eggs to groceries', 'how many calories did i eat today'],
		expectCombinedContains: ['dinner', 'eggs', 'calories'],
	},
	{
		input:
			"hey could you do me a favor, add bananas to my list, and also tell me what's in the pantry?",
		segments: ['add bananas to my list', "tell me what's in the pantry"],
		expectCombinedContains: ['bananas', 'pantry'],
	},
	{
		input: "GROCERY LIST. ALSO, what's the cheapest store for eggs???",
		segments: ['grocery list', "what's the cheapest store for eggs"],
		expectCombinedContains: ['grocery', 'eggs'],
	},
];

describe('Multi-intent natural-language persona — combined-reply UX (REQ-ROUTE-022)', () => {
	for (const { input, segments, expectCombinedContains } of NATURAL_MULTI_INTENT_CASES) {
		it(`"${input}" → preamble + 1 combined message`, async () => {
			const sends = await runPersonaCase(input, segments, true);
			expect(sends).toHaveLength(2);
			expect(sends[0]?.text).toMatch(/Got it/);
			for (const expected of expectCombinedContains) {
				expect(sends[1]?.text).toContain(expected);
			}
			// Combined message uses \n\n separators between segment replies
			expect(sends[1]?.text?.split('\n\n')).toHaveLength(segments.length);
		});
	}

	it('long combined message auto-splits at segment boundaries', async () => {
		const { real, sends } = makeRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		// 3 segments × 1800-char replies → 1800+2+1800 = 3602 ≤ 4000 in chunk 1,
		// 1800 alone in chunk 2.
		const sizeBySeg: Record<string, string> = {
			s1: 'A'.repeat(1800),
			s2: 'B'.repeat(1800),
			s3: 'C'.repeat(1800),
		};
		const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
			manifest: echoManifest,
			module: {
				init: vi.fn().mockResolvedValue(undefined),
				handleMessage: vi.fn(async (ctx: MessageContext) => {
					await services.telegram.send(ctx.userId, sizeBySeg[ctx.text] ?? '');
				}),
				handleCommand: vi.fn().mockResolvedValue(undefined),
				handlePhoto: vi.fn().mockResolvedValue(undefined),
			},
		};
		const { router } = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['s1', 's2', 's3']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});
		await router.routeMessage(createTextCtx('s1; s2; s3'));
		expect(sends).toHaveLength(3); // preamble + 2 packed messages
		for (const s of sends) {
			expect((s.text ?? '').length).toBeLessThanOrEqual(4000);
		}
		const combined = sends
			.slice(1)
			.map((s) => s.text ?? '')
			.join('');
		expect(combined.split('A').length - 1).toBe(1800);
		expect(combined.split('B').length - 1).toBe(1800);
		expect(combined.split('C').length - 1).toBe(1800);
	});

	const SHOULD_NOT_SPLIT_CASES = [
		'whats for dinner',
		'how much did i spend at costco',
		'hey',
		'good morning',
		'show me recipes with chicken and pasta',
		'add salt and pepper to my list',
	];

	for (const input of SHOULD_NOT_SPLIT_CASES) {
		it(`"${input}" → no preamble, single-message path`, async () => {
			// preFilter returns FALSE for these — the splitter declines.
			const sends = await runPersonaCase(input, [], false);
			// Exactly 1 send: the handler reply. No preamble.
			expect(sends).toHaveLength(1);
			expect(sends[0]?.text?.startsWith('reply: ')).toBe(true);
			expect(sends[0]?.text).not.toMatch(/Got it/);
		});
	}
});
