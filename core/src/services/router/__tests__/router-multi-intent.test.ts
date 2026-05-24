/**
 * Multi-intent message splitting (Task 4.3/4.4) + reply-buffer integration
 * (REQ-ROUTE-017..022).
 *
 * Covers the router-level wiring of `preFilterMultiIntent` + `segmentMessage`
 * via the injected `messageSegmenter` dep. The segmenter itself is tested in
 * `message-segmenter.test.ts`; these tests mock it so we can assert dispatch
 * shape (preamble, per-segment dispatch order, error isolation, kill switch).
 *
 * Codex Round 1 #5: fake apps' handleMessage actually call
 * `services.telegram.send(...)` through a `ContextAwareTelegramService` that
 * wraps the recording telegram. Without that, the combined-reply assertions
 * would be vacuous (handlers returned undefined and never produced a send).
 */

import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule, CoreServices } from '../../../types/app-module.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { requestContext } from '../../context/request-context.js';
import { ContextAwareTelegramService } from '../../telegram/context-aware.js';
import { buildRouter, createTextCtx, echoManifest, groceryManifest } from './test-helpers.js';

// ─── Send-capable app helpers (Codex Round 1 #5) ────────────────────────────

/**
 * Build a fake app module whose `handleMessage` actually drives
 * `services.telegram.send(...)` so the reply-buffer assertions are real.
 * The `services.telegram` it captures is a `ContextAwareTelegramService`
 * wrapping the recording telegram — same production wrapper compose-runtime
 * hands to apps.
 */
function makeSendCapableModule(
	services: CoreServices,
	replyMap: Map<string, string>,
	options?: { throwOn?: string },
): AppModule {
	return {
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
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Router — multi-intent split (Task 4.3/4.4) + combined reply (REQ-ROUTE-017..022)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('splits a two-question message → preamble + one combined send; both handlers dispatched in order', async () => {
		const segA = 'What is for dinner?';
		const segB = 'What is on my schedule today?';
		const inputText = `${segA} Also, ${segB}`;

		// Build services BEFORE buildRouter so the apps' handleMessage can
		// close over the ContextAwareTelegramService that wraps the real
		// recording telegram.
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(services, new Map([[segA, 'Dinner: pasta tonight']]));
		const groceryModule = makeSendCapableModule(
			services,
			new Map([[segB, 'Schedule: 3pm meeting']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(inputText));

		// 1. Preamble + 1 combined message — 2 sends total at the real transport.
		expect(recording.send).toHaveBeenCalledTimes(2);
		expect(recording.send).toHaveBeenNthCalledWith(1, 'u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenNthCalledWith(
			2,
			'u1',
			'Dinner: pasta tonight\n\nSchedule: 3pm meeting',
		);

		// 2. Both apps dispatched, in input order
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
		expect(groceryModule.handleMessage).toHaveBeenCalledTimes(1);
		const echoCall = (echoModule.handleMessage as Mock).mock.calls[0]?.[0];
		const groceryCall = (groceryModule.handleMessage as Mock).mock.calls[0]?.[0];
		expect(echoCall.text).toBe(segA);
		expect(groceryCall.text).toBe(segB);

		// 3. Order: echo dispatched before grocery
		const echoOrder = (echoModule.handleMessage as Mock).mock.invocationCallOrder[0] ?? 0;
		const groceryOrder = (groceryModule.handleMessage as Mock).mock.invocationCallOrder[0] ?? 0;
		expect(echoOrder).toBeLessThan(groceryOrder);
	});

	it('dispatches three segments → preamble + one combined send with three sections', async () => {
		const segA = 'What is for dinner?';
		const segB = 'What is on my schedule today?';
		const segC = 'Add milk to my list.';

		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(
			services,
			new Map([
				[segA, 'echo-A'],
				[segB, 'echo-B'],
			]),
		);
		const groceryModule = makeSendCapableModule(services, new Map([[segC, 'grocery-C']]));

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB, segC]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB} Plus, ${segC}`));

		expect(recording.send).toHaveBeenNthCalledWith(1, 'u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenNthCalledWith(2, 'u1', 'echo-A\n\necho-B\n\ngrocery-C');
		expect(recording.send).toHaveBeenCalledTimes(2);
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(2);
		expect(groceryModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('does NOT split when prefilter returns false: no segment call, no preamble, single dispatch', async () => {
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		// No buffer scope → handler send goes straight to recording.
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(
			services,
			new Map([['one short request', 'singleton-reply']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			preFilter: vi.fn(() => false),
			segment: vi.fn(async () => {
				throw new Error('should not be called');
			}),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('one short request'));

		expect(built.preFilter).toHaveBeenCalledTimes(1);
		expect(built.segment).not.toHaveBeenCalled();
		// No preamble; one direct send-from-handler (single-message path bypassed the buffer).
		expect(recording.send).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledWith('u1', 'singleton-reply');
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('flag OFF: no segmenter call, no preamble, single-message path runs', async () => {
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(
			services,
			new Map([['multi question? Also, another?', 'flag-off-reply']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			multiIntentSplit: false,
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['a', 'b', 'c']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('multi question? Also, another?'));

		// When OFF, the prefilter must not even be consulted.
		expect(built.preFilter).not.toHaveBeenCalled();
		expect(built.segment).not.toHaveBeenCalled();
		expect(recording.send).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledWith('u1', 'flag-off-reply');
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('segment 2 denied: post-routing access check fires per segment (denial sent at REAL transport, not buffered)', async () => {
		// Two segments: seg 1 routes to echo (allowed), seg 2 routes to grocery (NOT allowed).
		const segA = 'echo this back';
		const segB = 'add milk to list';
		const restrictedUsers = [
			{
				id: 'u1',
				name: 'Tester',
				isAdmin: false,
				enabledApps: ['echo'], // explicitly NOT grocery
				sharedScopes: [],
			},
		];

		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(services, new Map([[segA, 'echo-reply']]));
		const groceryModule = makeSendCapableModule(services, new Map([[segB, 'grocery-reply']]));

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: groceryModule },
			],
			users: restrictedUsers,
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB}`));

		// Segment 1 dispatched
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
		// Segment 2 NOT dispatched (access denied before reaching handler)
		expect(groceryModule.handleMessage).not.toHaveBeenCalled();
		// Telegram (REAL) receives at the real transport, in order:
		//   1. preamble
		//   2. access-denied notice (Router.trySend → this.telegram, NOT buffered)
		//   3. combined flush — echo's reply only (segment 2 produced none)
		expect(recording.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenCalledWith('u1', "You don't have access to the grocery app.");
		expect(recording.send).toHaveBeenCalledWith('u1', 'echo-reply');
	});

	it('per-segment error isolation (stubbed routeOneTextRequest throw): apology + segment 2 reply combined', async () => {
		const segA = 'echo this back';
		const segB = 'add milk to list';

		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const groceryModule = makeSendCapableModule(services, new Map([[segB, 'grocery-reply']]));

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: { handleMessage: vi.fn() } as unknown as AppModule },
				{ manifest: groceryManifest, module: groceryModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			// Only segment 2 reaches classify (segment 1 is intercepted by the
			// routeOneTextRequest stub below).
			classifyResults: [
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		// Force the THROW path of tryMultiIntentSplit's per-segment catch by
		// stubbing routeOneTextRequest to throw on the first call only.
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
			if (call === 1) throw new Error('boom: segment 1 handler failed');
			return originalRoute(ctx, user);
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB}`));

		// Two sends at the real transport:
		//   1. preamble (Router.trySend → real)
		//   2. combined flush — apology (from buffer.send in the catch) + segment 2 reply
		expect(recording.send).toHaveBeenCalledTimes(2);
		expect(recording.send).toHaveBeenNthCalledWith(1, 'u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenNthCalledWith(
			2,
			'u1',
			"(I couldn't handle that part — sorry.)\n\ngrocery-reply",
		);
		// Segment 2 went through the real routeOneTextRequest → grocery dispatched.
		expect(groceryModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('integration: real handleMessage throws → "Something went wrong" sent at REAL transport, segment 2 reply buffered', async () => {
		// Codex Round 2 finding 7 — the patched-routeOneTextRequest test above
		// proves the per-segment catch in tryMultiIntentSplit; this test proves
		// the REAL dispatch path also recovers when an app's handleMessage
		// throws inside dispatchMessage. dispatchMessage uses this.trySend
		// (real transport) for "Something went wrong"; segment 2 runs to
		// completion and its reply lands in the buffer for the final flush.
		const segA = 'echo this back';
		const segB = 'add milk to list';

		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;

		const throwingEchoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockRejectedValue(new Error('boom: real handleMessage failed')),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};
		const recordingGroceryModule = makeSendCapableModule(
			services,
			new Map([[segB, 'grocery-reply']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: throwingEchoModule },
				{ manifest: groceryManifest, module: recordingGroceryModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB}`));

		// 1. echo's REAL handleMessage was invoked AND threw
		expect(throwingEchoModule.handleMessage).toHaveBeenCalledTimes(1);
		// 2. grocery ran to completion — proves the run-loop did not abort
		expect(recordingGroceryModule.handleMessage).toHaveBeenCalledTimes(1);
		// 3. Three sends at the real transport, in order:
		//      a. preamble (real)
		//      b. "Something went wrong" from dispatchMessage (real)
		//      c. combined flush — just grocery's reply (apology NOT added; the
		//         per-segment catch in tryMultiIntentSplit does not fire because
		//         dispatchMessage already swallowed the throw)
		expect(recording.send).toHaveBeenCalledTimes(3);
		expect(recording.send).toHaveBeenNthCalledWith(1, 'u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenNthCalledWith(
			2,
			'u1',
			'Something went wrong. Please try again later.',
		);
		expect(recording.send).toHaveBeenNthCalledWith(3, 'u1', 'grocery-reply');
	});

	it('segmenter throws: degrade to single dispatch (no preamble, single-message path runs)', async () => {
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(
			services,
			new Map([['one? Also, two?', 'degraded-reply']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => {
				throw new Error('LLM unavailable');
			}),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('one? Also, two?'));

		// Prefilter consulted, segmenter attempted, neither preamble nor apology sent.
		expect(built.preFilter).toHaveBeenCalledTimes(1);
		expect(built.segment).toHaveBeenCalledTimes(1);
		// Single send — the handler's direct reply at the real transport.
		expect(recording.send).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledWith('u1', 'degraded-reply');
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
		const [ctxArg] = (echoModule.handleMessage as Mock).mock.calls[0] ?? [];
		expect(ctxArg.text).toBe('one? Also, two?');
	});

	it('segmenter returns <2 segments: no preamble, single-message path runs', async () => {
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule = makeSendCapableModule(
			services,
			new Map([['one? Also, looked like two?', 'lone-segment-reply']]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async (text: string) => [text]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('one? Also, looked like two?'));

		// Single send — handler reply at the real transport, no preamble.
		expect(recording.send).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledWith('u1', 'lone-segment-reply');
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('setMultiIntentSplit hot-update flips the gate at runtime', async () => {
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		// Map every possible segment text to a distinct reply so we can pin
		// the combined flush content.
		const echoModule = makeSendCapableModule(
			services,
			new Map([
				['q1? Also, q2?', 'single-off'],
				['a', 'reply-a'],
				['b', 'reply-b'],
			]),
		);

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			multiIntentSplit: false,
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['a', 'b']),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		// OFF: single dispatch → 1 direct send.
		await built.router.routeMessage(createTextCtx('q1? Also, q2?'));
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledTimes(1);
		expect(recording.send).toHaveBeenCalledWith('u1', 'single-off');

		// Flip ON: now splits → preamble + 1 combined send.
		built.router.setMultiIntentSplit(true);
		await built.router.routeMessage(createTextCtx('q3? Also, q4?'));
		expect(echoModule.handleMessage).toHaveBeenCalledTimes(3); // 1 + 2
		expect(recording.send).toHaveBeenCalledTimes(3); // 1 single + (preamble + combined)
		expect(recording.send).toHaveBeenNthCalledWith(2, 'u1', "Got it — I'll cover all of those:");
		expect(recording.send).toHaveBeenNthCalledWith(3, 'u1', 'reply-a\n\nreply-b');
	});

	it('requestContext.replyBuffer is INSTALLED during multi-intent dispatch and CLEARED after flush', async () => {
		// REQ-ROUTE-020 sanity check: inside the per-segment handler, the
		// replyBuffer must be the active buffer; outside, it is undefined.
		const segA = 'first';
		const segB = 'second';

		const observed: Array<unknown> = [];
		const recording: TelegramService = {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(''),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramService;
		const services = { telegram: new ContextAwareTelegramService(recording) } as CoreServices;
		const echoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn(async (ctx: MessageContext) => {
				observed.push(requestContext.getStore()?.replyBuffer);
				await services.telegram.send(ctx.userId, `reply-${ctx.text}`);
			}),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};

		const built = buildRouter({
			telegram: recording,
			apps: [
				{ manifest: echoManifest, module: echoModule },
				{ manifest: groceryManifest, module: { ...echoModule } as AppModule },
			],
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA}; ${segB}`));

		expect(observed).toHaveLength(2);
		expect(observed[0]).toBeDefined();
		expect(observed[0]).toBe(observed[1]); // same buffer instance across segments
		// After the dispatch returns, the outer (test) scope sees no buffer.
		expect(requestContext.getStore()?.replyBuffer).toBeUndefined();
	});
});
