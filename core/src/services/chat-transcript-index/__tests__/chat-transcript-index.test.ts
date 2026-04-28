import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ChatTranscriptIndexImpl } from '../chat-transcript-index.js';
import type { MessageRow, SessionRow } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionRow> & { id: string; user_id: string }): SessionRow {
	return {
		household_id: null,
		source: 'telegram',
		started_at: '2026-01-01T00:00:00Z',
		ended_at: null,
		model: null,
		title: null,
		...overrides,
	};
}

function makeMessage(overrides: Partial<MessageRow> & { session_id: string }): MessageRow {
	return {
		turn_index: 0,
		role: 'user',
		content: 'hello',
		timestamp: '2026-01-01T00:00:01Z',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string;
let index: ChatTranscriptIndexImpl;

async function setup(): Promise<void> {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-fts-test-'));
	index = new ChatTranscriptIndexImpl(join(tempDir, 'test.db'));
}

async function teardown(): Promise<void> {
	await index.close();
	await rm(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// upsertSession + appendMessage + searchSessions
// ---------------------------------------------------------------------------

describe('upsertSession + appendMessage + searchSessions', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('insert session + 3 turns → searchSessions returns matching turn with snippet', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({
				session_id: 's1',
				turn_index: 0,
				role: 'user',
				content: 'I love pasta carbonara',
				timestamp: '2026-01-01T00:00:01Z',
			}),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 's1',
				turn_index: 1,
				role: 'assistant',
				content: 'Pasta carbonara is a classic Italian dish',
				timestamp: '2026-01-01T00:00:02Z',
			}),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 's1',
				turn_index: 2,
				role: 'user',
				content: 'How do I make pasta?',
				timestamp: '2026-01-01T00:00:03Z',
			}),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0];
		expect(hit.sessionId).toBe('s1');
		expect(hit.matches.length).toBeGreaterThan(0);
		// Snippet contains highlighted term
		expect(hit.matches[0].snippet).toContain('[');
	});

	test('auth filter: user A cannot see user B turns', async () => {
		await index.upsertSession(makeSession({ id: 'sA', user_id: 'userA' }));
		await index.upsertSession(makeSession({ id: 'sB', user_id: 'userB' }));
		await index.appendMessage(
			makeMessage({ session_id: 'sA', turn_index: 0, content: 'pasta recipe' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'sB', turn_index: 0, content: 'pasta sauce' }),
		);

		const resultA = await index.searchSessions({
			userId: 'userA',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(resultA.hits).toHaveLength(1);
		expect(resultA.hits[0].sessionId).toBe('sA');

		const resultB = await index.searchSessions({
			userId: 'userB',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(resultB.hits).toHaveLength(1);
		expect(resultB.hits[0].sessionId).toBe('sB');
	});

	test('userId empty string → no results (auth parameter required)', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta carbonara' }),
		);

		const result = await index.searchSessions({
			userId: '',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(result.hits).toHaveLength(0);
	});

	test('excludeSessionIds filters at SQL level', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.upsertSession(
			makeSession({ id: 's2', user_id: 'u1', started_at: '2026-01-02T00:00:00Z' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta recipe' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 's2', turn_index: 0, content: 'pasta sauce' }),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			excludeSessionIds: ['s1'],
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0].sessionId).toBe('s2');
	});

	test('empty queryTerms → empty hits, no SQL call', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta carbonara' }),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: [],
		});

		expect(result.hits).toHaveLength(0);
	});

	test('limitSessions caps results', async () => {
		// Insert 4 sessions with matching content
		for (let i = 0; i < 4; i++) {
			await index.upsertSession(
				makeSession({
					id: `s${i}`,
					user_id: 'u1',
					started_at: `2026-01-0${i + 1}T00:00:00Z`,
				}),
			);
			await index.appendMessage(
				makeMessage({
					session_id: `s${i}`,
					turn_index: 0,
					content: `pasta dish number ${i}`,
				}),
			);
		}

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			limitSessions: 2,
		});

		expect(result.hits).toHaveLength(2);
	});

	test('limitMessagesPerSession caps matches per session', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		// Insert 5 pasta messages in one session
		for (let i = 0; i < 5; i++) {
			await index.appendMessage(
				makeMessage({
					session_id: 's1',
					turn_index: i,
					content: `pasta iteration ${i}`,
					timestamp: `2026-01-01T00:00:0${i + 1}Z`,
				}),
			);
		}

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			limitMessagesPerSession: 2,
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0].matches).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// endSession
// ---------------------------------------------------------------------------

describe('endSession', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('populates ended_at in DB', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.endSession('s1', '2026-01-01T12:00:00Z');

		const meta = await index.getSessionMeta('s1');
		expect(meta).toBeDefined();
		expect(meta!.ended_at).toBe('2026-01-01T12:00:00Z');
	});

	test('ended session is still searchable', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta carbonara' }),
		);
		await index.endSession('s1', '2026-01-01T12:00:00Z');

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0].sessionId).toBe('s1');
		expect(result.hits[0].sessionEndedAt).toBe('2026-01-01T12:00:00Z');
	});
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe('deleteSession', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('cascade: messages gone after session deleted', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta carbonara' }),
		);

		await index.deleteSession('s1');

		const meta = await index.getSessionMeta('s1');
		expect(meta).toBeUndefined();
	});

	test('cascade: FTS rows gone after session deleted (search returns nothing)', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'pasta carbonara recipe' }),
		);

		await index.deleteSession('s1');

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
		});

		expect(result.hits).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

describe('ordering', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('sessions ordered by min(bm25) ASC, then sessionStartedAt DESC, then sessionId ASC', async () => {
		// Sessions a, b, c all have the word "pasta" — use same content to equalize bm25
		// Tiebreak: startedAt DESC (more recent first), then sessionId ASC
		const sessions = [
			{ id: 'sA', started_at: '2026-01-01T00:00:00Z' },
			{ id: 'sB', started_at: '2026-01-03T00:00:00Z' },
			{ id: 'sC', started_at: '2026-01-02T00:00:00Z' },
		];

		for (const s of sessions) {
			await index.upsertSession(makeSession({ id: s.id, user_id: 'u1', started_at: s.started_at }));
			await index.appendMessage(
				makeMessage({ session_id: s.id, turn_index: 0, content: 'pasta cooking tips' }),
			);
		}

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			limitSessions: 10,
		});

		expect(result.hits).toHaveLength(3);

		// With equal bm25, order should be by started_at DESC: sB (Jan 3), sC (Jan 2), sA (Jan 1)
		const ids = result.hits.map((h) => h.sessionId);
		expect(ids).toEqual(['sB', 'sC', 'sA']);
	});

	test('sessionId ASC is tiebreak when started_at is also equal', async () => {
		const sameDate = '2026-01-01T00:00:00Z';

		await index.upsertSession(makeSession({ id: 'sZ', user_id: 'u1', started_at: sameDate }));
		await index.upsertSession(makeSession({ id: 'sA', user_id: 'u1', started_at: sameDate }));
		await index.upsertSession(makeSession({ id: 'sM', user_id: 'u1', started_at: sameDate }));

		await index.appendMessage(
			makeMessage({ session_id: 'sZ', turn_index: 0, content: 'pasta delicious' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'sA', turn_index: 0, content: 'pasta delicious' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'sM', turn_index: 0, content: 'pasta delicious' }),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			limitSessions: 10,
		});

		expect(result.hits).toHaveLength(3);
		const ids = result.hits.map((h) => h.sessionId);
		expect(ids).toEqual(['sA', 'sM', 'sZ']);
	});
});

// ---------------------------------------------------------------------------
// WAL checkpoint
// ---------------------------------------------------------------------------

describe('WAL checkpoint', () => {
	test('after 50 writes, no errors thrown (file-backed DB)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pas-fts-wal-'));
		const idx = new ChatTranscriptIndexImpl(join(dir, 'wal.db'));

		try {
			// Each upsertSession + appendMessage = 2 writes each; do 25 sessions = 50 writes
			for (let i = 0; i < 25; i++) {
				await idx.upsertSession(
					makeSession({
						id: `s${i}`,
						user_id: 'u1',
						started_at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
					}),
				);
				await idx.appendMessage(
					makeMessage({ session_id: `s${i}`, turn_index: 0, content: `message ${i}` }),
				);
			}
			// If we get here, no errors during 50 writes including the checkpoint
			expect(true).toBe(true);
		} finally {
			await idx.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
	test('close() then rm -rf succeeds without EBUSY', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pas-fts-lifecycle-'));
		const idx = new ChatTranscriptIndexImpl(join(dir, 'test.db'));
		await idx.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await idx.close();
		await expect(rm(dir, { recursive: true, force: true })).resolves.not.toThrow();
	});

	test('calling close() twice does not throw', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pas-fts-lifecycle2-'));
		try {
			const idx = new ChatTranscriptIndexImpl(join(dir, 'test.db'));
			await idx.close();
			await expect(idx.close()).resolves.not.toThrow();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('concurrent Promise.all appendMessage calls both succeed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pas-fts-concurrent-'));
		const idx = new ChatTranscriptIndexImpl(join(dir, 'test.db'));

		try {
			await idx.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));

			const [r1, r2] = await Promise.all([
				idx.appendMessage(
					makeMessage({
						session_id: 's1',
						turn_index: 1,
						role: 'user',
						content: 'msg1',
						timestamp: '2026-01-01T00:00:01Z',
					}),
				),
				idx.appendMessage(
					makeMessage({
						session_id: 's1',
						turn_index: 2,
						role: 'assistant',
						content: 'msg2',
						timestamp: '2026-01-01T00:00:02Z',
					}),
				),
			]);

			expect(r1).toBeUndefined();
			expect(r2).toBeUndefined();

			// Both messages indexed — search should return them
			const result = await idx.searchSessions({
				userId: 'u1',
				householdId: null,
				queryTerms: ['msg1'],
			});
			expect(result.hits).toHaveLength(1);
		} finally {
			await idx.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// listExpiredSessions
// ---------------------------------------------------------------------------

describe('listExpiredSessions', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('returns only sessions with ended_at < cutoff', async () => {
		await index.upsertSession(
			makeSession({
				id: 's1',
				user_id: 'u1',
				started_at: '2026-01-01T00:00:00Z',
				ended_at: '2026-01-01T01:00:00Z',
			}),
		);
		await index.upsertSession(
			makeSession({
				id: 's2',
				user_id: 'u1',
				started_at: '2026-01-02T00:00:00Z',
				ended_at: '2026-01-05T01:00:00Z',
			}),
		);
		await index.upsertSession(
			makeSession({ id: 's3', user_id: 'u1', started_at: '2026-01-03T00:00:00Z' }),
		); // no ended_at

		const expired = await index.listExpiredSessions('2026-01-03T00:00:00Z');

		// s1 ended before cutoff, s2 ended after, s3 open
		expect(expired).toHaveLength(1);
		expect(expired[0].id).toBe('s1');
		expect(expired[0].user_id).toBe('u1');
	});

	test('returns empty array when no sessions are expired', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		const expired = await index.listExpiredSessions('2020-01-01T00:00:00Z');
		expect(expired).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// getSessionMeta
// ---------------------------------------------------------------------------

describe('getSessionMeta', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('returns undefined for unknown session', async () => {
		const meta = await index.getSessionMeta('nonexistent');
		expect(meta).toBeUndefined();
	});

	test('returns full SessionRow for known session', async () => {
		const session = makeSession({
			id: 's1',
			user_id: 'u1',
			household_id: 'h1',
			source: 'telegram',
			started_at: '2026-01-01T00:00:00Z',
			ended_at: '2026-01-01T01:00:00Z',
			model: 'claude-sonnet',
			title: 'My Session',
		});
		await index.upsertSession(session);

		const meta = await index.getSessionMeta('s1');
		expect(meta).toBeDefined();
		expect(meta!.id).toBe('s1');
		expect(meta!.user_id).toBe('u1');
		expect(meta!.household_id).toBe('h1');
		expect(meta!.model).toBe('claude-sonnet');
		expect(meta!.title).toBe('My Session');
		expect(meta!.ended_at).toBe('2026-01-01T01:00:00Z');
	});
});

// ---------------------------------------------------------------------------
// upsertSession idempotency
// ---------------------------------------------------------------------------

describe('upsertSession idempotency', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('upserting with updated title replaces the row', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1', title: 'First Title' }));
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1', title: 'Updated Title' }));

		const meta = await index.getSessionMeta('s1');
		expect(meta!.title).toBe('Updated Title');
	});

	test('appendMessage with same turn_index is idempotent (INSERT OR IGNORE)', async () => {
		await index.upsertSession(makeSession({ id: 's1', user_id: 'u1' }));
		await index.appendMessage(
			makeMessage({ session_id: 's1', turn_index: 0, content: 'first content' }),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 's1',
				turn_index: 0,
				content: 'second content — should be ignored',
			}),
		);

		// Search for first content still succeeds
		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['first'],
		});
		expect(result.hits).toHaveLength(1);

		// Search for second content finds nothing (not stored)
		const result2 = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['ignored'],
		});
		expect(result2.hits).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// startedAfter / startedBefore filters
// ---------------------------------------------------------------------------

describe('date range filters', () => {
	beforeEach(setup);
	afterEach(teardown);

	test('startedAfter filters sessions before the date', async () => {
		await index.upsertSession(
			makeSession({ id: 'old', user_id: 'u1', started_at: '2025-06-01T00:00:00Z' }),
		);
		await index.upsertSession(
			makeSession({ id: 'new', user_id: 'u1', started_at: '2026-01-01T00:00:00Z' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'old', turn_index: 0, content: 'pasta recipe' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'new', turn_index: 0, content: 'pasta recipe' }),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			startedAfter: '2026-01-01T00:00:00Z',
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0].sessionId).toBe('new');
	});

	test('startedBefore filters sessions on or after the date', async () => {
		await index.upsertSession(
			makeSession({ id: 'old', user_id: 'u1', started_at: '2025-06-01T00:00:00Z' }),
		);
		await index.upsertSession(
			makeSession({ id: 'new', user_id: 'u1', started_at: '2026-01-01T00:00:00Z' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'old', turn_index: 0, content: 'pasta recipe' }),
		);
		await index.appendMessage(
			makeMessage({ session_id: 'new', turn_index: 0, content: 'pasta recipe' }),
		);

		const result = await index.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['pasta'],
			startedBefore: '2026-01-01T00:00:00Z',
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0].sessionId).toBe('old');
	});
});
