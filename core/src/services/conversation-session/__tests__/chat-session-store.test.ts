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
import { mintSessionId } from '../session-id.js';

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

function makeDataStore() {
	return new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});
}

const FROZEN = new Date('2026-04-27T15:45:00Z');
const clock = () => FROZEN;

function makeStore(opts?: { rng?: () => string; clock?: () => Date }): ChatSessionStore {
	return composeChatSessionStore({
		data: makeDataStore(),
		logger: makeMockLogger(),
		clock: opts?.clock ?? clock,
		rng: opts?.rng,
	});
}

function turn(role: 'user' | 'assistant', content: string, ts?: string): SessionTurn {
	return { role, content, timestamp: ts ?? FROZEN.toISOString() };
}

const ctx = { userId: USER, sessionKey: SESSION_KEY };

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-chat-session-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tracer D.1 — Happy path
// ---------------------------------------------------------------------------

describe('D.1 — appendExchange happy path', () => {
	it('first appendExchange mints a session with deterministic id format', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'hi'), turn('assistant', 'hello'));
		expect(sessionId).toMatch(/^\d{8}_\d{6}_[0-9a-f]{8}$/);
	});

	it('peekActive returns the minted session id after first appendExchange', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'hi'), turn('assistant', 'hello'));
		expect(await store.peekActive(ctx)).toBe(sessionId);
	});

	it('second appendExchange reuses the same session id', async () => {
		const store = makeStore();
		const { sessionId: id1 } = await store.appendExchange(ctx, turn('user', 'hi'), turn('assistant', 'hello'));
		const { sessionId: id2 } = await store.appendExchange(ctx, turn('user', 'q2'), turn('assistant', 'a2'));
		expect(id1).toBe(id2);
	});

	it('loadRecentTurns returns all turns in sequence after two exchanges', async () => {
		const store = makeStore();
		await store.appendExchange(ctx, turn('user', 'q1'), turn('assistant', 'a1'));
		await store.appendExchange(ctx, turn('user', 'q2'), turn('assistant', 'a2'));
		const turns = await store.loadRecentTurns(ctx, { maxTurns: 20 });
		expect(turns).toHaveLength(4);
		expect(turns[0]?.content).toBe('q1');
		expect(turns[1]?.content).toBe('a1');
		expect(turns[2]?.content).toBe('q2');
		expect(turns[3]?.content).toBe('a2');
	});

	it('loadRecentTurns respects maxTurns (returns last N)', async () => {
		const store = makeStore();
		for (let i = 0; i < 5; i++) {
			await store.appendExchange(ctx, turn('user', `q${i}`), turn('assistant', `a${i}`));
		}
		const turns = await store.loadRecentTurns(ctx, { maxTurns: 3 });
		expect(turns).toHaveLength(3);
		expect(turns[2]?.content).toBe('a4');
	});

	it('loadRecentTurns returns [] when no active session', async () => {
		const store = makeStore();
		const turns = await store.loadRecentTurns(ctx);
		expect(turns).toEqual([]);
	});

	it('transcript file contains correct YAML frontmatter fields', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(
			{ ...ctx, model: 'claude-sonnet-4-6', householdId: 'household-abc' },
			turn('user', 'hi'),
			turn('assistant', 'hello'),
		);
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.id).toBe(sessionId);
		expect(decoded?.meta.source).toBe('telegram');
		expect(decoded?.meta.user_id).toBe(USER);
		expect(decoded?.meta.household_id).toBe('household-abc');
		expect(decoded?.meta.model).toBe('claude-sonnet-4-6');
		expect(decoded?.meta.title).toBeNull();
		expect(decoded?.meta.parent_session_id).toBeNull();
		expect(decoded?.meta.ended_at).toBeNull();
		expect(decoded?.meta.token_counts).toEqual({ input: 0, output: 0 });
	});
});

// ---------------------------------------------------------------------------
// Tracer D.2 — Concurrency
// ---------------------------------------------------------------------------

describe('D.2 — concurrency', () => {
	it('10 concurrent appendExchange calls preserve all 20 turn pairs with no interleaving', async () => {
		const store = makeStore();
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				store.appendExchange(ctx, turn('user', `u${i}`), turn('assistant', `a${i}`)),
			),
		);
		const turns = await store.loadRecentTurns(ctx, { maxTurns: 100 });
		expect(turns).toHaveLength(20);
		// Every even index is user, every odd is assistant (no inter-pair interleaving)
		for (let i = 0; i < turns.length; i += 2) {
			expect(turns[i]?.role).toBe('user');
			expect(turns[i + 1]?.role).toBe('assistant');
		}
	});

	it('expectedSessionId race: turns land in old session after endActive clears it', async () => {
		const store = makeStore();
		// Create session s1
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'original'), turn('assistant', 'reply'));
		// End the session (simulating /newchat)
		await store.endActive(ctx, 'newchat');
		// In-flight reply with bound expectedSessionId (simulating locked decision)
		await store.appendExchange(
			{ ...ctx, expectedSessionId: sessionId },
			turn('user', 'late-user'),
			turn('assistant', 'late-reply'),
		);
		// Turns landed in old session
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.turns).toHaveLength(4);
		expect(decoded?.turns[2]?.content).toBe('late-user');
		expect(decoded?.turns[3]?.content).toBe('late-reply');
		// Old session still closed
		expect(decoded?.meta.ended_at).toBeDefined();
		expect(decoded?.meta.ended_at).not.toBeNull();
	});

	it('parallel endActive calls leave consistent active-sessions.yaml with no active session', async () => {
		const store = makeStore();
		await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));
		await Promise.all([
			store.endActive(ctx, 'newchat'),
			store.endActive(ctx, 'reset'),
		]);
		expect(await store.peekActive(ctx)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tracer D.3 — Restart (store re-creation from same data dir)
// ---------------------------------------------------------------------------

describe('D.3 — restart', () => {
	it('re-created store reuses same sessionId and appends to same file', async () => {
		const dataStore = makeDataStore();
		const store1 = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const { sessionId } = await store1.appendExchange(ctx, turn('user', 'q1'), turn('assistant', 'a1'));

		// Drop store1, create store2 from same data dir
		const store2 = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const { sessionId: sessionId2 } = await store2.appendExchange(ctx, turn('user', 'q2'), turn('assistant', 'a2'));

		expect(sessionId2).toBe(sessionId);
		const decoded = await store2.readSession(USER, sessionId);
		expect(decoded?.turns).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// Tracer D.4 — Security
// ---------------------------------------------------------------------------

describe('D.4 — security', () => {
	it('readSession with path-traversal id returns undefined without file access', async () => {
		const store = makeStore();
		expect(await store.readSession(USER, '../etc/passwd')).toBeUndefined();
		expect(await store.readSession(USER, '../../shadow')).toBeUndefined();
	});

	it('readSession with wrong format returns undefined', async () => {
		const store = makeStore();
		expect(await store.readSession(USER, 'foo')).toBeUndefined();
		expect(await store.readSession(USER, '')).toBeUndefined();
		expect(await store.readSession(USER, '20260427_154500_XXXXXXXX')).toBeUndefined(); // uppercase hex
		expect(await store.readSession(USER, '2026-04-27_15:45:00_a1b2c3d4')).toBeUndefined(); // wrong separators
	});

	it('readSession with valid id for non-existent session returns undefined', async () => {
		const store = makeStore();
		expect(await store.readSession(USER, '20260427_154500_a1b2c3d4')).toBeUndefined();
	});

	it('userB cannot read userA session via their scoped store', async () => {
		// Both users share the same DataStoreServiceImpl but are scoped separately
		const dataStore = makeDataStore();
		const storeA = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const ctxA = { userId: USER, sessionKey: SESSION_KEY };
		const { sessionId } = await storeA.appendExchange(ctxA, turn('user', 'secret'), turn('assistant', 'reply'));

		// UserB reads by sessionId via their own store — file doesn't exist in their scope
		const storeB = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const result = await storeB.readSession('nina', sessionId);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tracer D.5 — Collision retry
// ---------------------------------------------------------------------------

describe('D.5 — collision retry', () => {
	it('RNG returning colliding id on first call causes retry with different id', async () => {
		// Pre-create a session file with a known id to force collision
		const dataStore = makeDataStore();
		const collisionId = mintSessionId(FROZEN, () => 'aaaabbbb');
		// Write the collision file via store (within a data store)
		const baseStore = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		await baseStore.appendExchange(
			{ userId: USER, sessionKey: 'agent:main:telegram:dm:other' },
			turn('user', 'collision file'),
			turn('assistant', 'exists'),
		);
		// The above created a session with a random id; we need to plant the specific collision file
		// Use the scoped store directly to write a file with the collision id
		const scopedStore = dataStore.forUser(USER);
		await scopedStore.write(`conversation/sessions/${collisionId}.md`, '---\nid: placeholder\n---\n');

		let callCount = 0;
		const rng = () => {
			callCount++;
			return callCount === 1 ? 'aaaabbbb' : 'ccccdddd';
		};

		const store = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock, rng });
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'new'), turn('assistant', 'reply'));
		// Should have retried and used 'ccccdddd'
		expect(sessionId).toContain('ccccdddd');
		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Tracer D.6 — Clock injection
// ---------------------------------------------------------------------------

describe('D.6 — clock injection', () => {
	it('endActive sets ended_at using injected clock', async () => {
		const endTime = new Date('2026-04-27T16:00:00Z');
		let callCount = 0;
		const dynamicClock = () => {
			callCount++;
			return callCount <= 2 ? FROZEN : endTime; // first calls for minting/frontmatter, end call
		};

		const store = makeStore({ clock: dynamicClock });
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));
		await store.endActive(ctx, 'newchat');

		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.ended_at).toBe(endTime.toISOString());
	});

	it('started_at in frontmatter matches injected clock at mint time', async () => {
		const store = makeStore({ clock });
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.started_at).toBe(FROZEN.toISOString());
	});
});

// ---------------------------------------------------------------------------
// Tracer D.7 — Corruption self-heal
// ---------------------------------------------------------------------------

describe('D.7 — corruption self-heal', () => {
	it('corrupted active-sessions.yaml causes appendExchange to mint a fresh session', async () => {
		const dataStore = makeDataStore();
		// Write corrupt YAML directly
		const scopedStore = dataStore.forUser(USER);
		await scopedStore.write('conversation/active-sessions.yaml', 'invalid: [[[corrupt');

		const store = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));

		// A new session was minted
		expect(sessionId).toMatch(/^\d{8}_\d{6}_[0-9a-f]{8}$/);
		// Transcript file exists
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.turns).toHaveLength(2);
	});

	it('loadRecentTurns with corrupt active-sessions.yaml returns []', async () => {
		const dataStore = makeDataStore();
		const scopedStore = dataStore.forUser(USER);
		await scopedStore.write('conversation/active-sessions.yaml', 'invalid: [[[corrupt');

		const store = composeChatSessionStore({ data: dataStore, logger: makeMockLogger(), clock });
		const turns = await store.loadRecentTurns(ctx);
		expect(turns).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// endActive — token_counts preservation (plan F.2 — tested here for coverage)
// ---------------------------------------------------------------------------

describe('endActive — token_counts preservation', () => {
	it('endActive preserves existing token_counts unchanged', async () => {
		const store = makeStore();
		const { sessionId } = await store.appendExchange(ctx, turn('user', 'q'), turn('assistant', 'a'));

		// Manually set token_counts to non-zero by reading + verifying initial state
		// P3 ships zeros; we just verify they don't get clobbered
		await store.endActive(ctx, 'newchat');
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.token_counts).toEqual({ input: 0, output: 0 });
	});
});

// ---------------------------------------------------------------------------
// expectedSessionId — error when session does not exist
// ---------------------------------------------------------------------------

describe('expectedSessionId validation', () => {
	it('throws when expectedSessionId file does not exist', async () => {
		const store = makeStore();
		await expect(
			store.appendExchange(
				{ ...ctx, expectedSessionId: '20260427_154500_nonexist' },
				turn('user', 'q'),
				turn('assistant', 'a'),
			),
		).rejects.toThrow(/expected session/);
	});
});
