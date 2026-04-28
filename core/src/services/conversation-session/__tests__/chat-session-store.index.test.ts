/**
 * Chunk D — Live indexer hook tests.
 *
 * Verifies that ChatSessionStore correctly drives ChatTranscriptIndex
 * on appendExchange, endActive, and legacy migration.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { composeChatSessionStore } from '../compose.js';
import type { ChatSessionStore, SessionTurn } from '../chat-session-store.js';
import { ChatTranscriptIndexImpl } from '../../chat-transcript-index/chat-transcript-index.js';
import type { ChatTranscriptIndex } from '../../chat-transcript-index/index.js';

const USER = 'matt';
const SESSION_KEY = 'agent:main:telegram:dm:matt';

let tempDir: string;

function makeMockLogger(): Logger {
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

function makeDataStore(dir: string) {
	return new DataStoreServiceImpl({
		dataDir: dir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(dir),
	});
}

const FROZEN = new Date('2026-04-27T15:45:00Z');
const clock = () => FROZEN;

function turn(role: 'user' | 'assistant', content: string, ts?: string): SessionTurn {
	return { role, content, timestamp: ts ?? FROZEN.toISOString() };
}

const ctx = { userId: USER, sessionKey: SESSION_KEY };

let index: ChatTranscriptIndexImpl;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-chat-index-hook-'));
	index = new ChatTranscriptIndexImpl(join(tempDir, 'transcript.db'));
});

afterEach(async () => {
	await index.close();
	await rm(tempDir, { recursive: true, force: true });
});

function makeStore(opts?: { index?: ChatTranscriptIndex }): ChatSessionStore {
	return composeChatSessionStore({
		data: makeDataStore(tempDir),
		logger: makeMockLogger(),
		clock,
		index: opts?.index ?? index,
	});
}

// ---------------------------------------------------------------------------
// Test 1: appendExchange → searchSessions returns the new turns
// ---------------------------------------------------------------------------

describe('Chunk D — live indexer hook: appendExchange', () => {
	it('appendExchange → immediate searchSessions returns the hit', async () => {
		const store = makeStore();
		await store.appendExchange(ctx, turn('user', 'tell me about carbonara'), turn('assistant', 'carbonara is a pasta dish'));

		const result = await index.searchSessions({
			userId: USER,
			householdId: null,
			queryTerms: ['carbonara'],
		});

		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0]!;
		expect(hit.matches.length).toBeGreaterThan(0);
		// Both user and assistant turns should be indexed
		const roles = hit.matches.map((m) => m.role);
		expect(roles).toContain('user');
	});

	it('second appendExchange increments turn_index correctly', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(
			ctx,
			turn('user', 'first question'),
			turn('assistant', 'first answer'),
		);
		await store.appendExchange(ctx, turn('user', 'second question'), turn('assistant', 'second answer'));

		// The session should have 4 messages in the DB: turn_indices 0,1,2,3
		const result = await index.searchSessions({
			userId: USER,
			householdId: null,
			queryTerms: ['question'],
		});

		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]!.sessionId).toBe(sessionId);
		// Both user turns (turn_index 0 and 2) contain 'question'
		const turnIndices = result.hits[0]!.matches.map((m) => m.turn_index);
		expect(turnIndices).toContain(0);
		expect(turnIndices).toContain(2);
	});
});

// ---------------------------------------------------------------------------
// Test 2: index throw does not break appendExchange
// ---------------------------------------------------------------------------

describe('Chunk D — live indexer hook: fault isolation', () => {
	it('index appendMessage throw → appendExchange still returns success and transcript is written', async () => {
		const failingIndex: ChatTranscriptIndex = {
			upsertSession: vi.fn().mockResolvedValue(undefined),
			appendMessage: vi.fn().mockRejectedValue(new Error('DB locked')),
			endSession: vi.fn().mockResolvedValue(undefined),
			deleteSession: vi.fn().mockResolvedValue(undefined),
			searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
			getSessionMeta: vi.fn().mockResolvedValue(undefined),
			listExpiredSessions: vi.fn().mockResolvedValue([]),
			close: vi.fn().mockResolvedValue(undefined),
		};

		const store = makeStore({ index: failingIndex });
		// Should not throw even though the index throws
		const { sessionId } = await store.appendExchange(
			ctx,
			turn('user', 'hello'),
			turn('assistant', 'world'),
		);
		expect(sessionId).toMatch(/^\d{8}_\d{6}_[0-9a-f]{8}$/);

		// Transcript file was written successfully
		const loaded = await store.loadRecentTurns(ctx, { maxTurns: 10 });
		expect(loaded).toHaveLength(2);
		expect(loaded[0]!.content).toBe('hello');
	});

	it('index upsertSession throw on mint → appendExchange still returns success', async () => {
		const failingIndex: ChatTranscriptIndex = {
			upsertSession: vi.fn().mockRejectedValue(new Error('DB unavailable')),
			appendMessage: vi.fn().mockResolvedValue(undefined),
			endSession: vi.fn().mockResolvedValue(undefined),
			deleteSession: vi.fn().mockResolvedValue(undefined),
			searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
			getSessionMeta: vi.fn().mockResolvedValue(undefined),
			listExpiredSessions: vi.fn().mockResolvedValue([]),
			close: vi.fn().mockResolvedValue(undefined),
		};

		const store = makeStore({ index: failingIndex });
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));
		expect(sessionId).toMatch(/^\d{8}_\d{6}_[0-9a-f]{8}$/);
	});
});

// ---------------------------------------------------------------------------
// Test 3: endActive → ended_at populated in DB
// ---------------------------------------------------------------------------

describe('Chunk D — live indexer hook: endActive', () => {
	it('endActive → endSession called with correct timestamp, DB shows ended_at != null', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));

		// Session should exist and be open
		const beforeEnd = await index.getSessionMeta(sessionId);
		expect(beforeEnd).toBeDefined();
		expect(beforeEnd!.ended_at).toBeNull();

		await store.endActive(ctx, 'newchat');

		const afterEnd = await index.getSessionMeta(sessionId);
		expect(afterEnd).toBeDefined();
		expect(afterEnd!.ended_at).not.toBeNull();
		expect(afterEnd!.ended_at).toBe(FROZEN.toISOString());
	});

	it('endActive on a session with no index entry (index absent) does not throw', async () => {
		// Store without index
		const storeNoIndex = composeChatSessionStore({
			data: makeDataStore(tempDir),
			logger: makeMockLogger(),
			clock,
		});
		await storeNoIndex.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));
		// Should complete without error
		await expect(storeNoIndex.endActive(ctx, 'newchat')).resolves.toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Test 4: legacy migration → upsertSession + appendMessage called
// ---------------------------------------------------------------------------

const LEGACY_TURNS = [
	{ role: 'user', content: 'what is spaghetti carbonara', timestamp: '2026-04-26T10:00:00Z' },
	{ role: 'assistant', content: 'spaghetti carbonara is a classic Italian pasta dish', timestamp: '2026-04-26T10:00:01Z' },
	{ role: 'user', content: 'how many eggs do I need', timestamp: '2026-04-26T10:01:00Z' },
	{ role: 'assistant', content: 'you need two eggs per serving', timestamp: '2026-04-26T10:01:01Z' },
];

async function plantHistoryJson(dir: string, content: string) {
	const ds = new DataStoreServiceImpl({
		dataDir: dir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(dir),
	});
	await ds.forUser(USER).write('history.json', content);
}

describe('Chunk D — live indexer hook: legacy migration', () => {
	it('legacy migration → session appears in searchSessions with FTS hit', async () => {
		await plantHistoryJson(tempDir, JSON.stringify(LEGACY_TURNS));

		const store = makeStore();
		// Trigger migration via loadRecentTurns
		await store.loadRecentTurns(ctx);

		const result = await index.searchSessions({
			userId: USER,
			householdId: null,
			queryTerms: ['carbonara'],
		});

		expect(result.hits).toHaveLength(1);
		const hit = result.hits[0]!;
		expect(hit.sessionEndedAt).not.toBeNull();
		expect(hit.matches.length).toBeGreaterThan(0);
	});

	it('legacy migration → getSessionMeta returns source:legacy-import', async () => {
		await plantHistoryJson(tempDir, JSON.stringify(LEGACY_TURNS));

		const store = makeStore();
		await store.loadRecentTurns(ctx);

		// Get the session id from the file system
		const ds = makeDataStore(tempDir);
		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(1);
		const sessionId = sessions[0]!.replace('.md', '');

		const meta = await index.getSessionMeta(sessionId);
		expect(meta).toBeDefined();
		expect(meta!.source).toBe('legacy-import');
		expect(meta!.ended_at).not.toBeNull();
	});

	it('legacy migration index failure does not break the migration itself', async () => {
		await plantHistoryJson(tempDir, JSON.stringify(LEGACY_TURNS));

		const failingIndex: ChatTranscriptIndex = {
			upsertSession: vi.fn().mockRejectedValue(new Error('index down')),
			appendMessage: vi.fn().mockResolvedValue(undefined),
			endSession: vi.fn().mockResolvedValue(undefined),
			deleteSession: vi.fn().mockResolvedValue(undefined),
			searchSessions: vi.fn().mockResolvedValue({ hits: [] }),
			getSessionMeta: vi.fn().mockResolvedValue(undefined),
			listExpiredSessions: vi.fn().mockResolvedValue([]),
			close: vi.fn().mockResolvedValue(undefined),
		};

		const store = makeStore({ index: failingIndex });
		// Should not throw
		await expect(store.loadRecentTurns(ctx)).resolves.toBeDefined();

		// Sentinel file should have been written — migration did complete
		const ds = makeDataStore(tempDir);
		const sentinel = await ds.forUser(USER).read('conversation/.legacy-checked');
		expect(sentinel).not.toBe('');
	});
});
