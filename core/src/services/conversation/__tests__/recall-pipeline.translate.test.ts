/**
 * Tests for Chunk G: timeAnchorToFilters translation and pipeline integration.
 *
 * Covers:
 *  1. timeAnchorToFilters — null anchor, absolute anchor (UTC + NY), window anchor variants
 *  2. runRecallPipeline — searchSessions receives correct messageAfter/messageBefore
 *  3. Legacy-fallback removed: null timeAnchor does NOT inject any 14d window
 */

import { describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../chat-transcript-index/types.js';
import { requestContext } from '../../context/request-context.js';
import type { ConversationRetrievalService } from '../../conversation-retrieval/conversation-retrieval-service.js';
import { runRecallPipeline, timeAnchorToFilters } from '../recall-pipeline.js';
import type { RecallPipelineDeps } from '../recall-pipeline.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withUserId<T>(userId: string, fn: () => T): T {
	return requestContext.run({ userId }, fn);
}

function makeMockRetrieval(searchResult?: SearchResult): ConversationRetrievalService {
	return {
		searchData: vi.fn(),
		listContextEntries: vi.fn(),
		getRecentInteractions: vi.fn(),
		getEnabledApps: vi.fn(),
		searchAppKnowledge: vi.fn(),
		buildSystemDataBlock: vi.fn(),
		listScopedReports: vi.fn(),
		listScopedAlerts: vi.fn(),
		hasSessionSearch: vi.fn().mockReturnValue(true),
		searchSessions: vi.fn().mockResolvedValue(searchResult ?? { hits: [] }),
		buildContextSnapshot: vi.fn(),
		buildMemorySnapshot: vi.fn(),
	} as unknown as ConversationRetrievalService;
}

/** Build deps with a stubbed LLM that returns a fixed verdict JSON. */
function makeDepsWithVerdict(
	verdict: object,
	retrieval: ConversationRetrievalService,
	timezone?: string,
): RecallPipelineDeps {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue(JSON.stringify(verdict)),
		} as unknown as RecallPipelineDeps['llm'],
		logger: {
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		} as unknown as RecallPipelineDeps['logger'],
		conversationRetrieval: retrieval,
		timezone,
	};
}

// ─── timeAnchorToFilters unit tests ──────────────────────────────────────────

describe('timeAnchorToFilters', () => {
	it('null anchor → empty object (no filters)', () => {
		expect(timeAnchorToFilters(null, 'UTC')).toEqual({});
	});

	it('absolute anchor on 2026-04-28 in UTC → exact day bounds', () => {
		const result = timeAnchorToFilters({ type: 'absolute', on: '2026-04-28' }, 'UTC');
		expect(result).toEqual({
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
		});
	});

	it('absolute anchor on 2026-04-28 in America/New_York (EDT, UTC-4) → day bounds shifted +4h', () => {
		const result = timeAnchorToFilters({ type: 'absolute', on: '2026-04-28' }, 'America/New_York');
		expect(result).toEqual({
			messageAfter: '2026-04-28T04:00:00.000Z',
			messageBefore: '2026-04-29T04:00:00.000Z',
		});
	});

	it('window anchor with both after and before → bounds use startUtc of after, endUtcExclusive of before', () => {
		// before=2026-04-22 → endUtcExclusive = 2026-04-23T00:00:00.000Z (day AFTER before)
		const result = timeAnchorToFilters(
			{ type: 'window', after: '2026-04-14', before: '2026-04-22' },
			'UTC',
		);
		expect(result).toEqual({
			messageAfter: '2026-04-14T00:00:00.000Z',
			messageBefore: '2026-04-23T00:00:00.000Z',
		});
	});

	it('window anchor with only after → messageAfter set, messageBefore undefined', () => {
		const result = timeAnchorToFilters({ type: 'window', after: '2026-04-14' }, 'UTC');
		expect(result.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(result.messageBefore).toBeUndefined();
	});

	it('window anchor with only before → messageBefore set (next day), messageAfter undefined', () => {
		const result = timeAnchorToFilters({ type: 'window', before: '2026-04-22' }, 'UTC');
		expect(result.messageAfter).toBeUndefined();
		expect(result.messageBefore).toBe('2026-04-23T00:00:00.000Z');
	});
});

// ─── runRecallPipeline integration tests ─────────────────────────────────────

describe('runRecallPipeline — temporal filters threaded to searchSessions', () => {
	// The message "what did we discuss on 2026-04-28" must pass the pre-filter
	const recallMessage = 'what did we discuss on 2026-04-28 about the project';

	it('null timeAnchor → searchSessions called WITHOUT messageAfter/messageBefore (no legacy 14d fallback)', async () => {
		const retrieval = makeMockRetrieval();
		const deps = makeDepsWithVerdict(
			{
				shouldRecall: true,
				query: 'project',
				timeAnchor: null,
				reason: 'no time reference',
			},
			retrieval,
			'UTC',
		);

		await withUserId('u1', () => runRecallPipeline(recallMessage, undefined, deps));

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const opts = vi.mocked(retrieval.searchSessions).mock.calls[0]![0];
		expect(opts.messageAfter).toBeUndefined();
		expect(opts.messageBefore).toBeUndefined();
	});

	it('absolute timeAnchor + tz=UTC → correct messageAfter/messageBefore in searchSessions', async () => {
		const retrieval = makeMockRetrieval();
		const deps = makeDepsWithVerdict(
			{
				shouldRecall: true,
				query: 'project',
				timeAnchor: { type: 'absolute', on: '2026-04-28' },
				reason: 'specific date',
			},
			retrieval,
			'UTC',
		);

		await withUserId('u1', () => runRecallPipeline(recallMessage, undefined, deps));

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const opts = vi.mocked(retrieval.searchSessions).mock.calls[0]![0];
		expect(opts.messageAfter).toBe('2026-04-28T00:00:00.000Z');
		expect(opts.messageBefore).toBe('2026-04-29T00:00:00.000Z');
	});

	it('absolute timeAnchor + tz=America/New_York → EDT-shifted UTC bounds', async () => {
		const retrieval = makeMockRetrieval();
		const deps = makeDepsWithVerdict(
			{
				shouldRecall: true,
				query: 'project',
				timeAnchor: { type: 'absolute', on: '2026-04-28' },
				reason: 'specific date',
			},
			retrieval,
			'America/New_York',
		);

		await withUserId('u1', () => runRecallPipeline(recallMessage, undefined, deps));

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const opts = vi.mocked(retrieval.searchSessions).mock.calls[0]![0];
		expect(opts.messageAfter).toBe('2026-04-28T04:00:00.000Z');
		expect(opts.messageBefore).toBe('2026-04-29T04:00:00.000Z');
	});

	it('window timeAnchor with both after and before → correct half-open interval', async () => {
		const retrieval = makeMockRetrieval();
		const deps = makeDepsWithVerdict(
			{
				shouldRecall: true,
				query: 'trip',
				timeAnchor: { type: 'window', after: '2026-04-14', before: '2026-04-22' },
				reason: 'date range',
			},
			retrieval,
			'UTC',
		);

		await withUserId('u1', () => runRecallPipeline(recallMessage, undefined, deps));

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const opts = vi.mocked(retrieval.searchSessions).mock.calls[0]![0];
		expect(opts.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		// before=2026-04-22 → endUtcExclusive = 2026-04-23T00:00:00.000Z
		expect(opts.messageBefore).toBe('2026-04-23T00:00:00.000Z');
	});

	it('window timeAnchor with only after (no before) → messageAfter set, messageBefore undefined', async () => {
		const retrieval = makeMockRetrieval();
		const deps = makeDepsWithVerdict(
			{
				shouldRecall: true,
				query: 'plan',
				timeAnchor: { type: 'window', after: '2026-04-14' },
				reason: 'open-ended from date',
			},
			retrieval,
			'UTC',
		);

		await withUserId('u1', () => runRecallPipeline(recallMessage, undefined, deps));

		expect(retrieval.searchSessions).toHaveBeenCalledOnce();
		const opts = vi.mocked(retrieval.searchSessions).mock.calls[0]![0];
		expect(opts.messageAfter).toBe('2026-04-14T00:00:00.000Z');
		expect(opts.messageBefore).toBeUndefined();
	});
});
