import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { composeChatSessionStore } from '../compose.js';
import type { ChatSessionStore, ChatSessionFrontmatter, SessionTurn } from '../chat-session-store.js';
import { mintSessionId } from '../session-id.js';
import { encodeNew } from '../transcript-codec.js';

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
			// mintAndRegister consumes 1 clock call (for the id + skeleton started_at).
			// appendExchange no longer calls buildFrontmatter (the skeleton is pre-written).
			// endActive's this.now() is therefore the 2nd clock call.
			return callCount <= 1 ? FROZEN : endTime;
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

// ---------------------------------------------------------------------------
// Tracer E — Legacy history.json migration
// ---------------------------------------------------------------------------

const LEGACY_TURNS = [
	{ role: 'user', content: 'hi there', timestamp: '2026-04-26T10:00:00Z' },
	{ role: 'assistant', content: 'hello!', timestamp: '2026-04-26T10:00:01Z' },
	{ role: 'user', content: 'what time is it', timestamp: '2026-04-26T10:01:00Z' },
	{ role: 'assistant', content: 'around 10am', timestamp: '2026-04-26T10:01:01Z' },
];

async function plantHistoryJson(ds: DataStoreServiceImpl, content: string) {
	const scoped = ds.forUser(USER);
	await scoped.write('history.json', content);
}

describe('E — Legacy history.json migration', () => {
	it('first loadRecentTurns triggers migration: creates legacy-import session file', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(1);
		const sessionId = sessions[0]!.replace('.md', '');
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.source).toBe('legacy-import');
		expect(decoded?.turns).toHaveLength(4);
	});

	it('legacy-import session has started_at from first turn and ended_at from last turn', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		const sessionId = sessions[0]!.replace('.md', '');
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.started_at).toBe('2026-04-26T10:00:00Z');
		expect(decoded?.meta.ended_at).toBe('2026-04-26T10:01:01Z');
	});

	it('history.json is preserved after migration (not deleted)', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const raw = await ds.forUser(USER).read('history.json');
		expect(raw).not.toBe('');
		expect(JSON.parse(raw)).toHaveLength(4);
	});

	it('active session is NOT the legacy-import session after migration', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		// No active session — legacy is read-only
		expect(await store.peekActive(ctx)).toBeUndefined();
		// loadRecentTurns returns [] (no active session)
		const turns = await store.loadRecentTurns(ctx);
		expect(turns).toEqual([]);
	});

	it('migration is idempotent: second loadRecentTurns does not create duplicate', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);
		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(1);
	});

	it('absent history.json: no migration, no session file', async () => {
		const ds = makeDataStore();
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(0);
	});

	it('empty JSON array []: no migration, no session file', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, '[]');
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(0);
	});

	it('malformed JSON: no migration, no crash, warning is logged', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, 'not valid json {{{');
		const logger = makeMockLogger();
		const store = composeChatSessionStore({ data: ds, logger, clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalled();
	});

	it('turns with invalid timestamps fall back to clock time', async () => {
		const ds = makeDataStore();
		const badTurns = [
			{ role: 'user', content: 'hi', timestamp: 'not-a-date' },
			{ role: 'assistant', content: 'hello', timestamp: 'also-bad' },
		];
		await plantHistoryJson(ds, JSON.stringify(badTurns));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await store.loadRecentTurns(ctx);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(1);
		const sessionId = sessions[0]!.replace('.md', '');
		const decoded = await store.readSession(USER, sessionId);
		expect(decoded?.meta.source).toBe('legacy-import');
		// Timestamps fell back to clock
		expect(decoded?.meta.started_at).toBe(FROZEN.toISOString());
		expect(decoded?.meta.ended_at).toBe(FROZEN.toISOString());
	});

	it('concurrency: two simultaneous loadRecentTurns produce exactly one legacy-import file', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		await Promise.all([store.loadRecentTurns(ctx), store.loadRecentTurns(ctx)]);

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		expect(sessions).toHaveLength(1);
	});

	it('first appendExchange also triggers migration (creates legacy-import + new telegram session)', async () => {
		const ds = makeDataStore();
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));
		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });

		const { sessionId } = await store.appendExchange(ctx, turn('user', 'new msg'), turn('assistant', 'new reply'));

		const sessions = await ds.forUser(USER).list('conversation/sessions/');
		// Two sessions: one legacy-import, one telegram
		expect(sessions).toHaveLength(2);

		const newSession = await store.readSession(USER, sessionId);
		expect(newSession?.meta.source).toBe('telegram');
		expect(newSession?.turns).toHaveLength(2);

		// Find the legacy session
		const legacyId = sessions.find(f => f.replace('.md', '') !== sessionId)!.replace('.md', '');
		const legacySession = await store.readSession(USER, legacyId);
		expect(legacySession?.meta.source).toBe('legacy-import');
		expect(legacySession?.turns).toHaveLength(4);
	});

	it('upgrade compat: pre-seeded legacy-import session + history.json + no sentinel — does not duplicate', async () => {
		// Simulates a user who ran Hermes P3 before the .legacy-checked sentinel
		// was introduced: they already have a source:legacy-import session on disk,
		// history.json is still present (preserved by design), but there is no
		// .legacy-checked file. Without the upgrade-compat scan, maybeImportLegacy
		// would see no sentinel, find history.json, and create a second import.
		const ds = makeDataStore();
		const scoped = ds.forUser(USER);

		// Plant the pre-existing legacy-import session (no sentinel)
		const existingId = mintSessionId(new Date('2026-04-26T10:00:00Z'));
		const meta: ChatSessionFrontmatter = {
			id: existingId,
			source: 'legacy-import',
			user_id: USER,
			household_id: null,
			model: null,
			title: null,
			parent_session_id: null,
			started_at: '2026-04-26T10:00:00Z',
			ended_at: '2026-04-26T10:01:01Z',
			token_counts: { input: 0, output: 0 },
		};
		await scoped.write(`conversation/sessions/${existingId}.md`, encodeNew(meta));

		// Plant history.json (preserved by design — never deleted)
		await plantHistoryJson(ds, JSON.stringify(LEGACY_TURNS));

		const store = composeChatSessionStore({ data: ds, logger: makeMockLogger(), clock });
		await store.loadRecentTurns(ctx);

		// Still exactly one session — no duplicate was created
		const sessions = await scoped.list('conversation/sessions/');
		const mdSessions = sessions.filter(f => f.endsWith('.md'));
		expect(mdSessions).toHaveLength(1);
		expect(mdSessions[0]).toContain(existingId);
	});
});

// ─── ensureActiveSession ───────────────────────────────────────────────────────

describe('ChatSessionStore.ensureActiveSession', () => {
	it('mints a new session and returns isNew:true on first call', async () => {
		const store = makeStore();
		const result = await store.ensureActiveSession(ctx);
		expect(result.isNew).toBe(true);
		expect(result.sessionId).toBeTruthy();
		expect(result.snapshot).toBeUndefined();
	});

	it('returns isNew:false on subsequent calls for the same session', async () => {
		const store = makeStore();
		const first = await store.ensureActiveSession(ctx);
		const second = await store.ensureActiveSession(ctx);
		expect(second.isNew).toBe(false);
		expect(second.sessionId).toBe(first.sessionId);
	});

	it('fires buildSnapshot callback exactly once on mint, not on peek', async () => {
		const buildSnapshot = vi.fn().mockResolvedValue({
			content: '## key\nvalue',
			status: 'ok',
			builtAt: new Date().toISOString(),
			entryCount: 1,
		});
		const store = makeStore();
		await store.ensureActiveSession(ctx, { buildSnapshot });
		await store.ensureActiveSession(ctx, { buildSnapshot }); // second call: peek path
		expect(buildSnapshot).toHaveBeenCalledTimes(1);
	});

	it('returns snapshot from frontmatter on peek path (isNew:false)', async () => {
		const snapshot = {
			content: '## pref\nmetric',
			status: 'ok' as const,
			builtAt: new Date().toISOString(),
			entryCount: 1,
		};
		const store = makeStore();
		await store.ensureActiveSession(ctx, { buildSnapshot: vi.fn().mockResolvedValue(snapshot) });
		const second = await store.ensureActiveSession(ctx);
		expect(second.snapshot).toEqual(snapshot);
	});

	it('persists snapshot in session frontmatter', async () => {
		const snapshot = {
			content: '## k\nv',
			status: 'ok' as const,
			builtAt: '2026-04-28T08:00:00.000Z',
			entryCount: 1,
		};
		const store = makeStore();
		const { sessionId } = await store.ensureActiveSession(ctx, {
			buildSnapshot: vi.fn().mockResolvedValue(snapshot),
		});
		const session = await store.readSession(USER, sessionId);
		const fm = session!.meta as ChatSessionFrontmatter & { memory_snapshot?: unknown };
		expect(fm.memory_snapshot).toBeDefined();
		const ms = fm.memory_snapshot as { content: string; status: string; built_at: string; entry_count: number };
		expect(ms.content).toBe(snapshot.content);
		expect(ms.status).toBe('ok');
		expect(ms.built_at).toBe(snapshot.builtAt);
		expect(ms.entry_count).toBe(1);
	});

	it('snapshot field survives appendExchange (encodeAppend does not touch frontmatter)', async () => {
		const snapshot = {
			content: '## k\nv',
			status: 'ok' as const,
			builtAt: '2026-04-28T08:00:00.000Z',
			entryCount: 1,
		};
		const store = makeStore();
		const { sessionId } = await store.ensureActiveSession(ctx, {
			buildSnapshot: vi.fn().mockResolvedValue(snapshot),
		});
		await store.appendExchange(
			{ ...ctx, expectedSessionId: sessionId },
			turn('user', 'hello'),
			turn('assistant', 'hi'),
		);
		const session = await store.readSession(USER, sessionId);
		const fm = session!.meta as ChatSessionFrontmatter & { memory_snapshot?: unknown };
		expect(fm.memory_snapshot).toBeDefined();
	});

	it('snapshot field survives endActive rewrite', async () => {
		const snapshot = {
			content: '## k\nv',
			status: 'ok' as const,
			builtAt: '2026-04-28T08:00:00.000Z',
			entryCount: 1,
		};
		const store = makeStore();
		const { sessionId } = await store.ensureActiveSession(ctx, {
			buildSnapshot: vi.fn().mockResolvedValue(snapshot),
		});
		await store.endActive(ctx, 'newchat');
		const session = await store.readSession(USER, sessionId);
		const fm = session!.meta as ChatSessionFrontmatter & { memory_snapshot?: unknown };
		expect(fm.memory_snapshot).toBeDefined();
	});

	it('no memory_snapshot field when buildSnapshot callback is absent', async () => {
		const store = makeStore();
		const { sessionId } = await store.ensureActiveSession(ctx); // no callback
		const session = await store.readSession(USER, sessionId);
		const fm = session!.meta as ChatSessionFrontmatter & { memory_snapshot?: unknown };
		expect(fm.memory_snapshot).toBeUndefined();
	});

	it('mints with status:degraded when buildSnapshot throws', async () => {
		const buildSnapshot = vi.fn().mockRejectedValue(new Error('store down'));
		const store = makeStore();
		const { sessionId, snapshot } = await store.ensureActiveSession(ctx, { buildSnapshot });
		expect(sessionId).toBeTruthy();
		expect(snapshot?.status).toBe('degraded');
		const session = await store.readSession(USER, sessionId);
		expect(session).toBeDefined();
		const fm = session!.meta as ChatSessionFrontmatter & { memory_snapshot?: unknown };
		// degraded snapshot IS persisted (service was wired but failed)
		expect(fm.memory_snapshot).toBeDefined();
	});

	it('session minted before P4 (no memory_snapshot field) decodes snapshot as undefined', async () => {
		// Simulate a pre-P4 session by writing a transcript without memory_snapshot in frontmatter
		const store = makeStore();
		// First ensure an active session exists (minted without snapshot)
		const { sessionId } = await store.ensureActiveSession(ctx);
		// peekSnapshot should return undefined since no snapshot field was written
		const snap = await store.peekSnapshot(ctx);
		expect(snap).toBeUndefined();
	});
});

describe('ChatSessionStore.peekSnapshot', () => {
	it('returns undefined when no active session', async () => {
		const store = makeStore();
		expect(await store.peekSnapshot(ctx)).toBeUndefined();
	});

	it('returns undefined when active session has no snapshot field', async () => {
		const store = makeStore();
		await store.ensureActiveSession(ctx); // no callback → no snapshot
		expect(await store.peekSnapshot(ctx)).toBeUndefined();
	});

	it('returns the snapshot when present', async () => {
		const snapshot = {
			content: '## x\ny',
			status: 'ok' as const,
			builtAt: '2026-04-28T08:00:00.000Z',
			entryCount: 1,
		};
		const store = makeStore();
		await store.ensureActiveSession(ctx, { buildSnapshot: vi.fn().mockResolvedValue(snapshot) });
		const result = await store.peekSnapshot(ctx);
		expect(result).toEqual(snapshot);
	});
});
