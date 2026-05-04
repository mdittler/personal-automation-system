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

function makeStore(clock?: () => Date) {
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
