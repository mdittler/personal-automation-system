/**
 * Tests for ConversationRetrievalServiceImpl.searchSessions (Chunk E).
 *
 * Verifies:
 *  1. userId is derived from requestContext — not from caller opts
 *  2. Missing userId (no requestContext) → ConversationRetrievalError (fail-closed)
 *  3. No index injected → { hits: [] } (fail-open, graceful degradation)
 *  4. Auth isolation — caller-supplied userId in opts is ignored; context wins
 *  5. Same-household different user → empty hits (real index, in-memory SQLite)
 */

import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import { ChatTranscriptIndexImpl } from '../../chat-transcript-index/index.js';
import {
	ConversationRetrievalError,
	ConversationRetrievalServiceImpl,
} from '../conversation-retrieval-service.js';
import type { ChatTranscriptIndex, SearchResult } from '../../chat-transcript-index/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withUserId<T>(userId: string, fn: () => T): T {
	return requestContext.run({ userId }, fn);
}

function withUserAndHousehold<T>(userId: string, householdId: string, fn: () => T): T {
	return requestContext.run({ userId, householdId }, fn);
}

/** Build a minimal mock ChatTranscriptIndex. */
function makeMockIndex(searchResult?: SearchResult): ChatTranscriptIndex {
	return {
		upsertSession: vi.fn(),
		appendMessage: vi.fn(),
		endSession: vi.fn(),
		deleteSession: vi.fn(),
		searchSessions: vi.fn().mockResolvedValue(searchResult ?? { hits: [] }),
		getSessionMeta: vi.fn().mockResolvedValue(undefined),
		listExpiredSessions: vi.fn().mockResolvedValue([]),
		close: vi.fn(),
	};
}

// ─── Test 1: userId comes from requestContext, not from opts ─────────────────

describe('searchSessions — userId from requestContext', () => {
	it('passes the requestContext userId to index.searchSessions, not any caller value', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		const result = await withUserId('ctx-user-42', () =>
			// opts has no userId field — verifies the type contract
			service.searchSessions({ queryTerms: ['pasta'] }),
		);

		expect(result).toEqual({ hits: [] });
		expect(mockIndex.searchSessions).toHaveBeenCalledOnce();
		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.userId).toBe('ctx-user-42');
		expect(callArg.queryTerms).toEqual(['pasta']);
	});

	it('passes householdId from requestContext (null when absent)', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		// userId only, no householdId
		await withUserId('user-no-hh', () => service.searchSessions({ queryTerms: ['coffee'] }));

		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.householdId).toBeNull();
	});

	it('passes householdId from requestContext when present', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await withUserAndHousehold('user-hh', 'hh-99', () =>
			service.searchSessions({ queryTerms: ['dinner'] }),
		);

		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.householdId).toBe('hh-99');
	});
});

// ─── Test 2: Missing requestContext → ConversationRetrievalError (fail-closed) ─

describe('searchSessions — fail-closed without requestContext', () => {
	it('throws ConversationRetrievalError when userId is absent from context', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		// No requestContext at all
		await expect(service.searchSessions({ queryTerms: ['test'] })).rejects.toBeInstanceOf(
			ConversationRetrievalError,
		);
	});

	it('throws ConversationRetrievalError when requestContext has no userId', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		// Explicit empty context (userId undefined)
		await expect(
			requestContext.run({}, () => service.searchSessions({ queryTerms: ['test'] })),
		).rejects.toBeInstanceOf(ConversationRetrievalError);
	});

	it('does not call index.searchSessions when userId is missing', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await expect(service.searchSessions({ queryTerms: ['test'] })).rejects.toThrow();
		expect(mockIndex.searchSessions).not.toHaveBeenCalled();
	});

	it('error has category conversation-transcripts', async () => {
		const service = new ConversationRetrievalServiceImpl({ index: makeMockIndex() });

		const err = await service
			.searchSessions({ queryTerms: ['test'] })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ConversationRetrievalError);
		expect((err as ConversationRetrievalError).category).toBe('conversation-transcripts');
	});
});

// ─── Test 3: No index injected → { hits: [] } ────────────────────────────────

describe('searchSessions — graceful degradation when no index', () => {
	it('returns { hits: [] } when index is not injected', async () => {
		// No index in deps
		const service = new ConversationRetrievalServiceImpl({});

		const result = await withUserId('user-a', () =>
			service.searchSessions({ queryTerms: ['pasta'] }),
		);

		expect(result).toEqual({ hits: [] });
	});

	it('does not throw when index is absent and userId is present', async () => {
		const service = new ConversationRetrievalServiceImpl({});

		await expect(
			withUserId('user-b', () => service.searchSessions({ queryTerms: ['soup'] })),
		).resolves.toBeDefined();
	});
});

// ─── Test 4: Auth isolation — user A vs user B ───────────────────────────────

describe('searchSessions — auth isolation', () => {
	it('calls index.searchSessions with userId A when running as user A', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await withUserId('userA', () => service.searchSessions({ queryTerms: ['pasta'] }));

		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.userId).toBe('userA');
	});

	it('calls index.searchSessions with userId B when running as user B', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await withUserId('userB', () => service.searchSessions({ queryTerms: ['pasta'] }));

		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.userId).toBe('userB');
	});

	it('consecutive calls with different users each use their own userId', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await withUserId('alice', () => service.searchSessions({ queryTerms: ['recipe'] }));
		await withUserId('bob', () => service.searchSessions({ queryTerms: ['grocery'] }));

		const calls = vi.mocked(mockIndex.searchSessions).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0]![0].userId).toBe('alice');
		expect(calls[1]![0].userId).toBe('bob');
	});

	it('forwards optional filter fields untouched', async () => {
		const mockIndex = makeMockIndex();
		const service = new ConversationRetrievalServiceImpl({ index: mockIndex });

		await withUserId('filter-user', () =>
			service.searchSessions({
				queryTerms: ['pasta', 'dinner'],
				limitSessions: 3,
				limitMessagesPerSession: 2,
				startedAfter: '2026-01-01T00:00:00.000Z',
				startedBefore: '2026-04-01T00:00:00.000Z',
				excludeSessionIds: ['sess-abc', 'sess-def'],
			}),
		);

		const callArg = vi.mocked(mockIndex.searchSessions).mock.calls[0]![0];
		expect(callArg.queryTerms).toEqual(['pasta', 'dinner']);
		expect(callArg.limitSessions).toBe(3);
		expect(callArg.limitMessagesPerSession).toBe(2);
		expect(callArg.startedAfter).toBe('2026-01-01T00:00:00.000Z');
		expect(callArg.startedBefore).toBe('2026-04-01T00:00:00.000Z');
		expect(callArg.excludeSessionIds).toEqual(['sess-abc', 'sess-def']);
	});
});

// ─── Test 5: Same-household different user → empty hits (real in-memory index) ─

describe('searchSessions — household isolation (real ChatTranscriptIndexImpl)', () => {
	it('user B gets no hits from user A sessions in same household', async () => {
		const index = new ChatTranscriptIndexImpl(':memory:');

		try {
			// Seed session for userA in household hh-shared
			await index.upsertSession({
				id: 'sess-a-001',
				user_id: 'userA',
				household_id: 'hh-shared',
				source: 'telegram',
				started_at: '2026-04-01T10:00:00.000Z',
				ended_at: null,
				model: null,
				title: 'Pasta dinner planning',
			});
			await index.appendMessage({
				session_id: 'sess-a-001',
				turn_index: 0,
				role: 'user',
				content: 'I want to make pasta carbonara tonight',
				timestamp: '2026-04-01T10:00:01.000Z',
			});
			await index.appendMessage({
				session_id: 'sess-a-001',
				turn_index: 1,
				role: 'assistant',
				content: 'Great idea! Here is a pasta carbonara recipe.',
				timestamp: '2026-04-01T10:00:02.000Z',
			});

			const service = new ConversationRetrievalServiceImpl({ index });

			// userA should find their own session
			const userAResult = await withUserAndHousehold('userA', 'hh-shared', () =>
				service.searchSessions({ queryTerms: ['pasta'] }),
			);
			expect(userAResult.hits).toHaveLength(1);
			expect(userAResult.hits[0]!.sessionId).toBe('sess-a-001');

			// userB (same household) should find nothing — userId filter is strict
			const userBResult = await withUserAndHousehold('userB', 'hh-shared', () =>
				service.searchSessions({ queryTerms: ['pasta'] }),
			);
			expect(userBResult.hits).toHaveLength(0);
		} finally {
			await index.close();
		}
	});

	it('user sees their own sessions across multiple sessions', async () => {
		const index = new ChatTranscriptIndexImpl(':memory:');

		try {
			// Two sessions for the same user
			for (const [sessionId, content] of [
				['sess-u1-a', 'Looking for a good lasagna recipe'],
				['sess-u1-b', 'Found a great pasta bake for the weekend'],
			] as const) {
				await index.upsertSession({
					id: sessionId,
					user_id: 'userC',
					household_id: 'hh-x',
					source: 'telegram',
					started_at: '2026-04-10T12:00:00.000Z',
					ended_at: null,
					model: null,
					title: null,
				});
				await index.appendMessage({
					session_id: sessionId,
					turn_index: 0,
					role: 'user',
					content,
					timestamp: '2026-04-10T12:00:01.000Z',
				});
			}

			const service = new ConversationRetrievalServiceImpl({ index });

			const result = await withUserAndHousehold('userC', 'hh-x', () =>
				service.searchSessions({ queryTerms: ['pasta'], limitSessions: 10 }),
			);
			// At least one session contains "pasta" variants
			expect(result.hits.length).toBeGreaterThanOrEqual(1);
			const sessionIds = result.hits.map((h) => h.sessionId);
			// All returned hits belong to userC's sessions
			for (const id of sessionIds) {
				expect(['sess-u1-a', 'sess-u1-b']).toContain(id);
			}
		} finally {
			await index.close();
		}
	});
});
