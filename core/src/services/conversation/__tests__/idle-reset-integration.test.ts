/**
 * Real-store integration test for runIdleResetHook (Hermes P8a Codex P3-3).
 *
 * Uses a real ChatSessionStore backed by a temp filesystem to prove that:
 * 1. The hook genuinely ends the session (ended_at written to the file).
 * 2. The next appendExchange creates a fresh session (new sessionId).
 */

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTurn } from '../../conversation-session/chat-session-store.js';
import { composeChatSessionStore } from '../../conversation-session/compose.js';
import { decode } from '../../conversation-session/transcript-codec.js';
import { CONTEXT_INTERNAL_BYPASS, ContextStoreServiceImpl } from '../../context-store/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { ChatTranscriptIndexImpl } from '../../chat-transcript-index/chat-transcript-index.js';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ChatTranscriptIndex } from '../../chat-transcript-index/index.js';
import { handleMessage } from '../handle-message.js';
import { runIdleResetHook } from '../idle-reset-hook.js';
import { RECENT_SESSION_SUMMARY_KEY } from '../memory-flush.js';
import { CONVERSATION_DATA_SCOPES } from '../manifest.js';

const USER = 'alice';
const SESSION_KEY = 'agent:main:telegram:dm:alice';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-idle-reset-int-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeStore(clock?: () => Date, index?: ChatTranscriptIndex) {
	const dataStore = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});
	return {
		store: composeChatSessionStore({
			data: dataStore,
			logger: pino({ level: 'silent' }),
			clock,
			index,
		}),
		dataStore,
	};
}

function makeTurn(role: 'user' | 'assistant', content: string, ts: string): SessionTurn {
	return { role, content, timestamp: ts };
}

describe('idle-reset integration — real ChatSessionStore', () => {
	it('hook ends an idle session and sets ended_at in the filesystem', async () => {
		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store, dataStore } = makeStore(() => mintTime);

		// Mint a session by running an exchange
		const userTurn = makeTurn('user', 'hello', mintTime.toISOString());
		const assistantTurn = makeTurn('assistant', 'hi', mintTime.toISOString());
		const { sessionId } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			userTurn,
			assistantTurn,
		);

		// Hook runs 2 hours + 1 second later (well past idle threshold of 1 minute)
		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const logger = pino({ level: 'silent' });

		const result = await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store,
				telegram: { send: vi.fn().mockResolvedValue(undefined) },
				logger: logger as Pick<Logger, 'warn'>,
				now: () => hookNow,
			},
		);

		expect(result.status).toBe('reset');
		expect(result.endedSessionId).toBe(sessionId);

		// Verify the transcript file has ended_at set
		const raw = await dataStore.forUser(USER).read(`conversation/sessions/${sessionId}.md`);
		const { meta } = decode(raw);
		expect(meta.ended_at).toBeTruthy();
		expect(meta.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('next appendExchange after idle reset lands in a fresh session', async () => {
		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store } = makeStore(() => mintTime);

		// First exchange → mints session A
		const { sessionId: sessionA } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'first message', mintTime.toISOString()),
			makeTurn('assistant', 'first reply', mintTime.toISOString()),
		);

		// Idle reset fires (2 hours later)
		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const result = await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store,
				telegram: { send: vi.fn().mockResolvedValue(undefined) },
				logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
				now: () => hookNow,
			},
		);
		expect(result.status).toBe('reset');

		// Next exchange after reset → must land in a NEW session (session B)
		const nextTime = new Date('2026-05-01T12:00:10.000Z');
		const freshStore = makeStore(() => nextTime).store;
		const { sessionId: sessionB } = await freshStore.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'new message', nextTime.toISOString()),
			makeTurn('assistant', 'new reply', nextTime.toISOString()),
		);

		expect(sessionB).not.toBe(sessionA);
		// Active session is now B, not A
		const active = await freshStore.peekActive({ userId: USER, sessionKey: SESSION_KEY });
		expect(active).toBe(sessionB);
	});

	// ── P8b: memory-flush household-aware path ───────────────────────────────

	it('writes summary to households/<hh>/users/<u>/context/recent-session-summary.md', async () => {
		const householdService = { getHouseholdForUser: (_u: string) => 'h1' };
		const contextStore = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger: pino({ level: 'silent' }),
			householdService,
		});
		const flushSave = (uid: string, key: string, content: string) =>
			contextStore.save(uid, key, content, CONTEXT_INTERNAL_BYPASS);

		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store } = makeStore(() => mintTime);

		const { sessionId: _sid } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'hello', mintTime.toISOString()),
			makeTurn('assistant', 'hi', mintTime.toISOString()),
		);

		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const result = await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store,
				telegram: { send: vi.fn().mockResolvedValue(undefined) },
				logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
				now: () => hookNow,
				summarizer: async () => 'Alice prefers tea.',
				flushSave,
				getFlushEnabled: async () => true,
			},
		);

		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('written');

		const filePath = join(
			tempDir,
			'households',
			'h1',
			'users',
			USER,
			'context',
			`${RECENT_SESSION_SUMMARY_KEY}.md`,
		);
		const onDisk = await readFile(filePath, 'utf-8');
		expect(onDisk).toBe('Alice prefers tea.');
	});

	it('legacy non-household path: data/users/<u>/context/ when householdService absent', async () => {
		const contextStore = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger: pino({ level: 'silent' }),
		});
		const flushSave = (uid: string, key: string, content: string) =>
			contextStore.save(uid, key, content, CONTEXT_INTERNAL_BYPASS);

		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store } = makeStore(() => mintTime);

		await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'hello', mintTime.toISOString()),
			makeTurn('assistant', 'hi', mintTime.toISOString()),
		);

		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const result = await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store,
				telegram: { send: vi.fn().mockResolvedValue(undefined) },
				logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
				now: () => hookNow,
				summarizer: async () => 'Alice prefers tea.',
				flushSave,
				getFlushEnabled: async () => true,
			},
		);

		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('written');

		const filePath = join(
			tempDir,
			'users',
			USER,
			'context',
			`${RECENT_SESSION_SUMMARY_KEY}.md`,
		);
		const onDisk = await readFile(filePath, 'utf-8');
		expect(onDisk).toBe('Alice prefers tea.');
	});

	it('rolling key — second idle reset overwrites first summary', async () => {
		const contextStore = new ContextStoreServiceImpl({
			dataDir: tempDir,
			logger: pino({ level: 'silent' }),
		});
		const flushSave = (uid: string, key: string, content: string) =>
			contextStore.save(uid, key, content, CONTEXT_INTERNAL_BYPASS);

		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const logger = pino({ level: 'silent' }) as Pick<Logger, 'warn'>;
		const telegramSend = vi.fn().mockResolvedValue(undefined);

		// First session + reset
		const time1 = new Date('2026-05-01T10:00:00.000Z');
		const { store: store1 } = makeStore(() => time1);
		await store1.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'msg1', time1.toISOString()),
			makeTurn('assistant', 'reply1', time1.toISOString()),
		);
		await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store1,
				telegram: { send: telegramSend },
				logger,
				now: () => hookNow,
				summarizer: async () => 'First summary.',
				flushSave,
				getFlushEnabled: async () => true,
			},
		);

		// Second session + reset
		const time2 = new Date('2026-05-01T13:00:00.000Z');
		const { store: store2 } = makeStore(() => time2);
		await store2.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'msg2', time2.toISOString()),
			makeTurn('assistant', 'reply2', time2.toISOString()),
		);
		const hookNow2 = new Date('2026-05-01T15:00:01.000Z');
		await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store2,
				telegram: { send: telegramSend },
				logger,
				now: () => hookNow2,
				summarizer: async () => 'Second summary.',
				flushSave,
				getFlushEnabled: async () => true,
			},
		);

		const filePath = join(
			tempDir,
			'users',
			USER,
			'context',
			`${RECENT_SESSION_SUMMARY_KEY}.md`,
		);
		const onDisk = await readFile(filePath, 'utf-8');
		expect(onDisk).toBe('Second summary.');
		expect(onDisk).not.toContain('First summary');
	});

	it('ContextStore.save failure — idle reset still proceeds with summaryStatus="failed"', async () => {
		const failingFlushSave = async (_uid: string, _key: string, _content: string): Promise<void> => {
			throw new Error('disk full');
		};

		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store } = makeStore(() => mintTime);
		await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'hello', mintTime.toISOString()),
			makeTurn('assistant', 'hi', mintTime.toISOString()),
		);

		const hookNow = new Date('2026-05-01T12:00:01.000Z');
		const result = await runIdleResetHook(
			{ userId: USER, sessionKey: SESSION_KEY },
			{
				idleMinutes: 1,
				chatSessions: store,
				telegram: { send: vi.fn().mockResolvedValue(undefined) },
				logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
				now: () => hookNow,
				summarizer: async () => 'Some summary.',
				flushSave: failingFlushSave,
				getFlushEnabled: async () => true,
			},
		);

		expect(result.status).toBe('reset');
		expect(result.summaryStatus).toBe('failed');
	});

	// ── existing CAS test ────────────────────────────────────────────────────

	it('endActive CAS mismatch: stale expectedSessionId leaves fresh session intact', async () => {
		const mintTime = new Date('2026-05-01T10:00:00.000Z');
		const { store } = makeStore(() => mintTime);

		// Mint session A
		const { sessionId: sessionA } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'first message', mintTime.toISOString()),
			makeTurn('assistant', 'first reply', mintTime.toISOString()),
		);

		// Concurrent operation: end A and mint B (simulates another request racing the hook)
		await store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'newchat');
		const nextTime = new Date('2026-05-01T10:01:00.000Z');
		const { store: storeB, dataStore } = makeStore(() => nextTime);
		const { sessionId: sessionB } = await storeB.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'second message', nextTime.toISOString()),
			makeTurn('assistant', 'second reply', nextTime.toISOString()),
		);

		// Hook calls endActive with stale expectedSessionId = A, but B is now active
		const result = await storeB.endActive(
			{ userId: USER, sessionKey: SESSION_KEY, expectedSessionId: sessionA },
			'idle',
		);

		// CAS mismatch → no change
		expect(result.endedSessionId).toBeNull();

		// Session B must still be active and not have ended_at set
		const active = await storeB.peekActive({ userId: USER, sessionKey: SESSION_KEY });
		expect(active).toBe(sessionB);

		const raw = await dataStore.forUser(USER).read(`conversation/sessions/${sessionB}.md`);
		const { meta } = decode(raw);
		expect(meta.ended_at).toBeNull();
	});
});

// ── P8c — parent-session lineage persona test ────────────────────────────────

describe('P8c — parent-session lineage persona', () => {
	it('D.4a — user chats overnight and returns next morning: bot notices gap + parent lineage stamped', async () => {
		const lastNight = new Date('2026-05-03T22:30:00.000Z');
		const dbPath = join(tempDir, 'p8c-persona.sqlite');
		const index = new ChatTranscriptIndexImpl(dbPath);

		try {
			const { store, dataStore: _dataStore } = makeStore(() => lastNight, index);

			// Last night — user discusses weekend trip
			const { sessionId: yesterdayId } = await store.appendExchange(
				{ userId: USER, sessionKey: SESSION_KEY },
				makeTurn('user', 'help me think through a weekend trip — beach or mountains?', lastNight.toISOString()),
				makeTurn('assistant', "Both sound great! Let's compare...", lastNight.toISOString()),
			);

			// 12+ hours pass — idle threshold met
			const thisMorning = new Date('2026-05-04T11:05:00.000Z');
			const sendSpy = vi.fn().mockResolvedValue(undefined);
			const idleResult = await runIdleResetHook(
				{ userId: USER, sessionKey: SESSION_KEY },
				{
					idleMinutes: 720, // 12-hour threshold
					chatSessions: store,
					telegram: { send: sendSpy },
					logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
					now: () => thisMorning,
				},
			);
			expect(idleResult.status).toBe('reset');

			// User-visible: bot sent the inactivity notice
			expect(sendSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.stringContaining('Started a new session'),
			);

			// User: "good morning! can we keep planning the trip?"
			const { store: morningStore, dataStore: morningDataStore } = makeStore(() => thisMorning, index);
			const services = createMockCoreServices();
			vi.mocked(services.llm.complete).mockResolvedValue('Good morning! Of course, let us continue planning.');

			await handleMessage(
				createTestMessageContext({
					userId: USER,
					sessionKey: SESSION_KEY,
					text: 'good morning! can we keep planning the trip?',
					timestamp: thisMorning,
					idleResetState: idleResult,
				}),
				{
					llm: services.llm,
					telegram: services.telegram,
					data: services.data,
					logger: services.logger,
					timezone: 'UTC',
					chatSessions: morningStore,
				},
			);

			const todayId = await morningStore.peekActive({ userId: USER, sessionKey: SESSION_KEY });
			expect(todayId).toBeDefined();
			expect(todayId).not.toBe(yesterdayId);

			// Persisted lineage in Markdown frontmatter
			const raw = await morningDataStore.forUser(USER).read(`conversation/sessions/${todayId}.md`);
			expect(decode(raw).meta.parent_session_id).toBe(yesterdayId);

			// Persisted lineage in SQLite
			expect((await index.getSessionMeta(todayId!))?.parent_session_id).toBe(yesterdayId);
		} finally {
			await index.close();
		}
	});

	it('D.4b — user starts /newchat manually: no lineage attribution', async () => {
		const t = new Date('2026-05-04T11:00:00.000Z');
		const { store, dataStore } = makeStore(() => t);

		const { sessionId: firstId } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'tell me about Mars', t.toISOString()),
			makeTurn('assistant', 'Mars is the fourth planet...', t.toISOString()),
		);
		await store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'newchat');

		// No idleResetState — manual /newchat has no lineage
		const { sessionId: secondId } = await store.ensureActiveSession({
			userId: USER,
			sessionKey: SESSION_KEY,
		});

		expect(secondId).not.toBe(firstId);
		const raw = await dataStore.forUser(USER).read(`conversation/sessions/${secondId}.md`);
		expect(decode(raw).meta.parent_session_id).toBeNull();
	});
});

// ── P8c — parent-session lineage integration ─────────────────────────────────

describe('P8c — parent-session lineage: real handleMessage + real SQLite index', () => {
	it('D.1 — idle reset → handleMessage mints successor with parent_session_id in frontmatter AND SQLite', async () => {
		const t1 = new Date('2026-05-01T10:00:00.000Z');
		const dbPath = join(tempDir, 'p8c-d1.sqlite');
		const index = new ChatTranscriptIndexImpl(dbPath);

		try {
			const { store, dataStore: _dataStore } = makeStore(() => t1, index);

			// Mint session A
			const { sessionId: sessionA } = await store.appendExchange(
				{ userId: USER, sessionKey: SESSION_KEY },
				makeTurn('user', 'planning a weekend trip', t1.toISOString()),
				makeTurn('assistant', 'sounds great!', t1.toISOString()),
			);

			// Hook fires 2+ hours later
			const tHook = new Date('2026-05-01T12:00:01.000Z');
			const idleResult = await runIdleResetHook(
				{ userId: USER, sessionKey: SESSION_KEY },
				{
					idleMinutes: 1,
					chatSessions: store,
					telegram: { send: vi.fn().mockResolvedValue(undefined) },
					logger: pino({ level: 'silent' }) as Pick<Logger, 'warn'>,
					now: () => tHook,
				},
			);
			expect(idleResult.status).toBe('reset');
			expect(idleResult.endedSessionId).toBe(sessionA);

			// Next user turn via real handleMessage with idleResetState attached
			const t2 = new Date('2026-05-01T12:00:10.000Z');
			const { store: store2, dataStore: dataStore2 } = makeStore(() => t2, index);
			const services = createMockCoreServices();
			vi.mocked(services.llm.complete).mockResolvedValue('ok, continuing the trip plan!');

			await handleMessage(
				createTestMessageContext({
					userId: USER,
					sessionKey: SESSION_KEY,
					text: 'ok continue',
					timestamp: t2,
					idleResetState: idleResult,
				}),
				{
					llm: services.llm,
					telegram: services.telegram,
					data: services.data,
					logger: services.logger,
					timezone: 'UTC',
					chatSessions: store2,
				},
			);

			// Session B is new
			const sessionB = await store2.peekActive({ userId: USER, sessionKey: SESSION_KEY });
			expect(sessionB).toBeDefined();
			expect(sessionB).not.toBe(sessionA);

			// Markdown frontmatter has parent_session_id = sessionA
			const raw = await dataStore2.forUser(USER).read(`conversation/sessions/${sessionB}.md`);
			const { meta } = decode(raw);
			expect(meta.parent_session_id).toBe(sessionA);

			// SQLite also has parent_session_id = sessionA
			const dbMeta = await index.getSessionMeta(sessionB!);
			expect(dbMeta?.parent_session_id).toBe(sessionA);
		} finally {
			await index.close();
		}
	});

	it('D.2 — manual endActive (newchat) produces successor with parent_session_id null', async () => {
		const t1 = new Date('2026-05-01T10:00:00.000Z');
		const { store, dataStore } = makeStore(() => t1);

		const { sessionId: sessionA } = await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'first message', t1.toISOString()),
			makeTurn('assistant', 'first reply', t1.toISOString()),
		);
		await store.endActive({ userId: USER, sessionKey: SESSION_KEY }, 'newchat');

		// Next session — no idleResetState, so no parentSessionId forwarded
		const t2 = new Date('2026-05-01T10:00:30.000Z');
		const { store: store2, dataStore: dataStore2 } = makeStore(() => t2);
		const { sessionId: sessionB } = await store2.ensureActiveSession({
			userId: USER,
			sessionKey: SESSION_KEY,
		});

		expect(sessionB).not.toBe(sessionA);
		const raw = await dataStore2.forUser(USER).read(`conversation/sessions/${sessionB}.md`);
		const { meta } = decode(raw);
		expect(meta.parent_session_id).toBeNull();
	});

	it('D.3 — parent_session_id is set only at mint; second appendExchange does not alter it', async () => {
		const t = new Date('2026-05-01T10:00:00.000Z');
		const { store, dataStore } = makeStore(() => t);
		const parentId = '20260427_140000_aaaaaaaa';

		// Mint with a parent
		const { sessionId } = await store.ensureActiveSession({
			userId: USER,
			sessionKey: SESSION_KEY,
			parentSessionId: parentId,
		} as Parameters<typeof store.ensureActiveSession>[0]);

		// First exchange on the session
		await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY },
			makeTurn('user', 'q1', t.toISOString()),
			makeTurn('assistant', 'a1', t.toISOString()),
		);

		// Second exchange — would-be attacker tries to override parent
		await store.appendExchange(
			{ userId: USER, sessionKey: SESSION_KEY, parentSessionId: '20260427_150000_bbbbbbbb' } as Parameters<typeof store.appendExchange>[0],
			makeTurn('user', 'q2', t.toISOString()),
			makeTurn('assistant', 'a2', t.toISOString()),
		);

		// Original parent must be preserved
		const raw = await dataStore.forUser(USER).read(`conversation/sessions/${sessionId}.md`);
		const { meta } = decode(raw);
		expect(meta.parent_session_id).toBe(parentId);
	});
});
