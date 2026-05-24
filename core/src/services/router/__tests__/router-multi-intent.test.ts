/**
 * Multi-intent message splitting (Task 4.3/4.4).
 *
 * Covers the router-level wiring of `preFilterMultiIntent` + `segmentMessage`
 * via the injected `messageSegmenter` dep. The segmenter itself is tested in
 * `message-segmenter.test.ts`; these tests mock it so we can assert dispatch
 * shape (preamble, per-segment dispatch order, error isolation, kill switch).
 */

import type { Logger } from 'pino';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModule } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn(),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createMockModule(): AppModule {
	return {
		init: vi.fn().mockResolvedValue(undefined),
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleCommand: vi.fn().mockResolvedValue(undefined),
		handlePhoto: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockFallback(): FallbackHandler {
	return {
		handleUnrecognized: vi.fn().mockResolvedValue(undefined),
	} as unknown as FallbackHandler;
}

function createConfig(users: SystemConfig['users']): SystemConfig {
	return {
		port: 3000,
		dataDir: '/tmp/data',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: 'http://localhost:11434', model: 'test' },
		claude: { apiKey: 'test', model: 'test' },
		gui: { authToken: 'test' },
		cloudflare: {},
		users,
	} as SystemConfig;
}

const echoManifest: AppManifest = {
	app: { id: 'echo', name: 'Echo', version: '1.0.0', description: 'Echo app', author: 'Test' },
	capabilities: {
		messages: {
			intents: ['echo something back to the user'],
			commands: [],
		},
	},
};

const groceryManifest: AppManifest = {
	app: {
		id: 'grocery',
		name: 'Grocery',
		version: '1.0.0',
		description: 'Grocery app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			intents: ['add an item to the grocery list'],
			commands: [],
		},
	},
};

function createTextCtx(text: string, userId = 'u1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ─── Router builder ─────────────────────────────────────────────────────────

interface BuildOptions {
	multiIntentSplit?: boolean;
	preFilter?: Mock<(text: string) => boolean>;
	segment?: Mock<(text: string, deps: unknown) => Promise<string[]>>;
	classifyResults?: Array<{ appId: string; intent: string; confidence: number } | null>;
	users?: SystemConfig['users'];
	apps?: Array<{ manifest: AppManifest; module: AppModule }>;
	includeSegmenter?: boolean;
}

interface BuiltRouter {
	router: Router;
	telegram: TelegramService;
	llm: LLMService;
	fallback: FallbackHandler;
	logger: Logger;
	echoModule: AppModule;
	groceryModule: AppModule;
	preFilter: Mock<(text: string) => boolean>;
	segment: Mock<(text: string, deps: unknown) => Promise<string[]>>;
}

function buildRouter(opts: BuildOptions = {}): BuiltRouter {
	const telegram = createMockTelegram();
	const llm = createMockLLM();
	const fallback = createMockFallback();
	const logger = createMockLogger();
	const echoModule = createMockModule();
	const groceryModule = createMockModule();

	const users = opts.users ?? [
		{ id: 'u1', name: 'Tester', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
	];
	const apps = opts.apps ?? [
		{ manifest: echoManifest, module: echoModule },
		{ manifest: groceryManifest, module: groceryModule },
	];

	const cache = new ManifestCache();
	for (const a of apps) cache.add(a.manifest, `/apps/${a.manifest.app.id}`);

	const registry = {
		getApp: (id: string) => {
			const a = apps.find((x) => x.manifest.app.id === id);
			if (!a) return undefined;
			return {
				manifest: a.manifest,
				module: a.module,
				appDir: `/apps/${id}`,
			} as RegisteredApp;
		},
		getManifestCache: () => cache,
		getLoadedAppIds: () => apps.map((a) => a.manifest.app.id),
	} as unknown as AppRegistry;

	// Wire classify mock — defaults to unknown so dispatches fall through to fallback
	// unless the test supplies explicit per-call results.
	if (opts.classifyResults) {
		let i = 0;
		(llm.classify as Mock).mockImplementation(async () => {
			const r = opts.classifyResults?.[i++];
			if (!r) return { category: 'unknown', confidence: 0.1 };
			return { category: r.intent, confidence: r.confidence };
		});
	}

	const preFilter = opts.preFilter ?? vi.fn((_text: string) => true);
	const segment = opts.segment ?? vi.fn(async (text: string) => [text]);

	const router = new Router({
		registry,
		llm,
		telegram,
		fallback,
		config: createConfig(users),
		logger,
		confidenceThreshold: 0.4,
		multiIntentSplit: opts.multiIntentSplit ?? true,
		messageSegmenter: opts.includeSegmenter === false ? undefined : { preFilter, segment },
	});
	router.buildRoutingTables();

	return {
		router,
		telegram,
		llm,
		fallback,
		logger,
		echoModule,
		groceryModule,
		preFilter,
		segment,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Router — multi-intent split (Task 4.3/4.4)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('splits a two-question message and dispatches both segments in order, with one preamble', async () => {
		const segA = 'What is for dinner?';
		const segB = 'What is on my schedule today?';
		const inputText = `${segA} Also, ${segB}`;

		const built = buildRouter({
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			// Each segment classifies as a different app
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(inputText));

		// 1. Preamble (exact copy)
		expect(built.telegram.send).toHaveBeenCalledTimes(1);
		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");

		// 2. Both apps dispatched, in input order
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
		expect(built.groceryModule.handleMessage).toHaveBeenCalledTimes(1);
		const echoCall = (built.echoModule.handleMessage as Mock).mock.calls[0]?.[0];
		const groceryCall = (built.groceryModule.handleMessage as Mock).mock.calls[0]?.[0];
		expect(echoCall.text).toBe(segA);
		expect(groceryCall.text).toBe(segB);

		// 3. Order: echo dispatched before grocery
		const echoOrder = (built.echoModule.handleMessage as Mock).mock.invocationCallOrder[0]!;
		const groceryOrder = (built.groceryModule.handleMessage as Mock).mock.invocationCallOrder[0]!;
		expect(echoOrder).toBeLessThan(groceryOrder);
	});

	it('dispatches three segments when the segmenter returns three', async () => {
		const segA = 'What is for dinner?';
		const segB = 'What is on my schedule today?';
		const segC = 'Add milk to my list.';
		const built = buildRouter({
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB, segC]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB} Plus, ${segC}`));

		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(2);
		expect(built.groceryModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('does NOT split when prefilter returns false: no segment call, no preamble, single dispatch', async () => {
		const built = buildRouter({
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
		expect(built.telegram.send).not.toHaveBeenCalled();
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('flag OFF: no segmenter call, no preamble, single-message path runs', async () => {
		const built = buildRouter({
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
		expect(built.telegram.send).not.toHaveBeenCalled();
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('segment 2 denied: post-routing access check fires per segment', async () => {
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

		const built = buildRouter({
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
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
		// Segment 2 NOT dispatched
		expect(built.groceryModule.handleMessage).not.toHaveBeenCalled();
		// Telegram receives: 1 preamble + 1 access-denied notice
		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
		expect(built.telegram.send).toHaveBeenCalledWith(
			'u1',
			"You don't have access to the grocery app.",
		);
	});

	it('per-segment error isolation: segment 1 throws, segment 2 still runs', async () => {
		const segA = 'echo this back';
		const segB = 'add milk to list';
		const built = buildRouter({
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			// Only segment 2 reaches classify (segment 1 is intercepted by the
			// stub below, so the first classify call is the grocery call).
			classifyResults: [
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
		});

		// Segment 1's handler throws when invoked. The catch is around the entire
		// routeOneTextRequest pipeline (which itself catches downstream handler
		// errors via dispatchMessage's try/catch). To force the THROW path of
		// tryMultiIntentSplit's per-segment catch, we make routeOneTextRequest
		// throw directly by stubbing it.
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

		// Preamble + per-segment apology for segment 1 + segment 2 still runs.
		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
		expect(built.telegram.send).toHaveBeenCalledWith(
			'u1',
			"(I couldn't handle that part — sorry.)",
		);
		// Segment 2 went through the real routeOneTextRequest → grocery dispatched.
		expect(built.groceryModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('integration: segment 1 routes to an app whose handleMessage throws — segment 2 still runs', async () => {
		// Codex Round 2 finding 7 — the patched-routeOneTextRequest test above
		// proves the per-segment catch in tryMultiIntentSplit; this test proves
		// the REAL dispatch path also recovers when an app's handleMessage
		// throws inside dispatchMessage. The error is caught by dispatchMessage,
		// which sends a "Something went wrong" reply but does NOT re-throw, so
		// the loop in tryMultiIntentSplit proceeds to segment 2 normally.
		const segA = 'echo this back';
		const segB = 'add milk to list';

		// Build two REAL-ish app modules; app-a's handleMessage throws.
		const throwingEchoModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockRejectedValue(new Error('boom: real handleMessage failed')),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};
		const recordingGroceryModule: AppModule = {
			init: vi.fn().mockResolvedValue(undefined),
			handleMessage: vi.fn().mockResolvedValue(undefined),
			handleCommand: vi.fn().mockResolvedValue(undefined),
			handlePhoto: vi.fn().mockResolvedValue(undefined),
		};

		const built = buildRouter({
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => [segA, segB]),
			// Both segments classify — segment 1 → echo (which throws), segment 2 → grocery.
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'grocery', intent: 'add an item to the grocery list', confidence: 0.95 },
			],
			apps: [
				{ manifest: echoManifest, module: throwingEchoModule },
				{ manifest: groceryManifest, module: recordingGroceryModule },
			],
		});

		await built.router.routeMessage(createTextCtx(`${segA} Also, ${segB}`));

		// 1. app-a's REAL handleMessage was invoked AND threw (proof we exercised
		//    the real dispatch path, not a stubbed routeOneTextRequest).
		expect(throwingEchoModule.handleMessage).toHaveBeenCalledTimes(1);
		// 2. app-b ran to completion — proves the run-loop did NOT abort on the
		//    real handler throw.
		expect(recordingGroceryModule.handleMessage).toHaveBeenCalledTimes(1);
		// 3. Telegram sees three sends:
		//    - 1 preamble ("Got it — I'll cover all of those:")
		//    - 1 dispatchMessage error reply ("Something went wrong. Please try again later.")
		//    - 0 per-segment apology (dispatchMessage swallowed the throw, so
		//      tryMultiIntentSplit's per-segment catch doesn't fire here)
		//    Note: app-b's handler resolves silently, so it adds no send of its own.
		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
		expect(built.telegram.send).toHaveBeenCalledWith(
			'u1',
			'Something went wrong. Please try again later.',
		);
		expect(built.telegram.send).toHaveBeenCalledTimes(2);
	});

	it('segmenter throws: degrade to single dispatch (no preamble, single-message path runs)', async () => {
		const built = buildRouter({
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
		expect(built.telegram.send).not.toHaveBeenCalled();
		// Single-message dispatch happened with the full original text.
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
		const [ctxArg] = (built.echoModule.handleMessage as Mock).mock.calls[0]!;
		expect(ctxArg.text).toBe('one? Also, two?');
	});

	it('segmenter returns <2 segments: no preamble, single-message path runs', async () => {
		const built = buildRouter({
			preFilter: vi.fn(() => true),
			segment: vi.fn(async (text: string) => [text]),
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		await built.router.routeMessage(createTextCtx('one? Also, looked like two?'));

		expect(built.telegram.send).not.toHaveBeenCalled();
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
	});

	it('setMultiIntentSplit hot-update flips the gate at runtime', async () => {
		const built = buildRouter({
			multiIntentSplit: false,
			preFilter: vi.fn(() => true),
			segment: vi.fn(async () => ['a', 'b']),
			// 3 entries: 1 for the OFF-state single dispatch + 2 for the post-flip split.
			classifyResults: [
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
				{ appId: 'echo', intent: 'echo something back to the user', confidence: 0.95 },
			],
		});

		// OFF: single dispatch.
		await built.router.routeMessage(createTextCtx('q1? Also, q2?'));
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(1);
		expect(built.telegram.send).not.toHaveBeenCalled();

		// Flip ON: now splits.
		built.router.setMultiIntentSplit(true);
		await built.router.routeMessage(createTextCtx('q3? Also, q4?'));
		expect(built.echoModule.handleMessage).toHaveBeenCalledTimes(3); // 1 from before + 2 from split
		expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
	});
});
