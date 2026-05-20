/**
 * Persona tests for /recall command.
 *
 * Tests cover:
 *   - Router dispatch: various /recall <query> forms → handleRecall with correct args
 *   - Should NOT dispatch: no slash prefix, other commands
 *   - Handler behavior: various queries → correct queryTerms to searchSessions
 *   - Multi-step scenarios
 *   - Auth boundary
 *
 * All assertions target deterministic surfaces (handler args, queryTerms,
 * telegram.send content) — not LLM behavior.
 *
 * REQ-CONV-RECALL-001..009
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { AppLogger } from '../../../types/app-module.js';
import type { SystemConfig } from '../../../types/config.js';
import type { LLMService } from '../../../types/llm.js';
import type { AppManifest } from '../../../types/manifest.js';
import type { MessageContext, TelegramService } from '../../../types/telegram.js';
import { type AppRegistry, ManifestCache, type RegisteredApp } from '../../app-registry/index.js';
import type { SearchHit, SearchResult } from '../../chat-transcript-index/types.js';
import { requestContext } from '../../context/request-context.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/conversation-retrieval-service.js';
import { ConversationRetrievalError } from '../../conversation-retrieval/conversation-retrieval-service.js';
import type { FallbackHandler } from '../../router/fallback.js';
import { Router } from '../../router/index.js';
import { handleRecall } from '../handle-recall.js';
import type { HandleRecallDeps } from '../handle-recall.js';

// ---------------------------------------------------------------------------
// Router fixtures (mirrors router-recall.test.ts)
// ---------------------------------------------------------------------------

function createMockLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as any;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendWithButtons: vi.fn().mockResolvedValue(undefined),
		editMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockLLM(): LLMService {
	return {
		complete: vi.fn().mockResolvedValue('hi'),
		classify: vi.fn().mockResolvedValue({ category: 'unknown', confidence: 0.1 }),
		extractStructured: vi.fn(),
	};
}

function createConfig(): SystemConfig {
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
		users: [{ id: 'user1', name: 'Alice', isAdmin: true, enabledApps: ['*'], sharedScopes: [] }],
	};
}

const chatbotManifest: AppManifest = {
	app: { id: 'chatbot', name: 'Chatbot', version: '1.0.0', description: 'Chatbot', author: 'Test' },
	capabilities: { messages: {} },
};

function makeConversationService() {
	return {
		handleMessage: vi.fn().mockResolvedValue(undefined),
		handleAsk: vi.fn().mockResolvedValue(undefined),
		handleEdit: vi.fn().mockResolvedValue(undefined),
		handleNotes: vi.fn().mockResolvedValue(undefined),
		handleNewChat: vi.fn().mockResolvedValue(undefined),
		handleTitle: vi.fn().mockResolvedValue(undefined),
		handleRecall: vi.fn().mockResolvedValue(undefined),
	};
}

function buildRouter(conversationService: ReturnType<typeof makeConversationService> | undefined) {
	const cache = new ManifestCache();
	cache.add(chatbotManifest, '/apps/chatbot');

	const registry = {
		getApp: (id: string) =>
			id === 'chatbot'
				? ({
						manifest: chatbotManifest,
						module: { init: vi.fn(), handleMessage: vi.fn() } as any,
						appDir: '/apps/chatbot',
					} as RegisteredApp)
				: undefined,
		getManifestCache: () => cache,
		getLoadedAppIds: () => ['chatbot'],
	} as unknown as AppRegistry;

	const telegram = createMockTelegram();
	const router = new Router({
		registry,
		llm: createMockLLM(),
		telegram,
		fallback: { handleUnrecognized: vi.fn() } as unknown as FallbackHandler,
		config: createConfig(),
		logger: createMockLogger(),
		conversationService: conversationService as any,
	});
	router.buildRoutingTables();
	return { router, telegram };
}

function msg(text: string, userId = 'user1'): MessageContext {
	return { userId, text, timestamp: new Date(), chatId: 1, messageId: 1 };
}

// ---------------------------------------------------------------------------
// Handler fixtures
// ---------------------------------------------------------------------------

function makeLogger(): AppLogger {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	} as unknown as AppLogger;
}

function makeTelegram() {
	return { send: vi.fn().mockResolvedValue(undefined) } as unknown as TelegramService & {
		send: ReturnType<typeof vi.fn>;
	};
}

function makeSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
	return {
		sessionId: '20260428_142301_3a1b2c4d',
		sessionStartedAt: '2026-04-28T14:23:01Z',
		sessionEndedAt: '2026-04-28T15:00:00Z',
		title: 'Test session',
		matches: [
			{
				turn_index: 1,
				role: 'user',
				timestamp: '2026-04-28T14:24:00Z',
				snippet: 'test snippet content',
				bm25: -1.0,
			},
		],
		...overrides,
	};
}

function makeRetrieval(result: SearchResult = { hits: [] }): ConversationRetrievalService {
	return {
		hasSessionSearch: vi.fn().mockReturnValue(true),
		searchSessions: vi.fn().mockResolvedValue(result),
	} as unknown as ConversationRetrievalService;
}

function makeDeps(retrieval?: ConversationRetrievalService): HandleRecallDeps & {
	telegram: { send: ReturnType<typeof vi.fn> };
} {
	return {
		conversationRetrieval: retrieval,
		telegram: makeTelegram() as any,
		logger: makeLogger(),
	};
}

function makeCtx(userId = 'user1', text = '/recall pasta') {
	return createTestMessageContext({ userId, text });
}

function runWithContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, fn);
}

// ---------------------------------------------------------------------------
// Section 1: Router dispatch — various /recall <query> forms
// ---------------------------------------------------------------------------

describe('/recall persona — router dispatch', () => {
	let conv: ReturnType<typeof makeConversationService>;

	beforeEach(() => {
		conv = makeConversationService();
	});

	// 30 dispatch cases: each verifies handleRecall is called with correct args

	it.each([
		['/recall pasta', ['pasta']],
		['/recall PASTA', ['PASTA']],
		['/recall pasta carbonara', ['pasta', 'carbonara']],
		[
			'/recall what did i say about onions last week',
			['what', 'did', 'i', 'say', 'about', 'onions', 'last', 'week'],
		],
		['/recall pantry restock', ['pantry', 'restock']],
		['/recall school lunches', ['school', 'lunches']],
		['/recall grocery list', ['grocery', 'list']],
		['/recall mushroom risotto recipe', ['mushroom', 'risotto', 'recipe']],
		['/recall dinner plans for friday', ['dinner', 'plans', 'for', 'friday']],
		['/recall what we discussed last time', ['what', 'we', 'discussed', 'last', 'time']],
		['/recall birthday party ideas', ['birthday', 'party', 'ideas']],
		['/recall homework', ['homework']],
		['/recall kids schedule', ['kids', 'schedule']],
		['/recall budget planning', ['budget', 'planning']],
		['/recall weekend trip', ['weekend', 'trip']],
		['/recall chicken stew recipe', ['chicken', 'stew', 'recipe']],
		[
			'/recall when did we talk about the car',
			['when', 'did', 'we', 'talk', 'about', 'the', 'car'],
		],
		['/recall meal prep ideas', ['meal', 'prep', 'ideas']],
		['/recall allergies', ['allergies']],
		['/recall the', ['the']],
		['/recall and a the', ['and', 'a', 'the']],
		['/recall    leading spaces query', ['leading', 'spaces', 'query']],
		['/recall query   with   extra   spaces', ['query', 'with', 'extra', 'spaces']],
		['/recall café latte', ['café', 'latte']],
		['/recall naïve approach', ['naïve', 'approach']],
		['/recall 2026 January planning', ['2026', 'January', 'planning']],
		['/recall onions garlic ginger', ['onions', 'garlic', 'ginger']],
		['/recall UPPER CASE', ['UPPER', 'CASE']],
		['/recall MixedCase Query', ['MixedCase', 'Query']],
	] as [string, string[]][])('"%s" dispatches with args %j', async (text, expectedArgs) => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg(text));

		expect(conv.handleRecall).toHaveBeenCalledOnce();
		const [args] = conv.handleRecall.mock.calls[0]!;
		expect(args).toEqual(expectedArgs);
	});

	it('@bot suffix is stripped: /recall@PASBot pasta → args=["pasta"]', async () => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg('/recall@PASBot pasta'));
		expect(conv.handleRecall).toHaveBeenCalledOnce();
		const [args] = conv.handleRecall.mock.calls[0]!;
		expect(args).toEqual(['pasta']);
	});

	it('@bot suffix (lowercase): /recall@mybot query → dispatches', async () => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg('/recall@mybot query'));
		expect(conv.handleRecall).toHaveBeenCalledOnce();
	});

	it('leading whitespace " /recall pasta" dispatches — parseCommand trims first', async () => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg(' /recall pasta'));
		expect(conv.handleRecall).toHaveBeenCalledOnce();
		const [args] = conv.handleRecall.mock.calls[0]!;
		expect(args).toEqual(['pasta']);
	});

	it('/recall (no args) dispatches with empty args → handler shows usage', async () => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg('/recall'));
		expect(conv.handleRecall).toHaveBeenCalledOnce();
		const [args] = conv.handleRecall.mock.calls[0]!;
		expect(args).toEqual([]);
	});

	it('/recall route has source=command, intent=recall, appId=chatbot, confidence=1.0', async () => {
		const { router } = buildRouter(conv);
		await router.routeMessage(msg('/recall pasta'));
		const [, ctx] = conv.handleRecall.mock.calls[0]!;
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('recall');
		expect(ctx.route?.appId).toBe('chatbot');
		expect(ctx.route?.confidence).toBe(1.0);
	});
});

// ---------------------------------------------------------------------------
// Section 2: Should NOT dispatch to handleRecall
// ---------------------------------------------------------------------------

describe('/recall persona — should NOT dispatch to handleRecall', () => {
	it.each([
		'recall pasta',
		'recall my password',
		'recall what we discussed',
		'please recall everything',
		'i need to recall the recipe',
		'can you recall what I said about dinner',
		'search for pasta',
		'find my grocery list',
		'look up my notes',
		'what did I say about school',
		'search past conversations for recipe',
		'/search pasta',
		'/find pasta',
		'/history pasta',
		'/lookup pasta',
	])('"%s" does NOT call handleRecall', async (text) => {
		const conv = makeConversationService();
		const { router } = buildRouter(conv);
		await router.routeMessage(msg(text));
		expect(conv.handleRecall).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Section 3: Handler behavior — queryTerms
// ---------------------------------------------------------------------------

describe('/recall persona — handler queryTerms', () => {
	it.each([
		['pasta', ['pasta']],
		['pasta carbonara', ['pasta', 'carbonara']],
		['school lunches', ['school', 'lunches']],
		['the and a', ['the', 'and', 'a']],
		['GROCERY LIST', ['GROCERY', 'LIST']],
	] as [string, string[]][])(
		'query "%s" → searchSessions called with queryTerms %j',
		async (query, expectedTerms) => {
			const retrieval = makeRetrieval();
			const deps = makeDeps(retrieval);
			const ctx = makeCtx();
			await runWithContext('user1', () => handleRecall(query.split(' '), ctx, deps));
			expect(retrieval.searchSessions).toHaveBeenCalledWith(
				expect.objectContaining({ queryTerms: expectedTerms }),
			);
		},
	);

	it('FTS operators stripped: "*" → zero terms → no search', async () => {
		const retrieval = makeRetrieval();
		const deps = makeDeps(retrieval);
		await runWithContext('user1', () => handleRecall(['"*()"'], makeCtx(), deps));
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('No searchable terms');
	});

	it('no excludeSessionIds passed — current session is searchable from /recall', async () => {
		const retrieval = makeRetrieval();
		const deps = makeDeps(retrieval);
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const opts = (retrieval.searchSessions as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(opts.excludeSessionIds).toBeUndefined();
	});

	it('limitSessions=5, limitMessagesPerSession=3 always used', async () => {
		const retrieval = makeRetrieval();
		const deps = makeDeps(retrieval);
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		expect(retrieval.searchSessions).toHaveBeenCalledWith(
			expect.objectContaining({ limitSessions: 5, limitMessagesPerSession: 3 }),
		);
	});
});

// ---------------------------------------------------------------------------
// Section 4: Handler output — reply content
// ---------------------------------------------------------------------------

describe('/recall persona — reply formatting', () => {
	it('reply contains session title', async () => {
		const hit = makeSearchHit({ title: 'Pasta carbonara night' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('Pasta carbonara night');
	});

	it('reply contains date in YYYY-MM-DD format', async () => {
		const hit = makeSearchHit({ sessionStartedAt: '2026-03-15T10:00:00Z' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['test'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('2026-03-15');
	});

	it('reply contains full session id YYYYMMDD_HHMMSS_<8hex>', async () => {
		const hit = makeSearchHit({ sessionId: '20260315_100000_cafebabe' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['test'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('20260315_100000_cafebabe');
	});

	it('empty results: "No past conversations matched" message', async () => {
		const deps = makeDeps(makeRetrieval({ hits: [] }));
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toMatch(/No past conversations matched/);
	});

	it('null title shown as "(untitled)"', async () => {
		const hit = makeSearchHit({ title: null });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['test'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('untitled');
	});

	it('FTS5 highlight markers stripped: [pasta] → pasta in snippet', async () => {
		const hit = makeSearchHit({
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					snippet: 'we should make [pasta] tonight',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).not.toContain('[pasta]');
		expect(sent).toContain('pasta');
	});

	it('user [brackets] not a query term: survive in escaped form \\[not a highlight\\]', async () => {
		const hit = makeSearchHit({
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					snippet: 'check [not a highlight] here',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('\\[not a highlight\\]');
	});

	it('Markdown special chars in snippet are escaped', async () => {
		const hit = makeSearchHit({
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					snippet: 'try *bold* and _italic_',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['bold'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toContain('\\*bold\\*');
		expect(sent).toContain('\\_italic\\_');
	});
});

// ---------------------------------------------------------------------------
// Section 5: Multi-step scenarios
// ---------------------------------------------------------------------------

describe('/recall persona — multi-step', () => {
	it('Step 1: empty /recall shows usage; Step 2: /recall pasta triggers search', async () => {
		const retrieval = makeRetrieval({ hits: [makeSearchHit({ title: 'Pasta night' })] });
		const deps = makeDeps(retrieval);
		const ctx = makeCtx();

		// Step 1: no args → usage help
		await runWithContext('user1', () => handleRecall([], ctx, deps));
		expect((deps.telegram as any).send.mock.calls[0][1]).toContain('/recall');
		expect(retrieval.searchSessions).not.toHaveBeenCalled();

		// Step 2: real query → search runs
		await runWithContext('user1', () => handleRecall(['pasta'], ctx, deps));
		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const sent2 = (deps.telegram as any).send.mock.calls[1][1] as string;
		expect(sent2).toContain('Pasta night');
	});

	it('Hostile content scenario: prior session contains *bold* → Markdown is escaped', async () => {
		const hit = makeSearchHit({
			title: 'Normal title',
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					snippet: '*bold* and _italic_ content',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		await runWithContext('user1', () => handleRecall(['bold'], makeCtx(), deps));

		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		// Asterisks escaped — no raw Markdown bold that could render unintentionally
		expect(sent).toContain('\\*bold\\*');
		expect(sent).toContain('\\_italic\\_');
		// The words are still present
		expect(sent).toContain('bold');
		expect(sent).toContain('italic');
	});

	it('Two users: each /recall call returns only their own results', async () => {
		const hitA = makeSearchHit({ sessionId: '20260101_000000_aaaaaaaa', title: 'Alice pasta' });
		const hitB = makeSearchHit({ sessionId: '20260101_000000_bbbbbbbb', title: 'Bob pantry' });

		const retrievalA = makeRetrieval({ hits: [hitA] });
		const retrievalB = makeRetrieval({ hits: [hitB] });
		const depsA = makeDeps(retrievalA);
		const depsB = makeDeps(retrievalB);

		const ctxA = makeCtx('userA', '/recall pasta');
		const ctxB = makeCtx('userB', '/recall pantry');

		await Promise.all([
			requestContext.run({ userId: 'userA' }, () => handleRecall(['pasta'], ctxA, depsA)),
			requestContext.run({ userId: 'userB' }, () => handleRecall(['pantry'], ctxB, depsB)),
		]);

		const sentA = (depsA.telegram as any).send.mock.calls[0][1] as string;
		const sentB = (depsB.telegram as any).send.mock.calls[0][1] as string;

		// A sees only A's content
		expect(sentA).toContain('Alice pasta');
		expect(sentA).not.toContain('Bob');

		// B sees only B's content
		expect(sentB).toContain('Bob pantry');
		expect(sentB).not.toContain('Alice');
	});

	it('Multi-hit reply: 5 sessions each with long snippets → telegram.send called', async () => {
		const hits: SearchHit[] = Array.from({ length: 5 }, (_, i) =>
			makeSearchHit({
				sessionId: `20260428_14000${i}_abcd000${i}`,
				title: `Session ${i}`,
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: '2026-04-28T14:00:00Z',
						snippet: 'long '.repeat(60),
						bm25: -1.0,
					},
				],
			}),
		);
		const deps = makeDeps(makeRetrieval({ hits }));
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		expect((deps.telegram as any).send).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Section 6: Error and unavailability handling
// ---------------------------------------------------------------------------

describe('/recall persona — error handling', () => {
	it('retrieval service undefined → "not available" message', async () => {
		const deps = makeDeps(undefined);
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toMatch(/not available/i);
	});

	it('hasSessionSearch=false → "not available" message, no search', async () => {
		const retrieval = makeRetrieval();
		vi.mocked(retrieval.hasSessionSearch as ReturnType<typeof vi.fn>).mockReturnValue(false);
		const deps = makeDeps(retrieval);
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		expect((deps.telegram as any).send.mock.calls[0][1]).toMatch(/not available/i);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
	});

	it('searchSessions throws → logged and generic error sent', async () => {
		const retrieval = makeRetrieval();
		vi.mocked(retrieval.searchSessions).mockRejectedValue(
			new ConversationRetrievalError('no context', 'transcript-search'),
		);
		const deps = makeDeps(retrieval);
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));
		expect((deps.logger as any).warn).toHaveBeenCalled();
		const sent = (deps.telegram as any).send.mock.calls[0][1] as string;
		expect(sent).toMatch(/Search failed/);
	});
});
