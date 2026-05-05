/**
 * Integration tests for message-timestamp filtering in searchSessions (Chunk G).
 *
 * Uses a real SQLite database in a temp directory to verify that:
 *  - messageAfter / messageBefore filter on m.timestamp (NOT s.started_at)
 *  - Sessions started BEFORE the filter window are included when they have
 *    messages WITHIN the window (the key cross-day case)
 *  - Boundary semantics: messageAfter is inclusive (>=), messageBefore is exclusive (<)
 *
 * Setup:
 *  Session A: started 2026-04-27; has messages on Mon, Tue, Wed
 *  Session B: started 2026-04-28; has messages only on Tue
 *  Session C: started 2026-04-29; has messages only on Wed
 *
 * Filter window: Tue 2026-04-28 [00:00Z, 2026-04-29T00:00Z)
 *
 * Expected: A (has Tue message) + B (started+messages on Tue); NOT C (Wed only)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ChatTranscriptIndexImpl } from '../chat-transcript-index.js';

// ─── Test setup ──────────────────────────────────────────────────────────────

let tempDir: string;
let idx: ChatTranscriptIndexImpl;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-msgfilter-test-'));
	idx = new ChatTranscriptIndexImpl(join(tempDir, 'test.db'));

	// Session A: started Mon 2026-04-27 but spans Mon/Tue/Wed
	await idx.upsertSession({
		id: 'sA',
		user_id: 'u1',
		household_id: null,
		source: 'telegram',
		started_at: '2026-04-27T10:00:00.000Z',
		ended_at: '2026-04-29T12:00:00.000Z',
		model: null,
		title: 'Session A',
	});
	// Mon message
	await idx.appendMessage({
		session_id: 'sA',
		turn_index: 0,
		role: 'user',
		content: 'monday recall test alpha',
		timestamp: '2026-04-27T15:00:00.000Z',
	});
	// Tue message (within filter window)
	await idx.appendMessage({
		session_id: 'sA',
		turn_index: 1,
		role: 'assistant',
		content: 'tuesday recall test alpha',
		timestamp: '2026-04-28T14:00:00.000Z',
	});
	// Wed message
	await idx.appendMessage({
		session_id: 'sA',
		turn_index: 2,
		role: 'user',
		content: 'wednesday recall test alpha',
		timestamp: '2026-04-29T09:00:00.000Z',
	});

	// Session B: started Tue 2026-04-28, only Tue messages
	await idx.upsertSession({
		id: 'sB',
		user_id: 'u1',
		household_id: null,
		source: 'telegram',
		started_at: '2026-04-28T10:00:00.000Z',
		ended_at: null,
		model: null,
		title: 'Session B',
	});
	await idx.appendMessage({
		session_id: 'sB',
		turn_index: 0,
		role: 'user',
		content: 'tuesday recall test beta',
		timestamp: '2026-04-28T11:00:00.000Z',
	});
	await idx.appendMessage({
		session_id: 'sB',
		turn_index: 1,
		role: 'assistant',
		content: 'tuesday recall test beta response',
		timestamp: '2026-04-28T11:01:00.000Z',
	});

	// Session C: started Wed 2026-04-29, only Wed messages
	await idx.upsertSession({
		id: 'sC',
		user_id: 'u1',
		household_id: null,
		source: 'telegram',
		started_at: '2026-04-29T10:00:00.000Z',
		ended_at: null,
		model: null,
		title: 'Session C',
	});
	await idx.appendMessage({
		session_id: 'sC',
		turn_index: 0,
		role: 'user',
		content: 'wednesday recall test gamma',
		timestamp: '2026-04-29T11:00:00.000Z',
	});
});

afterEach(async () => {
	await idx.close();
	await rm(tempDir, { recursive: true, force: true });
});

// ─── Main cross-day filter test ───────────────────────────────────────────────

describe('searchSessions message-timestamp filtering', () => {
	test('Tue filter window returns A (cross-day) and B, but NOT C (Wed only)', async () => {
		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test'],
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
			limitSessions: 10,
			limitMessagesPerSession: 5,
		});

		const sessionIds = result.hits.map((h) => h.sessionId).sort();
		expect(sessionIds).toContain('sA'); // Has Tue message even though started Mon
		expect(sessionIds).toContain('sB'); // Started and has Tue messages
		expect(sessionIds).not.toContain('sC'); // Only Wed messages — excluded
	});

	test('Session A included: the matching message is the Tue one (within window)', async () => {
		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test'],
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
			limitSessions: 10,
			limitMessagesPerSession: 5,
		});

		const hitA = result.hits.find((h) => h.sessionId === 'sA');
		expect(hitA).toBeDefined();
		// All matches must be within the filter window
		for (const match of hitA!.matches) {
			expect(match.timestamp >= '2026-04-28T00:00:00.000Z').toBe(true);
			expect(match.timestamp < '2026-04-29T00:00:00.000Z').toBe(true);
		}
	});

	// ─── Boundary semantics ──────────────────────────────────────────────────

	test('message at exactly messageAfter (00:00Z) is INCLUDED (>= boundary)', async () => {
		await idx.upsertSession({
			id: 'sBoundary',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2026-04-28T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: 'Boundary',
		});
		await idx.appendMessage({
			session_id: 'sBoundary',
			turn_index: 0,
			role: 'user',
			content: 'recall test boundary exact midnight start',
			timestamp: '2026-04-28T00:00:00.000Z', // exactly at boundary
		});

		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test', 'boundary'],
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
		});

		const ids = result.hits.map((h) => h.sessionId);
		expect(ids).toContain('sBoundary');
	});

	test('message at exactly messageBefore (next midnight) is EXCLUDED (< boundary)', async () => {
		await idx.upsertSession({
			id: 'sExcluded',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2026-04-29T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: 'Excluded',
		});
		await idx.appendMessage({
			session_id: 'sExcluded',
			turn_index: 0,
			role: 'user',
			content: 'recall test excluded exact midnight end',
			timestamp: '2026-04-29T00:00:00.000Z', // exactly AT the exclusive boundary
		});

		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test', 'excluded'],
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
		});

		const ids = result.hits.map((h) => h.sessionId);
		expect(ids).not.toContain('sExcluded');
	});

	test('message at 23:59:59.999Z is INCLUDED (just before exclusive boundary)', async () => {
		await idx.upsertSession({
			id: 'sLastMs',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2026-04-28T23:59:00.000Z',
			ended_at: null,
			model: null,
			title: 'Last ms',
		});
		await idx.appendMessage({
			session_id: 'sLastMs',
			turn_index: 0,
			role: 'user',
			content: 'recall test lastms end of day',
			timestamp: '2026-04-28T23:59:59.999Z', // just inside window
		});

		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test', 'lastms'],
			messageAfter: '2026-04-28T00:00:00.000Z',
			messageBefore: '2026-04-29T00:00:00.000Z',
		});

		const ids = result.hits.map((h) => h.sessionId);
		expect(ids).toContain('sLastMs');
	});

	// ─── No filter → all sessions returned ───────────────────────────────────

	test('no messageAfter/messageBefore → all matching sessions returned regardless of date', async () => {
		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test'],
			limitSessions: 10,
		});

		const ids = result.hits.map((h) => h.sessionId).sort();
		expect(ids).toContain('sA');
		expect(ids).toContain('sB');
		expect(ids).toContain('sC');
	});

	// ─── Only messageAfter set ────────────────────────────────────────────────

	test('only messageAfter set → excludes messages before the cutoff', async () => {
		const result = await idx.searchSessions({
			userId: 'u1',
			householdId: null,
			queryTerms: ['recall', 'test'],
			messageAfter: '2026-04-29T00:00:00.000Z', // only Wed and later
			limitSessions: 10,
		});

		const ids = result.hits.map((h) => h.sessionId).sort();
		// Only sessions with messages on Wed or later
		expect(ids).toContain('sA'); // Has Wed message
		expect(ids).toContain('sC'); // Only Wed messages — included
		expect(ids).not.toContain('sB'); // Only Tue messages — excluded
	});
});
