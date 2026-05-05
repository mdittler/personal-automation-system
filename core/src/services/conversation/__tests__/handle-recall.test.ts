/**
 * Unit tests for handleRecall — the /recall slash command handler.
 *
 * Covers: happy path, edge cases, error handling, security, concurrency.
 * REQ-CONV-RECALL-001..009
 */

import { describe, expect, it, vi } from 'vitest';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { AppLogger } from '../../../types/app-module.js';
import type { TelegramService } from '../../../types/telegram.js';
import type { SearchHit, SearchResult } from '../../chat-transcript-index/types.js';
import { requestContext } from '../../context/request-context.js';
import type {
	ConversationRetrievalService,
	SessionSearchOpts,
} from '../../conversation-retrieval/conversation-retrieval-service.js';
import { ConversationRetrievalError } from '../../conversation-retrieval/conversation-retrieval-service.js';
import { handleRecall } from '../handle-recall.js';
import type { HandleRecallDeps } from '../handle-recall.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeLogger(): AppLogger {
	return {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	} as unknown as AppLogger;
}

function makeTelegram(): { send: ReturnType<typeof vi.fn> } & TelegramService {
	return { send: vi.fn().mockResolvedValue(undefined) } as unknown as {
		send: ReturnType<typeof vi.fn>;
	} & TelegramService;
}

function makeSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
	return {
		sessionId: '20260428_142301_3a1b2c4d',
		sessionStartedAt: '2026-04-28T14:23:01Z',
		sessionEndedAt: '2026-04-28T15:00:00Z',
		title: 'Conversation about pasta',
		matches: [
			{
				turn_index: 5,
				role: 'user',
				timestamp: '2026-04-28T14:25:00Z',
				snippet: 'we should make pasta',
				bm25: -1.5,
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

type MockDeps = HandleRecallDeps & {
	telegram: { send: ReturnType<typeof vi.fn> } & TelegramService;
	logger: AppLogger;
};

function makeDeps(retrieval?: ConversationRetrievalService): MockDeps {
	// Explicit undefined as argument to avoid JS default-parameter trigger:
	// makeDeps(undefined) works because we check retrieval === undefined inside.
	return {
		conversationRetrieval: retrieval,
		telegram: makeTelegram(),
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
// Happy path
// ---------------------------------------------------------------------------

describe('handleRecall — happy path', () => {
	it('recognizes valid query and formats hits', async () => {
		const hit = makeSearchHit({ title: 'Pasta night' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));
		const ctx = makeCtx('user1', '/recall pasta');

		await runWithContext('user1', () => handleRecall(['pasta'], ctx, deps));

		expect(deps.telegram.send).toHaveBeenCalledOnce();
		const sent = deps.telegram.send.mock.calls[0][1] as string;
		expect(sent).toContain('Pasta night');
		expect(sent).toContain('2026-04-28');
		expect(sent).toContain('20260428_142301_3a1b2c4d');
	});

	it('formats title, date, and full session id (YYYYMMDD_HHMMSS_<8hex>) per hit', async () => {
		const hit = makeSearchHit({
			sessionId: '20260501_090000_abcd1234',
			sessionStartedAt: '2026-05-01T09:00:00Z',
			title: 'Grocery planning',
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['groceries'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		// Full session id, not just 8-hex
		expect(sent).toContain('20260501_090000_abcd1234');
		// Date from started_at
		expect(sent).toContain('2026-05-01');
	});

	it('passes limitSessions=5 and limitMessagesPerSession=3 to searchSessions', async () => {
		const retrieval = makeRetrieval({ hits: [] });
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		expect(retrieval.searchSessions).toHaveBeenCalledWith(
			expect.objectContaining({
				limitSessions: 5,
				limitMessagesPerSession: 3,
			}),
		);
	});

	it('does NOT pass excludeSessionIds — current session is searchable', async () => {
		const retrieval = makeRetrieval({ hits: [] });
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		const opts = (retrieval.searchSessions as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as SessionSearchOpts;
		expect(opts.excludeSessionIds).toBeUndefined();
	});

	it('sends split response for 5 hits with long snippets', async () => {
		const hits: SearchHit[] = Array.from({ length: 5 }, (_, i) =>
			makeSearchHit({
				sessionId: `20260428_14230${i}_abcd000${i}`,
				title: `Session ${i}`,
				matches: [
					{
						turn_index: 1,
						role: 'user',
						timestamp: '2026-04-28T14:00:00Z',
						snippet: 'a'.repeat(300),
						bm25: -1.0,
					},
				],
			}),
		);
		const deps = makeDeps(makeRetrieval({ hits }));

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		// sendSplitResponse may call send multiple times for long replies
		expect(deps.telegram.send).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('handleRecall — edge cases', () => {
	it('empty query (no args) sends usage help', async () => {
		const deps = makeDeps(makeRetrieval());

		await runWithContext('user1', () => handleRecall([], makeCtx(), deps));

		expect(deps.telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('/recall'));
		expect(
			(deps.conversationRetrieval as ConversationRetrievalService).searchSessions,
		).not.toHaveBeenCalled();
	});

	it('empty query (whitespace-only args) sends usage help', async () => {
		const deps = makeDeps(makeRetrieval());

		await runWithContext('user1', () => handleRecall(['   ', ''], makeCtx(), deps));

		expect(deps.telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('/recall'));
		expect(
			(deps.conversationRetrieval as ConversationRetrievalService).searchSessions,
		).not.toHaveBeenCalled();
	});

	it('query containing only FTS operators and control chars sends "no searchable terms"', async () => {
		// buildUntrustedQuery strips FTS operators: " * ( ) : ^ and zero-width chars
		// Use a query containing only those characters — backslash is NOT in FTS5_OPERATORS
		// This produces zero terms — sanitizer does NOT filter stopwords
		const deps = makeDeps(makeRetrieval());

		await runWithContext('user1', () => handleRecall(['"*()"'], makeCtx(), deps));

		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('No searchable terms'),
		);
		expect(
			(deps.conversationRetrieval as ConversationRetrievalService).searchSessions,
		).not.toHaveBeenCalled();
	});

	it('stopwords like "the" ARE valid query terms (buildUntrustedQuery has no stopword filter)', async () => {
		const retrieval = makeRetrieval({ hits: [] });
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['the'], makeCtx(), deps));

		// "the" should produce one term and trigger a search
		expect(retrieval.searchSessions).toHaveBeenCalledWith(
			expect.objectContaining({ queryTerms: ['the'] }),
		);
	});

	it('empty hits sends "no matching conversations" with escaped query', async () => {
		const retrieval = makeRetrieval({ hits: [] });
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['pasta*'], makeCtx(), deps));

		// FTS operators are stripped by buildUntrustedQuery → "pasta" becomes the query
		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringMatching(/No past conversations matched/),
		);
	});

	it('shows (untitled) when hit title is null', async () => {
		const hit = makeSearchHit({ title: null });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		expect(sent).toContain('untitled');
	});

	it('single-hit reply formats correctly', async () => {
		const hit = makeSearchHit({
			title: 'Quick chat',
			sessionId: '20260101_120000_cafebabe',
			sessionStartedAt: '2026-01-01T12:00:00Z',
			matches: [
				{
					turn_index: 2,
					role: 'assistant',
					timestamp: '2026-01-01T12:01:00Z',
					snippet: 'Here is the recipe',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['recipe'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		expect(sent).toContain('Quick chat');
		expect(sent).toContain('2026-01-01');
		expect(sent).toContain('20260101_120000_cafebabe');
		expect(sent).toContain('Here is the recipe');
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('handleRecall — error handling', () => {
	it('searchSessions throws ConversationRetrievalError → logs and sends generic error', async () => {
		const retrieval = makeRetrieval();
		vi.mocked(retrieval.searchSessions).mockRejectedValue(
			new ConversationRetrievalError('no context', 'transcript-search'),
		);
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		expect(deps.logger.warn).toHaveBeenCalled();
		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringMatching(/Search failed/),
		);
	});

	it('conversationRetrieval undefined → sends "search not available"', async () => {
		const deps = makeDeps(undefined);

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringMatching(/not available/i),
		);
	});

	it('hasSessionSearch() returns false → sends "search not available"', async () => {
		const retrieval = makeRetrieval();
		vi.mocked(retrieval.hasSessionSearch as ReturnType<typeof vi.fn>).mockReturnValue(false);
		const deps = makeDeps(retrieval);

		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		expect(deps.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringMatching(/not available/i),
		);
		expect(retrieval.searchSessions).not.toHaveBeenCalled();
	});

	it('permanent telegram.send failure (non-Markdown error) propagates', async () => {
		const retrieval = makeRetrieval({ hits: [makeSearchHit()] });
		const deps = makeDeps(retrieval);
		const permanentError = new Error('Telegram 400 Bad Request');
		deps.telegram.send.mockRejectedValue(permanentError);

		await expect(
			runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps)),
		).rejects.toThrow('Telegram 400 Bad Request');
	});
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('handleRecall — security', () => {
	it('hostile snippet "*bold*" rendered as escaped \\*bold\\*, not as Markdown bold', async () => {
		const hit = makeSearchHit({
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					snippet: 'try *bold* formatting',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['bold'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		// The asterisks must be escaped
		expect(sent).toContain('\\*bold\\*');
		// Raw unescaped bold must not appear as Telegram bold (unescaped * chars)
		expect(sent).not.toMatch(/[^\\]\*bold\*[^\\]/);
	});

	it('hostile title with backticks does not break monospace formatting', async () => {
		const hit = makeSearchHit({ title: 'Session `rm -rf /` notes' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['notes'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		expect(sent).toContain('\\`rm -rf /\\`');
	});

	it('FTS5 [highlight] markers stripped term-aware: [pasta] → pasta', async () => {
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

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		// The highlight brackets around the query term should be removed
		expect(sent).not.toContain('[pasta]');
		// But the word should still be present
		expect(sent).toContain('pasta');
	});

	it('user content with literal [not a highlight] survives unmodified', async () => {
		const hit = makeSearchHit({
			matches: [
				{
					turn_index: 1,
					role: 'user',
					timestamp: '2026-04-28T14:00:00Z',
					// "[not a highlight]" is user-typed content that is NOT a query term highlight
					snippet: 'check [not a highlight] brackets here',
					bm25: -1.0,
				},
			],
		});
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		// Query is "pasta" — "not a highlight" is not a query term, so brackets survive
		await runWithContext('user1', () => handleRecall(['pasta'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		// The user's literal brackets (escaped for Markdown) should survive
		expect(sent).toContain('\\[not a highlight\\]');
	});

	it('hostile session id escaping does not break the reply', async () => {
		// sessionId is always YYYYMMDD_HHMMSS_8hex (no Markdown chars) but
		// title can be hostile
		const hit = makeSearchHit({ title: 'Session_with_underscores_and_[brackets]' });
		const deps = makeDeps(makeRetrieval({ hits: [hit] }));

		await runWithContext('user1', () => handleRecall(['test'], makeCtx(), deps));

		const sent = deps.telegram.send.mock.calls[0][1] as string;
		expect(sent).toContain('Session\\_with\\_underscores\\_and\\_\\[brackets\\]');
	});
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('handleRecall — concurrency', () => {
	it('two concurrent /recall calls in different requestContexts return their own results', async () => {
		let resolveA!: (v: SearchResult) => void;
		let resolveB!: (v: SearchResult) => void;

		const hitA = makeSearchHit({ sessionId: '20260428_100000_aaaaaaaa', title: 'User A pasta' });
		const hitB = makeSearchHit({ sessionId: '20260428_100000_bbbbbbbb', title: 'User B pantry' });

		const retrievalA = makeRetrieval();
		vi.mocked(retrievalA.searchSessions).mockReturnValue(
			new Promise<SearchResult>((r) => {
				resolveA = r;
			}),
		);

		const retrievalB = makeRetrieval();
		vi.mocked(retrievalB.searchSessions).mockReturnValue(
			new Promise<SearchResult>((r) => {
				resolveB = r;
			}),
		);

		const depsA = makeDeps(retrievalA);
		const depsB = makeDeps(retrievalB);

		const ctxA = makeCtx('userA', '/recall pasta');
		const ctxB = makeCtx('userB', '/recall pantry');

		// Start both concurrently
		const promiseA = requestContext.run({ userId: 'userA' }, () =>
			handleRecall(['pasta'], ctxA, depsA),
		);
		const promiseB = requestContext.run({ userId: 'userB' }, () =>
			handleRecall(['pantry'], ctxB, depsB),
		);

		// Resolve in reverse order
		resolveB({ hits: [hitB] });
		resolveA({ hits: [hitA] });

		await Promise.all([promiseA, promiseB]);

		// User A sees A's results
		expect(depsA.telegram.send).toHaveBeenCalledWith(
			'userA',
			expect.stringContaining('User A pasta'),
		);
		expect(depsA.telegram.send).not.toHaveBeenCalledWith(
			'userA',
			expect.stringContaining('User B'),
		);

		// User B sees B's results
		expect(depsB.telegram.send).toHaveBeenCalledWith(
			'userB',
			expect.stringContaining('User B pantry'),
		);
		expect(depsB.telegram.send).not.toHaveBeenCalledWith(
			'userB',
			expect.stringContaining('User A'),
		);
	});
});
