/**
 * Real-store integration test for runIdleResetHook (Hermes P8a Codex P3-3).
 *
 * Uses a real ChatSessionStore backed by a temp filesystem to prove that:
 * 1. The hook genuinely ends the session (ended_at written to the file).
 * 2. The next appendExchange creates a fresh session (new sessionId).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { CONVERSATION_DATA_SCOPES } from '../manifest.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { composeChatSessionStore } from '../../conversation-session/compose.js';
import { decode } from '../../conversation-session/transcript-codec.js';
import type { SessionTurn } from '../../conversation-session/chat-session-store.js';
import { runIdleResetHook } from '../idle-reset-hook.js';

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
				logger: logger as any,
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
				logger: pino({ level: 'silent' }) as any,
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
});
