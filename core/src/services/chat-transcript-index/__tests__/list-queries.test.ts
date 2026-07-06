/**
 * Tests for the additive read-only list/count queries used by the GUI
 * Conversations browser and metrics endpoints (Batch 2 of the GUI UX redesign).
 *
 * These methods are additive on ChatTranscriptIndex — no existing method
 * signature changes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatTranscriptIndex } from '../chat-transcript-index.js';
import { createChatTranscriptIndex } from '../index.js';
import type { MessageRow, SessionRow } from '../types.js';

function makeSession(overrides: Partial<SessionRow> & { id: string; user_id: string }): SessionRow {
	return {
		household_id: null,
		source: 'telegram',
		started_at: '2026-01-01T00:00:00Z',
		ended_at: null,
		model: null,
		title: null,
		parent_session_id: null,
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

describe('ChatTranscriptIndex additive list/count queries', () => {
	let dir: string;
	let index: ChatTranscriptIndex;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), 'pas-cti-list-'));
		index = createChatTranscriptIndex(join(dir, 'cti.db'));

		// Seed 2 users x several sessions/messages.
		await index.upsertSession(
			makeSession({ id: 'a-1', user_id: 'a', started_at: '2026-01-01T00:00:00Z', title: 'First' }),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 'a-1',
				turn_index: 0,
				role: 'user',
				content: 'hi',
				timestamp: '2026-01-01T00:00:01Z',
			}),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 'a-1',
				turn_index: 1,
				role: 'assistant',
				content: 'hello',
				timestamp: '2026-01-01T00:00:02Z',
			}),
		);

		await index.upsertSession(
			makeSession({ id: 'a-2', user_id: 'a', started_at: '2026-01-02T00:00:00Z', title: 'Second' }),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 'a-2',
				turn_index: 0,
				role: 'user',
				content: 'yo',
				timestamp: '2026-01-02T00:00:01Z',
			}),
		);

		await index.upsertSession(
			makeSession({ id: 'b-1', user_id: 'b', started_at: '2026-01-01T12:00:00Z', title: 'Bees' }),
		);
		await index.appendMessage(
			makeMessage({
				session_id: 'b-1',
				turn_index: 0,
				role: 'user',
				content: 'buzz',
				timestamp: '2026-01-01T12:00:01Z',
			}),
		);
	});

	afterEach(async () => {
		await index.close();
		rmSync(dir, { recursive: true, force: true });
	});

	describe('listSessionsForUser', () => {
		it('returns only the requesting user’s sessions, ordered by started_at DESC', async () => {
			const sessions = await index.listSessionsForUser({ userId: 'a', limit: 20, offset: 0 });
			expect(sessions.map((s) => s.id)).toEqual(['a-2', 'a-1']);
			for (const s of sessions) {
				expect(s).toMatchObject({
					id: expect.any(String),
					title: expect.anything(),
					startedAt: expect.any(String),
				});
				expect('messageCount' in s).toBe(true);
			}
		});

		it('reports the correct messageCount per session', async () => {
			const sessions = await index.listSessionsForUser({ userId: 'a', limit: 20, offset: 0 });
			const first = sessions.find((s) => s.id === 'a-1');
			const second = sessions.find((s) => s.id === 'a-2');
			expect(first?.messageCount).toBe(2);
			expect(second?.messageCount).toBe(1);
		});

		it('never returns another user’s sessions', async () => {
			const sessions = await index.listSessionsForUser({ userId: 'a', limit: 20, offset: 0 });
			expect(sessions.some((s) => s.id === 'b-1')).toBe(false);
		});

		it('respects limit and offset for pagination', async () => {
			const page1 = await index.listSessionsForUser({ userId: 'a', limit: 1, offset: 0 });
			const page2 = await index.listSessionsForUser({ userId: 'a', limit: 1, offset: 1 });
			expect(page1).toHaveLength(1);
			expect(page2).toHaveLength(1);
			expect(page1[0]?.id).not.toBe(page2[0]?.id);
		});

		it('returns an empty array for a user with no sessions', async () => {
			const sessions = await index.listSessionsForUser({ userId: 'nobody', limit: 20, offset: 0 });
			expect(sessions).toEqual([]);
		});
	});

	describe('listMessagesForSession', () => {
		it('returns messages ordered by timestamp ASC with role/text/timestamp', async () => {
			const messages = await index.listMessagesForSession('a-1');
			expect(messages).toEqual([
				{ role: 'user', text: 'hi', timestamp: '2026-01-01T00:00:01Z' },
				{ role: 'assistant', text: 'hello', timestamp: '2026-01-01T00:00:02Z' },
			]);
		});

		it('returns an empty array for an unknown session id', async () => {
			const messages = await index.listMessagesForSession('nonexistent');
			expect(messages).toEqual([]);
		});
	});

	describe('countMessagesByDay', () => {
		it('counts only the given user’s messages, grouped by day', async () => {
			const counts = await index.countMessagesByDay({
				userId: 'a',
				sinceIso: '2026-01-01T00:00:00Z',
			});
			expect(counts).toEqual([
				{ date: '2026-01-01', count: 2 },
				{ date: '2026-01-02', count: 1 },
			]);
		});

		it('aggregates across all users when userId is omitted (admin path)', async () => {
			const counts = await index.countMessagesByDay({ sinceIso: '2026-01-01T00:00:00Z' });
			const day1 = counts.find((c) => c.date === '2026-01-01');
			const day2 = counts.find((c) => c.date === '2026-01-02');
			expect(day1?.count).toBe(3); // a-1 (2) + b-1 (1)
			expect(day2?.count).toBe(1); // a-2
		});

		it('excludes messages before sinceIso', async () => {
			const counts = await index.countMessagesByDay({
				userId: 'a',
				sinceIso: '2026-01-02T00:00:00Z',
			});
			expect(counts).toEqual([{ date: '2026-01-02', count: 1 }]);
		});

		it('returns an empty array when there is nothing in range', async () => {
			const counts = await index.countMessagesByDay({
				userId: 'a',
				sinceIso: '2099-01-01T00:00:00Z',
			});
			expect(counts).toEqual([]);
		});
	});
});
