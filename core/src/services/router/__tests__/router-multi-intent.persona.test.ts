/**
 * Persona coverage for multi-intent splitting (Task 4.5).
 *
 * Validates the END-TO-END router behavior of Tasks 4.1–4.4 against realistic
 * natural-language messages — not the small unit-level shape suite in
 * `router-multi-intent.test.ts`. The segmenter (`messageSegmenter.segment`) is
 * mocked so the LLM output is deterministic per scenario; the prefilter
 * (`preFilterMultiIntent`) is the REAL one so we exercise the genuine gate
 * heuristics rather than fake them.
 *
 * Scenario buckets (counts are minimums per the plan):
 *   (A) Two-question messages   — ≥15
 *   (B) Three-question messages — ≥8
 *   (C) Four-question messages  — ≥4  (router sees the 3-segment, merged-tail
 *                                       output the real segmenter produces;
 *                                       segment 3 contains 3+4 joined)
 *   (D) Must-NOT-split          — ≥15 (real prefilter returns false → no
 *                                       segment call, no preamble, 1 dispatch)
 *   (E) Dependent-clause        — ≥6  (segmenter returns 1 — kept attached)
 *   (F) Partial-failure         — ≥4  (one segment throws → per-segment
 *                                       apology, siblings still run)
 *   (G) Literal-bug integration — 1   (the operator's actual transcript;
 *                                       bridges a `[App: food]
 *                                       nightly-rating-prompt` turn-pair via
 *                                       the real AppOutboundBridge and asserts
 *                                       segment 2's chatbot system prompt
 *                                       sees that bridged context — proves
 *                                       the combined Part 1 + 3 + 4 fix
 *                                       closes the user's actual bug)
 *
 * Total unique persona messages: 50+ across A–E, plus F and G.
 *
 * The literal-bug integration test (G) cannot import from `apps/food` (core
 * tests cannot reach across the workspace), so the harness for the bridged
 * transcript is duplicated inline. The canonical helper lives at
 * `apps/food/src/__tests__/proactive-bridge.persona.test.ts` (Task 1.8) and
 * `apps/food/src/__tests__/app-outbound-bridge-wiring.test.ts` (Task 1.6) —
 * any change to the bridge wiring should be mirrored here.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type AppOutboundBridge,
	createAppOutboundBridge,
} from '../../../services/app-outbound-bridge/index.js';
import type { ChatSessionStore } from '../../../services/conversation-session/chat-session-store.js';
import { composeChatSessionStore } from '../../../services/conversation-session/compose.js';
import { buildSessionKey } from '../../../services/conversation-session/session-key.js';
import { CONVERSATION_DATA_SCOPES } from '../../../services/conversation/manifest.js';
import { buildSystemPrompt } from '../../../services/conversation/prompt-builder.js';
import { ChangeLog } from '../../../services/data-store/change-log.js';
import { DataStoreServiceImpl } from '../../../services/data-store/index.js';
import type { AppLogger, AppModule } from '../../../types/app-module.js';
import type { AppConfigService, SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { ConversationService } from '../../conversation/conversation-service.js';
import type { FallbackHandler } from '../fallback.js';
import { Router } from '../index.js';
import { preFilterMultiIntent } from '../message-segmenter.js';

// ─── Test fixtures (mirrors router-multi-intent.test.ts shape) ─────────────

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
	} as unknown as LLMService;
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

const foodManifest: AppManifest = {
	app: { id: 'food', name: 'Food', version: '1.0.0', description: 'Food app', author: 'Test' },
	capabilities: {
		messages: {
			intents: [
				'show what is for dinner tonight',
				'show the pantry contents',
				'add an item to the grocery list',
				'show how much was spent on groceries',
			],
			commands: [],
		},
	},
};

const calendarManifest: AppManifest = {
	app: {
		id: 'calendar',
		name: 'Calendar',
		version: '1.0.0',
		description: 'Calendar app',
		author: 'Test',
	},
	capabilities: {
		messages: {
			intents: ['show the calendar for today'],
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
	preFilter?: Mock<(text: string) => boolean> | ((text: string) => boolean);
	segment?: Mock<(text: string, deps: unknown) => Promise<string[]>>;
	/** Per-segment classifier results, in dispatch order. */
	classifyResults?: Array<{ appId: string; intent: string; confidence: number } | null>;
	users?: SystemConfig['users'];
	apps?: Array<{ manifest: AppManifest; module: AppModule }>;
	/**
	 * When `true` (default), a conversation-service spy is wired so chatbot-bound
	 * segments (classifier returns null) route through `dispatchConversation` and
	 * land on the spy, where the test can count them. Set to `false` to opt out
	 * and use the legacy `fallback.handleUnrecognized` path instead.
	 */
	wireConversationService?: boolean;
}

interface BuiltRouter {
	router: Router;
	telegram: TelegramService;
	llm: LLMService;
	fallback: FallbackHandler;
	logger: Logger;
	foodModule: AppModule;
	calendarModule: AppModule;
	preFilter: Mock<(text: string) => boolean>;
	segment: Mock<(text: string, deps: unknown) => Promise<string[]>>;
	/** Conversation-service `handleMessage` spy (always present when wireConversationService isn't false). */
	convHandle: Mock;
}

function buildRouter(opts: BuildOptions = {}): BuiltRouter {
	const telegram = createMockTelegram();
	const llm = createMockLLM();
	const fallback = createMockFallback();
	const logger = createMockLogger();
	const foodModule = createMockModule();
	const calendarModule = createMockModule();

	const users = opts.users ?? [
		{ id: 'u1', name: 'Tester', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
	];
	const apps = opts.apps ?? [
		{ manifest: foodManifest, module: foodModule },
		{ manifest: calendarManifest, module: calendarModule },
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

	// Classifier returns supplied per-segment results; defaults to unknown
	// (which steers to fallback / chatbot).
	if (opts.classifyResults) {
		let i = 0;
		(llm.classify as Mock).mockImplementation(async () => {
			const r = opts.classifyResults?.[i++];
			if (!r) return { category: 'unknown', confidence: 0.1 };
			return { category: r.intent, confidence: r.confidence };
		});
	}

	// Default prefilter: REAL one. Tests that want false can pass a mock.
	const preFilterFn = opts.preFilter ?? preFilterMultiIntent;
	const preFilter =
		typeof preFilterFn === 'function' && 'mock' in (preFilterFn as object)
			? (preFilterFn as Mock<(t: string) => boolean>)
			: (vi.fn(preFilterFn as (t: string) => boolean) as Mock<(t: string) => boolean>);

	const segment =
		opts.segment ??
		(vi.fn(async (text: string) => [text]) as unknown as Mock<
			(text: string, deps: unknown) => Promise<string[]>
		>);

	const convHandle = vi.fn().mockResolvedValue(undefined);
	const conversationService =
		opts.wireConversationService === false
			? undefined
			: ({ handleMessage: convHandle } as unknown as ConversationService);

	const router = new Router({
		registry,
		llm,
		telegram,
		fallback,
		config: createConfig(users),
		logger,
		confidenceThreshold: 0.4,
		multiIntentSplit: opts.multiIntentSplit ?? true,
		messageSegmenter: { preFilter, segment },
		...(conversationService ? { conversationService } : {}),
	});
	router.buildRoutingTables();

	return {
		router,
		telegram,
		llm,
		fallback,
		logger,
		foodModule,
		calendarModule,
		preFilter,
		segment,
		convHandle,
	};
}

/**
 * Collect the text of every dispatch (food, calendar, or chatbot conversation
 * service) across all module spies in invocation order. Used by the persona
 * cases that don't pin per-segment routing — they only assert BOTH (or N)
 * segments were dispatched, not which app got which.
 */
function collectDispatchedTexts(built: BuiltRouter): string[] {
	const out: string[] = [];
	for (const call of (built.foodModule.handleMessage as Mock).mock.calls) {
		out.push((call[0] as MessageContext).text);
	}
	for (const call of (built.calendarModule.handleMessage as Mock).mock.calls) {
		out.push((call[0] as MessageContext).text);
	}
	for (const call of built.convHandle.mock.calls) {
		out.push((call[0] as MessageContext).text);
	}
	return out;
}

// ─── Bridge env (duplicated from apps/food/src/__tests__/proactive-bridge.persona.test.ts) ─

/** Minimal AppLogger stub for buildSystemPrompt. */
function silentAppLogger(): AppLogger {
	const noop = () => {};
	const logger: AppLogger = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => logger,
	};
	return logger;
}

/** Minimal LLMService stub for buildSystemPrompt (only needs getModelForTier). */
function stubLlmServiceForPrompt(): LLMService {
	return {
		getModelForTier: (tier: string) => `stub-${tier}-model`,
	} as unknown as LLMService;
}

interface BridgeEnv {
	tempDir: string;
	chatSessions: ChatSessionStore;
	bridge: AppOutboundBridge;
	teardown(): Promise<void>;
}

async function makeBridgeEnv(): Promise<BridgeEnv> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-router-multi-intent-persona-'));
	const logger = createMockLogger();

	const dataService = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});

	const chatSessions = composeChatSessionStore({ data: dataService, logger });

	// Bridge enabled by default — getAll returns no override, so the bridge
	// proceeds with the append.
	const conversationConfig: AppConfigService = {
		get: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockResolvedValue({}),
		getOverrides: vi.fn().mockResolvedValue(null),
		setAll: vi.fn().mockResolvedValue(undefined),
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		removeOverride: vi.fn().mockResolvedValue(undefined),
	} as unknown as AppConfigService;

	const bridge = createAppOutboundBridge({
		chatSessions,
		conversationConfig,
		logger,
	});

	return {
		tempDir,
		chatSessions,
		bridge,
		teardown: () => rm(tempDir, { recursive: true, force: true }),
	};
}

/** Capture the chatbot's system prompt the way handle-message.ts does. */
async function captureChatbotSystemPrompt(
	chatSessions: ChatSessionStore,
	userId: string,
): Promise<string> {
	const sessionKey = buildSessionKey({
		agent: 'main',
		channel: 'telegram',
		scope: 'dm',
		chatId: userId,
	});
	const turns = await chatSessions.loadRecentTurns({ userId, sessionKey }, { maxTurns: 20 });
	return buildSystemPrompt([], turns, {
		llm: stubLlmServiceForPrompt(),
		logger: silentAppLogger(),
	});
}

// ─── (A) Two-question messages ──────────────────────────────────────────────

interface TwoSegCase {
	name: string;
	input: string;
	segments: [string, string];
	classifications: Array<{ appId: string; intent: string; confidence: number } | null>;
}

const TWO_SEG_CASES: TwoSegCase[] = [
	{
		name: 'literal bug message (greeting + invite + memory question)',
		input:
			'Good morning! Can you tell me about inviting people? Also, can you see what meals were suggested I cooked last night?',
		segments: [
			'Can you tell me about inviting people?',
			'can you see what meals were suggested I cooked last night?',
		],
		classifications: [null, null], // both → chatbot fallback
	},
	{
		name: 'dinner + grocery budget',
		input:
			"Hi! What's for dinner tonight and how much did I spend on groceries this week? Also, can you tell me both?",
		segments: ["What's for dinner tonight?", 'How much did I spend on groceries this week?'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
		],
	},
	{
		name: 'pantry + add eggs to list',
		input: 'Show me my pantry. Also can you add eggs to the list?',
		segments: ['Show me my pantry.', 'Can you add eggs to the list?'],
		classifications: [
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
		],
	},
	{
		name: 'time + what apps do you have',
		input: 'Tell me the time please. Also, what apps do you have available?',
		segments: ['Tell me the time please.', 'What apps do you have available?'],
		classifications: [null, null],
	},
	{
		name: 'pantry + calendar',
		input: 'Show me my pantry contents. Additionally what is on my calendar today?',
		segments: ['Show me my pantry contents.', 'What is on my calendar today?'],
		classifications: [
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
	{
		name: 'dinner + then add milk',
		input: "What's for dinner tonight? Then add milk to my grocery list please.",
		segments: ["What's for dinner tonight?", 'Add milk to my grocery list please.'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
		],
	},
	{
		name: 'two chatbot questions',
		input: 'Who wrote the Iliad? Also, what year was it written?',
		segments: ['Who wrote the Iliad?', 'What year was it written?'],
		classifications: [null, null],
	},
	{
		name: 'spending + plus what is for dinner',
		input:
			'Show me how much I spent on groceries this week. Plus what is for dinner tonight please?',
		segments: [
			'Show me how much I spent on groceries this week.',
			'What is for dinner tonight please?',
		],
		classifications: [
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
		],
	},
	{
		name: 'invite help + tell me a joke',
		input: 'Tell me about inviting people to PAS. Also, tell me a joke please.',
		segments: ['Tell me about inviting people to PAS.', 'Tell me a joke please.'],
		classifications: [null, null],
	},
	{
		name: 'pantry + general knowledge',
		input: 'Show me what is in my pantry. As well, what is the capital of France?',
		segments: ['Show me what is in my pantry.', 'What is the capital of France?'],
		classifications: [{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 }, null],
	},
	{
		name: 'dinner + one more thing add bread',
		input: "What's for dinner tonight? One more thing, add bread to my grocery list.",
		segments: ["What's for dinner tonight?", 'Add bread to my grocery list.'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
		],
	},
	{
		name: 'calendar + spending',
		input:
			'What is on my calendar today? Additionally, how much did I spend on groceries this week?',
		segments: ['What is on my calendar today?', 'How much did I spend on groceries this week?'],
		classifications: [
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
		],
	},
	{
		name: 'add milk + show pantry (food + food)',
		input: 'Add milk to my grocery list. Also, show me what is in my pantry please.',
		segments: ['Add milk to my grocery list.', 'Show me what is in my pantry please.'],
		classifications: [
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
		],
	},
	{
		name: 'long greeting then two questions',
		input:
			"Good morning to you! What's for dinner tonight, by the way? Also what is on my calendar today?",
		segments: ["What's for dinner tonight?", 'What is on my calendar today?'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
	{
		name: 'two memory questions about food history',
		input:
			'Can you remind me what I cooked last week? Also, what did I add to my grocery list yesterday?',
		segments: [
			'Can you remind me what I cooked last week?',
			'What did I add to my grocery list yesterday?',
		],
		classifications: [null, null],
	},
	{
		name: 'spending + calendar',
		input: 'How much did I spend on groceries this week, plus what is on my calendar today?',
		segments: ['How much did I spend on groceries this week?', 'What is on my calendar today?'],
		classifications: [
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
];

// ─── (B) Three-question messages ────────────────────────────────────────────

interface ThreeSegCase {
	name: string;
	input: string;
	segments: [string, string, string];
	classifications: Array<{ appId: string; intent: string; confidence: number } | null>;
}

const THREE_SEG_CASES: ThreeSegCase[] = [
	{
		name: 'dinner + pantry + calendar',
		input: "What's for dinner tonight? Also show me my pantry. Plus what is on my calendar today?",
		segments: ["What's for dinner tonight?", 'Show me my pantry.', 'What is on my calendar today?'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
	{
		name: 'all-food triple',
		input:
			"What's for dinner tonight? Also add eggs to my grocery list. Plus show me my pantry contents.",
		segments: [
			"What's for dinner tonight?",
			'Add eggs to my grocery list.',
			'Show me my pantry contents.',
		],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
		],
	},
	{
		name: 'all-chatbot triple',
		input:
			'Tell me about inviting people. Also, what apps do you have? Plus tell me the current time.',
		segments: [
			'Tell me about inviting people.',
			'What apps do you have?',
			'Tell me the current time.',
		],
		classifications: [null, null, null],
	},
	{
		name: 'spending + dinner + calendar',
		input:
			'How much did I spend on groceries this week? Also what is for dinner tonight? Plus what is on my calendar today?',
		segments: [
			'How much did I spend on groceries this week?',
			'What is for dinner tonight?',
			'What is on my calendar today?',
		],
		classifications: [
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
	{
		name: 'mixed knowledge + food + calendar',
		input:
			'Who wrote War and Peace? Also what is for dinner tonight? Additionally what is on my calendar today?',
		segments: [
			'Who wrote War and Peace?',
			'What is for dinner tonight?',
			'What is on my calendar today?',
		],
		classifications: [
			null,
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
	{
		name: 'pantry + bread + dinner',
		input: 'Show me my pantry. Also add bread to my grocery list. Plus what is for dinner tonight?',
		segments: [
			'Show me my pantry.',
			'Add bread to my grocery list.',
			'What is for dinner tonight?',
		],
		classifications: [
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
		],
	},
	{
		name: 'three general knowledge questions',
		input:
			'What is the tallest mountain? Also what is the deepest ocean? Plus what is the longest river?',
		segments: [
			'What is the tallest mountain?',
			'What is the deepest ocean?',
			'What is the longest river?',
		],
		classifications: [null, null, null],
	},
	{
		name: 'invite help + add eggs + calendar',
		input:
			'Tell me about inviting people to PAS. Also add eggs to my list. Plus what is on my calendar today?',
		segments: [
			'Tell me about inviting people to PAS.',
			'Add eggs to my list.',
			'What is on my calendar today?',
		],
		classifications: [
			null,
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
			{ appId: 'calendar', intent: 'show the calendar for today', confidence: 0.9 },
		],
	},
];

// ─── (C) Four-question messages (segmenter has already merged tail to 3) ────

interface FourSegCase {
	name: string;
	input: string;
	/** What the production segmenter returns: 3 segments, tail = orig 3 + orig 4 joined. */
	mergedSegments: [string, string, string];
	mergedTailParts: [string, string];
	classifications: Array<{ appId: string; intent: string; confidence: number } | null>;
}

const FOUR_SEG_CASES: FourSegCase[] = [
	{
		name: 'dinner + pantry + spending + calendar (merge 3+4)',
		input:
			"What's for dinner tonight? Also show me my pantry. Plus how much did I spend on groceries this week? Additionally what is on my calendar today?",
		mergedSegments: [
			"What's for dinner tonight?",
			'Show me my pantry.',
			'How much did I spend on groceries this week? What is on my calendar today?',
		],
		mergedTailParts: [
			'How much did I spend on groceries this week?',
			'What is on my calendar today?',
		],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'show the pantry contents', confidence: 0.9 },
			null,
		],
	},
	{
		name: 'four food asks (merge 3+4)',
		input:
			"What's for dinner tonight? Also add milk. Plus add eggs to my grocery list. Additionally show me my pantry.",
		mergedSegments: [
			"What's for dinner tonight?",
			'Add milk to my grocery list.',
			'Add eggs to my grocery list. Show me my pantry.',
		],
		mergedTailParts: ['Add eggs to my grocery list.', 'Show me my pantry.'],
		classifications: [
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			{ appId: 'food', intent: 'add an item to the grocery list', confidence: 0.9 },
			null,
		],
	},
	{
		name: 'four chatbot questions (merge 3+4)',
		input:
			'Tell me about inviting people. Also what apps do you have? Plus what is the current time? Additionally tell me a joke please.',
		mergedSegments: [
			'Tell me about inviting people.',
			'What apps do you have?',
			'What is the current time? Tell me a joke please.',
		],
		mergedTailParts: ['What is the current time?', 'Tell me a joke please.'],
		classifications: [null, null, null],
	},
	{
		name: 'mixed four asks (merge 3+4)',
		input:
			"How much did I spend on groceries this week? Also what's for dinner tonight? Plus show me my pantry. Additionally what is on my calendar today?",
		mergedSegments: [
			'How much did I spend on groceries this week?',
			"What's for dinner tonight?",
			'Show me my pantry. What is on my calendar today?',
		],
		mergedTailParts: ['Show me my pantry.', 'What is on my calendar today?'],
		classifications: [
			{ appId: 'food', intent: 'show how much was spent on groceries', confidence: 0.9 },
			{ appId: 'food', intent: 'show what is for dinner tonight', confidence: 0.9 },
			null,
		],
	},
];

// ─── (D) Must-NOT-split messages (real prefilter returns false) ─────────────

const NO_SPLIT_CASES: { name: string; input: string }[] = [
	{ name: 'short single question', input: "what's for dinner?" },
	{ name: 'short imperative', input: 'show pantry' },
	{ name: 'comma list — milk eggs bread', input: 'add milk, eggs, and bread to the list' },
	{
		name: 'two-sentence-one-ask',
		input: 'I want to plan meals. Tomorrow night specifically.',
	},
	{
		name: 'single question with internal comma',
		input: 'after the meeting, send me the notes please',
	},
	{ name: 'short marker — also hi', input: 'also hi' },
	{ name: 'bare "and" — menu and groceries', input: 'show me the menu and the groceries please' },
	{ name: 'single statement no question', input: 'I am feeling tired today' },
	{ name: 'single command', input: 'add eggs to the grocery list please' },
	{ name: 'single question ending in ?', input: 'what is the weather like today?' },
	{ name: 'short hello', input: 'hello there friend' },
	{
		name: 'short item list with and',
		input: 'I need bread and butter and jam',
	},
	{ name: 'single question short', input: 'what time is it?' },
	{
		name: 'lots of commas but one ask',
		input: 'on Monday, Tuesday, Wednesday, can you remind me to take vitamins',
	},
	{
		name: 'single ask with parenthetical',
		input: 'show me the menu for tonight (the dinner one)',
	},
	{ name: 'compound noun phrase', input: 'add salt and pepper to the grocery list please' },
];

// ─── (E) Dependent-clause messages (segmenter returns 1 segment) ────────────

const DEPENDENT_CLAUSE_CASES: { name: string; input: string }[] = [
	{
		name: 'plan dinner Saturday and do that for tomorrow too',
		input: 'Plan dinner Saturday and do that for tomorrow too. Also can you handle both?',
	},
	{
		name: 'spending yesterday and also for last week',
		input: "Show me yesterday's spending and also for last week. Additionally both periods.",
	},
	{
		name: 'dinner tonight and also for tomorrow night',
		input: 'What is for dinner tonight and also for tomorrow night? Plus both nights please.',
	},
	{
		name: 'pantry items and also expiring soon',
		input: 'Show me pantry items and also the ones expiring soon. Also both lists.',
	},
	{
		name: 'add eggs and also butter to the list',
		input: 'Add eggs and also butter to the grocery list please. Additionally both items.',
	},
	{
		name: 'calendar today and also tomorrow',
		input: 'Show my calendar today and also tomorrow. Plus both days at once.',
	},
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Router multi-intent splitting — persona coverage (Task 4.5)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── (A) Two-question messages ─────────────────────────────────────────────
	describe('(A) Two-question messages — split into 2 and dispatch both', () => {
		it.each(TWO_SEG_CASES)('$name', async ({ input, segments, classifications }) => {
			const segmentMock = vi.fn(async () => [...segments] as string[]);
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
				classifyResults: classifications,
			});

			// Real prefilter MUST fire for these (they all contain "Also"/"Plus"/etc.)
			expect(preFilterMultiIntent(input)).toBe(true);

			await built.router.routeMessage(createTextCtx(input));

			// Preamble fired.
			expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
			// Segmenter consulted exactly once for the full message.
			expect(segmentMock).toHaveBeenCalledTimes(1);

			// Both segments dispatched somewhere (don't pin per-segment app —
			// that's the classifier's job; we just prove BOTH segments ran).
			const dispatched = collectDispatchedTexts(built);
			expect(dispatched).toHaveLength(2);
			expect(dispatched).toContain(segments[0]);
			expect(dispatched).toContain(segments[1]);
		});
	});

	// ── (B) Three-question messages ───────────────────────────────────────────
	describe('(B) Three-question messages — split into 3 and dispatch all three', () => {
		it.each(THREE_SEG_CASES)('$name', async ({ input, segments, classifications }) => {
			const segmentMock = vi.fn(async () => [...segments] as string[]);
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
				classifyResults: classifications,
			});

			expect(preFilterMultiIntent(input)).toBe(true);

			await built.router.routeMessage(createTextCtx(input));

			expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
			expect(segmentMock).toHaveBeenCalledTimes(1);

			const dispatched = collectDispatchedTexts(built);
			expect(dispatched).toHaveLength(3);
			for (const seg of segments) expect(dispatched).toContain(seg);
		});
	});

	// ── (C) Four-question messages (segmenter has already merged tail to 3) ──
	describe('(C) Four-question messages — segmenter merges overflow into segment 3', () => {
		it.each(FOUR_SEG_CASES)(
			'$name',
			async ({ input, mergedSegments, mergedTailParts, classifications }) => {
				const segmentMock = vi.fn(async () => [...mergedSegments] as string[]);
				const built = buildRouter({
					segment: segmentMock as unknown as Mock<
						(text: string, deps: unknown) => Promise<string[]>
					>,
					classifyResults: classifications,
				});

				expect(preFilterMultiIntent(input)).toBe(true);

				await built.router.routeMessage(createTextCtx(input));

				expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");

				// Exactly 3 dispatches (NOT 4) — the segmenter's merge contract.
				const dispatched = collectDispatchedTexts(built);
				expect(dispatched).toHaveLength(3);

				// Segment 3 contains BOTH original tail parts (proof the merge landed).
				const seg3Text = mergedSegments[2];
				expect(dispatched).toContain(seg3Text);
				for (const tailPart of mergedTailParts) {
					expect(seg3Text).toContain(tailPart);
				}
			},
		);
	});

	// ── (D) Must-NOT-split messages (prefilter rejects) ───────────────────────
	describe('(D) Must-NOT-split messages — real prefilter returns false', () => {
		it.each(NO_SPLIT_CASES)('$name', async ({ input }) => {
			// The real prefilter MUST reject these.
			expect(preFilterMultiIntent(input)).toBe(false);

			const segmentMock = vi.fn(async () => {
				throw new Error('segmenter must not be called for must-NOT-split case');
			});
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
			});

			await built.router.routeMessage(createTextCtx(input));

			// No segmenter call, no preamble.
			expect(segmentMock).not.toHaveBeenCalled();
			const preambleSent = (built.telegram.send as Mock).mock.calls.some(
				(c: unknown[]) => c[1] === "Got it — I'll cover all of those:",
			);
			expect(preambleSent).toBe(false);

			// Exactly one dispatch with the FULL original text.
			expect(collectDispatchedTexts(built)).toEqual([input]);
		});
	});

	// ── (E) Dependent-clause messages — segmenter returns 1 ──────────────────
	describe('(E) Dependent-clause messages — kept attached, single dispatch', () => {
		it.each(DEPENDENT_CLAUSE_CASES)('$name', async ({ input }) => {
			// Prefilter fires (these all contain marker words), but the LLM
			// segmenter correctly returns 1 segment for them.
			expect(preFilterMultiIntent(input)).toBe(true);

			const segmentMock = vi.fn(async (text: string) => [text]);
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
			});

			await built.router.routeMessage(createTextCtx(input));

			// Segmenter consulted (it had to be, because prefilter fired).
			expect(segmentMock).toHaveBeenCalledTimes(1);
			// But because only 1 segment came back, NO preamble.
			const preambleSent = (built.telegram.send as Mock).mock.calls.some(
				(c: unknown[]) => c[1] === "Got it — I'll cover all of those:",
			);
			expect(preambleSent).toBe(false);
			// Exactly one dispatch with the FULL original text.
			expect(collectDispatchedTexts(built)).toEqual([input]);
		});
	});

	// ── (F) Partial-failure cases — one segment throws, siblings continue ────
	describe('(F) Partial-failure cases — failing segment apologizes; siblings still run', () => {
		const PARTIAL_FAILURE_CASES: {
			name: string;
			input: string;
			segments: string[];
			failingIndex: number;
		}[] = [
			{
				name: 'segment 1 of 2 fails',
				input: 'Show me my pantry. Also what is for dinner tonight?',
				segments: ['Show me my pantry.', 'What is for dinner tonight?'],
				failingIndex: 0,
			},
			{
				name: 'segment 2 of 2 fails',
				input: 'Show me my pantry. Also what is for dinner tonight?',
				segments: ['Show me my pantry.', 'What is for dinner tonight?'],
				failingIndex: 1,
			},
			{
				name: 'segment 2 of 3 fails (middle); 1 and 3 still run',
				input:
					"What's for dinner tonight? Also add eggs to my list. Plus show me my pantry contents.",
				segments: [
					"What's for dinner tonight?",
					'Add eggs to my list.',
					'Show me my pantry contents.',
				],
				failingIndex: 1,
			},
			{
				name: 'segment 3 of 3 fails (last); 1 and 2 still run',
				input:
					"What's for dinner tonight? Also add eggs to my list. Plus show me my pantry contents.",
				segments: [
					"What's for dinner tonight?",
					'Add eggs to my list.',
					'Show me my pantry contents.',
				],
				failingIndex: 2,
			},
		];

		it.each(PARTIAL_FAILURE_CASES)('$name', async ({ input, segments, failingIndex }) => {
			const segmentMock = vi.fn(async () => [...segments]);
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
				// Classify every segment as null → fallback path → conversation.
				// We override routeOneTextRequest below so the per-index throw
				// fires before any actual handler runs for the failing segment.
			});

			// Patch routeOneTextRequest to throw on the failingIndex-th call.
			interface RouteShim {
				routeOneTextRequest: (ctx: MessageContext, user: unknown) => Promise<void>;
			}
			const shim = built.router as unknown as RouteShim;
			const original = shim.routeOneTextRequest.bind(built.router);
			let call = 0;
			shim.routeOneTextRequest = vi.fn(async (ctx: MessageContext, user: unknown) => {
				const myCall = call++;
				if (myCall === failingIndex) throw new Error(`boom: segment ${failingIndex} failed`);
				return original(ctx, user);
			});

			await built.router.routeMessage(createTextCtx(input));

			// Preamble fired.
			expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
			// Per-segment apology fired for the failing index.
			expect(built.telegram.send).toHaveBeenCalledWith(
				'u1',
				"(I couldn't handle that part — sorry.)",
			);

			// Sibling segments (N-1 of them) still ran via the real routeOneTextRequest.
			expect(built.convHandle).toHaveBeenCalledTimes(segments.length - 1);
		});
	});

	// ── (G) The literal bug — full integration (Parts 1 + 3 + 4 combined) ────
	describe('(G) Literal-bug integration — bridged Food context visible to chatbot', () => {
		let env: BridgeEnv;
		afterEach(async () => {
			await env?.teardown();
		});

		it('literal bug message: both segments dispatch; segment 2 sees bridged [App: food] nightly-rating-prompt', async () => {
			env = await makeBridgeEnv();

			// (1) Simulate the nightly-rating-prompt job firing BEFORE the user
			// sends the literal bug message — this is what the cron job at
			// `apps/food/src/handlers/scheduled.ts` would do via the real
			// `services.appOutboundBridge`. We invoke the bridge directly
			// because core tests cannot import from apps/food (workspace
			// isolation rule). The canonical Food-side proof that the JOB
			// actually calls the bridge lives at:
			//   apps/food/src/__tests__/app-outbound-bridge-wiring.test.ts
			//   apps/food/src/__tests__/proactive-bridge.persona.test.ts (P1)
			await env.bridge.recordOutboundMessage({
				userId: 'u1',
				appId: 'food',
				kind: 'nightly-rating-prompt',
				body: 'How was your dinner of Chicken Dinner tonight? Reply 1-5 to rate.',
			});

			// Sanity: bridged turn-pair landed in transcript with the right header.
			const sessionKey = buildSessionKey({
				agent: 'main',
				channel: 'telegram',
				scope: 'dm',
				chatId: 'u1',
			});
			const turns = await env.chatSessions.loadRecentTurns(
				{ userId: 'u1', sessionKey },
				{ maxTurns: 20 },
			);
			expect(turns.length).toBeGreaterThanOrEqual(2);
			expect(turns.at(-2)?.content).toBe('[App: food] nightly-rating-prompt');
			expect(turns.at(-1)?.content).toContain('Chicken Dinner');

			// (2) Dispatch the literal bug message through the router with
			// multi-intent enabled. Mock the segmenter to return EXACTLY two
			// segments (dropping the "Good morning!" greeting fragment, per
			// the segmenter's prompt contract).
			const segA = 'Can you tell me about inviting people?';
			const segB = 'can you see what meals were suggested I cooked last night?';
			const literalBugMessage =
				'Good morning! Can you tell me about inviting people? Also, can you see what meals were suggested I cooked last night?';
			const segmentMock = vi.fn(async () => [segA, segB]);

			// buildRouter wires a conversation-service spy at built.convHandle by
			// default so we can confirm BOTH segments route to chatbot (no app
			// intent matches either one).
			const built = buildRouter({
				segment: segmentMock as unknown as Mock<(text: string, deps: unknown) => Promise<string[]>>,
				classifyResults: [null, null], // neither segment matches a manifest intent
			});

			// Real prefilter must fire for the literal bug message.
			expect(preFilterMultiIntent(literalBugMessage)).toBe(true);

			await built.router.routeMessage(createTextCtx(literalBugMessage));

			// Preamble fired.
			expect(built.telegram.send).toHaveBeenCalledWith('u1', "Got it — I'll cover all of those:");
			// Both segments dispatched to chatbot.
			expect(built.convHandle).toHaveBeenCalledTimes(2);
			const dispatchedTexts = (built.convHandle.mock.calls as Array<[MessageContext]>).map(
				([c]) => c.text,
			);
			expect(dispatchedTexts).toEqual([segA, segB]);

			// (3) Capture the chatbot system prompt segment 2 would see — this
			// is the load-bearing assertion. The bridged Food turn-pair must
			// be present in the conversation-history section so the chatbot
			// can answer "what meals were suggested I cooked last night?"
			// from REAL context, not by hallucinating.
			const prompt = await captureChatbotSystemPrompt(env.chatSessions, 'u1');
			expect(prompt).toContain('[App: food] nightly-rating-prompt');
			expect(prompt).toContain('Chicken Dinner');
		});
	});
});
