/**
 * REQ-ROUTE-017..022 integration tests. Drive the real Router →
 * BufferingTelegramProxy → ContextAwareTelegramService stack. The real
 * telegram is a recording stub (REAL transport); the wrapper is the
 * production ContextAwareTelegramService; the fake apps actually call
 * `services.telegram.send` so the buffer wiring is genuinely exercised
 * (Codex Round 1 #5).
 *
 * Where Task 2.4's `router-multi-intent.test.ts` covers dispatch shape and
 * buffer existence, this file covers the COMBINED OUTPUT — preamble +
 * combined send for 2/3 segments, segment-throw → apology merged with
 * peers, per-user buffer isolation under concurrency, rich-send
 * flush-then-pass-through, and editMessage bypass (REQ-ROUTE-019b).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppModule, CoreServices } from '../../../types/app-module.js';
import type {
	InlineButton,
	MessageContext,
	SentMessage,
	TelegramService,
} from '../../../types/telegram.js';
import { ContextAwareTelegramService } from '../../telegram/context-aware.js';
import { buildRouter, createTextCtx, echoManifest, groceryManifest } from './test-helpers.js';

interface Recorded {
	method: 'send' | 'sendPhoto' | 'sendWithButtons' | 'sendOptions' | 'editMessage';
	userId: string;
	text?: string;
	caption?: string;
}

function makeRecordingRealTelegram(): { real: TelegramService; sends: Recorded[] } {
	const sends: Recorded[] = [];
	const real: TelegramService = {
		send: vi.fn(async (userId: string, text: string) => {
			sends.push({ method: 'send', userId, text });
		}),
		sendPhoto: vi.fn(async (userId: string, _photo: Buffer, caption?: string) => {
			sends.push({ method: 'sendPhoto', userId, caption });
		}),
		sendOptions: vi.fn(async (userId: string, _prompt: string, options: string[]) => {
			sends.push({ method: 'sendOptions', userId, text: options[0] });
			return options[0] ?? '';
		}),
		sendWithButtons: vi.fn(async (userId: string, text: string, _buttons: InlineButton[][]) => {
			sends.push({ method: 'sendWithButtons', userId, text });
			return { chatId: 1, messageId: 1 } as SentMessage;
		}),
		editMessage: vi.fn(async (chatId: number, _messageId: number, text: string) => {
			sends.push({ method: 'editMessage', userId: String(chatId), text });
		}),
	} as unknown as TelegramService;
	return { real, sends };
}

function makeFakeApp(
	id: string,
	services: CoreServices,
	replyMap: Map<string, string>,
	options?: { throwOn?: string },
): { manifest: typeof echoManifest; module: AppModule } {
	const manifest = id === 'grocery' ? groceryManifest : echoManifest;
	return {
		manifest,
		module: {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn(async (ctx: MessageContext) => {
				if (options?.throwOn && ctx.text === options.throwOn) {
					throw new Error('intentional segment failure');
				}
				const reply = replyMap.get(ctx.text);
				if (reply) await services.telegram.send(ctx.userId, reply);
			}),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		},
	};
}

describe('Router multi-intent — reply buffer integration', () => {
	it('two-segment message → preamble + exactly one combined send (REQ-ROUTE-017)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		const replies = new Map<string, string>([
			['What is for dinner?', 'Dinner: pasta tonight'],
			['How much did I spend?', 'Spend: $42 at Costco'],
		]);
		const fakeApp = makeFakeApp('echo', services, replies);

		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['What is for dinner?', 'How much did I spend?']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('What is for dinner? How much did I spend?'));

		// Preamble + 1 combined message
		expect(sends).toHaveLength(2);
		expect(sends[0]).toMatchObject({ method: 'send', userId: 'u1' });
		expect(sends[0]?.text).toMatch(/Got it/);
		expect(sends[1]).toMatchObject({ method: 'send', userId: 'u1' });
		expect(sends[1]?.text).toBe('Dinner: pasta tonight\n\nSpend: $42 at Costco');
	});

	it('segment 1 throws → apology + segment 2 reply combined in one message (REQ-ROUTE-021)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		// Need to throw INSIDE routeOneTextRequest so tryMultiIntentSplit's
		// per-segment catch fires (the buffer.send apology path). Stub
		// routeOneTextRequest to throw on first call.
		const replies = new Map<string, string>([['second', 'second reply ok']]);
		const fakeApp = makeFakeApp('echo', services, replies);

		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['first', 'second']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		const originalRoute = (
			built.router as unknown as {
				routeOneTextRequest: (ctx: MessageContext, user: unknown) => Promise<void>;
			}
		).routeOneTextRequest.bind(built.router);
		let call = 0;
		(
			built.router as unknown as {
				routeOneTextRequest: (ctx: MessageContext, user: unknown) => Promise<void>;
			}
		).routeOneTextRequest = vi.fn(async (ctx: MessageContext, user: unknown) => {
			call += 1;
			if (call === 1) throw new Error('boom segment 1');
			return originalRoute(ctx, user);
		});

		await built.router.routeMessage(createTextCtx('first; second'));

		expect(sends).toHaveLength(2);
		expect(sends[0]?.text).toMatch(/Got it/);
		expect(sends[1]?.text).toMatch(/couldn't handle that part.*second reply ok/s);
	});

	it('combined reply > 4000 chars auto-splits at segment boundaries (REQ-ROUTE-018)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		// 3 segments × 1800-char replies. 1800+2+1800 = 3602 ≤ 4000.
		// Adding +1802 → 5404 > 4000 → new chunk.
		const replies = new Map<string, string>([
			['s1', 'A'.repeat(1800)],
			['s2', 'B'.repeat(1800)],
			['s3', 'C'.repeat(1800)],
		]);
		const fakeApp = makeFakeApp('echo', services, replies);

		const built = buildRouter({
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

		await built.router.routeMessage(createTextCtx('s1; s2; s3'));

		expect(sends).toHaveLength(3); // preamble + 2 split messages
		expect(sends[1]?.text).toBe(`${'A'.repeat(1800)}\n\n${'B'.repeat(1800)}`);
		expect(sends[2]?.text).toBe('C'.repeat(1800));
		expect((sends[1]?.text ?? '').length).toBeLessThanOrEqual(4000);
		expect((sends[2]?.text ?? '').length).toBeLessThanOrEqual(4000);
	});

	it('concurrent dispatches for two users — buffers do not cross-contaminate (REQ-ROUTE-020)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
		const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
			manifest: echoManifest,
			module: {
				init: vi.fn().mockResolvedValue(undefined),
				handleMessage: vi.fn(async (ctx: MessageContext) => {
					await delay(5);
					await services.telegram.send(ctx.userId, `reply-for-${ctx.userId}-${ctx.text}`);
				}),
				handleCommand: vi.fn().mockResolvedValue(undefined),
				handlePhoto: vi.fn().mockResolvedValue(undefined),
			},
		};

		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			users: [
				{ id: 'u1', name: 'User1', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
				{ id: 'u2', name: 'User2', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async (text: string) => text.split(';').map((s) => s.trim())),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await Promise.all([
			built.router.routeMessage(createTextCtx('a; b', 'u1')),
			built.router.routeMessage(createTextCtx('c; d', 'u2')),
		]);

		// Each user sees: preamble + 1 combined message.
		const u1Sends = sends.filter((s) => s.userId === 'u1');
		const u2Sends = sends.filter((s) => s.userId === 'u2');
		expect(u1Sends).toHaveLength(2);
		expect(u2Sends).toHaveLength(2);
		expect(u1Sends[1]?.text).toBe('reply-for-u1-a\n\nreply-for-u1-b');
		expect(u2Sends[1]?.text).toBe('reply-for-u2-c\n\nreply-for-u2-d');
		// Critical: u1 never receives any 'reply-for-u2-…' content and vice versa.
		expect(u1Sends[1]?.text).not.toMatch(/u2/);
		expect(u2Sends[1]?.text).not.toMatch(/u1/);
	});

	it('sendPhoto mid-segment flushes prior plain text then passes through (REQ-ROUTE-019)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
			manifest: echoManifest,
			module: {
				init: vi.fn().mockResolvedValue(undefined),
				handleMessage: vi.fn(async (ctx: MessageContext) => {
					if (ctx.text === 's1') {
						await services.telegram.send(ctx.userId, 'text-reply');
					} else if (ctx.text === 's2') {
						await services.telegram.sendPhoto(ctx.userId, Buffer.alloc(8), 'caption-here');
					}
				}),
				handleCommand: vi.fn().mockResolvedValue(undefined),
				handlePhoto: vi.fn().mockResolvedValue(undefined),
			},
		};
		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['s1', 's2']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('s1; s2'));

		// Order: preamble, plain text flush (triggered by sendPhoto), photo
		expect(sends).toHaveLength(3);
		expect(sends[0]?.method).toBe('send');
		expect(sends[0]?.text).toMatch(/Got it/);
		expect(sends[1]?.method).toBe('send');
		expect(sends[1]?.text).toBe('text-reply');
		expect(sends[2]?.method).toBe('sendPhoto');
		expect(sends[2]?.caption).toBe('caption-here');
	});

	it('sendWithButtons mid-segment flushes prior plain text then passes through', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
			manifest: echoManifest,
			module: {
				init: vi.fn().mockResolvedValue(undefined),
				handleMessage: vi.fn(async (ctx: MessageContext) => {
					if (ctx.text === 's1') {
						await services.telegram.send(ctx.userId, 'first reply');
					} else if (ctx.text === 's2') {
						await services.telegram.sendWithButtons(ctx.userId, 'Confirm?', [
							[{ text: 'Yes', callbackData: 'y' }],
						]);
					}
				}),
				handleCommand: vi.fn().mockResolvedValue(undefined),
				handlePhoto: vi.fn().mockResolvedValue(undefined),
			},
		};
		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['s1', 's2']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('s1; s2'));

		expect(sends).toHaveLength(3);
		expect(sends[1]?.text).toBe('first reply');
		expect(sends[2]?.method).toBe('sendWithButtons');
		expect(sends[2]?.text).toBe('Confirm?');
	});

	it('editMessage bypasses the buffer entirely (REQ-ROUTE-019b)', async () => {
		const { real, sends } = makeRecordingRealTelegram();
		const services = {
			telegram: new ContextAwareTelegramService(real),
		} as unknown as CoreServices;
		const fakeApp: { manifest: typeof echoManifest; module: AppModule } = {
			manifest: echoManifest,
			module: {
				init: vi.fn().mockResolvedValue(undefined),
				handleMessage: vi.fn(async (ctx: MessageContext) => {
					if (ctx.text === 's1') {
						await services.telegram.send(ctx.userId, 'first plain');
						await services.telegram.editMessage(1, 1, 'edited body');
					} else {
						await services.telegram.send(ctx.userId, 'second plain');
					}
				}),
				handleCommand: vi.fn().mockResolvedValue(undefined),
				handlePhoto: vi.fn().mockResolvedValue(undefined),
			},
		};
		const built = buildRouter({
			telegram: real,
			apps: [fakeApp],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['s1', 's2']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('s1; s2'));

		// Preamble + editMessage (mid-segment, never buffered) + combined plain
		// (first plain + second plain joined). 3 sends total.
		expect(sends).toHaveLength(3);
		expect(sends[0]?.text).toMatch(/Got it/);
		expect(sends[1]?.method).toBe('editMessage');
		expect(sends[1]?.text).toBe('edited body');
		expect(sends[2]?.method).toBe('send');
		expect(sends[2]?.text).toBe('first plain\n\nsecond plain');
	});
});
